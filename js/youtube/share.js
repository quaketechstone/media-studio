/**
 * 字幕文件导出：让"保存"在手机上真的可用。
 *
 * 桌面和手机是两套现实：
 *   桌面 Chrome/Edge 有 showSaveFilePicker，能选路径、能边写边存；
 *   iOS Safari 两者都没有——没有 showSaveFilePicker，对 blob: + <a download>
 *   的处理也不稳定，常见结果是**把纯文本直接在新标签页打开**。用户看到一屏
 *   字，会以为"没下载成功"，然后反复点。
 *
 * 手机的原生保存路径是**系统分享面板**：navigator.share({ files }) 弹出来的是
 * 系统级「存储到文件 / 微信 / 隔空投送 / 邮件」。这比任何下载目录都更贴近真实
 * 意图——用户要的往往不是"存到某个文件夹"，而是"把这个文件拿到别处去用"。
 *
 * 因此按三级降级，并且**如实返回走了哪一级**，不许统一说成"已保存"：
 *   share     系统分享面板
 *   download  <a download>（Android Chrome 可靠）
 *   none      都不支持，UI 引导去复制文本
 *
 * 两个硬约束（都是踩过的坑）：
 *   1. navigator.share() 必须在用户点击的**同步调用栈**内触发，中间不能插 await，
 *      否则手势失效抛 NotAllowedError。字幕内容早就在内存里，构造 File 是同步
 *      操作，所以这里安全；但谁要是future在这个函数前面加"先请求一下"，就会坏。
 *   2. canShare({ files }) 只认 File，不认 Blob。用 Blob 会被静默判为不支持。
 */

/** 文件名里不能出现的字符：Windows 全量 + 控制字符（手机经微信/网盘中转时更容易撞上）。 */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/** 语音码、标题都可能很长，截断避免超出各平台的文件名上限。 */
const MAX_STEM = 60;

export class ShareError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ShareError";
    this.code = code;
    this.detail = detail;
  }
}

function safeStem(raw, fallback = "") {
  const cleaned = String(raw || "")
    .replace(ILLEGAL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    // 以点开头在手机上会被当成隐藏文件，去掉
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, MAX_STEM).trim() || fallback;
}

/**
 * 生成文件名：`标题.语言.srt`。
 *
 * 标题为空的视频（未解析元数据时很常见）退到 videoId，再退到 subtitles——
 * 退到空字符串会让分享面板里出现一个没有名字的文件，用户无从辨认。
 */
export function subtitleFilename({ title = "", videoId = "", lang = "", ext = "srt", suffix = "" } = {}) {
  const stem = safeStem(title) || safeStem(videoId) || "subtitles";
  const parts = [stem];
  if (suffix) parts.push(safeStem(suffix));
  const language = safeStem(lang);
  if (language) parts.push(language);
  return `${parts.join(".")}.${safeStem(ext, "srt")}`;
}

function byteLength(text) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
  return String(text || "").length;
}

/** 探测文件分享能力。没有 navigator / 没有 canShare / canShare 返回 false 都算不支持。 */
export function canShareFiles(scope = globalThis) {
  const nav = scope?.navigator;
  if (!nav || typeof nav.share !== "function") return false;
  if (typeof nav.canShare !== "function") return false;
  // 老实现只支持 share({text})，对文件一律 false；必须真的问一次
  const FileCtor = scope?.File || globalThis.File;
  if (typeof FileCtor !== "function") return false;
  try {
    const probe = new FileCtor([""], "probe.txt", { type: "text/plain" });
    return Boolean(nav.canShare({ files: [probe] }));
  } catch {
    return false;
  }
}

/** 触屏设备优先分享。iPad 带触控笔时 matchMedia 仍报 coarse，走分享是对的。 */
export function prefersShare(scope = globalThis) {
  if (typeof scope?.matchMedia !== "function") return false;
  try {
    return Boolean(scope.matchMedia("(pointer: coarse)")?.matches);
  } catch {
    return false;
  }
}

function tryDownload(text, filename, mime, scope) {
  const doc = scope?.document;
  if (!doc) return false;
  const BlobCtor = scope.Blob || globalThis.Blob;
  const urlApi = scope.URL || globalThis.URL;
  if (!BlobCtor || !urlApi?.createObjectURL) return false;
  const blob = new BlobCtor([text], { type: mime });
  const url = urlApi.createObjectURL(blob);
  const anchor = doc.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器来不及取字节，1 秒后回收
  const timer = setTimeout(() => urlApi.revokeObjectURL(url), 1000);
  // Node 里跑测试时不要因为这个定时器把进程拖住 1 秒；浏览器返回 number，无 unref
  timer?.unref?.();
  return true;
}

async function tryShare(text, filename, mime, scope) {
  const FileCtor = scope?.File || globalThis.File;
  if (typeof FileCtor !== "function") return { ok: false, reason: "no_file" };
  const file = new FileCtor([text], filename, { type: mime });
  try {
    // 同步调用，不插 await —— 手势窗口
    await scope.navigator.share({ files: [file], title: filename });
    return { ok: true };
  } catch (error) {
    const name = error?.name || "";
    // 用户在分享面板点取消，是他不想存，不是失败；也不能顺手降级去下载
    if (name === "AbortError") return { ok: false, reason: "canceled" };
    return { ok: false, reason: name || "share_failed" };
  }
}

/**
 * 保存一段文本为文件。**在点击事件的同步栈里调用**（share 需要手势）。
 *
 * @returns {Promise<{via:"share"|"download"|"none"|"canceled", filename:string, bytes:number}>}
 */
export async function saveTextFile({
  text = "",
  filename = "subtitles.srt",
  mime = "text/plain;charset=utf-8",
  scope = globalThis,
} = {}) {
  const bytes = byteLength(text);
  const payload = String(text ?? "");
  const shareReady = canShareFiles(scope);
  const shareFirst = prefersShare(scope);
  const canDownload = Boolean(scope?.document);

  const useDownload = async () => {
    if (canDownload && tryDownload(payload, filename, mime, scope)) {
      return { via: "download", filename, bytes };
    }
    return null;
  };

  const order = shareFirst ? ["share", "download"] : ["download", "share"];
  for (const step of order) {
    if (step === "share") {
      if (!shareReady) continue;
      const result = await tryShare(payload, filename, mime, scope);
      if (result.ok) return { via: "share", filename, bytes };
      if (result.reason === "canceled") return { via: "canceled", filename, bytes };
      continue; // 分享失败就继续往下走，不能让用户白点一次
    }
    if (step === "download") {
      const saved = await useDownload();
      if (saved) return saved;
    }
  }
  return { via: "none", filename, bytes };
}

/** 保存结果 → 一句人话。文案要区分"存到哪了"，否则用户不知道下一步去哪找。 */
export function describeSaveResult(result, { sizeText = "" } = {}) {
  const name = result?.filename || "字幕文件";
  const size = sizeText ? `（${sizeText}）` : "";
  switch (result?.via) {
    case "share":
      return `已打开系统分享：${name}${size}。选「存储到文件」或发送到微信即可。`;
    case "download":
      return `已保存 ${name}${size}。手机上通常在「文件 → 下载」里。`;
    case "canceled":
      return `已取消保存。字幕仍在编辑器里，没有丢失。`;
    default:
      return `当前浏览器不支持保存文件。字幕已在编辑器中，可以用「复制结果」带走。`;
  }
}
