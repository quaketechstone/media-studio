/**
 * 视频元数据：只走 YouTube 官方 oEmbed，不需要 API Key、不需要服务端。
 *
 * oEmbed 能给：标题、作者、封面。
 * oEmbed 给不了：时长、可用字幕、可下载格式——这些必须另找来源，不要在这里编。
 * 时长由 player.js 通过官方 IFrame API 补，字幕/格式由 executor 提供。
 */

const OEMBED = "https://www.youtube.com/oembed";

export class MetadataError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = "MetadataError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 封面地址候选。YouTube 对不同视频提供的最大尺寸不一样，
 * maxresdefault 对老视频经常是 404，所以要按顺序回退到能用的那张。
 */
export function thumbnailCandidates(videoId) {
  return ["maxresdefault", "sddefault", "hqdefault", "mqdefault"].map(
    (name) => `https://i.ytimg.com/vi/${videoId}/${name}.jpg`,
  );
}

/** 秒 → `12:34` / `1:02:03`；未知返回空串，不显示 `NaN`。 */
export function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return "";
  const s = Math.floor(total % 60);
  const m = Math.floor((total / 60) % 60);
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * @param {string} videoId
 * @param {{fetchImpl?:Function, timeoutMs?:number}} options
 * @returns {Promise<{videoId:string,title:string,author:string,authorUrl:string,thumbnail:string,thumbnailCandidates:string[]}>}
 */
export async function fetchMetadata(videoId, { fetchImpl, timeoutMs = 8000 } = {}) {
  const doFetch = (fetchImpl || globalThis.fetch).bind(globalThis);
  const endpoint = `${OEMBED}?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`,
  )}&format=json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await doFetch(endpoint, { signal: controller.signal, credentials: "omit" });
  } catch (error) {
    const aborted = error?.name === "AbortError";
    throw new MetadataError(
      aborted ? "获取视频信息超时，请检查网络后重试" : "无法连接 YouTube 获取视频信息",
      aborted ? "timeout" : "network",
      error?.message,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404 || response.status === 401 || response.status === 403) {
    throw new MetadataError("视频不存在、已设为私享，或不允许嵌入", "unavailable", `HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new MetadataError(`获取视频信息失败（HTTP ${response.status}）`, "http", `HTTP ${response.status}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new MetadataError("YouTube 返回的内容不是有效 JSON", "parse");
  }
  if (!data || typeof data.title !== "string") {
    throw new MetadataError("YouTube 返回的数据缺少标题", "shape");
  }

  return {
    videoId,
    title: data.title,
    author: data.author_name || "",
    authorUrl: data.author_url || "",
    thumbnail: data.thumbnail_url || thumbnailCandidates(videoId)[2],
    thumbnailCandidates: thumbnailCandidates(videoId),
  };
}
