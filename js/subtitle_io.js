/**
 * 字幕文件 I/O：编码识别、UTF-8 规范化、下载。
 *
 * 浏览器 `File.text()` 只按 UTF-8 解码，碰上 GBK 编码的中文字幕会整片乱码，
 * 所以这里先拿字节，再按 BOM → UTF-8 → GBK 的顺序试解码，并明确告知用了哪种编码。
 */

const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8", label: "UTF-8 BOM" },
  { bytes: [0xff, 0xfe], encoding: "utf-16le", label: "UTF-16 LE" },
  { bytes: [0xfe, 0xff], encoding: "utf-16be", label: "UTF-16 BE" },
];

function startsWith(bytes, prefix) {
  return prefix.every((byte, i) => bytes[i] === byte);
}

/** 返回 `{ text, encoding, label, warnings }`，text 保证是无 BOM 的 UTF-8 字符串。 */
export function decodeText(bytes) {
  const warnings = [];
  const bom = BOMS.find((candidate) => startsWith(bytes, candidate.bytes));
  if (bom) {
    const body = bytes.subarray(bom.bytes.length);
    const text = new TextDecoder(bom.encoding, { fatal: false }).decode(body);
    return { text, encoding: bom.encoding, label: bom.label, warnings };
  }

  const tryDecode = (encoding) => {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };

  const utf8 = tryDecode("utf-8");
  if (utf8 !== null) return { text: utf8, encoding: "utf-8", label: "UTF-8", warnings };

  for (const legacy of ["gbk", "big5", "shift_jis"]) {
    const decoded = tryDecode(legacy);
    if (decoded !== null) {
      warnings.push(`文件不是 UTF-8，已按 ${legacy.toUpperCase()} 解码并转换为 UTF-8`);
      return { text: decoded, encoding: legacy, label: legacy.toUpperCase(), warnings };
    }
  }

  const fallback = new TextDecoder("windows-1252").decode(bytes);
  warnings.push("无法识别的字符编码，已按 Windows-1252 兜底解码，内容可能有乱码");
  return { text: fallback, encoding: "windows-1252", label: "Windows-1252", warnings };
}

const EXTENSION_HINTS = { srt: "srt", vtt: "vtt", txt: "txt", text: "txt" };

export function hintFromFilename(name = "") {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_HINTS[ext] ?? "";
}

/** 读取字幕文件：字节 → 解码 → 返回文本与格式提示（解析交给核心）。 */
export async function readSubtitleFile(file) {
  const buffer = await file.arrayBuffer();
  const decoded = decodeText(new Uint8Array(buffer));
  return {
    name: file.name,
    text: decoded.text,
    encoding: decoded.label,
    warnings: decoded.warnings,
    hint: hintFromFilename(file.name),
    bytes: buffer.byteLength,
  };
}

/** 文件头部的合法性预检：空文件、二进制文件在解析前就拦掉，错误信息更可读。 */
export function looksBinary(text) {
  const sample = text.slice(0, 2048);
  let control = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return control > sample.length * 0.1;
}

export function suggestFilename(baseName, format) {
  const stem = (baseName || "subtitles").replace(/\.(srt|vtt|txt)$/i, "");
  const suffix = format === "txt" ? "" : "";
  return `${stem}.translated${suffix}.${format}`;
}

/** 触发浏览器下载。测试环境没有 DOM 时静默返回，便于在 Node 里复用本模块。 */
export function downloadText(text, filename, mime = "text/plain;charset=utf-8") {
  if (typeof document === "undefined") return false;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
