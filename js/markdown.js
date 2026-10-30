/**
 * 轻量 Markdown 解析与渲染。
 *
 * 为什么自己写而不是引依赖：
 *   1. 只在浏览器里跑，不需要完整 CommonMark；需要的是一组稳定的块级结构
 *      （标题 / 列表 / 表格 / 代码 / 引用），供预览与 DOCX 导出共用同一份 AST；
 *   2. LLM 输出不可信，渲染必须先转义再拼标签，且链接协议要白名单。
 *      第三方渲染器的默认配置经常允许内联 HTML，一旦漏配就是 XSS。
 *
 * 不支持的语法会原样保留为文本，不会静默吞掉内容——宁可显示得朴素，
 * 也不能让用户以为内容丢了。
 */

const BLANK = /^\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
// 结尾的 # 只在前面有空格时才算闭合标记，否则 "## C#" 会被截成 "C"
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
// GFM 只要求每个单元格至少一个 -，写成 -- 的表格很常见，不能判死
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 链接协议白名单。先把控制字符与空白抹掉再判断，
 * 否则 `java\nscript:` 这类变形能绕过朴素的正则检查。
 */
export function isSafeUrl(url, { image = false } = {}) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  const normalized = raw.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
  if (normalized.startsWith("javascript:") || normalized.startsWith("vbscript:")) return false;
  // 连 data:image 也拒绝：SVG 里可以带脚本，预览是直接插进 DOM 的
  if (normalized.startsWith("data:")) return false;
  if (/^[a-z][a-z0-9+.-]*:/.test(normalized)) {
    return normalized.startsWith("http://") || normalized.startsWith("https://") || normalized.startsWith("mailto:");
  }
  return true; // 相对路径、锚点
}

/** 行内渲染：先转义，再把 `code` 抽出来保护，避免其中的 * 被当成强调。 */
export function renderInline(text) {
  let out = escapeHtml(text);
  const codes = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, alt, url) => {
    if (!isSafeUrl(url, { image: true })) return alt;
    return `<img src="${url}" alt="${alt}" loading="lazy">`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, label, url) => {
    if (!isSafeUrl(url)) return label;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  return out.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

/** 行内 Markdown → 纯文本，供 DOCX 等不支持富文本行内的目标使用。 */
export function inlineToPlain(text) {
  return String(text)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1（$2）")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .trim();
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function parseAlign(cells) {
  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

function isBlockStart(line) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line);
}

function parseList(lines, start) {
  const first = lines[start].match(LIST);
  const baseIndent = first[1].replace(/\t/g, "  ").length;
  const ordered = /^\d/.test(first[2]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    if (BLANK.test(lines[i])) {
      // 空行后仍是同层列表项则继续，否则列表结束
      let j = i + 1;
      while (j < lines.length && BLANK.test(lines[j])) j += 1;
      const next = lines[j]?.match(LIST);
      if (!next || next[1].replace(/\t/g, "  ").length < baseIndent) break;
      i = j;
      continue;
    }
    const match = lines[i].match(LIST);
    if (!match) break;
    const indent = match[1].replace(/\t/g, "  ").length;
    if (indent < baseIndent) break;

    if (indent === baseIndent) {
      items.push({ text: match[3], children: [], orderedChildren: false });
      i += 1;
      // 续行：缩进更深的非列表行并入当前项
      while (i < lines.length && !BLANK.test(lines[i]) && !LIST.test(lines[i]) && /^\s{2,}/.test(lines[i])) {
        items[items.length - 1].text += ` ${lines[i].trim()}`;
        i += 1;
      }
      continue;
    }

    const last = items[items.length - 1];
    if (!last) break;
    const nested = parseList(lines, i);
    last.children = nested.items;
    last.orderedChildren = nested.ordered;
    i = nested.next;
  }

  return { items, ordered, next: i };
}

/** Markdown → 块级 AST。预览（HTML）与 DOCX 导出共用，避免两套解析逐渐漂移。 */
export function parseBlocks(source) {
  const lines = String(source).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (BLANK.test(line)) {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1][0];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏（文件结束时越界也无妨）
      blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].match(QUOTE)[1]);
        i += 1;
      }
      blocks.push({ type: "quote", children: parseBlocks(body.join("\n")) });
      continue;
    }

    const listMatch = line.match(LIST);
    if (listMatch) {
      const list = parseList(lines, i);
      blocks.push({ type: "list", ordered: list.ordered, items: list.items });
      i = list.next;
      continue;
    }

    // 表格：当前行含 |，下一行是分隔行
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const header = splitRow(line);
      const align = parseAlign(splitRow(lines[i + 1]));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && !BLANK.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", header, align, rows });
      continue;
    }

    // 段落：连续的非空、非块起始行
    const paragraph = [line.trim()];
    i += 1;
    while (i < lines.length && !BLANK.test(lines[i]) && !isBlockStart(lines[i])) {
      // 段落中途遇到表格分隔行不属于表格，按普通文本并入
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

function renderList(block) {
  const tag = block.ordered ? "ol" : "ul";
  const items = block.items
    .map((item) => {
      const children = item.children?.length
        ? renderList({ ordered: item.orderedChildren, items: item.children })
        : "";
      return `<li>${renderInline(item.text)}${children}</li>`;
    })
    .join("");
  return `<${tag}>${items}</${tag}>`;
}

function renderTable(block) {
  const alignStyle = (index) => (block.align[index] ? ` style="text-align:${block.align[index]}"` : "");
  const head = block.header
    .map((cell, index) => `<th${alignStyle(index)}>${renderInline(cell)}</th>`)
    .join("");
  const body = block.rows
    .map(
      (row) =>
        `<tr>${block.header
          .map((_, index) => `<td${alignStyle(index)}>${renderInline(row[index] ?? "")}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="md-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderBlocks(blocks, options) {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "heading":
          return `<h${block.level}>${renderInline(block.text)}</h${block.level}>`;
        case "hr":
          return "<hr>";
        case "code":
          return `<pre><code${block.lang ? ` class="language-${escapeHtml(block.lang)}"` : ""}>${escapeHtml(
            block.text,
          )}</code></pre>`;
        case "quote":
          return `<blockquote>${renderBlocks(block.children, options)}</blockquote>`;
        case "list":
          return renderList(block);
        case "table":
          return renderTable(block);
        case "paragraph": {
          const html = renderInline(block.text);
          return `<p>${options.breaks ? html.replace(/\n/g, "<br>") : html.replace(/\n/g, " ")}</p>`;
        }
        default:
          return "";
      }
    })
    .join("\n");
}

/**
 * Markdown → HTML 片段。
 * @param {string} source
 * @param {{breaks?: boolean}} options breaks=true 时单换行渲染为 <br>（字幕逐行场景）
 */
export function renderMarkdown(source, { breaks = true } = {}) {
  return renderBlocks(parseBlocks(source), { breaks });
}

/** 渲染结果是否为空（只有空白、没有可显示块）。 */
export function hasVisibleContent(source) {
  return parseBlocks(source).some((block) => {
    if (block.type === "hr") return false;
    if (block.type === "table") return block.header.some((c) => c.trim());
    if (block.type === "list") return block.items.length > 0;
    if (block.type === "quote") return block.children.length > 0;
    return String(block.text || "").trim().length > 0;
  });
}
