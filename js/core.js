/**
 * 核心桥接：优先加载 WASM，失败则**完整**回落到纯 JS 实现。
 *
 * 关键点：这里是 `import()` 而不是顶层 `import` —— 静态导入一旦解析失败，
 * 整个模块都不会执行，`try/catch` 根本没机会运行（原实现的降级分支就是这样变成死代码的）。
 */
import { core as jsCore } from "./fallback_core.js";

let active = null;
let info = { engine: "pending", label: "初始化中" };

/**
 * wasm-bindgen 抛的是 JsValue（字符串），不是 Error 实例。
 * 直接抛出会让 UI 里的 `error.message` 变成 undefined，提示变成"解析失败：undefined"。
 * 这里统一包成 Error，保证两套核心的错误对调用方是同一种形状。
 */
function wrap(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      if (error instanceof Error) throw error;
      const message = typeof error === "string" ? error : error?.message || String(error);
      throw new Error(message);
    }
  };
}

function wasmCore(mod) {
  return {
    engine: "wasm",
    parseSubtitles: wrap((text, hint = "") => JSON.parse(mod.parse_subtitles(text, hint || ""))),
    serializeSubtitles: wrap((doc, format = "") => mod.serialize_subtitles(JSON.stringify(doc), format || "")),
    segmentSubtitles: wrap((doc, target) => JSON.parse(mod.segment_subtitles(JSON.stringify(doc), target))),
    applyTranslations: wrap((doc, target, translations, format) =>
      JSON.parse(mod.apply_translations(JSON.stringify(doc), target, JSON.stringify(translations), format || "")),
    ),
    utf8ByteLen: wrap((text) => mod.utf8_byte_len(text)),
    coreVersion: wrap(() => mod.core_version()),
  };
}

export async function initCore() {
  try {
    const mod = await import("../pkg/youtube_media_studio.js");
    await mod.default();
    active = wasmCore(mod);
    info = { engine: "wasm", label: "WASM 核心", version: mod.core_version() };
  } catch (error) {
    active = jsCore;
    info = {
      engine: "js",
      label: "JS 降级核心",
      reason: error?.message || String(error),
    };
  }
  return info;
}

export function getCore() {
  if (!active) throw new Error("核心尚未初始化，请先调用 initCore()");
  return active;
}

export function getCoreInfo() {
  return info;
}
