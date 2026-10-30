/**
 * 字幕获取与格式归一。
 *
 * 为什么优先要 json3：自动生成字幕在 VTT 里是一串"滚动窗口"——同一句话会以递增的
 * 前缀重复出现十几次，直接塞进编辑器就是一堆重复行。json3 是结构化的（每条 event 带
 * 起止毫秒和 segs），能先合并再转字幕文本，得到的 cue 才和人工字幕一样干净。
 *
 * 本文件不做任何网络假设：executor 怎么实现是它的事，这里只认契约。
 */

import { MetadataError } from "./metadata.js";
import { withTimeout } from "./net.js";

/** 把毫秒转成 SRT 时间戳 `HH:MM:SS,mmm`。 */
export function msToSrtTime(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** 去掉内联样式标签（`<c.colorE5E5E5>`、`<00:00:01.234>` 这类）。 */
function stripTags(text) {
  return text.replace(/<[^>]*>/g, "");
}

/** 合并自动字幕的滚动重复：相邻且文本相同或互为前缀，只保留最长的那条。 */
export function mergeRollingCues(cues) {
  const out = [];
  for (const cue of cues) {
    const last = out[out.length - 1];
    if (last && last.text === cue.text) {
      last.end = Math.max(last.end, cue.end);
      continue;
    }
    if (last && cue.text.length > last.text.length && cue.text.startsWith(last.text)) {
      // 自动字幕逐字增长：用更长的那条覆盖，起点保持原来那句的开始时间
      last.text = cue.text;
      last.end = cue.end;
      continue;
    }
    if (last && last.text.startsWith(cue.text)) {
      last.end = Math.max(last.end, cue.end);
      continue;
    }
    out.push({ ...cue });
  }
  return out;
}

/**
 * 解析 YouTube `json3` 字幕。
 * 结构：{ events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
 */
export function parseJson3(payload) {
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;
  const events = Array.isArray(data?.events) ? data.events : [];
  const cues = [];
  for (const event of events) {
    const segs = Array.isArray(event?.segs) ? event.segs : null;
    if (!segs) continue;
    const text = decodeEntities(stripTags(segs.map((seg) => seg?.utf8 || "").join("")))
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text === "\n") continue;
    const start = Number(event.tStartMs) || 0;
    const duration = Number(event.dDurationMs) || 0;
    // 没有时长的 event 在自动字幕里是"窗口终点"，跳过可以避免零长度 cue
    if (duration <= 0) continue;
    cues.push({ start, end: start + duration, text });
  }
  return mergeRollingCues(cues);
}

/** cues → SRT 文本，交给现有的 WASM/JS 核心去解析，不自己建一套文档模型。 */
export function cuesToSrt(cues) {
  return cues
    .map((cue, index) => `${index + 1}\n${msToSrtTime(cue.start)} --> ${msToSrtTime(cue.end)}\n${cue.text}\n`)
    .join("\n");
}

export class SubtitlesError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = "SubtitlesError";
    this.code = code;
    this.detail = detail;
  }
}

/** executor 返回的错误码 → 人话。不要把所有失败都说成"网络错误"。 */
const MESSAGES = {
  no_captions: "该视频没有可用的字幕轨道（既无原生字幕也无自动生成字幕）",
  captions_disabled: "该视频的字幕被上传者关闭",
  age_restricted: "该视频有年龄限制，需要登录状态才能读取字幕",
  members_only: "该视频仅限频道会员观看，无法读取字幕",
  geo_blocked: "该视频在当前地区不可用",
  upstream_blocked: "YouTube 拒绝了服务端请求（常见于机房 IP），需要更换出口或在本地运行执行器",
  upstream_unreachable: "执行器连不上 YouTube（网络不可达或被 DNS 拦截），请检查执行器所在机器的网络",
  unsupported: "执行器不支持这个视频的字幕格式",
  not_configured: "尚未配置媒体执行器，无法获取字幕",
};

export function describeSubtitleError(code, fallback) {
  return MESSAGES[code] || fallback || "获取字幕失败";
}


export class ExecutorSubtitleClient {
  constructor({ baseUrl, fetchImpl, token = "" } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token;
    this.fetch = (fetchImpl || globalThis.fetch).bind(globalThis);
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  #headers(extra = {}) {
    return this.token ? { ...extra, Authorization: `Bearer ${this.token}` } : extra;
  }

  async #json(path, init = {}, { timeoutMs = 60000 } = {}) {
    if (!this.configured) {
      throw new SubtitlesError(describeSubtitleError("not_configured"), "not_configured");
    }
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: withTimeout(init.signal, timeoutMs),
        headers: this.#headers({ "Content-Type": "application/json", ...(init.headers || {}) }),
      });
    } catch (error) {
      throw new SubtitlesError("无法连接媒体执行器，请检查服务是否在运行", "network", error?.message);
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const code = body?.code || (response.status === 404 ? "no_captions" : "http");
      throw new SubtitlesError(describeSubtitleError(code, body?.message), code, `HTTP ${response.status}`);
    }
    return body;
  }

  /** @returns {Promise<Array<{id:string,lang:string,name:string,kind:"manual"|"auto",isTranslatable:boolean}>>} */
  async listTracks({ videoId, url }) {
    const body = await this.#json(
      `/tracks?v=${encodeURIComponent(videoId)}&url=${encodeURIComponent(url || "")}`,
    );
    const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
    return tracks.map((track) => ({
      id: track.id || `${track.lang}-${track.kind || "manual"}`,
      lang: track.lang || track.language || "",
      name: track.name || track.lang || "未知语言",
      kind: track.kind === "auto" || track.automatic ? "auto" : "manual",
      isTranslatable: Boolean(track.isTranslatable),
    }));
  }

  /** 取字幕正文并转成 SRT 文本，可直接喂给核心解析。 */
  async fetchAsSrt({ videoId, url, trackId }) {
    const body = await this.#json("/subtitles", {
      method: "POST",
      body: JSON.stringify({ videoId, url, trackId, format: "json3" }),
    });
    const format = String(body?.format || "json3").toLowerCase();
    const content = String(body?.content || "");
    if (!content.trim()) {
      throw new SubtitlesError(describeSubtitleError("no_captions"), "no_captions");
    }
    if (format === "json3") {
      const cues = parseJson3(content);
      if (!cues.length) {
        throw new SubtitlesError("字幕内容为空（轨道存在但没有文本），可能是自动字幕尚未生成", "empty");
      }
      return { srt: cuesToSrt(cues), cueCount: cues.length, lang: body.lang || "", kind: body.kind || "" };
    }
    // executor 直接给了 srt/vtt：原样交给核心解析，但先确认不是空壳
    return { srt: content, cueCount: null, lang: body.lang || "", kind: body.kind || "" };
  }
}

/** 供 health 检查用：executor 是否在线、带不带 yt-dlp。 */
export async function probeExecutor(baseUrl, { fetchImpl, timeoutMs = 4000 } = {}) {
  const doFetch = (fetchImpl || globalThis.fetch).bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(`${String(baseUrl).replace(/\/+$/, "")}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const body = await response.json().catch(() => ({}));
    return { ok: true, version: body.version || "", ytDlp: body.yt_dlp || body.ytDlp || "" };
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "超时" : "连接失败" };
  } finally {
    clearTimeout(timer);
  }
}

export { MetadataError };
