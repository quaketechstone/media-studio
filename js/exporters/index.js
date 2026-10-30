/**
 * 导出编排：字幕格式（SRT/VTT/TXT）与文档格式（MD/HTML/DOCX/PDF）走同一个入口。
 *
 * 两条路径的区别必须说清楚，否则用户会以为"导出的 PDF 和 SRT 是同一份东西"：
 *   - 字幕格式：保留时间轴与序号，能被播放器加载；
 *   - 文档格式：给人读的排版稿，时间轴变成列表项，标题/表格/链接按 Markdown 渲染。
 *
 * PDF 走浏览器打印（`buildPrintableHtml` + 调用方 window.print）。不引 jsPDF：
 * 中文字体子集动辄数 MB，且排版质量不如浏览器自带的打印引擎。
 */
import { renderMarkdown, escapeHtml } from "../markdown.js";
import { markdownToDocx } from "./docx.js";

export const EXPORT_FORMATS = {
  srt: { label: "SRT 字幕", ext: "srt", mime: "application/x-subrip;charset=utf-8", group: "subtitle" },
  vtt: { label: "VTT 字幕", ext: "vtt", mime: "text/vtt;charset=utf-8", group: "subtitle" },
  txt: { label: "TXT 纯文本", ext: "txt", mime: "text/plain;charset=utf-8", group: "subtitle" },
  md: { label: "Markdown", ext: "md", mime: "text/markdown;charset=utf-8", group: "document" },
  html: { label: "HTML 网页", ext: "html", mime: "text/html;charset=utf-8", group: "document" },
  docx: {
    label: "Word 文档",
    ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    group: "binary",
  },
  pdf: { label: "PDF（打印）", ext: "pdf", mime: null, group: "print" },
};

const KNOWN_EXT = /\.(srt|vtt|txt|md|markdown|html?|docx|pdf|ass|ssa|lrc|json|csv)$/i;

export function stemOf(name, fallback = "translated") {
  const base = String(name || "").split(/[\\/]/).pop() || fallback;
  const stem = base.replace(KNOWN_EXT, "").trim();
  return stem || fallback;
}

/** 字幕文档 → Markdown：标题、来源信息、逐条时间轴。 */
export function documentToMarkdown({ doc, title = "译文", source = "", model = "", generatedAt = "" }) {
  const lines = [`# ${title}`, ""];
  const meta = [];
  if (source) meta.push(`来源：${source}`);
  if (model) meta.push(`模型：${model}`);
  if (generatedAt) meta.push(`导出时间：${generatedAt}`);
  if (meta.length) lines.push(...meta.map((item) => `- ${item}`), "");

  const cues = doc?.cues || [];
  if (!cues.length) {
    lines.push("_（没有可导出的条目）_");
    return lines.join("\n");
  }

  lines.push(`共 ${cues.length} 条 · 原始格式 ${String(doc.format || "txt").toUpperCase()}`, "", "---", "");
  for (const cue of cues) {
    const text = String(cue.text || "").replace(/\s*\n\s*/g, " ").trim();
    if (!text) continue;
    const range = cue.start ? `**${cue.start} → ${cue.end}**` : "";
    lines.push(range ? `- ${range}  ${text}` : `- ${text}`);
  }
  return lines.join("\n");
}

/** 无时间轴的纯文本 → Markdown：按空行分段，单换行保留为段内换行。 */
export function plainTextToMarkdown(text, { title = "译文", source = "", model = "", generatedAt = "" } = {}) {
  const body = String(text || "").trim();
  const meta = [];
  if (source) meta.push(`来源：${source}`);
  if (model) meta.push(`模型：${model}`);
  if (generatedAt) meta.push(`导出时间：${generatedAt}`);
  const metaBlock = meta.length ? `${meta.map((item) => `- ${item}`).join("\n")}\n\n` : "";

  // 内容自带标题（导入的 Markdown/HTML 经常如此）时不再叠加文件名标题，
  // 否则导出的文档会出现"# notes"和"# 会议纪要"两个一级标题。
  if (/^#{1,6}\s+\S/.test(body)) {
    const newline = body.indexOf("\n");
    if (newline === -1) return `${body}\n\n${metaBlock}`.trimEnd() + "\n";
    return `${body.slice(0, newline)}\n\n${metaBlock}${body.slice(newline + 1).trimStart()}\n`;
  }

  const header = [`# ${title}`, ""];
  if (metaBlock) header.push(metaBlock.trimEnd(), "", "---", "");
  return `${header.join("\n")}\n${body}\n`;
}

/** 字幕文档 → 纯文本（每条一行，不含时间轴）。 */
export function documentToText(doc) {
  return (doc?.cues || [])
    .map((cue) => String(cue.text || "").trim())
    .filter(Boolean)
    .join("\n");
}

const PRINT_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#1f2328;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif}
article{max-width:820px;margin:0 auto;padding:48px 24px 64px}
h1,h2,h3,h4{line-height:1.3;margin:1.6em 0 .6em;font-weight:650}
h1{font-size:1.9em;margin-top:0}
h2{font-size:1.45em;border-bottom:1px solid #e5e7eb;padding-bottom:.25em}
h3{font-size:1.2em}
p{margin:.8em 0}
ul,ol{padding-left:1.5em;margin:.8em 0}
li{margin:.3em 0}
li>ul,li>ol{margin:.2em 0}
a{color:#0969da;text-decoration:none;border-bottom:1px solid rgba(9,105,218,.3)}
code{background:#f6f8fa;padding:.15em .35em;border-radius:4px;font:.9em/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
pre{background:#f6f8fa;padding:14px 16px;border-radius:8px;overflow:auto;margin:1em 0}
pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.2em 1em;border-left:4px solid #d0d7de;color:#57606a}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.95em}
th,td{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top}
th{background:#f6f8fa;font-weight:600}
img{max-width:100%;height:auto}
hr{border:0;border-top:1px solid #e5e7eb;margin:1.6em 0}
.doc-meta{color:#57606a;font-size:14px;margin:0 0 1.6em;padding:0;list-style:none}
.doc-meta li{margin:.2em 0}
@page{margin:18mm 16mm}
@media print{
  article{max-width:none;padding:0}
  body{font-size:11.5pt}
  a{color:inherit;border-bottom:0}
  h1,h2,h3,h4{page-break-after:avoid}
  table,pre,blockquote,li{page-break-inside:avoid}
  thead{display:table-header-group}
}
`;

/** 完整 HTML 文档（分享 / 打印共用）。body 必须已经过 renderMarkdown 转义。 */
export function buildHtmlDocument({ title = "译文", bodyHtml = "", metaLines = [] }) {
  const meta = metaLines.filter(Boolean).length
    ? `<ul class="doc-meta">${metaLines.filter(Boolean).map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
    : "";
  // meta 插在标题之后：先标题、再来源/模型，符合阅读顺序
  const content = bodyHtml.includes("</h1>")
    ? bodyHtml.replace("</h1>", `</h1>\n${meta}`)
    : `${meta}\n${bodyHtml}`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<article>
${content}
</article>
</body>
</html>`;
}

/** 打印视图：与 HTML 相同，额外带一个"打印"按钮（新窗口里用户可能找不到 Ctrl+P）。 */
export function buildPrintableHtml({ title, bodyHtml, metaLines }) {
  const html = buildHtmlDocument({ title, bodyHtml, metaLines });
  const button = `<button class="no-print" onclick="window.print()">打印 / 另存为 PDF</button>`;
  const extraCss = `<style>.no-print{position:fixed;right:24px;bottom:24px;padding:12px 20px;border:0;border-radius:999px;background:#2563eb;color:#fff;font-size:15px;cursor:pointer;box-shadow:0 6px 20px rgba(37,99,235,.35)}@media print{.no-print{display:none}}</style>`;
  return html
    .replace("</style>", `${extraCss}\n</style>`)
    .replace("<article>", `${button}\n<article>`);
}

function metaLinesFor({ source, model, generatedAt }) {
  return [
    source ? `来源：${source}` : "",
    model ? `模型：${model}` : "",
    generatedAt ? `导出时间：${generatedAt}` : "",
  ];
}

/**
 * 生成一次导出的内容。
 * @returns {{filename:string, mime:string|null, text?:string, bytes?:Uint8Array, printHtml?:string}}
 */
export function buildExport({ format, doc, text, title = "译文", source = "", model = "", now = new Date() }) {
  const spec = EXPORT_FORMATS[format];
  if (!spec) throw new Error(`未知导出格式：${format}`);
  const stem = `${stemOf(source) || "translated"}.translated`;
  const generatedAt = now.toISOString().replace("T", " ").slice(0, 19);
  const hasCues = Boolean(doc?.cues?.length);

  if (spec.group === "subtitle") {
    if (format === "txt") {
      return { filename: `${stem}.txt`, mime: spec.mime, text: hasCues ? documentToText(doc) : String(text || "") };
    }
    // SRT/VTT 由调用方用核心序列化（需要格式转换与时间轴校验），这里只给文件名
    return { filename: `${stem}.${spec.ext}`, mime: spec.mime, text: null };
  }

  const markdown = hasCues
    ? documentToMarkdown({ doc, title, source, model, generatedAt })
    : plainTextToMarkdown(text, { title, source, model, generatedAt });
  const metaLines = metaLinesFor({ source, model, generatedAt });

  if (format === "md") {
    return { filename: `${stem}.md`, mime: spec.mime, text: markdown };
  }
  if (format === "html") {
    return {
      filename: `${stem}.html`,
      mime: spec.mime,
      text: buildHtmlDocument({ title, bodyHtml: renderMarkdown(markdown), metaLines }),
    };
  }
  if (format === "docx") {
    return { filename: `${stem}.docx`, mime: spec.mime, bytes: markdownToDocx(markdown, { title, now }) };
  }
  if (format === "pdf") {
    return {
      filename: `${stem}.pdf`,
      mime: null,
      printHtml: buildPrintableHtml({ title, bodyHtml: renderMarkdown(markdown), metaLines }),
    };
  }
  throw new Error(`未实现的导出格式：${format}`);
}
