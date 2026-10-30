/**
 * 落盘层：把"下载"和"存到哪儿"分开。
 *
 * 为什么需要这一层：`new Blob(chunks)` 要求整个文件先躺在内存里。1 小时 1080p
 * 大约 2–4 GB，Chrome 的 Blob 上限就在这个量级，iOS Safari 更低。所以能边下边存
 * 就必须边下边存；不能的时候要**明确告诉用户**，而不是等浏览器崩掉。
 *
 * 两条实现：
 *   fs    桌面 Chrome / Edge：用户选路径 → FileSystemWritableFileStream 逐块写，内存恒定
 *   blob  其余环境：累积到内存后一次性交给浏览器，超过阈值时带 warn
 *
 * 关键约束（都是踩过的坑）：
 *   1. showSaveFilePicker 必须在用户手势内调用，所以**先开 sink 再发请求**。
 *      先 fetch 再弹选择器，慢网络下手势窗口过期会抛 SecurityError。
 *   2. 用户在选择器里点取消 = 用户不想下载，必须整体取消，
 *      不能"降级成 Blob 继续下"——那等于无视用户操作。
 *   3. 能力探测看 `typeof showSaveFilePicker === "function"`，不用 try/catch 猜。
 */

/** 超过这个体积还走 Blob 就有风险：1.5 GB 是保守值，不是浏览器上限。 */
export const BLOB_WARN_BYTES = 1.5 * 1024 ** 3;

export class SinkError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "SinkError";
    this.code = code;
    this.detail = detail;
  }
}

export function pickerAvailable(scope = globalThis) {
  return typeof scope?.showSaveFilePicker === "function";
}

const MIME_BY_MODE = {
  video: "video/mp4",
  audio: "audio/mp4",
};

function sizeOf(chunk) {
  if (!chunk) return 0;
  if (typeof chunk.byteLength === "number") return chunk.byteLength;
  if (typeof chunk.length === "number") return chunk.length;
  return 0;
}

class FileSink {
  constructor(writable, { filename, totalBytes }) {
    this.kind = "fs";
    this.writable = writable;
    this.filename = filename;
    this.totalBytes = totalBytes;
    this.bytes = 0;
    this.bufferedBytes = 0;
    this.closed = false;
    this.warn = "";
  }

  async write(chunk) {
    if (this.closed) throw new SinkError("closed", "保存已结束，不能再写入");
    try {
      await this.writable.write(chunk);
    } catch (error) {
      throw new SinkError("write_failed", `写入文件失败：${error?.message || "未知原因"}`, error?.name);
    }
    this.bytes += sizeOf(chunk);
  }

  async close() {
    if (this.closed) return { kind: "fs", filename: this.filename, bytes: this.bytes, warn: "" };
    this.closed = true;
    try {
      await this.writable.close();
    } catch (error) {
      throw new SinkError("write_failed", `写入文件失败：${error?.message || "未知原因"}`, error?.name);
    }
    return { kind: "fs", filename: this.filename, bytes: this.bytes, warn: "" };
  }

  async abort() {
    this.closed = true;
    try {
      await this.writable.abort();
    } catch {
      /* 取消时清理失败不再阻断用户操作 */
    }
  }
}

class BlobSink {
  constructor({ filename, totalBytes, mode, reason }) {
    this.kind = "blob";
    this.filename = filename;
    this.totalBytes = totalBytes;
    this.mode = mode;
    this.reason = reason;
    this.chunks = [];
    this.bytes = 0;
    this.bufferedBytes = 0;
    this.closed = false;
    // 只在"总大小已知且确实很大"时提示；大小未知时不编造风险
    this.warn =
      totalBytes > BLOB_WARN_BYTES ? "当前浏览器不支持边下边存，超过 1.5 GB 可能失败" : "";
  }

  write(chunk) {
    if (this.closed) throw new SinkError("closed", "保存已结束，不能再写入");
    this.chunks.push(chunk);
    const size = sizeOf(chunk);
    this.bytes += size;
    this.bufferedBytes += size;
  }

  close() {
    if (this.closed) return { kind: "blob", blob: null, filename: this.filename, bytes: this.bytes, warn: this.warn };
    this.closed = true;
    const blob = new Blob(this.chunks, { type: MIME_BY_MODE[this.mode] || "application/octet-stream" });
    this.chunks = [];
    this.bufferedBytes = 0;
    return { kind: "blob", blob, filename: this.filename, bytes: this.bytes, warn: this.warn };
  }

  abort() {
    this.closed = true;
    this.chunks = [];
    this.bufferedBytes = 0;
  }
}

/**
 * 打开一个落盘目标。**必须在用户点击的同步栈内调用**（选择器需要手势）。
 *
 * @returns {Promise<FileSink|BlobSink>} 两者接口一致：write / close / abort
 */
export async function openSink({
  filename = "download",
  totalBytes = 0,
  mode = "video",
  showSaveFilePicker,
  scope = globalThis,
} = {}) {
  const picker = showSaveFilePicker ?? scope?.showSaveFilePicker;
  if (typeof picker !== "function") {
    return new BlobSink({ filename, totalBytes, mode, reason: "unsupported" });
  }

  const types =
    mode === "audio"
      ? [{ description: "音频文件", accept: { "audio/mp4": [".m4a"] } }]
      : [{ description: "视频文件", accept: { "video/mp4": [".mp4"] } }];

  let handle;
  try {
    handle = await picker.call(scope, { suggestedName: filename, types });
  } catch (error) {
    const name = error?.name || "";
    // 用户主动取消：整体取消，不降级
    if (name === "AbortError") throw new SinkError("canceled", "已取消保存位置选择");
    // 手势过期/权限被拒：降级，但把原因挂在 sink 上，UI 可以说明为什么没边下边存
    if (name === "NotAllowedError" || name === "SecurityError") {
      return new BlobSink({ filename, totalBytes, mode, reason: name });
    }
    throw new SinkError("picker_failed", `无法打开保存位置选择器：${error?.message || name}`, name);
  }

  let writable;
  try {
    writable = await handle.createWritable();
  } catch (error) {
    throw new SinkError("picker_failed", `无法创建写入流：${error?.message || error?.name}`, error?.name);
  }
  return new FileSink(writable, { filename, totalBytes });
}

/** 内存降级时的提示语；没有风险时返回空串。 */
export function sinkWarning(result) {
  return result?.warn || "";
}
