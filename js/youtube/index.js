/**
 * YouTube 能力的组合层。app.js 只跟这里打交道，不直接碰下面的实现模块。
 *
 * 能力分开暴露，任何一个都没有"用一个冒充另一个"的余地：
 *   - embed     官方嵌入预览（纯前端，一定能用）
 *   - metadata  标题/作者/封面（oEmbed，纯前端）
 *   - local     本地媒体导入与预览（objectURL，纯前端）
 *   - notes     笔记素材导出（纯前端）
 *   - subtitles / download（必须执行器，未配置时明确为 false）
 *
 * 零后端路径（local / notes / 字幕文件导入）与执行器路径互不依赖：前者失效不会
 * 影响后者，反之亦然。UI 应该逐项显示，而不是用一句"需要执行器"概括整块。
 */

import { parseYouTubeUrl, tryParseYouTubeUrl, parseStartSeconds } from "./url.js";
import { fetchMetadata, formatDuration, thumbnailCandidates, MetadataError } from "./metadata.js";
import { YouTubePlayer, buildEmbedUrl } from "./player.js";
import {
  ExecutorSubtitleClient,
  SubtitlesError,
  probeExecutor,
  parseJson3,
  cuesToSrt,
  mergeRollingCues,
  describeSubtitleError,
} from "./subtitles.js";
import {
  ExecutorDownloadClient,
  ExecutorDownloadJob,
  DownloadError,
  DownloadPhase,
  downloadStream,
  filenameFromDisposition,
  saveBlob,
  describeDownloadError,
} from "./download.js";
import {
  LocalMediaSession,
  MediaError,
  MAX_LOCAL_BYTES,
  classifyMedia,
  validateMedia,
  describeMedia,
  compatibilityHint,
  probeMedia,
} from "./local_media.js";
import {
  SOURCE_LABELS,
  isKnownSource,
  buildProvenance,
  describeProvenance,
  provenanceCaveat,
} from "./subtitle_source.js";
import { NOTES_SCHEMA, buildNotes, serializeNotes, notesFilename, cuesForNotes, segmentsForNotes } from "./notes.js";

export class YouTubeService {
  constructor({ baseUrl = "", token = "", fetchImpl } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.subtitles = new ExecutorSubtitleClient({ baseUrl: this.baseUrl, token, fetchImpl });
    this.downloads = new ExecutorDownloadClient({ baseUrl: this.baseUrl, token, fetchImpl });
    this.fetchImpl = fetchImpl;
    this.lastVideo = null;
  }

  /** 能力矩阵：UI 据此决定显示"可用"还是"需要配置执行器"。 */
  get capabilities() {
    return {
      embed: true,
      metadata: true,
      // 零后端能力：与环境无关，永远为 true
      local: true,
      notes: true,
      subtitles: this.subtitles.configured,
      download: this.downloads.configured,
    };
  }

  parse(link) {
    return parseYouTubeUrl(link);
  }

  tryParse(link) {
    return tryParseYouTubeUrl(link);
  }

  /** 解析 + 取元数据。元数据失败不阻断预览：预览只需要 videoId。 */
  async resolve(link, { timeoutMs = 8000 } = {}) {
    const parsed = parseYouTubeUrl(link);
    let meta = null;
    let metaError = null;
    try {
      meta = await fetchMetadata(parsed.videoId, { fetchImpl: this.fetchImpl, timeoutMs });
    } catch (error) {
      metaError = { message: error.message, code: error.code || "unknown" };
    }
    this.lastVideo = { ...parsed, meta, metaError };
    return this.lastVideo;
  }

  mountPlayer(container, { videoId, start = 0, onStateChange } = {}) {
    const player = new YouTubePlayer(container, { videoId, start, onStateChange });
    player.mount();
    return player;
  }

  async listTracks(video) {
    return this.subtitles.listTracks({ videoId: video.videoId, url: video.canonicalUrl });
  }

  async loadSubtitles(video, trackId) {
    return this.subtitles.fetchAsSrt({
      videoId: video.videoId,
      url: video.canonicalUrl,
      trackId,
    });
  }

  async resolveFormats(video) {
    return this.downloads.resolveFormats(video.canonicalUrl);
  }

  createDownloadJob(video, { mode = "video", formatId = "", lang = "" } = {}) {
    return new ExecutorDownloadJob(this.downloads, {
      url: video.canonicalUrl,
      videoId: video.videoId,
      mode,
      formatId,
      lang,
    });
  }

  async probe() {
    if (!this.baseUrl) return { ok: false, reason: "未配置 media-api-base" };
    return probeExecutor(this.baseUrl, { fetchImpl: this.fetchImpl });
  }
}

export {
  parseYouTubeUrl,
  tryParseYouTubeUrl,
  parseStartSeconds,
  fetchMetadata,
  formatDuration,
  thumbnailCandidates,
  YouTubePlayer,
  buildEmbedUrl,
  parseJson3,
  cuesToSrt,
  mergeRollingCues,
  downloadStream,
  filenameFromDisposition,
  saveBlob,
  DownloadPhase,
  describeDownloadError,
  describeSubtitleError,
  MetadataError,
  SubtitlesError,
  DownloadError,
  // 零后端能力：本地媒体、来源标注、笔记素材
  LocalMediaSession,
  MediaError,
  MAX_LOCAL_BYTES,
  classifyMedia,
  validateMedia,
  describeMedia,
  compatibilityHint,
  probeMedia,
  SOURCE_LABELS,
  isKnownSource,
  buildProvenance,
  describeProvenance,
  provenanceCaveat,
  NOTES_SCHEMA,
  buildNotes,
  serializeNotes,
  notesFilename,
  cuesForNotes,
  segmentsForNotes,
};
