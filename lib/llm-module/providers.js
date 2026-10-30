import { LLMError, ErrorCode, isRetryableStatus, normalizeError } from "./errors.js";
import { SSEParser, extractDelta } from "./sse.js";

export const DEFAULT_SYSTEM_PROMPT =
  "你是一名专业字幕翻译人员。忠实翻译原文，保留字幕编号与时间轴，保持术语一致，不得遗漏、总结、扩写或添加评论。只输出译文本身。";

/** 把外部取消信号与内部超时合并成一个信号（AbortSignal.any 不可用时手工桥接）。 */
function linkSignals(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("请求超时", "TimeoutError"));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** 图片按 OpenAI 视觉格式组装；模型未声明视觉能力时直接拒绝，不假装识别。 */
function buildUserContent(prompt, attachments, capabilities) {
  const images = (attachments || []).filter((a) => a.kind === "image");
  if (!images.length) return prompt;
  if (!capabilities.vision) {
    throw new LLMError("当前模型未声明视觉能力，无法读取图片内容", {
      code: ErrorCode.CONFIG,
      detail: "在配置里勾选「支持视觉输入」并换用支持图片的模型",
    });
  }
  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
  ];
}

export class OpenAICompatibleProvider {
  static id = "openai-compatible";

  constructor(config, { fetchImpl } = {}) {
    this.config = config;
    // 必须 bind 到 globalThis：把 window.fetch 取出来再当方法调用会抛
    // "Illegal invocation"（浏览器特有，Node 里不会复现，只有真机/e2e 能抓到）
    this.fetch = (fetchImpl || globalThis.fetch).bind(globalThis);
  }

  get capabilities() {
    return {
      streaming: true,
      vision: Boolean(this.config.capabilities?.vision),
      provider: this.config.provider || "OpenAI-compatible",
    };
  }

  #endpoint() {
    const base = String(this.config.baseUrl || "").replace(/\/+$/, "");
    if (!base) throw new LLMError("缺少 Base URL", { code: ErrorCode.CONFIG });
    return `${base}/chat/completions`;
  }

  async #request({ prompt, attachments, stream, onChunk, signal, systemPrompt, json }) {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new LLMError("尚未配置 API Key", { code: ErrorCode.CONFIG });
    const link = linkSignals(signal, Number(this.config.timeout) || 60000);
    try {
      const body = {
        model: this.config.model,
        temperature: Number(this.config.temperature ?? 0.3),
        stream: Boolean(stream),
        messages: [
          { role: "system", content: systemPrompt || this.config.systemPrompt || DEFAULT_SYSTEM_PROMPT },
          { role: "user", content: buildUserContent(prompt, attachments, this.capabilities) },
        ],
      };
      if (Number(this.config.maxTokens) > 0) body.max_tokens = Number(this.config.maxTokens);
      if (json) body.response_format = { type: "json_object" };

      let response;
      try {
        response = await this.fetch(this.#endpoint(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: link.signal,
        });
      } catch (error) {
        if (link.didTimeout()) throw new LLMError("请求超时（可在配置里调大 Timeout）", { code: ErrorCode.TIMEOUT, retryable: true });
        if (signal?.aborted) throw new LLMError("请求已取消", { code: ErrorCode.ABORTED });
        throw normalizeError(error);
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 600);
        throw new LLMError(`模型服务返回 HTTP ${response.status}`, {
          code: ErrorCode.HTTP,
          status: response.status,
          retryable: isRetryableStatus(response.status),
          detail,
        });
      }
      if (!stream) {
        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new LLMError("响应格式不符合 Chat Completions 约定", { code: ErrorCode.FORMAT });
        }
        return content;
      }
      return await this.#readStream(response, onChunk, signal);
    } finally {
      link.dispose();
    }
  }

  async #readStream(response, onChunk, signal) {
    if (!response.body) throw new LLMError("响应不支持流式读取", { code: ErrorCode.STREAM });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser();
    let full = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const payloads = parser.push(decoder.decode(value, { stream: true }));
        if (this.#consume(payloads, onChunk, (chunk) => (full += chunk))) {
          await reader.cancel().catch(() => {});
          return full;
        }
      }
      const tail = parser.push(decoder.decode());
      if (this.#consume(tail, onChunk, (chunk) => (full += chunk))) return full;
      this.#consume(parser.flush(), onChunk, (chunk) => (full += chunk));
      return full;
    } catch (error) {
      if (signal?.aborted) throw new LLMError("请求已取消", { code: ErrorCode.ABORTED });
      throw normalizeError(error);
    } finally {
      reader.releaseLock?.();
    }
  }

  #consume(payloads, onChunk, append) {
    for (const payload of payloads) {
      if (payload.trim() === "[DONE]") return true;
      if (!payload.trim()) continue;
      const delta = extractDelta(payload);
      if (delta === null) {
        // 结构异常的包不致命：跳过并继续读，避免整段翻译因一个坏包失败
        continue;
      }
      if (delta) {
        append(delta);
        onChunk?.(delta);
      }
    }
    return false;
  }

  async complete(prompt, options = {}) {
    return this.#request({ prompt, stream: false, ...options });
  }

  async stream(prompt, options = {}) {
    return this.#request({ prompt, stream: true, ...options });
  }

  async testConnection(options = {}) {
    const reply = await this.complete("Reply with OK only.", { ...options, systemPrompt: "You are a health check endpoint. Reply with OK." });
    if (!reply) throw new LLMError("服务有响应但内容为空", { code: ErrorCode.FORMAT });
    return true;
  }
}

/** Provider 扩展点：新增后端只需 register 一个工厂，UI 与任务层不用改。 */
export class ProviderRegistry {
  #factories = new Map();

  constructor() {
    this.register(OpenAICompatibleProvider.id, (config, deps) => new OpenAICompatibleProvider(config, deps));
  }

  register(id, factory) {
    if (!id || typeof factory !== "function") throw new Error("注册 provider 需要 id 与工厂函数");
    this.#factories.set(id, factory);
    return this;
  }

  list() {
    return [...this.#factories.keys()];
  }

  create(config, deps = {}) {
    const id = config?.providerType || OpenAICompatibleProvider.id;
    const factory = this.#factories.get(id);
    if (!factory) throw new LLMError(`未知的 provider：${id}`, { code: ErrorCode.CONFIG });
    return factory(config, deps);
  }
}

export const defaultRegistry = new ProviderRegistry();
