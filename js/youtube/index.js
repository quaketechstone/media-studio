/**
 * YouTube 能力的组合层。app.js 只跟这里打交道，不直接碰下面四个模块。
 *
 * 三种能力分开暴露，任何一个都没有"用一个冒充另一个"的余地：
 *   - embed    官方嵌入预览（纯前端，一定能用）
 *   - metadata 标题/作者/封面（oEmbed，纯前端）
 *   - subtitles / download（必须执行器，未配置时明确为 false）
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
};
