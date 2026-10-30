/**
 * 辅助参考资料提取：把 TXT / MD / PDF / DOCX / 图片变成真正能进 prompt 的内容。
 *
 * 原则：宁可明确报"不支持"，也不要把文件名当内容塞给模型。
 * - TXT/MD：直接读文本；
 * - DOCX：ZIP 解包后取 word/document.xml，零依赖（浏览器自带 DecompressionStream）；
 * - PDF：动态加载随仓库分发的 pdf.js（体积大，只在真的拖入 PDF 时才下载）；
 * - 图片：走模型的视觉输入，由调用方按 capabilities 决定，未声明能力时明确拒绝。
 */

const MAX_CONTEXT_CHARS = 120000; // 约 40k tokens 量级，超出截断并告警

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json", "log"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

export function classifyFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext) || file.type.startsWith("image/")) return { kind: "image", ext };
  if (TEXT_EXTENSIONS.has(ext)) return { kind: "text", ext };
  if (ext === "docx") return { kind: "docx", ext };
  if (ext === "pdf") return { kind: "pdf", ext };
  if (ext === "doc") return { kind: "unsupported", ext, reason: "旧版 .doc 是二进制格式，请另存为 .docx" };
  return { kind: "unsupported", ext, reason: `不支持的文件类型：${ext || "未知"}` };
}

// ---------------------------------------------------------------- DOCX

function readUint16(view, offset) {
  return view.getUint16(offset, true);
}
function readUint32(view, offset) {
  return view.getUint32(offset, true);
}

/** 解析 ZIP 中央目录，返回 name → Uint8Array 的读取器。只支持 store/deflate（DOCX 只用这两种）。 */
export async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65535; i -= 1) {
    if (readUint32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("不是有效的 ZIP/DOCX 文件（找不到中央目录）");

  const entryCount = readUint16(view, eocd + 10);
  let offset = readUint32(view, eocd + 16);
  const entries = new Map();

  for (let i = 0; i < entryCount; i += 1) {
    if (readUint32(view, offset) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
    const method = readUint16(view, offset + 10);
    const compressedSize = readUint32(view, offset + 20);
    const nameLength = readUint16(view, offset + 28);
    const extraLength = readUint16(view, offset + 30);
    const commentLength = readUint16(view, offset + 32);
    const localOffset = readUint32(view, offset + 42);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    const localNameLength = readUint16(view, localOffset + 26);
    const localExtraLength = readUint16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, { method, data: bytes.subarray(dataStart, dataStart + compressedSize) });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return {
    names: () => [...entries.keys()],
    async text(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      const raw = entry.data;
      if (entry.method === 0) return new TextDecoder("utf-8").decode(raw);
      if (entry.method !== 8) throw new Error(`ZIP 压缩方式 ${entry.method} 不受支持`);
      if (typeof DecompressionStream === "undefined") {
        throw new Error("当前浏览器不支持解压 DOCX（缺少 DecompressionStream）");
      }
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new TextDecoder("utf-8").decode(await new Response(stream).arrayBuffer());
    },
  };
}

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** word/document.xml → 纯文本：段落转换行、制表符保留、跳过删除修订。 */
export function docxXmlToText(xml) {
  return decodeXmlEntities(
    xml
      .replace(/<w:del [\s\S]*?<\/w:del>/g, "")
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:br\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractDocx(buffer) {
  const zip = await unzip(buffer);
  const xml = await zip.text("word/document.xml");
  if (!xml) throw new Error("DOCX 内缺少 word/document.xml，文件可能已损坏");
  const text = docxXmlToText(xml);
  if (!text) throw new Error("DOCX 里没有提取到任何文本");
  return text;
}

// ---------------------------------------------------------------- PDF

let pdfjsPromise = null;

/** 懒加载随仓库分发的 pdf.js（只在真用到时下载 ~1.5MB）。 */
function loadPdfjs() {
  pdfjsPromise ??= import("../vendor/pdfjs/pdf.mjs").then((module) => {
    module.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;
    return module;
  });
  return pdfjsPromise;
}

export async function extractPdf(buffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  const pages = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    let lastY = null;
    let line = "";
    const lines = [];
    for (const item of content.items) {
      const y = item.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line.trimEnd());
        line = "";
      }
      line += item.str;
      if (item.hasEOL) {
        lines.push(line.trimEnd());
        line = "";
      }
      lastY = y;
    }
    if (line.trim()) lines.push(line.trimEnd());
    pages.push(lines.filter((l) => l.trim()).join("\n"));
  }
  await doc.destroy();
  const text = pages.join("\n\n").trim();
  if (!text) throw new Error("PDF 没有可提取的文本层（可能是扫描件，需要 OCR）");
  return text;
}

// ---------------------------------------------------------------- 统一入口

function toBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 提取单个文件内容。
 * @returns {Promise<{kind:string,name:string,text?:string,dataUrl?:string,bytes:number,warnings:string[]}>}
 */
export async function extractFile(file) {
  const { kind, reason } = classifyFile(file);
  if (kind === "unsupported") throw new Error(`${file.name}：${reason}`);

  if (kind === "text") {
    const text = await file.text();
    return { kind, name: file.name, text, bytes: file.size, warnings: [] };
  }
  if (kind === "docx") {
    const text = await extractDocx(await file.arrayBuffer());
    return { kind, name: file.name, text, bytes: file.size, warnings: [] };
  }
  if (kind === "pdf") {
    const text = await extractPdf(await file.arrayBuffer());
    return { kind, name: file.name, text, bytes: file.size, warnings: [] };
  }
  // 图片：转 data URL，是否真的能读由模型的视觉能力决定。
  // 用 arrayBuffer + btoa 而不是 FileReader：浏览器与 Node（测试）两边都能跑。
  const buffer = await file.arrayBuffer();
  const dataUrl = `data:${file.type || "image/png"};base64,${toBase64(new Uint8Array(buffer))}`;
  return { kind: "image", name: file.name, dataUrl, bytes: file.size, warnings: [] };
}

/** 拼进 prompt 的参考资料；超长时截断并明确告知截断了多少。 */
export function buildContextBlock(items) {
  const parts = [];
  const warnings = [];
  let used = 0;
  for (const item of items) {
    if (item.kind === "image") continue;
    const body = item.text || "";
    if (!body.trim()) continue;
    const remaining = MAX_CONTEXT_CHARS - used;
    if (remaining <= 0) {
      warnings.push(`参考资料总量超过 ${MAX_CONTEXT_CHARS} 字符，已忽略后续文件`);
      break;
    }
    const slice = body.length > remaining ? body.slice(0, remaining) : body;
    if (slice.length < body.length) warnings.push(`${item.name} 过长，已截断至 ${slice.length} 字符`);
    parts.push(`[参考文件：${item.name}]\n${slice}`);
    used += slice.length;
  }
  return { text: parts.join("\n\n"), warnings };
}

/** 只有图片的附件列表，供视觉模型使用。 */
export function imageAttachments(items) {
  return items
    .filter((item) => item.kind === "image" && item.dataUrl)
    .map((item) => ({ kind: "image", dataUrl: item.dataUrl, name: item.name }));
}

export { MAX_CONTEXT_CHARS };
