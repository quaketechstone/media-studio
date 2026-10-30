/**
 * 纯 JS 核心：`src/subtitle.rs` + `src/segment.rs` 的等价实现。
 *
 * 存在的唯一理由：WASM 未构建或初始化失败时，产品必须**功能完整**地继续工作，
 * 而不是弹一句"降级模式"然后什么都不能用。因此这里不是简化版，是等价版：
 * 同样的解析规则、同样的 5000 字节阈值、同样的贪心切分、同样的错误文案。
 *
 * 一致性由 `tests/integration/parity.test.js` 用同一批样本比对两边输出兜底。
 * 改这里必须同步改 Rust，反之亦然。
 */

const SEGMENT_THRESHOLD = 5000;
const SENTENCE_ENDERS = new Set([".", "!", "?", "。", "！", "？", "…", "‥", "｡", ";"]);

const encoder = new TextEncoder();
export function utf8Len(text) {
  return encoder.encode(text).length;
}

// ---------------------------------------------------------------- 时间戳

export function parseTimestamp(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  const match = s.match(/^(?:(\d+):)?(\d+):(\d+)[,.](\d{3})$/);
  if (!match) return null;
  const [, h, m, sec, ms] = match;
  const hours = Number(h || 0);
  const minutes = Number(m);
  const seconds = Number(sec);
  if (minutes >= 60 || seconds >= 60 || hours > 999) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(ms);
}

const isTimingLine = (line) => line.includes("-->");

function splitTiming(line) {
  const idx = line.indexOf("-->");
  if (idx === -1) return null;
  const start = line.slice(0, idx).trim();
  const right = line.slice(idx + 3).trim();
  const space = right.search(/\s/);
  const end = space === -1 ? right : right.slice(0, space);
  const settings = space === -1 ? null : right.slice(space).trim() || null;
  return { start, end: end.trim(), settings };
}

// ---------------------------------------------------------------- 探测

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export function detectFormat(text, hint) {
  if (hint) return hint;
  const body = stripBom(text);
  if (body.trimStart().slice(0, 6).toUpperCase() === "WEBVTT") return "vtt";
  let sawDot = false;
  for (const line of body.split("\n")) {
    if (!isTimingLine(line)) continue;
    if (line.includes(",")) return "srt";
    sawDot = true;
  }
  return sawDot ? "vtt" : "txt";
}

// ---------------------------------------------------------------- 解析

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitBlocks(text) {
  const blocks = [];
  let current = [];
  let startLine = 1;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      if (current.length) {
        blocks.push({ line: startLine, lines: current });
        current = [];
      }
    } else {
      if (!current.length) startLine = i + 1;
      current.push(line);
    }
  }
  if (current.length) blocks.push({ line: startLine, lines: current });
  return blocks;
}

const fail = (line, message) => {
  throw new Error(line > 0 ? `第 ${line} 行：${message}` : message);
};

export function parseSrt(text) {
  const body = normalizeNewlines(stripBom(text));
  const blocks = splitBlocks(body);
  if (!blocks.length) fail(0, "文件为空或没有任何字幕条目");
  const doc = { format: "srt", cues: [], warnings: [] };

  for (const block of blocks) {
    const lines = block.lines;
    let cursor = 0;
    if (lines.length > 1 && /^\d+$/.test(lines[0].trim()) && isTimingLine(lines[1])) cursor = 1;
    const timing = lines[cursor] ?? "";
    if (!isTimingLine(timing)) fail(block.line, "缺少时间轴行（形如 00:00:01,000 --> 00:00:04,000）");
    const parsed = splitTiming(timing);
    if (!parsed) fail(block.line, "时间轴行格式无效");
    if (parseTimestamp(parsed.start) === null) fail(block.line, `起点时间戳无效：${parsed.start}`);
    if (parseTimestamp(parsed.end) === null) fail(block.line, `终点时间戳无效：${parsed.end}`);
    const cueText = lines.slice(cursor + 1).join("\n");
    if (!cueText.trim()) doc.warnings.push(`第 ${block.line} 行起的字幕条目没有文本内容`);
    doc.cues.push({
      id: cursor === 1 ? lines[0].trim() : null,
      start: parsed.start,
      end: parsed.end,
      settings: parsed.settings,
      text: cueText,
    });
  }
  return doc;
}

export function parseVtt(text) {
  const body = normalizeNewlines(stripBom(text));
  const blocks = splitBlocks(body);
  if (!blocks.length) fail(0, "文件为空或没有任何字幕条目");
  const doc = { format: "vtt", cues: [], warnings: [] };
  const header = blocks.shift();
  if (!header.lines[0].trimStart().toUpperCase().startsWith("WEBVTT")) fail(header.line, "缺少 WEBVTT 头部");
  if (header.lines.length > 1) doc.warnings.push(`已忽略 WEBVTT 头部附加信息（${header.lines.length - 1} 行）`);

  for (const block of blocks) {
    const lines = block.lines;
    const first = lines[0].trimStart().toUpperCase();
    if (first.startsWith("NOTE") || first.startsWith("STYLE") || first.startsWith("REGION")) continue;
    let cursor = 0;
    if (!isTimingLine(lines[0])) {
      if (lines.length < 2) fail(block.line, "字幕块缺少时间轴行");
      cursor = 1;
    }
    const timing = lines[cursor];
    if (!isTimingLine(timing)) fail(block.line, "缺少时间轴行（形如 00:00.000 --> 00:04.000）");
    const parsed = splitTiming(timing);
    if (!parsed) fail(block.line, "时间轴行格式无效");
    if (parseTimestamp(parsed.start) === null) fail(block.line, `起点时间戳无效：${parsed.start}`);
    if (parseTimestamp(parsed.end) === null) fail(block.line, `终点时间戳无效：${parsed.end}`);
    const cueText = lines.slice(cursor + 1).join("\n");
    if (!cueText.trim()) doc.warnings.push(`第 ${block.line} 行起的字幕条目没有文本内容`);
    doc.cues.push({
      id: cursor === 1 ? lines[0].trim() : null,
      start: parsed.start,
      end: parsed.end,
      settings: parsed.settings,
      text: cueText,
    });
  }
  if (!doc.cues.length) fail(0, "没有解析出任何字幕条目");
  return doc;
}

export function parseTxt(text) {
  const body = normalizeNewlines(stripBom(text));
  if (!body.trim()) fail(0, "文件内容为空");
  return { format: "txt", cues: [], text: body, warnings: [] };
}

export function parse(text, hint = "") {
  if (!String(text).trim()) fail(0, "文件内容为空");
  const format = detectFormat(text, hint || null);
  if (format === "srt") return parseSrt(text);
  if (format === "vtt") return parseVtt(text);
  return parseTxt(text);
}

// ---------------------------------------------------------------- 序列化

/** SRT 必须带小时位；VTT 允许 MM:SS.mmm，转 SRT 时补 00:。 */
function toFullForm(ts) {
  const text = String(ts);
  return text.split(":").length === 2 ? `00:${text}` : text;
}

/** 时间戳分隔符按目标格式归一：SRT 逗号、VTT 点号，跨格式导出才合法。 */
function withSeparator(ts, sep) {
  const text = String(ts);
  const idx = Math.max(text.lastIndexOf(","), text.lastIndexOf("."));
  return idx === -1 ? text : `${text.slice(0, idx)}${sep}${text.slice(idx + 1)}`;
}

export function serializeSrt(cues) {
  const body = cues
    .map((cue, i) => `${i + 1}\n${withSeparator(toFullForm(cue.start), ",")} --> ${withSeparator(toFullForm(cue.end), ",")}\n${cue.text}`)
    .join("\n\n");
  return `${body}\n`;
}

export function serializeVtt(cues) {
  let out = "WEBVTT\n\n";
  for (const cue of cues) {
    // SRT 的纯数字序号在 VTT 里没有意义，跨格式导出时丢掉
    if (cue.id && !/^\d+$/.test(cue.id)) out += `${cue.id}\n`;
    out += `${withSeparator(cue.start, ".")} --> ${withSeparator(cue.end, ".")}`;
    if (cue.settings) out += ` ${cue.settings}`;
    out += `\n${cue.text}\n\n`;
  }
  return out;
}

export function serialize(doc, format = "") {
  const target = format || doc.format;
  if (target === "srt") return serializeSrt(doc.cues || []);
  if (target === "vtt") return serializeVtt(doc.cues || []);
  if (typeof doc.text === "string") return doc.text;
  return (doc.cues || []).map((c) => c.text).join("\n");
}

// ---------------------------------------------------------------- 分段

const endsSentence = (text) => {
  const trimmed = String(text).replace(/\s+$/, "");
  return trimmed.length > 0 && SENTENCE_ENDERS.has(trimmed[trimmed.length - 1]);
};

function groupUnits(weights, sentenceEnds, target) {
  const len = weights.length;
  if (!len) return [];
  const n = Math.min(Math.max(target, 3), 5, len);
  if (n <= 1) return [[0, len - 1]];

  const total = weights.reduce((a, b) => a + b, 0);
  const targetBytes = Math.ceil(total / n);
  const groups = [];
  let start = 0;
  let acc = 0;

  for (let i = 0; i < len; i += 1) {
    const remainingUnits = len - i;
    const remainingGroups = n - groups.length;
    const mustCut = i > start && remainingUnits === remainingGroups;
    const overflow = i > start && acc + weights[i] > targetBytes;
    const hardOverflow = i > start && acc + weights[i] > targetBytes + Math.floor(targetBytes / 4);
    const afterSentence = i > start && sentenceEnds[i - 1];

    if (mustCut || (overflow && (afterSentence || hardOverflow))) {
      groups.push([start, i - 1]);
      start = i;
      acc = 0;
      if (groups.length + 1 === n) break;
    }
    acc += weights[i];
  }
  groups.push([start, len - 1]);

  while (groups.length < n) {
    let largest = -1;
    let largestCount = 1;
    for (let i = 0; i < groups.length; i += 1) {
      const count = groups[i][1] - groups[i][0] + 1;
      if (count >= 2 && count > largestCount) {
        largest = i;
        largestCount = count;
      }
    }
    if (largest === -1) break;
    const [s, e] = groups[largest];
    const mid = s + Math.floor(largestCount / 2);
    groups.splice(largest, 1, [s, mid - 1], [mid, e]);
  }
  return groups;
}

const cueBlockLen = (cue, index) =>
  utf8Len(cue.text) + utf8Len(cue.start) + utf8Len(cue.end) + String(index).length + 8;

export function segment(doc, target) {
  const totalBytes = utf8Len(serialize(doc));
  const warnings = [];

  if (doc.format === "txt") {
    const body = doc.text || "";
    if (!body) return { mode: "full", total_bytes: totalBytes, unit_count: 0, segments: [], warnings };
    if (totalBytes < SEGMENT_THRESHOLD) {
      return {
        mode: "full",
        total_bytes: totalBytes,
        unit_count: 1,
        segments: [{ start: 0, end: 0, text: body, bytes: utf8Len(body), sentences: 1 }],
        warnings,
      };
    }
    const paragraphs = splitInclusiveNewline(body);
    const weights = paragraphs.map((p) => utf8Len(p));
    const ends = paragraphs.map(endsSentence);
    const groups = groupUnits(weights, ends, target);
    const segments = groups.map(([s, e]) => {
      const text = paragraphs.slice(s, e + 1).join("");
      return { start: s, end: e, text, bytes: utf8Len(text), sentences: 0 };
    });
    return { mode: "segmented", total_bytes: totalBytes, unit_count: paragraphs.length, segments, warnings };
  }

  const cues = doc.cues || [];
  if (!cues.length) return { mode: "full", total_bytes: totalBytes, unit_count: 0, segments: [], warnings };
  if (totalBytes < SEGMENT_THRESHOLD) {
    const text = serialize(doc);
    const sentences = cues.filter((c) => endsSentence(c.text)).length;
    return {
      mode: "full",
      total_bytes: totalBytes,
      unit_count: cues.length,
      segments: [{ start: 0, end: cues.length - 1, text, bytes: utf8Len(text), sentences }],
      warnings,
    };
  }

  const weights = cues.map((c, i) => cueBlockLen(c, i + 1));
  const ends = cues.map((c) => endsSentence(c.text));
  const groups = groupUnits(weights, ends, target);
  const segments = groups.map(([s, e]) => {
    const sliceDoc = { format: doc.format, cues: cues.slice(s, e + 1), warnings: [] };
    const text = serialize(sliceDoc);
    const sentences = cues.slice(s, e + 1).filter((c) => endsSentence(c.text)).length;
    return { start: s, end: e, text, bytes: utf8Len(text), sentences };
  });

  const covered = segments.reduce((sum, s) => sum + (s.end - s.start + 1), 0);
  if (covered !== cues.length) warnings.push(`分段覆盖条目数 ${covered} 与总数 ${cues.length} 不一致`);
  const want = Math.min(Math.max(target, 3), 5);
  if (segments.length < want) {
    warnings.push(`目标 ${want} 段，实际 ${segments.length} 段（受字幕条目数与句末边界限制）`);
  }
  return { mode: "segmented", total_bytes: totalBytes, unit_count: cues.length, segments, warnings };
}

function splitInclusiveNewline(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out.filter((s) => s.length);
}

/**
 * 合并译文。
 * 第二个参数既可以传分段计划对象，也可以传目标段数——传数字时内部重新分段，
 * 与 WASM 侧 `apply_translations(doc, target, ...)` 的签名保持一致
 * （两套核心的调用方式必须一样，否则切换核心就会静默出错）。
 */
export function applyTranslations(doc, planOrTarget, translations, format) {
  const seg = typeof planOrTarget === "number" ? segment(doc, planOrTarget) : planOrTarget;
  const out = { ...doc, cues: (doc.cues || []).map((c) => ({ ...c })) };
  const warnings = [];

  if (doc.format === "txt" || !out.cues.length) {
    const joined = translations.filter((t) => t && t.trim()).join("\n");
    out.text = joined.trim() ? joined : doc.text || "";
    return { document: out, warnings };
  }

  seg.segments.forEach((segment, i) => {
    const raw = translations[i];
    const span = segment.end - segment.start + 1;
    if (raw === undefined) {
      warnings.push(`第 ${i + 1} 段缺少译文，已保留原文`);
      return;
    }
    if (!raw.trim()) {
      warnings.push(`第 ${i + 1} 段译文为空，已保留原文`);
      return;
    }
    let parsed;
    try {
      parsed = parse(raw, format);
    } catch (error) {
      if (span === 1) {
        out.cues[segment.start].text = raw.trim();
        warnings.push(`第 ${i + 1} 段译文不是合法字幕结构，已按纯文本写入`);
      } else {
        warnings.push(`第 ${i + 1} 段译文无法解析（${error.message}），已保留原文`);
      }
      return;
    }
    if (parsed.cues.length === span) {
      parsed.cues.forEach((cue, offset) => {
        out.cues[segment.start + offset].text = cue.text;
      });
    } else {
      warnings.push(
        `第 ${i + 1} 段译文有 ${parsed.cues.length} 条，原文 ${span} 条，时间轴无法一一对应，已保留原文`,
      );
    }
  });
  return { document: out, warnings };
}

export const core = {
  engine: "js",
  parseSubtitles: parse,
  serializeSubtitles: (doc, format = "") => serialize(doc, format),
  segmentSubtitles: segment,
  applyTranslations,
  utf8ByteLen: utf8Len,
  coreVersion: () => "0.1.0-js",
};

export { SEGMENT_THRESHOLD };
