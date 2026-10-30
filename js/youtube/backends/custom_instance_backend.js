/**
 * 用户自建 Invidious 兼容实例通道（默认关闭）。
 *
 * 取舍说明（写在这里，避免以后有人"顺手"把公共实例加回来）：
 *   - 不预置任何公共实例。公共实例的存活、限流、内容完整性都不受控，
 *     而且会把用户的视频 ID 和 IP 交给第三方，这与本项目的隐私立场冲突。
 *   - 只允许用户填自己部署的地址；地址保存在 localStorage，不上报。
 *   - 该通道的能力完全取决于实例配置：有的实例关掉了字幕、有的不给直链、
 *     有的对 CORS 做了限制。所以每一项能力都要靠实测失败来暴露，不能假设。
 *
 * 安全约束（本文件的两条硬规则）：
 *   1. 所有返回的地址都要先归一成绝对 URL，再校验 origin 与本实例一致——
 *      否则实例被控时可以把请求指向任意域。
 *   2. 字幕正文只当文本处理，不拼 HTML（渲染在 app.js 用 textContent）。
 *
 * v1.0.0 之前这里还有第三条规则（不经 googlevideo 直链下载视频），随视频下载一起移除。
 */

import { MediaBackend, BackendError } from "./base.js";
import { parseJson3, cuesToSrt } from "../subtitles.js";
import { withTimeout } from "../net.js";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * 校验并归一实例地址。返回 {ok, url, reason}，UI 与后端共用同一套规则，
 * 避免"界面放行、请求时才报错"。
 */
export function parseInstanceUrl(raw, { pageProtocol = "" } = {}) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, url: "", reason: "未填写实例地址" };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, url: "", reason: "地址格式不合法（需要以 http:// 或 https:// 开头）" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, url: "", reason: "只支持 http/https 地址" };
  }
  if (url.username || url.password) {
    return { ok: false, url: "", reason: "请不要把账号密码写进地址" };
  }
  const localhost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (pageProtocol === "https:" && url.protocol === "http:" && !localhost) {
    return { ok: false, url: "", reason: "HTTPS 页面无法访问 HTTP 实例（浏览器会按混合内容拦截）" };
  }
  // 归一：去掉 query/hash，去掉尾部斜杠，其余路径保留（实例可能挂在子路径下）
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${url.origin}${path}`, reason: "" };
}

/** 把实例返回的相对地址归一，并强制同源。跨源一律拒绝，不做"善意放行"。 */
export function resolveSameOrigin(pathOrUrl, base) {
  const origin = new URL(base).origin;
  let resolved;
  try {
    resolved = new URL(String(pathOrUrl || ""), `${base}/`);
  } catch {
    throw new BackendError("bad_url", "实例返回的地址不合法");
  }
  if (resolved.origin !== origin) {
    throw new BackendError("cross_origin", "实例返回了跨域地址，已拒绝请求");
  }
  return resolved.toString();
}

const AUTO_LABEL_RE = /auto[\s-]?generated|自动生成|自動生成/i;

export class CustomInstanceBackend extends MediaBackend {
  constructor({ baseUrl = "", fetchImpl, timeoutMs = 8000, pageProtocol = "" } = {}) {
    const parsed = parseInstanceUrl(baseUrl, { pageProtocol });
    super({ id: "custom", label: "自建实例" });
    this.baseUrl = parsed.ok ? parsed.url : "";
    this.reason = parsed.ok ? "" : parsed.reason;
    this.fetchImpl = (fetchImpl || globalThis.fetch).bind(globalThis);
    this.timeoutMs = timeoutMs;
    this.cached = null; // { videoId, payload, at }
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  get capabilities() {
    // 实例能不能做事，只有它自己知道；这里声明的是"本通道具备这条代码路径"，
    // 真实可用性由 probe() 与逐次请求的失败来暴露。
    const on = this.configured;
    return { metadata: on, subtitles: on };
  }

  async probe() {
    if (!this.configured) return { ok: false, reason: this.reason || "未配置实例地址" };
    try {
      const body = await this.#json("/api/v1/stats", { timeoutMs: 4000 });
      return { ok: true, version: body?.version || "", software: "invidious" };
    } catch (error) {
      return { ok: false, reason: error.message || "连接失败" };
    }
  }

  async #json(path, { timeoutMs = this.timeoutMs, signal } = {}) {
    if (!this.configured) throw new BackendError("not_configured", this.reason || "未配置实例地址");
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        signal: withTimeout(signal, timeoutMs),
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      if (error?.name === "TimeoutError") throw new BackendError("timeout", "实例响应超时");
      if (error?.name === "AbortError") throw new BackendError("canceled", "已取消");
      throw new BackendError("network", "连不上该实例，请检查地址与网络", error?.message);
    }
    if (response.status === 401 || response.status === 403) {
      throw new BackendError("unauthorized", "实例要求认证，或拒绝了这个请求");
    }
    if (response.status === 429) {
      throw new BackendError("rate_limited", "实例正在限流，请稍后再试");
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code = body?.error ? "upstream_error" : "http";
      throw new BackendError(code, body?.error || `实例返回 HTTP ${response.status}`);
    }
    if (!body) throw new BackendError("bad_response", "实例返回的不是 JSON");
    return body;
  }

  async #video(videoId) {
    if (!VIDEO_ID_RE.test(String(videoId || ""))) {
      throw new BackendError("bad_video", "视频 ID 不合法");
    }
    if (this.cached && this.cached.videoId === videoId && Date.now() - this.cached.at < 60000) {
      return this.cached.payload;
    }
    const payload = await this.#json(`/api/v1/videos/${videoId}`);
    this.cached = { videoId, payload, at: Date.now() };
    return payload;
  }

  async listTracks({ videoId }) {
    const payload = await this.#video(videoId);
    const captions = Array.isArray(payload?.captions) ? payload.captions : [];
    return captions.map((caption, index) => {
      const name = caption.label || caption.languageCode || `字幕 ${index + 1}`;
      return {
        id: caption.url || `${caption.languageCode || "und"}-${index}`,
        lang: caption.languageCode || "",
        name,
        kind: AUTO_LABEL_RE.test(name) ? "auto" : "manual",
        url: caption.url ? resolveSameOrigin(caption.url, this.baseUrl) : "",
      };
    });
  }

  /** 逐字判定正文格式：不靠扩展名，也不靠 URL 里的 fmt 参数（实例可能改写）。 */
  static detectSubtitleFormat(text) {
    const head = String(text || "").replace(/^\uFEFF/, "").trimStart();
    if (/^WEBVTT/i.test(head)) return "vtt";
    if (head.startsWith("{")) return "json3";
    if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/m.test(head)) return "srt";
    return "";
  }

  async fetchSubtitle({ videoId, trackId }) {
    const trackUrl = trackId || "";
    const url = resolveSameOrigin(trackUrl, this.baseUrl);
    let response;
    try {
      response = await this.fetchImpl(url, { signal: withTimeout(undefined, this.timeoutMs) });
    } catch (error) {
      if (error?.name === "TimeoutError") throw new BackendError("timeout", "字幕请求超时");
      throw new BackendError("network", "字幕请求失败，请检查实例与网络", error?.message);
    }
    if (response.status === 429) throw new BackendError("rate_limited", "实例正在限流，请稍后再试");
    if (!response.ok) throw new BackendError("http", `字幕请求失败（HTTP ${response.status}）`);
    const raw = await response.text();
    if (!raw.trim()) throw new BackendError("empty", "该字幕轨道返回了空内容");

    const format = CustomInstanceBackend.detectSubtitleFormat(raw);
    if (format === "json3") {
      const cues = parseJson3(raw);
      if (!cues.length) throw new BackendError("empty", "字幕内容为空（轨道存在但没有文本）");
      return { text: cuesToSrt(cues), format: "srt", cueCount: cues.length, lang: "", kind: "" };
    }
    if (!format) {
      // 既不认识又不像字幕：大概率是实例返回了 HTML 错误页，绝不能当字幕存下来
      throw new BackendError("unsupported", "实例返回的内容不是 SRT/VTT 字幕");
    }
    return { text: raw, format, cueCount: null, lang: "", kind: "" };
  }
}
