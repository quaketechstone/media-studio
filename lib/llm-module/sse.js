/**
 * 最小可用的 SSE 解析器。
 *
 * 为什么不用现成库：OpenAI 兼容端点的流只有 `data:` 一种字段，但分片位置任意
 * （可能切在 `\r\n` 中间、切在 JSON 中间），这里按 SSE 规范做"事件级"组装：
 * 连续 data 行用 \n 连接，空行分隔事件，`:` 开头视为注释（心跳）。
 */
export class SSEParser {
  #buffer = "";
  #data = [];
  #events = 0;

  get eventCount() {
    return this.#events;
  }

  /** 推入一个文本分片，返回本次解析出的完整事件负载（字符串数组）。 */
  push(chunk) {
    this.#buffer += chunk;
    const payloads = [];
    let index;
    const lines = this.#buffer.split("\n");
    // 保留最后一个可能不完整的行
    this.#buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      index = this.#consumeLine(rawLine, payloads);
      if (index === false) break;
    }
    return payloads;
  }

  /** 流结束时把残留内容收尾（处理末行没有换行符的情况）。 */
  flush() {
    const payloads = [];
    if (this.#buffer.length) {
      this.#consumeLine(this.#buffer, payloads);
      this.#buffer = "";
    }
    this.#dispatch(payloads);
    return payloads;
  }

  #consumeLine(rawLine, payloads) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      this.#dispatch(payloads);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.#data.push(value);
  }

  #dispatch(payloads) {
    if (!this.#data.length) return;
    payloads.push(this.#data.join("\n"));
    this.#data = [];
    this.#events += 1;
  }
}

/** 从 Chat Completions 的流式片段里取增量文本；结构不符时返回 null 而不是抛错。 */
export function extractDelta(payload) {
  try {
    const parsed = JSON.parse(payload);
    const delta = parsed?.choices?.[0]?.delta;
    if (typeof delta?.content === "string") return delta.content;
    // 少数实现把首包放在 message.content 里
    const message = parsed?.choices?.[0]?.message;
    if (typeof message?.content === "string") return message.content;
    return "";
  } catch {
    return null;
  }
}
