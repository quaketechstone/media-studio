/**
 * 统一的「来源文件」入口：字幕、文档、纯文本都从这里进。
 *
 * 之前只认 .srt/.vtt/.txt，导出一个 Word 或 PDF 稿子就没法翻译。这里把
 * 「文件 → 可直接交给核心的文本 + 格式提示」这段拆出来，规则是：
 *
 *   1. 已知文本格式 → 解码（UTF-8/UTF-16/GBK）后按类型处理；
 *   2. 字幕变体（ASS/SSA/LRC）→ 先转成 SRT 再交给核心，核心不扩语法；
 *   3. HTML → 提取可见文本（保留段落换行，剔除脚本样式）；
 *   4. DOCX/PDF → 走 file_context 的真实提取；
 *   5. 未知扩展名 → 先当文本试，二进制才拒绝（不要用扩展名白名单把用户挡在门外）。
 *
 * 一条硬规则：**不把文件名当内容**。提取不到文本就明确报错，不生成空文档。
 */
import { decodeText, looksBinary } from "./subtitle_io.js";
import { extractFile } from "./file_context.js";

export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

const SUBTITLE_EXT = new Set(["srt", "vtt", "ass", "ssa", "lrc"]);
const DOCUMENT_EXT = new Set([
  "txt", "text", "md", "markdown", "html", "htm", "json", "csv", "tsv",
  "log", "xml", "yaml", "yml", "ini", "conf", "rst", "adoc", "org", "tex",
]);
const BINARY_EXT = new Set(["doc", "xls", "ppt", "pages", "key", "numbers", "rtf", "epub", "mobi"]);
const MEDIA_EXT = new Set(["mp4", "mkv", "mov", "webm", "mp3", "m4a", "wav", "flac", "ogg"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "heic"]);

export function extensionOf(name = "") {
  return (String(name).split(".").pop() || "").toLowerCase();
}

/** 文件类型判定。`kind` 只用于给出正确的错误信息，不决定后续解析路径。 */
export function classifySource(file) {
  const ext = extensionOf(file.name);
  if (SUBTITLE_EXT.has(ext)) return { kind: "subtitle", ext };
  if (DOCUMENT_EXT.has(ext)) return { kind: "document", ext };
  if (ext === "docx" || ext === "pdf") return { kind: "binary-document", ext };
  if (MEDIA_EXT.has(ext)) {
    return { kind: "unsupported", ext, reason: "这是音视频文件，请用「导入本地视频 / 音频」预览，字幕请单独提供" };
  }
  if (IMAGE_EXT.has(ext)) {
    return { kind: "unsupported", ext, reason: "图片请放在「辅助参考资料」里，由支持视觉的模型读取" };
  }
  if (BINARY_EXT.has(ext)) {
    return { kind: "unsupported", ext, reason: `.${ext} 是二进制办公格式，请另存为 .docx 或 .pdf 后再导入` };
  }
  return { kind: "unknown", ext };
}

// ---------------------------------------------------------------- 格式转换

const pad = (value) => String(value).padStart(2, "0");

/** ASS/SSA 时间轴 `0:00:01.00` → SRT `00:00:01,000`（ASS 用百分秒）。 */
function assTime(value) {
  const match = String(value).trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!match) return null;
  const fraction = (match[4] + "00").slice(0, 3);
  return `${pad(match[1])}:${pad(match[2])}:${pad(match[3])},${fraction}`;
}

/**
 * 按字段数切分 Dialogue 行。
 * 最后一个字段（Text）本身可以含逗号，所以只切前 count-1 个逗号——
 * 用 split(",") 会把台词从逗号处截断，这是处理 ASS 最常见的错误。
 */
function splitAssFields(payload, count) {
  const fields = [];
  let rest = payload;
  for (let i = 0; i < count - 1; i += 1) {
    const index = rest.indexOf(",");
    if (index === -1) break;
    fields.push(rest.slice(0, index));
    rest = rest.slice(index + 1);
  }
  fields.push(rest);
  return fields;
}

function cleanAssText(text) {
  return text
    .replace(/\{[^}]*\}/g, "") // 覆盖标签 {\i1} 之类
    .replace(/\\[Nn]/g, " ") // 硬换行压成空格，保持一条一行
    .replace(/\\h/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** ASS/SSA → SRT。支持 Format 行自定义字段顺序（不同压制组写法不同）。 */
export function assToSrt(source) {
  const lines = String(source).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let inEvents = false;
  let format = null;
  const cues = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[events\]$/i.test(trimmed)) {
      inEvents = true;
      continue;
    }
    if (/^\[.+\]$/.test(trimmed)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(trimmed)) {
      format = trimmed.slice(trimmed.indexOf(":") + 1).split(",").map((part) => part.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(trimmed)) continue;

    const payload = trimmed.slice(trimmed.indexOf(":") + 1);
    const count = Math.max(format?.length || 0, 10);
    const fields = splitAssFields(payload, count);
    const index = (name, fallback) => {
      const found = format ? format.indexOf(name) : -1;
      return found >= 0 ? found : fallback;
    };
    const start = assTime(fields[index("start", 1)] ?? "");
    const end = assTime(fields[index("end", 2)] ?? "");
    const textIndex = format ? format.length - 1 : fields.length - 1;
    const text = cleanAssText(fields[textIndex] ?? "");
    if (start && end && text) cues.push({ start, end, text });
  }

  return cues
    .map((cue, i) => `${i + 1}\n${cue.start} --> ${cue.end}\n${cue.text}`)
    .join("\n\n")
    .concat(cues.length ? "\n" : "");
}

const LRC_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** LRC 歌词 → SRT。一行多个时间标签会展开成多条；结束时间取下一条开始。 */
export function lrcToSrt(source) {
  const entries = [];
  for (const line of String(source).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")) {
    const tags = [...line.matchAll(LRC_TAG)];
    if (!tags.length) continue;
    const text = line.replace(LRC_TAG, "").trim();
    if (!text) continue;
    for (const tag of tags) {
      // LRC 标签是 [分:秒.百分秒]，不是 [时:分:秒]——把 tag[1] 当时会秒变分钟
      const seconds = Number(tag[1]) * 60 + Number(tag[2]) + (tag[3] ? Number(`0.${tag[3]}`) : 0);
      entries.push({ seconds, text });
    }
  }
  entries.sort((a, b) => a.seconds - b.seconds);
  if (!entries.length) return "";

  const stamp = (seconds) => {
    const total = Math.max(0, seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = Math.floor(total % 60);
    const ms = Math.round((total - Math.floor(total)) * 1000);
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${String(ms).padStart(3, "0")}`;
  };

  return entries
    .map((entry, i) => {
      const next = entries[i + 1];
      const end = next ? next.seconds : entry.seconds + 4;
      return `${i + 1}\n${stamp(entry.seconds)} --> ${stamp(end)}\n${entry.text}`;
    })
    .join("\n\n")
    .concat("\n");
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ",
  mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", middot: "·",
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/** HTML → 可见文本：剔除脚本样式，块级标签转换行，表格单元格用制表符分隔。 */
export function htmlToText(html) {
  const text = String(html)
    .replace(/^\uFEFF/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<\/(p|div|section|article|header|footer|h[1-6]|li|tr|blockquote|pre|dd|dt)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<hr\b[^>]*>/gi, "\n---\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------- 统一入口

/**
 * 读一个来源文件。
 * @returns {Promise<{text:string, hint:string, kind:string, ext:string, encoding:string,
 *   bytes:number, converted:boolean, warnings:string[]}>}
 */
export async function extractSource(file) {
  const { kind, ext, reason } = classifySource(file);
  if (kind === "unsupported") throw new Error(`${file.name}：${reason}`);
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(
      `${file.name} 超过 ${Math.round(MAX_SOURCE_BYTES / 1024 / 1024)} MB，请拆分后再导入（整篇读进内存会拖死标签页）`,
    );
  }

  if (kind === "binary-document") {
    const item = await extractFile(file);
    const text = (item.text || "").trim();
    if (!text) throw new Error(`${file.name} 里没有提取到文本`);
    const warnings = [...(item.warnings || [])];
    warnings.push(
      ext === "pdf"
        ? "PDF 只提取文本层，表格与图片不保留；扫描件需要先 OCR"
        : "DOCX 只提取文字，表格会按行拼接，样式不保留",
    );
    return { text, hint: "txt", kind: "document", ext, encoding: "—", bytes: file.size, converted: true, warnings };
  }

  const buffer = await file.arrayBuffer();
  const decoded = decodeText(new Uint8Array(buffer));
  let text = decoded.text;
  const warnings = [...decoded.warnings];

  if (looksBinary(text)) {
    throw new Error(`${file.name} 看起来是二进制文件，无法作为文本导入`);
  }

  let hint = "txt";
  let converted = false;

  if (ext === "vtt") {
    hint = "vtt";
  } else if (ext === "srt") {
    hint = "srt";
  } else if (ext === "ass" || ext === "ssa") {
    text = assToSrt(text);
    if (!text) throw new Error(`${file.name} 里没有解析到任何 Dialogue 行，可能不是 ASS/SSA 字幕`);
    hint = "srt";
    converted = true;
    warnings.push("ASS/SSA 已转换为 SRT：样式、定位与特效不保留，文本与时间轴保留");
  } else if (ext === "lrc") {
    text = lrcToSrt(text);
    if (!text) throw new Error(`${file.name} 里没有带时间标签的歌词行`);
    hint = "srt";
    converted = true;
    warnings.push("LRC 已转换为 SRT：结束时间按下一句开始推算，最后一句按 4 秒计");
  } else if (ext === "html" || ext === "htm") {
    text = htmlToText(text);
    if (!text) throw new Error(`${file.name} 里没有可见文本`);
    converted = true;
    warnings.push("HTML 已提取为纯文本：标题、列表、表格的文字保留，样式与脚本丢弃");
  } else if (kind === "unknown") {
    if (!text.trim()) throw new Error(`${file.name} 没有可导入的文本内容`);
    warnings.push(`未识别的扩展名${ext ? ` .${ext}` : ""}，按纯文本导入`);
  }

  if (!text.trim()) throw new Error(`${file.name} 是空文件`);

  return {
    text,
    hint,
    kind: hint === "txt" ? "document" : "subtitle",
    ext,
    encoding: decoded.label,
    bytes: file.size,
    converted,
    warnings,
  };
}
