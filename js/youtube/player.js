/**
 * 官方嵌入播放器。
 *
 * 一个刻意的设计：**先挂原生 iframe 播放器，再尝试接 IFrame Player API**。
 * 反过来的话，一旦 API 脚本被墙/被广告拦截器拦掉，用户连预览都没有——
 * 而预览本身并不依赖 API，只有"读时长/跳转"依赖。
 *
 * 所以：iframe 一定会出现；API 只是增强。API 不可用时 UI 会如实说"无法读取播放进度"，
 * 不会假装播放在受控状态。
 */

const IFRAME_API_SRC = "https://www.youtube.com/iframe_api";

/** 构造嵌入地址。参数都是有实际作用的，不是凑数。 */
export function buildEmbedUrl({ videoId, start = 0, autoplay = false, origin = "" } = {}) {
  if (!/^[A-Za-z0-9_-]{6,}$/.test(String(videoId || ""))) {
    throw new Error("无效的视频 ID，无法构造播放地址");
  }
  const params = new URLSearchParams({
    enablejsapi: "1",
    playsinline: "1", // iOS 上不加这个，点播放会强制全屏
    rel: "0", // 结束时不要推荐无关视频
    modestbranding: "1",
  });
  if (start > 0) params.set("start", String(Math.floor(start)));
  if (autoplay) params.set("autoplay", "1");
  // origin 只在合法来源下传，否则 YouTube 会拒绝带 origin 的嵌入
  if (origin && origin !== "null" && /^https?:\/\//.test(origin)) params.set("origin", origin);
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

let apiPromise = null;

/**
 * 加载 IFrame API，只加载一次。
 * 超时/失败都返回 false——调用方据此降级，不要抛异常打断预览。
 */
export function loadIframeApi({ timeoutMs = 8000 } = {}) {
  if (globalThis.YT?.Player) return Promise.resolve(true);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    // API 就绪时由它回调全局函数；脚本加载失败时这里永远收不到回调，靠 timeout 兜底
    const previous = globalThis.onYouTubeIframeAPIReady;
    globalThis.onYouTubeIframeAPIReady = () => {
      try {
        previous?.();
      } finally {
        clearTimeout(timer);
        finish(Boolean(globalThis.YT?.Player));
      }
    };

    if (document.querySelector(`script[src="${IFRAME_API_SRC}"]`)) return;
    const script = document.createElement("script");
    script.src = IFRAME_API_SRC;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      finish(false);
    };
    document.head.append(script);
  });
  return apiPromise;
}

export class YouTubePlayer {
  /**
   * @param {HTMLElement} container 播放器挂载点（会被清空）
   * @param {{videoId:string, start?:number, onStateChange?:Function}} options
   */
  constructor(container, { videoId, start = 0, onStateChange } = {}) {
    this.container = container;
    this.videoId = videoId;
    this.start = start;
    this.onStateChange = onStateChange;
    this.iframe = null;
    this.api = null;
    this.apiReady = false;
    this.duration = 0;
  }

  /** 同步挂 iframe：即使后续 API 失败，预览也已经可用。 */
  mount() {
    this.container.replaceChildren();
    const iframe = document.createElement("iframe");
    iframe.src = buildEmbedUrl({ videoId: this.videoId, start: this.start, origin: location.origin });
    iframe.title = "YouTube 视频预览";
    iframe.allow = "accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.loading = "lazy";
    iframe.className = "yt-frame";
    this.container.append(iframe);
    this.iframe = iframe;
    return this;
  }

  /** 增强：接上 IFrame API 以便读时长、跳转。失败不影响已挂好的预览。 */
  async enhance() {
    const ok = await loadIframeApi();
    if (!ok || !this.iframe?.isConnected) return false;
    try {
      this.api = new globalThis.YT.Player(this.iframe, {
        events: {
          onReady: (event) => {
            this.apiReady = true;
            this.duration = Number(event.target.getDuration?.()) || 0;
          },
          onStateChange: (event) => this.onStateChange?.(event.data),
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 跳到指定秒。API 未就绪时返回 false，调用方应忽略而不是报错。 */
  seek(seconds) {
    if (!this.apiReady || !this.api?.seekTo) return false;
    this.api.seekTo(Math.max(0, Number(seconds) || 0), true);
    return true;
  }

  getDuration() {
    if (this.apiReady && this.api?.getDuration) return Number(this.api.getDuration()) || this.duration;
    return this.duration;
  }

  destroy() {
    try {
      this.api?.destroy?.();
    } catch {
      /* 播放器可能已被移除，忽略 */
    }
    this.api = null;
    this.apiReady = false;
    this.container.replaceChildren();
    this.iframe = null;
  }
}
