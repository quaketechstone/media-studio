/**
 * 字幕来源的唯一真相。
 *
 * 产品里拿到字幕有四种方式，能力和可信度完全不同，必须各自标注、不许互相冒充：
 *   executor  执行器从 YouTube 在线抓取（需要后端；可能因为网络/权限失败）
 *   instance  用户自建的 Invidious 兼容实例抓取（同样需要服务端，但换了一台）
 *   file      用户导入的本地字幕文件（纯前端；内容准确性由用户负责）
 *   paste     用户粘贴的文本（纯前端；同上）
 *
 * provenance 会跟着字幕一路进入笔记导出，回看时能分辨"这段文字是哪来的"。
 * 之前这段对象是手写在 app.js 里的，只覆盖了 executor 一种来源，
 * 导入的文件会被默默当成"来自 YouTube"——这正是要避免的冒充。
 */

export const SOURCE_LABELS = {
  executor: "YouTube 在线字幕",
  instance: "自建实例字幕",
  file: "本地字幕文件",
  paste: "粘贴的文本",
};

export const SOURCE_HINTS = {
  executor: "由媒体执行器抓取，内容与视频时间轴一致",
  instance: "由你配置的实例抓取，内容与视频时间轴一致",
  file: "由本地文件解析，时间轴以文件内容为准",
  paste: "由粘贴文本解析，时间轴以文本内容为准",
};

const KNOWN = new Set(Object.keys(SOURCE_LABELS));

export function isKnownSource(via) {
  return KNOWN.has(String(via || ""));
}

/**
 * 统一来源对象。允许 video 为 null（先导字幕后解析视频），此时视频字段留空而不是编一个。
 */
export function buildProvenance({
  video = null,
  via,
  track = null,
  filename = null,
  cueCount = null,
  at = new Date(),
} = {}) {
  if (!isKnownSource(via)) throw new Error(`未知的字幕来源：${via}`);
  const when = at instanceof Date ? at : new Date(at);
  return {
    schema: "provenance@1",
    via,
    sourceLabel: SOURCE_LABELS[via],
    videoId: video?.videoId || null,
    title: video?.meta?.title || null,
    url: video?.canonicalUrl || null,
    start: Number(video?.start || 0),
    track: via === "executor" || via === "instance" ? track || null : null,
    filename: via === "file" ? filename || null : null,
    cueCount: Number.isInteger(cueCount) ? cueCount : null,
    at: when.toISOString(),
  };
}

/** 一行中文说明，用于状态栏。缺失的字段直接不提，不补"未知"。 */
export function describeProvenance(prov) {
  if (!prov) return "";
  const parts = [prov.sourceLabel];
  if (prov.track) parts.push(prov.track);
  if (prov.filename) parts.push(prov.filename);
  if (prov.cueCount != null) parts.push(`${prov.cueCount} 条`);
  return parts.join(" · ");
}

/** 导入来源的可信提示：让用户知道时间轴是否来自视频本身。 */
export function provenanceCaveat(prov) {
  if (!prov) return "";
  return SOURCE_HINTS[prov.via] || "";
}
