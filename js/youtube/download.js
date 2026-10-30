/**
 * 媒体下载客户端。
 *
 * 关键点：下载的是**服务端产出的真实文件流**，不是播放器的预览，也不是把 iframe 换个说法。
 * 没有执行器时这里连请求都发不出去，UI 会显示"未配置"，不会伪造进度条。
 *
 * 进度来自 `Content-Length` + 已读字节；服务端不返回长度时进度是未知而非 0%，
 * 界面要显示"已下载 X MB（总大小未知）"而不是假装 0%。
 */


import { withTimeout } from "./net.js";

export const DownloadPhase = {
  IDLE: "idle",
  PREPARING: "preparing",
  TRANSFERRING: "transferring",
  DONE: "done",
  FAILED: "failed",
  CANCELED: "canceled",
};

export class DownloadError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
    this.detail = detail;
  }
}

const MESSAGES = {
  age_restricted: "该视频有年龄限制，无法下载",
  members_only: "仅限频道会员的内容，无法下载",
  geo_blocked: "该视频在当前地区不可用",
  drm: "该视频受 DRM 保护，不提供下载",
  live_not_ready: "直播尚未结束或回放未生成，暂时无法下载",
  no_audio: "该视频没有独立音频流可提取",
  not_configured: "尚未配置媒体执行器，无法下载",
  upstream_blocked: "YouTube 拒绝了服务端请求（常见于机房 IP）",
  upstream_unreachable: "执行器连不上 YouTube（网络不可达或被 DNS 拦截）",
  forbidden: "该内容不允许下载（可能是版权或权限限制）",
};

export function describeDownloadError(code, fallback) {
  return MESSAGES[code] || fallback || "下载失败";
}

/**
 * 流式下载一个 URL 到内存 Blob，带进度与取消。
 * 之所以不用 `<a download>` 直接指过去：那样拿不到进度、失败无感知、也无法取消。
 */
export async function downloadStream(url, { onProgress, signal, fetchImpl, headers } = {}) {
  const doFetch = (fetchImpl || globalThis.fetch).bind(globalThis);
  let response;
  try {
    response = await doFetch(url, { signal, headers });
  } catch (error) {
    if (error?.name === "AbortError") throw new DownloadError("已取消", "canceled");
    throw new DownloadError("无法连接下载地址", "network", error?.message);
  }

  if (!response.ok) {
    let code = "http";
    try {
      const body = await response.json();
      code = body?.code || code;
    } catch {
      /* 错误体不是 JSON 就按状态码处理 */
    }
    throw new DownloadError(describeDownloadError(code, `下载失败（HTTP ${response.status}）`), code, `HTTP ${response.status}`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const type = response.headers.get("content-type") || "";
  const filename = filenameFromDisposition(response.headers.get("content-disposition")) || "";

  if (!response.body) {
    // 极老浏览器没有流式 body：退化成一次性读取，仍然给出最终大小
    const blob = await response.blob();
    onProgress?.({ received: blob.size, total: blob.size || total, done: true });
    return { blob, total: blob.size, filename, contentType: type };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (error?.name === "AbortError") throw new DownloadError("已取消", "canceled");
      throw new DownloadError("下载中断", "network", error?.message);
    }
    if (chunk.done) break;
    chunks.push(chunk.value);
    received += chunk.value.byteLength;
    onProgress?.({ received, total, done: false });
  }
  onProgress?.({ received, total: total || received, done: true });
  return {
    blob: new Blob(chunks, { type: type || "application/octet-stream" }),
    total: total || received,
    filename,
    contentType: type,
  };
}

export function filenameFromDisposition(header) {
  if (!header) return "";
  // filename*=UTF-8''xxx 优先：中文文件名走这个
  const star = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].replace(/^"|"$/g, ""));
    } catch {
      return star[1].replace(/^"|"$/g, "");
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : "";
}

/** 保存到磁盘。用 Blob URL，兼容所有浏览器；大文件走这里会有内存压力，属已知限制。 */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "download";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 在部分浏览器会打断下载，延迟释放
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * 一次下载任务的完整生命周期：建任务 → 轮询进度 → 取文件。
 * 取消时同时通知服务端 DELETE，避免临时文件堆积。
 */
export class ExecutorDownloadJob {
  constructor(client, { url, videoId, mode = "video", formatId = "", lang = "" }) {
    this.client = client;
    this.spec = { url, videoId, mode, formatId, lang };
    this.jobId = "";
    this.phase = DownloadPhase.IDLE;
    this.error = "";
    this.bytes = 0;
    this.total = 0;
    this.controller = null;
  }

  async start({ onProgress, pollMs = 800 } = {}) {
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.phase = DownloadPhase.PREPARING;
    onProgress?.({ phase: this.phase, received: 0, total: 0 });

    const created = await this.client.createJob(this.spec, { signal });
    this.jobId = created.jobId;

    // 阶段一：服务端准备（下载源流 + ffmpeg 合并），轮询进度
    for (;;) {
      if (signal.aborted) throw new DownloadError("已取消", "canceled");
      const job = await this.client.jobStatus(this.jobId, { signal });
      this.phase = job.phase || this.phase;
      this.bytes = job.received || 0;
      this.total = job.total || 0;
      onProgress?.({ phase: this.phase, received: this.bytes, total: this.total });
      if (job.state === "ready") break;
      if (job.state === "failed") {
        throw new DownloadError(describeDownloadError(job.code, job.message), job.code || "failed");
      }
      await sleep(pollMs, signal);
    }

    // 阶段二：把成品文件拉下来
    this.phase = DownloadPhase.TRANSFERRING;
    const fileUrl = this.client.downloadUrl(this.jobId);
    const result = await downloadStream(fileUrl, {
      signal,
      fetchImpl: this.client.fetch,
      headers: this.client.authHeaders(),
      onProgress: ({ received, total }) => {
        this.bytes = received;
        this.total = total || this.total;
        onProgress?.({ phase: DownloadPhase.TRANSFERRING, received, total });
      },
    });
    this.phase = DownloadPhase.DONE;
    onProgress?.({ phase: this.phase, received: result.blob.size, total: result.blob.size });
    return { ...result, jobId: this.jobId };
  }

  async cancel() {
    this.controller?.abort();
    this.phase = DownloadPhase.CANCELED;
    if (this.jobId) {
      // 服务端失败不阻塞本地取消：用户点了取消就该立刻停下
      await this.client.cancelJob(this.jobId).catch(() => {});
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DownloadError("已取消", "canceled"));
      },
      { once: true },
    );
  });
}

/** executor 的下载相关端点。与字幕客户端共用 baseUrl 与 token。 */
export class ExecutorDownloadClient {
  constructor({ baseUrl, fetchImpl, token = "" } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token;
    this.fetch = (fetchImpl || globalThis.fetch).bind(globalThis);
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  authHeaders() {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async #json(path, init = {}, { timeoutMs = 60000 } = {}) {
    if (!this.configured) throw new DownloadError(describeDownloadError("not_configured"), "not_configured");
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: withTimeout(init.signal, timeoutMs),
      headers: { "Content-Type": "application/json", ...this.authHeaders(), ...(init.headers || {}) },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new DownloadError(describeDownloadError(body?.code, body?.message), body?.code || "http");
    }
    return body;
  }

  /** 取视频信息与可用格式。走 POST /resolve，不缓存——格式会随视频状态变化。 */
  resolveFormats(url) {
    return this.#json("/resolve", { method: "POST", body: JSON.stringify({ url }) });
  }

  async createJob(spec, { signal } = {}) {
    const body = await this.#json("/download", { method: "POST", body: JSON.stringify(spec), signal });
    if (!body?.jobId) throw new DownloadError("执行器没有返回任务 ID", "protocol");
    return body;
  }

  jobStatus(jobId, { signal } = {}) {
    return this.#json(`/job/${encodeURIComponent(jobId)}`, { signal });
  }

  cancelJob(jobId) {
    return this.#json(`/job/${encodeURIComponent(jobId)}`, { method: "DELETE" });
  }

  downloadUrl(jobId) {
    return `${this.baseUrl}/download/${encodeURIComponent(jobId)}`;
  }
}
