/**
 * 自建执行器通道（默认）。
 *
 * 这里不做任何网络实现，只是把字幕客户端（subtitles.js）适配到 MediaBackend 契约上。
 * 好处是 app.js 再也不需要知道"执行器"这个概念，换通道时 UI 代码一行不用改。
 */

import { MediaBackend } from "./base.js";
import { ExecutorSubtitleClient, probeExecutor } from "../subtitles.js";

export class ExecutorBackend extends MediaBackend {
  constructor({ baseUrl = "", token = "", fetchImpl } = {}) {
    super({ id: "executor", label: "自建执行器" });
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.subtitles = new ExecutorSubtitleClient({ baseUrl: this.baseUrl, token, fetchImpl });
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  get capabilities() {
    // 两个能力同源同命：地址有就都有，没有就都没有。不单独吹某一项。
    const on = this.configured;
    return { metadata: on, subtitles: on };
  }

  probe() {
    if (!this.configured) return Promise.resolve({ ok: false, reason: "未配置执行器地址" });
    return probeExecutor(this.baseUrl, { fetchImpl: this.fetchImpl });
  }

  async listTracks({ videoId, url }) {
    return this.subtitles.listTracks({ videoId, url });
  }

  async fetchSubtitle({ videoId, url, trackId }) {
    const result = await this.subtitles.fetchAsSrt({ videoId, url, trackId });
    // 执行器已经把 json3 归一成 SRT，这里只换字段名，不改语义
    return { text: result.srt, format: "srt", cueCount: result.cueCount, lang: result.lang, kind: result.kind };
  }
}
