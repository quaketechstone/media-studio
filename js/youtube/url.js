/**
 * YouTube 链接解析。纯函数，不碰 DOM、不发请求，可在 Node 里直接测。
 *
 * 设计原则：只做"链接 → 视频 ID + 起始时间"，其余能力（元数据、播放、字幕、下载）
 * 各自独立，任何一个失效都不影响其他。
 */

const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/** 视频 ID 固定 11 位；放宽到 6 位是为了兼容历史上出现过的短 ID 形态。 */
const ID_RE = /^[A-Za-z0-9_-]{6,}$/;
/** 标准 11 位 ID，用于校验"这条链接看起来像不像正经 YouTube 链接"。 */
const CANONICAL_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export class YouTubeUrlError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "YouTubeUrlError";
    this.code = code;
  }
}

/**
 * 解析 `t=` / `start=` / `#t=` 这类起始时间。
 * YouTube 支持三种写法：纯秒数（90）、时长串（1h2m3s）、带单位后缀（90s）。
 * 解析不出来就返回 0，不要因为一个可选参数把整条链接判成无效。
 */
export function parseStartSeconds(raw) {
  if (raw === null || raw === undefined) return 0;
  const text = String(raw).trim().toLowerCase();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || (!match[1] && !match[2] && !match[3])) return 0;
  const [, h, m, s] = match;
  return Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0);
}

function pickStart(url) {
  const fromQuery = url.searchParams.get("t") ?? url.searchParams.get("start");
  if (fromQuery) return parseStartSeconds(fromQuery);
  // youtu.be/xxx?t=90 走 query；而 #t=90 在 hash 里，只能手动拆
  const hash = url.hash.replace(/^#/, "");
  if (hash.startsWith("t=") || hash.startsWith("start=")) {
    return parseStartSeconds(hash.split("=")[1]);
  }
  return 0;
}

/**
 * @returns {{videoId:string, start:number, canonicalUrl:string, embedUrl:string, playlistId:string|null}}
 */
export function parseYouTubeUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new YouTubeUrlError("请先粘贴 YouTube 链接", "empty");

  // 允许直接贴 11 位 ID：从地址栏复制时经常只剩这一段
  if (!/[/:.]/.test(raw) && ID_RE.test(raw)) {
    return build(raw, 0, null);
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new YouTubeUrlError("这不是一个有效的链接，请检查是否漏了 https://", "malformed");
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new YouTubeUrlError("只支持 http/https 链接", "protocol");
  }

  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) {
    throw new YouTubeUrlError("这不是 YouTube 链接（仅支持 youtube.com / youtu.be 等官方域名）", "host");
  }

  const start = pickStart(url);
  const playlistId = url.searchParams.get("list");

  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] || "";
    return assertId(id, start, playlistId);
  }

  if (url.pathname === "/watch" || url.pathname === "/watch/") {
    return assertId(url.searchParams.get("v") || "", start, playlistId);
  }

  const pathMatch = url.pathname.match(/^\/(?:embed|shorts|live|v|e)\/([^/?#]+)/);
  if (pathMatch) return assertId(pathMatch[1], start, playlistId);

  // 频道页、播放列表页、首页等都不是单条视频
  throw new YouTubeUrlError(
    "这个链接指向的不是单个视频（首页、频道页、播放列表都不行），请打开具体视频后复制地址",
    "not_a_video",
  );
}

function assertId(id, start, playlistId) {
  if (!ID_RE.test(id)) {
    throw new YouTubeUrlError("链接里没有可识别的视频 ID，请确认复制的是视频地址而不是搜索结果页", "no_id");
  }
  return build(id, start, playlistId);
}

function build(videoId, start, playlistId) {
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const params = new URLSearchParams({ v: videoId });
  if (start > 0) params.set("t", `${start}s`);
  return {
    videoId,
    start,
    canonicalUrl,
    embedUrl: `https://www.youtube.com/embed/${videoId}`,
    playlistId: playlistId || null,
    isCanonicalLength: CANONICAL_ID_RE.test(videoId),
  };
}

/** 给 UI 用：解析失败时返回 {ok:false, message}，不抛异常。 */
export function tryParseYouTubeUrl(input) {
  try {
    return { ok: true, value: parseYouTubeUrl(input) };
  } catch (error) {
    return { ok: false, message: error.message, code: error.code || "unknown" };
  }
}
