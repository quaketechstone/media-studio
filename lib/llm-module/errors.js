/** 统一错误类型：调用方只需判断 code / retryable，不必解析各家文案。 */
export const ErrorCode = {
  CONFIG: "config",
  NETWORK: "network",
  HTTP: "http",
  TIMEOUT: "timeout",
  ABORTED: "aborted",
  STREAM: "stream",
  FORMAT: "format",
};

export class LLMError extends Error {
  constructor(message, { code = ErrorCode.NETWORK, status = 0, retryable = false, detail = "" } = {}) {
    super(message);
    this.name = "LLMError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

/** HTTP 状态码 → 是否值得重试。429 与 5xx 重试，4xx（除 408/429）重试无意义。 */
export function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * 把任意异常归一化成 LLMError，供 UI 直接展示。
 *
 * 用鸭子类型而不是 `instanceof`：同一个模块可能被不同路径各加载一份
 * （源码一份、构建产物一份），`instanceof` 在那种情况下会静默失效，
 * 把"可重试的网络错误"误判成不可重试。
 */
export function normalizeError(error) {
  if (error instanceof LLMError) return error;
  if (error && typeof error.code === "string" && typeof error.retryable === "boolean") return error;
  if (error?.name === "TimeoutError" || error?.code === "ETIMEDOUT") {
    return new LLMError("请求超时", { code: ErrorCode.TIMEOUT, retryable: true });
  }
  if (error?.name === "AbortError" || error?.name === "AbortSignal") {
    return new LLMError("请求已取消", { code: ErrorCode.ABORTED });
  }
  if (error instanceof TypeError) {
    // fetch 在断网 / CORS 预检失败时抛 TypeError，语义上属于网络层
    return new LLMError(`网络请求失败：${error.message}`, { code: ErrorCode.NETWORK, retryable: true });
  }
  return new LLMError(error?.message || String(error), { code: ErrorCode.NETWORK });
}
