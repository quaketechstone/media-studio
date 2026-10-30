/**
 * DOCX 生成器（零依赖）。
 *
 * 只做一件事：把 Markdown 转成 Word 能打开的 .docx。
 * 不引 docx 库的理由很简单——产出只需要"能被 Word/WPS/Google Docs 正常打开并保留
 * 标题层级、列表、表格"，为这点需求引入几百 KB 依赖不划算；而 OOXML 的最小可用
 * 子集是固定且稳定的（[Content_Types] + _rels + document.xml）。
 *
 * 实现约束：
 * - ZIP 只用 store（不压缩）：省掉 deflate 实现，体积对文档来说完全可接受；
 * - 文件名写 UTF-8 标志位（0x0800），否则中文名在 Windows 上会乱码；
 * - 表格列宽固定为均分，不做自动布局——自动布局在 WPS 里表现不一致。
 */
import { parseBlocks, inlineToPlain } from "../markdown.js";

// ---------------------------------------------------------------- ZIP (store)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const stamp = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: stamp };
}

/** @param {{name:string,data:string|Uint8Array}[]} entries */
export function zipStore(entries, now = new Date()) {
  const encoder = new TextEncoder();
  const { time, date } = dosTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true); // UTF-8 文件名
    view.setUint16(8, 0, true); // store
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    local.set(name, 30);

    chunks.push(local, data);
    central.push({ name, crc, size: data.length, offset });
    offset += local.length + data.length;
  }

  const directory = [];
  let directorySize = 0;
  for (const entry of central) {
    const header = new Uint8Array(46 + entry.name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, time, true);
    view.setUint16(14, date, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.size, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint32(42, entry.offset, true);
    header.set(entry.name, 46);
    directory.push(header);
    directorySize += header.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, central.length, true);
  endView.setUint16(10, central.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);

  const total = offset + directorySize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, ...directory, end]) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------- OOXML

function escapeXml(text) {
  return String(text)
    // 控制字符会让 Word 直接报"文件已损坏"，必须剔掉
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function run(text, { bold = false, size = 22, mono = false, color = null } = {}) {
  const props = [
    `<w:rFonts w:ascii="${mono ? "Consolas" : "Calibri"}" w:hAnsi="${
      mono ? "Consolas" : "Calibri"
    }" w:eastAsia="等线" w:hint="eastAsia"/>`,
  ];
  if (bold) props.push("<w:b/>");
  if (color) props.push(`<w:color w:val="${color}"/>`);
  props.push(`<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`);

  const body = String(text)
    .split("\n")
    .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join("<w:br/>");
  return `<w:r><w:rPr>${props.join("")}</w:rPr>${body}</w:r>`;
}

function paragraph(content, { after = 120, before = 0, indent = 0, shading = null, border = false, style = null } = {}) {
  const props = [`<w:spacing w:before="${before}" w:after="${after}" w:line="300" w:lineRule="auto"/>`];
  // pStyle 必须放在 pPr 第一位，否则部分阅读器（WPS）会忽略
  if (style) props.unshift(`<w:pStyle w:val="${style}"/>`);
  if (indent) props.push(`<w:ind w:left="${indent}"/>`);
  if (shading) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${shading}"/>`);
  if (border) {
    props.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D0D0D0"/></w:pBdr>');
  }
  return `<w:p><w:pPr>${props.join("")}</w:pPr>${content}</w:p>`;
}

const HEADING_SIZE = { 1: 40, 2: 32, 3: 28, 4: 24, 5: 22, 6: 22 };

function tableXml(block) {
  const columns = Math.max(
    block.header.length,
    ...block.rows.map((row) => row.length),
    1,
  );
  const width = Math.floor(9000 / columns);
  const border = ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
    .join("");

  const cell = (text, { header = false, align = null } = {}) => {
    const shading = header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : "";
    const jc = align ? `<w:jc w:val="${align}"/>` : "";
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shading}${jc ? `<w:vAlign w:val="center"/>` : ""}</w:tcPr>${paragraph(
      run(inlineToPlain(text), { bold: header, size: 20 }),
      { after: 0 },
    )}</w:tc>`;
  };

  const headerRow = `<w:tr>${block.header.map((text, index) => cell(text, { header: true, align: block.align[index] })).join("")}</w:tr>`;
  const bodyRows = block.rows
    .map(
      (row) =>
        `<w:tr>${block.header
          .map((_, index) => cell(row[index] ?? "", { align: block.align[index] }))
          .join("")}</w:tr>`,
    )
    .join("");

  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${Array.from(
    { length: columns },
    () => `<w:gridCol w:w="${width}"/>`,
  ).join("")}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>${paragraph("", { after: 60 })}`;
}

function listXml(block, depth = 0, style = {}) {
  const parts = [];
  block.items.forEach((item, index) => {
    const marker = block.ordered ? `${index + 1}. ` : "• ";
    const indent = (style.indent ?? 0) + 360 + depth * 360;
    parts.push(
      paragraph(run(marker + inlineToPlain(item.text), { size: style.size ?? 22, color: style.color ?? null }), {
        after: 40,
        indent,
      }),
    );
    if (item.children?.length) {
      parts.push(listXml({ ordered: item.orderedChildren, items: item.children }, depth + 1, style));
    }
  });
  return parts.join("");
}

function blocksXml(blocks, style = {}) {
  const size = style.size ?? 22;
  const color = style.color ?? null;
  const indent = style.indent ?? 0;

  return blocks
    .map((block) => {
      switch (block.type) {
        case "heading":
          return paragraph(
            run(inlineToPlain(block.text), { bold: true, size: HEADING_SIZE[block.level] || 22, color }),
            // 同时带 pStyle 与直接格式：pStyle 让 Word 导航窗格识别大纲，
            // 直接格式保证即便样式表被裁剪也还是标题的样子
            { before: 240, after: 120, indent, style: `Heading${Math.min(block.level, 6)}` },
          );
        case "hr":
          return paragraph("", { after: 120, indent, border: true });
        case "code": {
          const lines = block.text.split("\n");
          return lines
            .map((line, index) =>
              paragraph(run(line, { mono: true, size: 18, color }), {
                after: index === lines.length - 1 ? 160 : 0,
                indent,
                shading: "F5F5F5",
              }),
            )
            .join("");
        }
        case "quote":
          // 引用是嵌套块：用样式传递缩进与灰色，而不是对生成的 XML 做字符串替换
          // （w:color 属于 rPr，塞进 pPr 会产出非法文档）
          return blocksXml(block.children, { size: Math.min(size, 20), color: "595959", indent: indent + 360 });
        case "list":
          return listXml(block, 0, { size, color, indent });
        case "table":
          return tableXml(block);
        case "paragraph":
          return paragraph(run(inlineToPlain(block.text), { size, color }), { after: 120, indent });
        default:
          return "";
      }
    })
    .join("");
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="等线"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${[1, 2, 3, 4, 5, 6]
  .map(
    (level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${HEADING_SIZE[level]}"/></w:rPr></w:style>`,
  )
  .join("\n")}
</w:styles>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

function coreXml(title, isoDate) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>YouTube Media Studio</dc:creator>
<cp:lastModifiedBy>YouTube Media Studio</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${isoDate}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${isoDate}</dcterms:modified>
</cp:coreProperties>`;
}

/**
 * Markdown → .docx 字节。
 * @param {string} markdown
 * @param {{title?: string, now?: Date}} options
 */
export function markdownToDocx(markdown, { title = "译文", now = new Date() } = {}) {
  const blocks = parseBlocks(markdown);
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocksXml(
    blocks,
  )}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  return zipStore(
    [
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: ROOT_RELS },
      { name: "docProps/core.xml", data: coreXml(title, now.toISOString()) },
      { name: "word/document.xml", data: documentXml },
      { name: "word/_rels/document.xml.rels", data: DOCUMENT_RELS },
      { name: "word/styles.xml", data: STYLES },
    ],
    now,
  );
}
