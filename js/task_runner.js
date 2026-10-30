/**
 * 翻译任务状态机。
 *
 * 五个状态：pending / running / done / failed / canceled（任务级），
 * 每个分段自己也有同样的状态，任务级状态由分段汇总而来。
 *
 * 三条硬约束（都有测试）：
 * 1. 默认串行，保持分段顺序，绝不并发抢跑；
 * 2. Stop 立即中止当前网络请求，且不再推进后续分段；
 * 3. 结果必须绑定文档版本 —— 用户改过原字幕，旧任务的产出不许覆盖新内容。
 */
import { ErrorCode, normalizeError } from "../lib/llm-module/errors.js";

export const TaskState = {
  PENDING: "pending",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  CANCELED: "canceled",
};

const STREAM_EVENT = { CHUNK: "chunk", UPDATE: "update" };

const defaultSleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export class TranslationTask {
  /**
   * @param {object} options
   * @param {Array<{text:string}>} options.segments 分段计划
   * @param {(text:string, ctx:{signal:AbortSignal,index:number,onChunk:(s:string)=>void}) => Promise<string>} options.request
   * @param {() => boolean} [options.isCurrentVersion] 版本守卫；返回 false 即作废旧任务
   * @param {(event:{type:string, snapshot:object, index?:number, chunk?:string}) => void} [options.onEvent]
   * @param {{maxAttempts?:number, baseDelayMs?:number, sleep?:Function}} [options.retry]
   */
  constructor({ segments, request, isCurrentVersion = () => true, onEvent = () => {}, retry = {} }) {
    this.segments = segments.map((s, index) => ({
      index,
      text: s.text,
      bytes: s.bytes,
      state: TaskState.PENDING,
      attempts: 0,
      error: "",
      output: "",
    }));
    this.request = request;
    this.isCurrentVersion = isCurrentVersion;
    this.onEvent = onEvent;
    this.maxAttempts = Math.max(1, retry.maxAttempts ?? 3);
    this.baseDelayMs = Math.max(0, retry.baseDelayMs ?? 800);
    this.sleep = retry.sleep ?? defaultSleep;

    this.state = TaskState.PENDING;
    this.canceled = false;
    this.controller = null;
    this.startedAt = 0;
    this.finishedAt = 0;
    this.reason = "";
    this.onlyIndexes = null;
  }

  get total() {
    return this.segments.length;
  }

  get translatedCount() {
    return this.segments.filter((s) => s.state === TaskState.DONE).length;
  }

  get failedCount() {
    return this.segments.filter((s) => s.state === TaskState.FAILED).length;
  }

  get pendingCount() {
    return this.segments.filter((s) => s.state === TaskState.PENDING).length;
  }

  snapshot() {
    return {
      state: this.state,
      total: this.total,
      done: this.translatedCount,
      failed: this.failedCount,
      pending: this.pendingCount,
      canceled: this.canceled,
      current: this.segments.find((s) => s.state === TaskState.RUNNING)?.index ?? -1,
      reason: this.reason,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      segments: this.segments.map((s) => ({
        index: s.index,
        state: s.state,
        attempts: s.attempts,
        error: s.error,
        bytes: s.bytes,
      })),
    };
  }

  /** 已完成的译文（保持原顺序，未完成的段落留空字符串）。 */
  translations() {
    return this.segments.map((s) => s.output);
  }

  #emit(type, extra = {}) {
    this.onEvent({ type, snapshot: this.snapshot(), ...extra });
  }

  #setState(state) {
    this.state = state;
    this.#emit(STREAM_EVENT.UPDATE);
  }

  async start() {
    if (this.state === TaskState.RUNNING) throw new Error("任务正在运行");
    this.canceled = false;
    this.reason = "";
    this.startedAt = Date.now();
    this.finishedAt = 0;
    this.controller = new AbortController();
    this.#setState(TaskState.RUNNING);

    const queue = this.onlyIndexes ?? this.segments.map((s) => s.index);
    this.onlyIndexes = null;

    for (const index of queue) {
      if (this.canceled) break;
      const segment = this.segments[index];
      if (segment.state === TaskState.DONE) continue;

      if (!this.isCurrentVersion()) {
        this.canceled = true;
        this.reason = "原字幕已被修改，本次任务作废";
        break;
      }
      await this.#runSegment(segment);
    }

    this.finishedAt = Date.now();
    if (this.canceled) this.#setState(TaskState.CANCELED);
    else if (this.failedCount > 0) this.#setState(TaskState.FAILED);
    else this.#setState(TaskState.DONE);
    return this.snapshot();
  }

  async #runSegment(segment) {
    segment.state = TaskState.RUNNING;
    segment.output = "";
    segment.error = "";
    this.#emit(STREAM_EVENT.UPDATE, { index: segment.index });

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      segment.attempts += 1;
      try {
        const text = await this.request(segment.text, {
          index: segment.index,
          signal: this.controller.signal,
          onChunk: (chunk) => {
            if (this.canceled) return;
            segment.output += chunk;
            this.#emit(STREAM_EVENT.CHUNK, { index: segment.index, chunk });
          },
        });
        if (this.canceled) {
          segment.state = TaskState.CANCELED;
          return;
        }
        if (!this.isCurrentVersion()) {
          segment.state = TaskState.CANCELED;
          this.canceled = true;
          this.reason = "原字幕已被修改，本次任务作废";
          return;
        }
        segment.output = text;
        segment.state = TaskState.DONE;
        this.#emit(STREAM_EVENT.UPDATE, { index: segment.index });
        return;
      } catch (error) {
        const normalized = normalizeError(error);
        if (this.canceled || normalized.code === ErrorCode.ABORTED) {
          segment.state = TaskState.CANCELED;
          this.#emit(STREAM_EVENT.UPDATE, { index: segment.index });
          return;
        }
        segment.error = normalized.message + (normalized.detail ? `（${normalized.detail}）` : "");
        const canRetry = normalized.retryable && attempt < this.maxAttempts && !this.canceled;
        if (!canRetry) {
          segment.state = TaskState.FAILED;
          this.#emit(STREAM_EVENT.UPDATE, { index: segment.index });
          return;
        }
        this.#emit(STREAM_EVENT.UPDATE, { index: segment.index });
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1), this.controller.signal);
        if (this.canceled) {
          segment.state = TaskState.CANCELED;
          return;
        }
      }
    }
  }

  /** 立即中断当前请求，并停止后续分段。 */
  cancel(reason = "用户停止") {
    if (this.state !== TaskState.RUNNING) return false;
    this.canceled = true;
    this.reason = reason;
    this.controller?.abort();
    this.segments.forEach((s) => {
      if (s.state === TaskState.RUNNING) s.state = TaskState.CANCELED;
    });
    this.#emit(STREAM_EVENT.UPDATE);
    return true;
  }

  /** 只重试失败的分段，已完成的不重跑。 */
  async retryFailed() {
    if (this.state === TaskState.RUNNING) throw new Error("任务正在运行");
    const indexes = this.segments.filter((s) => s.state === TaskState.FAILED).map((s) => s.index);
    if (!indexes.length) return this.snapshot();
    indexes.forEach((i) => {
      this.segments[i].state = TaskState.PENDING;
      this.segments[i].error = "";
      this.segments[i].attempts = 0;
      this.segments[i].output = "";
    });
    this.onlyIndexes = indexes;
    return this.start();
  }
}

export { STREAM_EVENT };
