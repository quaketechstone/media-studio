/**
 * Media Provider：视频/字幕/下载能力的抽象层。
 *
 * 本仓库**不包含** YouTube 提取器：不绕过签名、DRM、CORS 和访问控制。
 * 真正的解析能力必须来自你被授权使用的外部 Media Executor（见 docs/MEDIA-EXECUTOR.md）。
 * 没有配置 executor 时这里会明确报错，UI 不会伪造标题、封面或分辨率。
 */
import { normalizeError } from "../lib/llm-module/errors.js";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtube-nocookie.com",
  "music.youtube.com",
]);

export function normalizeYouTubeUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error("请输入有效 URL");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("仅支持 HTTP/HTTPS 链接");
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) throw new Error("链接域名不是受支持的 YouTube 域名");

  let videoId = "";
  if (host === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0] || "";
  } else if (url.pathname === "/watch") {
    videoId = url.searchParams.get("v") || "";
  } else {
    const match = url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,})/);
    videoId = match?.[1] || "";
  }
  if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) throw new Error("无法从链接中识别视频 ID");
  return { url: url.toString(), videoId };
}

export const DownloadState = {
  PENDING: "pending",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  CANCELED: "canceled",
};

/** 真实 executor 的 HTTP 实现，契约见 docs/MEDIA-EXECUTOR.md。 */
export class HttpMediaProvider {
  isMock = false;
  label = "Media Executor";

  constructor({ baseUrl = "", fetchImpl } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    // 同 LLM provider：window.fetch 必须绑定接收者，否则浏览器抛 Illegal invocation
    this.fetch = (fetchImpl || globalThis.fetch).bind(globalThis);
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  #requireBase() {
    if (!this.baseUrl) {
      throw new Error("尚未配置 Media Executor 地址（MEDIA_API_BASE），无法解析真实视频");
    }
  }

  async #json(path, body, { signal } = {}) {
    this.#requireBase();
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw normalizeError(error);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 400);
      throw new Error(`Media Executor HTTP ${response.status}：${detail || "无响应体"}`);
    }
    return response.json();
  }

  async resolve(input, options = {}) {
    const parsed = normalizeYouTubeUrl(input);
    const data = await this.#json("/resolve", parsed, options);
    if (!data?.video || !Array.isArray(data.subtitles) || !Array.isArray(data.formats)) {
      throw new Error("Media Executor 响应缺少 video / subtitles / formats 字段");
    }
    return data;
  }

  async subtitles(videoId, trackId, options = {}) {
    const data = await this.#json("/subtitles", { videoId, trackId }, options);
    if (typeof data?.content !== "string") throw new Error("字幕接口未返回 content 字符串");
    return data.content;
  }

  async formats(videoId, options = {}) {
    const data = await this.#json("/formats", { videoId }, options);
    return Array.isArray(data?.formats) ? data.formats : [];
  }

  /** 创建下载任务；进度、取消、状态由 DownloadTask 统一处理。 */
  createDownload({ videoId, formatId, signal, onProgress }) {
    this.#requireBase();
    return new DownloadTask({
      start: () =>
        this.fetch(`${this.baseUrl}/download`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId, formatId }),
          signal,
        }),
      onProgress,
      fallbackName: `${videoId}-${formatId}`,
    });
  }
}

/**
 * Mock Provider：仅供 UI 与接口联调。
 * 数据带 `mock: true`，界面必须显示"演示数据"横幅——绝不冒充真实解析结果。
 */
export class MockMediaProvider {
  isMock = true;
  label = "Mock 演示数据";
  configured = true;

  async resolve(input = "https://www.youtube.com/watch?v=dQw4w9WgXcQ") {
    const { videoId } = normalizeYouTubeUrl(input);
    return {
      mock: true,
      video: {
        id: videoId,
        title: "【演示数据】示例视频标题，不是真实解析结果",
        thumbnail: "",
        viewCount: "—",
        duration: "03:32",
      },
      subtitles: [{ id: "demo-zh", language: "中文", kind: "manual", name: "演示字幕" }],
      formats: [{ id: "demo-720", label: "720p（演示）", resolution: "720p", type: "progressive" }],
    };
  }

  async subtitles() {
    const lines = [
      "这是演示字幕的第一句。",
      "第二句用来验证导入与翻译流程。",
      "第三句包含数字 123 和 English words.",
      "第四句用于检查时间轴是否被保留。",
    ];
    return (
      lines
        .map((text, i) => {
          const start = String(i * 3).padStart(2, "0");
          const end = String(i * 3 + 2).padStart(2, "0");
          return `${i + 1}\n00:00:${start},000 --> 00:00:${end},900\n${text}`;
        })
        .join("\n\n") + "\n"
    );
  }

  async formats() {
    return [{ id: "demo-720", label: "720p（演示）", resolution: "720p", type: "progressive" }];
  }

  createDownload() {
    return new DownloadTask({
      start: async () => {
        throw new Error("演示 Provider 不提供真实下载，请配置 Media Executor 后再试");
      },
      fallbackName: "demo",
    });
  }
}

/** 下载任务：串起状态、进度、取消、错误，与 UI 解耦，便于单测。 */
export class DownloadTask {
  constructor({ start, onProgress, fallbackName = "download" }) {
    this.startFn = start;
    this.onProgress = onProgress;
    this.fallbackName = fallbackName;
    this.state = DownloadState.PENDING;
    this.received = 0;
    this.total = 0;
    this.error = "";
    this.filename = fallbackName;
    this.controller = new AbortController();
    this.blob = null;
  }

  cancel() {
    if (this.state === DownloadState.RUNNING || this.state === DownloadState.PENDING) {
      this.controller.abort();
      this.state = DownloadState.CANCELED;
      return true;
    }
    return false;
  }

  async run() {
    this.state = DownloadState.RUNNING;
    try {
      const response = await this.startFn();
      if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
      this.total = Number(response.headers.get("content-length")) || 0;
      this.filename = parseFilename(response.headers.get("content-disposition")) || this.fallbackName;

      if (!response.body) {
        this.blob = await response.blob();
        this.received = this.blob.size;
      } else {
        const reader = response.body.getReader();
        const chunks = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          this.received += value.byteLength;
          this.onProgress?.({ received: this.received, total: this.total });
        }
        this.blob = new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
      }
      this.state = DownloadState.DONE;
      return this.blob;
    } catch (error) {
      if (this.controller.signal.aborted) {
        this.state = DownloadState.CANCELED;
        this.error = "已取消";
      } else {
        this.state = DownloadState.FAILED;
        this.error = error.message;
      }
      throw error;
    }
  }
}

export function parseFilename(header) {
  if (!header) return "";
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      return utf8[1];
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : "";
}

/** 未配置 executor 且未启用 mock 时返回 null，UI 据此显示"未接入真实解析"状态。 */
export function createMediaProvider({ baseUrl = "", mock = false, fetchImpl } = {}) {
  if (mock) return new MockMediaProvider();
  if (baseUrl) return new HttpMediaProvider({ baseUrl, fetchImpl });
  return null;
}
