/**
 * 媒体通道的统一契约。
 *
 * 为什么要有这一层：字幕与下载有两种完全不同的来源——
 *   1. 自建执行器（executor/，yt-dlp + ffmpeg）：唯一能稳定产出成品文件的通道；
 *   2. 用户自己部署的 Invidious 兼容实例：能力取决于实例配置，且随时可能被限流。
 *
 * 这两者不能互相冒充，也不能让 UI 去猜"这个地址背后是什么"。所以每个通道自己
 * 声明 capabilities（逐项布尔），UI 只按声明显隐控件；没声明的能力**不渲染入口**，
 * 而不是渲染出来再报错。
 *
 * 归一化后的数据结构（所有通道必须返回同一形状）：
 *   listTracks   → [{ id, lang, name, kind: "manual"|"auto", url? }]
 *   fetchSubtitle→ { text, format: "srt"|"vtt", cueCount, lang, kind }
 *   resolveFormats → [{ id, label, ext, kind: "video"|"audio", hasAudio, filesize }]
 *   createJob    → { start({onProgress,sink,signal}), cancel() }
 *
 * 注意 `id` 对两种通道含义不同：执行器是 yt-dlp format_id / 字幕轨道 id，
 * 实例是 itag / 字幕地址。跨通道传递 id 没有意义，UI 不要缓存后混用。
 */

export class BackendError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.detail = detail;
  }
}

/** 所有通道共有的空能力表。新增能力时必须同时改这里，避免"忘声明=默认可用"。 */
export function emptyCapabilities() {
  return { metadata: false, subtitles: false, formats: false, download: false };
}

export class MediaBackend {
  constructor({ id, label }) {
    this.id = id;
    this.label = label;
  }

  get capabilities() {
    return emptyCapabilities();
  }

  /** 通道是否具备发起请求的最低条件（地址/令牌齐全）。 */
  get configured() {
    return false;
  }

  async probe() {
    return { ok: false, reason: "未配置" };
  }

  async listTracks() {
    throw new BackendError("not_configured", `「${this.label}」通道未配置，无法获取字幕`);
  }

  async fetchSubtitle() {
    throw new BackendError("not_configured", `「${this.label}」通道未配置，无法获取字幕`);
  }

  async resolveFormats() {
    return { formats: [] };
  }

  createJob() {
    throw new BackendError("not_configured", `「${this.label}」通道未配置，无法下载`);
  }
}
