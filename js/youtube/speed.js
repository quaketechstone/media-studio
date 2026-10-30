/**
 * 瞬时网速与剩余时间。
 *
 * 为什么不用"累计字节 / 总耗时"：那是全程平均值。真实网络是忽快忽慢的，
 * 平均值会把"卡住不动"显示成一个漂亮的数字，用户看不出到底有没有在走；
 * 而下载接近尾声时，平均值又必然偏低，看起来像"越下越慢"。
 *
 * 做法：1.5 秒滑动窗口，取窗口首尾差分除以时间差。
 * 两条纪律：
 *   - 样本不足（连接刚开始、或两次回调间隔太短）时返回 null，UI 显示 "—"，
 *     绝不用 0 冒充"速度为 0"，也绝不把平均值当瞬时值。
 *   - 进度回退（服务端重发、重试）时重置基线，不产生负速度。
 */

const DEFAULT_WINDOW_MS = 1500;
const DEFAULT_MIN_SPAN_MS = 250;
const MAX_SAMPLES = 240;

export class SpeedMeter {
  constructor({ windowMs = DEFAULT_WINDOW_MS, minSpanMs = DEFAULT_MIN_SPAN_MS, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.minSpanMs = minSpanMs;
    this.now = now;
    this.reset();
  }

  reset() {
    this.samples = [];
    this.startedAt = null;
    this.lastReceived = 0;
  }

  get elapsedMs() {
    return this.startedAt === null ? 0 : this.now() - this.startedAt;
  }

  /** 全程平均速度。只用于结束后的总结，不参与实时显示。 */
  get averageBytesPerSecond() {
    const elapsed = this.elapsedMs;
    return elapsed > 0 ? this.lastReceived / (elapsed / 1000) : null;
  }

  /**
   * 记录一次进度。
   * @param {number} received 已接收字节
   * @param {number} totalBytes 总字节；0 表示未知
   */
  sample(received, totalBytes = 0) {
    const at = this.now();
    const value = Math.max(0, Number(received) || 0);
    if (this.startedAt === null) this.startedAt = at;

    if (value < this.lastReceived) {
      // 进度回退：清空窗口重新计时，避免算出负数速度
      this.samples = [];
      this.startedAt = at;
    }
    this.lastReceived = value;
    this.samples.push({ at, received: value });

    while (this.samples.length > 2 && at - this.samples[0].at > this.windowMs) this.samples.shift();
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);

    const first = this.samples[0];
    const spanMs = at - first.at;
    let bytesPerSecond = null;
    if (this.samples.length >= 2 && spanMs >= this.minSpanMs) {
      bytesPerSecond = Math.max(0, (value - first.received) / (spanMs / 1000));
    }

    const elapsed = this.elapsedMs;
    const averageBytesPerSecond = elapsed > 0 ? value / (elapsed / 1000) : null;
    const etaSeconds =
      bytesPerSecond > 0 && totalBytes > value ? Math.ceil((totalBytes - value) / bytesPerSecond) : null;

    return { bytesPerSecond, averageBytesPerSecond, etaSeconds, spanMs, samples: this.samples.length };
  }
}

/** 秒 → "2 分 10 秒"。只用于展示，不做四舍五入到分钟（那会让短剩余时间变成 0 分）。 */
export function formatEta(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "";
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return "";
  if (total < 60) return `${Math.max(1, Math.round(total))} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = Math.round(total % 60);
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm ? `${hours} 小时 ${mm} 分` : `${hours} 小时`;
}
