/**
 * 笔记素材导出：把"视频 + 字幕 + 时间轴 + 分段计划"打包成一个稳定的 JSON。
 *
 * 定位：这是**素材**，不是成品笔记。后续的 WASM 分段、翻译、摘要引擎直接吃
 * 这个结构，不需要再从 DOM 里刮文本。字段一旦发布就不要随意改名，
 * 外部脚本会依赖它，所以带 schema 版本号。
 *
 * 三条不伪造原则：
 *   1. 没有的东西就是 null，不写空字符串、不写 0 冒充"有数据"；
 *   2. 译文条数与字幕条数不一致时整体丢弃并给出 warning，宁可没有也不能错位；
 *   3. 时间轴同时保留原始字符串与秒数——字符串是可读真相，秒数是给播放器定位用的。
 */

import { parseTimestamp } from "../fallback_core.js";

export const NOTES_SCHEMA = "youtube-media-studio/notes@1";

function toSeconds(raw) {
  const ms = parseTimestamp(String(raw ?? ""));
  return ms == null ? null : ms / 1000;
}

function textBytes(text) {
  if (typeof text !== "string" || !text) return null;
  return new TextEncoder().encode(text).length;
}

/** 字幕条目 → 笔记条目。index 从 1 开始，和 SRT 编号、UI 里的"第 N 条"对齐。 */
export function cuesForNotes(cues = []) {
  return cues.map((cue, i) => ({
    index: i + 1,
    start: cue.start ?? null,
    end: cue.end ?? null,
    startSeconds: toSeconds(cue.start),
    endSeconds: toSeconds(cue.end),
    text: cue.text ?? "",
  }));
}

/**
 * 分段计划 → 笔记段落。不重复携带 text（cues 里已有），只记单元下标与时间范围，
 * 消费方用 unitStart/unitEnd 去 cues 里切片即可。
 */
export function segmentsForNotes(plan, cues = []) {
  if (!plan?.segments?.length) return [];
  return plan.segments.map((seg, i) => {
    const first = cues[seg.start];
    const last = cues[seg.end];
    return {
      index: i + 1,
      unitStart: seg.start,
      unitEnd: seg.end,
      units: seg.end - seg.start + 1,
      bytes: seg.bytes ?? null,
      sentences: seg.sentences ?? null,
      start: first?.start ?? null,
      end: last?.end ?? null,
      startSeconds: first ? toSeconds(first.start) : null,
      endSeconds: last ? toSeconds(last.end) : null,
    };
  });
}

export function buildNotes({
  video = null,
  provenance = null,
  doc = null,
  sourceText = "",
  plan = null,
  translations = null,
  localMedia = null,
  engine = null,
  exportedAt = new Date(),
} = {}) {
  const warnings = [];
  const cues = doc?.cues?.length ? cuesForNotes(doc.cues) : [];
  const when = exportedAt instanceof Date ? exportedAt : new Date(exportedAt);

  if (!cues.length) warnings.push("没有字幕内容，导出的是不含时间轴的素材");
  if (cues.length && !video) warnings.push("字幕不是从 YouTube 链接载入的，视频字段为空");
  if (video && !cues.length) warnings.push("只有视频信息，没有字幕内容");

  let translation = null;
  if (Array.isArray(translations) && translations.length) {
    if (!cues.length) {
      warnings.push("有译文但没有字幕，译文已忽略");
    } else if (translations.length !== cues.length) {
      warnings.push(`译文 ${translations.length} 条与字幕 ${cues.length} 条不一致，已忽略以免错位`);
    } else {
      translation = {
        count: translations.length,
        entries: translations.map((text, i) => ({ index: i + 1, text: String(text ?? "") })),
      };
    }
  }

  const segments = segmentsForNotes(plan, doc?.cues || []);
  if (doc && !segments.length) warnings.push("缺少分段计划，只有字幕原文");

  return {
    schema: NOTES_SCHEMA,
    exportedAt: when.toISOString(),
    generator: {
      app: "YouTube Media Studio",
      engine: engine || null,
    },
    video: video
      ? {
          id: video.videoId || null,
          url: video.canonicalUrl || null,
          title: video.meta?.title ?? null,
          author: video.meta?.author ?? null,
          startSeconds: Number(video.start || 0),
        }
      : null,
    provenance: provenance || null,
    subtitle: cues.length
      ? {
          format: doc?.format || "",
          cueCount: cues.length,
          bytes: textBytes(sourceText),
          warnings: doc?.warnings || [],
          cues,
        }
      : null,
    plan: segments.length
      ? {
          mode: plan.mode || null,
          totalBytes: plan.total_bytes ?? null,
          unitCount: plan.unit_count ?? null,
          segmentCount: segments.length,
          segments,
        }
      : null,
    translation,
    localMedia: localMedia || null,
    warnings,
  };
}

export function serializeNotes(notes) {
  return JSON.stringify(notes, null, 2);
}

/** 文件名只保留安全字符：videoId 来自 URL，不能直接拼进文件名。 */
export function notesFilename({ videoId = "", at = new Date() } = {}) {
  const d = at instanceof Date ? at : new Date(at);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const safeId = String(videoId || "")
    .replace(/[^\w-]/g, "")
    .slice(0, 16);
  return safeId ? `yt-${safeId}-notes-${stamp}.json` : `media-notes-${stamp}.json`;
}
