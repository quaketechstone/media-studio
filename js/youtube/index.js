/**
 * YouTube 能力的组合层。app.js 只跟这里打交道，不直接碰下面的实现模块。
 *
 * v1.0.0 起，项目的定位是**字幕下载器**。能力分成两类：
 *   - 零后端：embed / metadata / 字幕文件导入 / 粘贴 / 解析编辑 / 导出保存——永远可用
 *   - 通道相关：subtitles（在线字幕抓取）——取决于当前媒体通道
 *
 * 视频与音频下载（含执行器的流式下载任务、sink 落盘、测速）已整体移除：
 * 产品不再承诺"下载视频"，保留它的 UI 会误导用户，保留它的代码会让每个改动
 * 都要考虑一条我们已经不做承诺的路径。详见 CHANGELOG 1.0.0 与 docs/GAPS.md。
 *
 * 通道层（backends/）是 v0.4.0 抽出来的：默认走自建执行器，用户可在高级设置里
 * 换成自己部署的 Invidious 兼容实例。两种通道实现同一个 MediaBackend 契约，
 * UI 只读 capabilities，不关心背后是谁。
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
  SOURCE_LABELS,
  isKnownSource,
  buildProvenance,
  describeProvenance,
  provenanceCaveat,
} from "./subtitle_source.js";
import { NOTES_SCHEMA, buildNotes, serializeNotes, notesFilename, cuesForNotes, segmentsForNotes } from "./notes.js";
import {
  buildSubtitleCommand,
  describeCommandResult,
  CommandError,
  SUBTITLE_SCOPES,
  SUBTITLE_FORMATS,
  DEFAULT_LANGS,
} from "./cli.js";
import {
  subtitleFilename,
  saveTextFile,
  saveBinaryFile,
  canShareFiles,
  describeSaveResult,
  ShareError,
} from "./share.js";
import { MediaBackend, BackendError, emptyCapabilities } from "./backends/base.js";
import { ExecutorBackend } from "./backends/executor_backend.js";
import { CustomInstanceBackend, parseInstanceUrl, resolveSameOrigin } from "./backends/custom_instance_backend.js";

export class YouTubeService {
  constructor({ baseUrl = "", token = "", fetchImpl, backendId = "executor", instanceUrl = "" } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.executor = new ExecutorBackend({ baseUrl: this.baseUrl, token, fetchImpl });
    this.custom = null;
    this.backendId = "executor";
    this.lastVideo = null;
    this.lastTracks = [];

    // 兼容旧字段：这个客户端曾被 app.js 之外的代码直接引用
    this.subtitles = this.executor.subtitles;

    if (instanceUrl) this.setBackend(backendId, { instanceUrl });
  }

  /** 当前生效的通道对象。永远返回 MediaBackend 的实现，不会返回 null。 */
  get backend() {
    if (this.backendId === "custom" && this.custom) return this.custom;
    return this.executor;
  }

  /**
   * 切通道。实例地址不合法时**不切换**并返回原因，避免出现"切过去了但用不了"
   * 这种需要用户自己猜的状态。
   */
  setBackend(id, { instanceUrl = "", pageProtocol = "" } = {}) {
    if (id === "custom") {
      const parsed = parseInstanceUrl(instanceUrl, { pageProtocol });
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      this.custom = new CustomInstanceBackend({
        baseUrl: parsed.url,
        fetchImpl: this.fetchImpl,
        pageProtocol,
      });
      this.backendId = "custom";
      this.lastTracks = [];
      return { ok: true, url: parsed.url };
    }
    this.backendId = "executor";
    this.lastTracks = [];
    return { ok: true };
  }

  /**
   * 能力矩阵：UI 据此决定显示"可用"还是"需要配置"。
   * 只有 subtitles 来自通道；零后端能力与环境无关，永远为 true。
   */
  get capabilities() {
    const caps = this.backend?.capabilities || emptyCapabilities();
    return {
      embed: true,
      metadata: true,
      notes: true,
      subtitles: Boolean(caps.subtitles),
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
    const tracks = await this.backend.listTracks({ videoId: video.videoId, url: video.canonicalUrl });
    this.lastTracks = tracks;
    return tracks;
  }

  async loadSubtitles(video, trackId) {
    const track = (this.lastTracks || []).find((item) => item.id === trackId);
    // 通道自己知道 id 的含义（执行器是轨道 id，实例是字幕地址）；这里只负责传
    return this.backend.fetchSubtitle({
      videoId: video.videoId,
      url: video.canonicalUrl,
      trackId: track?.url || trackId,
      track,
    });
  }

  async probe() {
    return this.backend.probe();
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
  describeSubtitleError,
  MetadataError,
  SubtitlesError,
  // 通道层
  MediaBackend,
  BackendError,
  emptyCapabilities,
  ExecutorBackend,
  CustomInstanceBackend,
  parseInstanceUrl,
  resolveSameOrigin,
  // 零后端：生成本机字幕下载命令（--skip-download，不发任何请求）
  buildSubtitleCommand,
  describeCommandResult,
  SUBTITLE_SCOPES,
  SUBTITLE_FORMATS,
  DEFAULT_LANGS,
  CommandError,
  // 字幕文件导出：手机走系统分享，桌面走下载
  subtitleFilename,
  saveTextFile,
  saveBinaryFile,
  canShareFiles,
  describeSaveResult,
  ShareError,
  // 来源标注与笔记素材
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
  ExecutorSubtitleClient,
};
