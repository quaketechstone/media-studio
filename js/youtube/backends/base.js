/**
 * 媒体通道的统一契约。
 *
 * 项目定位是**字幕下载器**：通道只需要回答两件事——能不能取元数据、能不能取字幕。
 * 视频/音频下载在 v1.0.0 被整体移除（原因见 docs/CHANGELOG 与 docs/GAPS.md），
 * 所以这里没有 formats / download 两项能力，UI 也不再有对应的 widgets。
 *
 * 为什么还留两个通道而不是一个：能拿到 YouTube 字幕的路只有两条——
 *   1. 自建执行器（executor/，yt-dlp）：能合并滚动式自动生成字幕、能处理 PO token；
 *   2. 用户自己部署的 Invidious 兼容实例：能力取决于实例配置，且随时可能被限流。
 *
 * 这两者不能互相冒充，也不能让 UI 去猜"这个地址背后是什么"。所以每个通道自己
 * 声明 capabilities（逐项布尔），UI 只按声明显隐控件；没声明的能力**不渲染入口**，
 * 而不是渲染出来再报错。
 *
 * 归一化后的数据结构（所有通道必须返回同一形状）：
 *   listTracks   → [{ id, lang, name, kind: "manual"|"auto", url? }]
 *   fetchSubtitle→ { text, format: "srt"|"vtt", cueCount, lang, kind }
 *
 * 注意 `id` 对两种通道含义不同：执行器是字幕轨道 id，实例是字幕地址。
 * 跨通道传递 id 没有意义，UI 不要缓存后混用。
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
  return { metadata: false, subtitles: false };
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
}
