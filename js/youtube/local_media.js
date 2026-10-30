/**
 * 本地视频 / 音频导入与预览（零后端）。
 *
 * 明确的能力边界，写在这里是为了不再被误解成"下载器"：
 *   - 只处理用户从磁盘选择的文件，不访问任何网络地址；
 *   - YouTube 官方播放器不提供视频文件下载接口，浏览器也不允许跨源读取
 *     googlevideo 的媒体流，所以"把在线视频变成本地文件"不在此模块能力内，
 *     也不会用任何代理/解析手段伪装成可以；
 *   - 文件用 URL.createObjectURL 挂载而不是读进内存：1 GB 的视频读成
 *     ArrayBuffer 会让标签页直接崩溃，objectURL 是引用语义，代价接近零。
 *
 * 浏览器能否解码取决于容器与编码（例如 MKV/AVI 多数浏览器放不了）。
 * 这里只做"声明类型 + 扩展名"的弱校验，真正的判断交给 <video> 的 error 事件，
 * 并把失败原因如实报出来，而不是提前假装文件可用。
 */

export const MAX_LOCAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mkv", "mov", "ogv", "avi", "3gp"]);
const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "weba"]);

/** 主流浏览器能稳定解码的容器；其余仍允许导入，但会附带"可能无法播放"的提示。 */
const WELL_SUPPORTED = new Set(["mp4", "m4v", "webm", "mov", "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "weba"]);

export class MediaError extends Error {
  constructor(message, code = "media_error") {
    super(message);
    this.name = "MediaError";
    this.code = code;
  }
}

/** 从 File 的 MIME 与扩展名判定媒体类型；两者都判不出来就返回 null，不猜。 */
export function classifyMedia(file) {
  const name = String(file?.name || "");
  const mime = String(file?.type || "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";

  if (mime.startsWith("video/")) return { kind: "video", ext, mime, by: "mime" };
  if (mime.startsWith("audio/")) return { kind: "audio", ext, mime, by: "mime" };
  if (VIDEO_EXT.has(ext)) return { kind: "video", ext, mime: mime || `video/${ext}`, by: "ext" };
  if (AUDIO_EXT.has(ext)) return { kind: "audio", ext, mime: mime || `audio/${ext}`, by: "ext" };
  return { kind: null, ext, mime, by: "unknown" };
}

/** 导入前的校验。返回结构固定，UI 只需要读 message。 */
export function validateMedia(file, { maxBytes = MAX_LOCAL_BYTES } = {}) {
  if (!file) return { ok: false, code: "empty", message: "没有选择文件" };
  const size = Number(file.size || 0);
  if (size === 0) return { ok: false, code: "empty", message: "文件是空的（0 字节）" };
  if (size > maxBytes) {
    return {
      ok: false,
      code: "too_large",
      message: `文件 ${(size / 1073741824).toFixed(2)} GB，超过 ${(maxBytes / 1073741824).toFixed(0)} GB 上限。请先用本地工具裁剪或转码。`,
    };
  }
  const info = classifyMedia(file);
  if (!info.kind) {
    return { ok: false, code: "unsupported", message: "无法识别为视频或音频文件（仅接受 video/* 与 audio/*）" };
  }
  return { ok: true, code: "ok", message: "", info };
}

/** 供笔记导出使用的元信息。只写真实存在的字段，没有的不虚构成空字符串。 */
export function describeMedia(file) {
  if (!file) return null;
  const info = classifyMedia(file);
  return {
    name: file.name || "",
    type: file.type || info.mime || "",
    size: Number(file.size || 0),
    kind: info.kind,
    ext: info.ext,
    lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
  };
}

/** 浏览器大概率放不了时的提示；返回空串表示没意见。 */
export function compatibilityHint(file) {
  const { ext, kind } = classifyMedia(file);
  if (!kind) return "";
  if (!ext || WELL_SUPPORTED.has(ext)) return "";
  return `${ext.toUpperCase()} 容器在部分浏览器（尤其 iOS Safari）无法解码。若预览黑屏，请转成 MP4(H.264) 或 WebM 再导入。`;
}

/**
 * objectURL 的生命周期管理。
 * 浏览器不会自动回收 objectURL，切文件时必须 revoke，否则内存会一直涨。
 */
export class LocalMediaSession {
  constructor({ createObjectURL, revokeObjectURL } = {}) {
    this._create = createObjectURL || ((file) => URL.createObjectURL(file));
    this._revoke = revokeObjectURL || ((url) => URL.revokeObjectURL(url));
    this.url = null;
    this.file = null;
    this.kind = null;
  }

  get active() {
    return Boolean(this.url);
  }

  select(file, options) {
    const check = validateMedia(file, options);
    if (!check.ok) throw new MediaError(check.message, check.code);
    this.release();
    this.file = file;
    this.kind = check.info.kind;
    this.url = this._create(file);
    return { url: this.url, kind: this.kind, file };
  }

  release() {
    if (this.url) {
      try {
        this._revoke(this.url);
      } catch {
        // revoke 失败不影响后续流程：抛出会让"移除文件"这个动作看起来失败了
      }
    }
    this.url = null;
    this.kind = null;
    this.file = null;
  }
}

/**
 * 读取时长/分辨率。失败或超时返回 null —— 显示"时长未知"比编一个数字诚实。
 * createElement 由调用方注入，便于在 node 里测试（没有 DOM）。
 */
export function probeMedia(url, kind, { createElement, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!createElement || !url) {
      resolve(null);
      return;
    }
    let timer = null;
    let done = false;
    const el = createElement(kind === "audio" ? "audio" : "video");

    const finish = (value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      el.onloadedmetadata = null;
      el.onerror = null;
      resolve(value);
    };

    timer = setTimeout(() => finish(null), timeoutMs);
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const duration = Number(el.duration);
      finish({
        duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
        width: Number(el.videoWidth) || 0,
        height: Number(el.videoHeight) || 0,
      });
    };
    el.onerror = () => finish(null);
    el.src = url;
  });
}
