/**
 * 工作台 UI 编排层。
 *
 * 职责边界：这里只做"把用户动作映射到核心/任务/模块调用并渲染状态"，
 * 解析、分段、合并、请求、重试全部在各自模块里，换 UI 不需要重写这些逻辑。
 */
import { initCore, getCore } from "./core.js";
import { LLMModule, DEFAULT_SYSTEM_PROMPT } from "../lib/llm-module/index.js";
import { readSubtitleFile, looksBinary, downloadText, suggestFilename } from "./subtitle_io.js";
import { TranslationTask, TaskState } from "./task_runner.js";
import { createMediaProvider, DownloadState } from "./media_provider.js";
import { extractFile, buildContextBlock, imageAttachments } from "./file_context.js";
import { buildTranslationPrompt } from "./prompt.js";

const $ = (id) => document.getElementById(id);
const MIME = { srt: "application/x-subrip;charset=utf-8", vtt: "text/vtt;charset=utf-8", txt: "text/plain;charset=utf-8" };

const llm = new LLMModule();
const state = {
  doc: null,
  plan: null,
  translated: null,
  version: 0,
  task: null,
  provider: null,
  resolved: null,
  download: null,
  context: [],
  sourceName: "subtitles",
};

// ---------------------------------------------------------------- 小工具

function show(id) {
  $(id).classList.remove("hidden");
}
function hide(id) {
  $(id).classList.add("hidden");
}
function setNotice(id, message, kind = "error") {
  const el = $(id);
  if (!message) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = message;
  el.className = `notice ${kind}`;
}
function setPill(id, text, kind = "") {
  const el = $(id);
  el.textContent = text;
  el.className = `pill ${kind}`.trim();
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
function debounce(fn, delay = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ---------------------------------------------------------------- 字幕载入

function renderDocStats() {
  const doc = state.doc;
  if (!doc) {
    setPill("doc-stats", "未载入");
    $("doc-format").textContent = "—";
    return;
  }
  const core = getCore();
  const text = core.serializeSubtitles(doc, doc.format);
  const bytes = core.utf8ByteLen(text);
  const cueCount = doc.cues.length;
  setPill("doc-stats", `${cueCount} 条 · ${formatBytes(bytes)}`);
  $("doc-format").textContent =
    `${doc.format.toUpperCase()}${cueCount ? ` · ${cueCount} 条字幕` : ""}${bytes >= 5000 ? " · 将分段翻译" : " · 全文翻译"}`;
  const plan = core.segmentSubtitles(doc, Number($("segment-count").value));
  state.plan = plan;
  renderPlan(plan);
  const warnings = doc.warnings || [];
  setNotice("source-warnings", warnings.length ? warnings.join("\n") : "", "warning");
}

function renderPlan(plan) {
  const list = $("progress-list");
  list.replaceChildren();
  if (!plan || !plan.segments.length) {
    $("plan-summary").textContent = state.doc ? "没有可翻译的条目。" : "载入字幕后显示分段计划。";
    return;
  }
  $("plan-summary").textContent =
    `模式：${plan.mode === "full" ? "全文一次发送" : `${plan.segments.length} 段分段发送`} · ` +
    `总字节 ${plan.total_bytes} · 条目 ${plan.unit_count}` +
    (plan.warnings.length ? ` · ${plan.warnings.join("；")}` : "");
  plan.segments.forEach((segment, i) => list.append(progressRow(i, segment)));
}

function progressRow(index, segment, stateValue = "pending", meta = "") {
  const li = document.createElement("li");
  li.dataset.state = stateValue;
  li.dataset.index = String(index);
  const name = document.createElement("span");
  name.className = "seg-name";
  name.textContent = `第 ${index + 1} 段`;
  const range = document.createElement("span");
  range.textContent = `条目 ${segment.start + 1}–${segment.end + 1} · ${formatBytes(segment.bytes)}`;
  const metaEl = document.createElement("span");
  metaEl.className = "seg-meta";
  metaEl.textContent = meta || stateLabel(stateValue);
  li.append(name, range, metaEl);
  return li;
}

function stateLabel(value) {
  return (
    {
      pending: "待处理",
      running: "进行中",
      done: "已完成",
      failed: "失败",
      canceled: "已取消",
    }[value] || value
  );
}

function applyParsed(text, hint) {
  const core = getCore();
  if (!text.trim()) {
    state.doc = null;
    state.translated = null;
    setNotice("source-warnings", "");
    renderDocStats();
    syncButtons();
    return false;
  }
  try {
    const doc = core.parseSubtitles(text, hint || "");
    state.doc = doc;
    state.translated = null;
    // 旧译文对应的是旧字幕，留着会误导（改了两句却看到整篇"已完成"）
    if ($("translation-output").value) {
      $("translation-output").value = "";
      $("output-stats").textContent = "—";
      setPill("translation-status", "就绪");
    }
    setNotice("source-warnings", (doc.warnings || []).join("\n"), "warning");
    renderDocStats();
    syncButtons();
    return true;
  } catch (error) {
    state.doc = null;
    setNotice("source-warnings", `解析失败：${error.message}`, "error");
    setPill("doc-stats", "解析失败", "err");
    syncButtons();
    return false;
  }
}

async function loadSubtitleFile(file) {
  const zone = $("drop-zone");
  zone.classList.add("busy");
  try {
    const result = await readSubtitleFile(file);
    if (looksBinary(result.text)) throw new Error("文件看起来是二进制内容，不是文本字幕");
    $("raw-subtitles").value = result.text;
    state.sourceName = file.name;
    state.version += 1;
    const ok = applyParsed(result.text, result.hint);
    if (ok) {
      const notes = [...result.warnings];
      notes.unshift(`已载入 ${file.name}（${result.encoding}，${formatBytes(result.bytes)}）`);
      setNotice("source-warnings", notes.join("\n"), result.warnings.length ? "warning" : "success");
    }
  } catch (error) {
    setNotice("source-warnings", `读取失败：${error.message}`, "error");
  } finally {
    zone.classList.remove("busy");
  }
}

// ---------------------------------------------------------------- 按钮状态

function syncButtons() {
  const hasDoc = Boolean(state.doc);
  $("translate").disabled = !hasDoc || state.task?.state === TaskState.RUNNING;
  const running = state.task?.state === TaskState.RUNNING;
  $("stop-translation").disabled = !running;
  $("retry-translation").disabled = running || (state.task?.failedCount ?? 0) === 0;
  const hasOutput = Boolean($("translation-output").value.trim());
  ["export-srt", "export-vtt", "export-txt", "copy-result"].forEach((id) => {
    $(id).disabled = !hasOutput;
  });
}

// ---------------------------------------------------------------- 翻译

function buildPrompt(segmentText, targetLanguage) {
  const context = buildContextBlock(state.context);
  return buildTranslationPrompt({ segmentText, targetLanguage, contextText: context.text });
}

async function startTranslation() {
  if (!state.doc) return;
  if (!llm.hasApiKey()) {
    openConfig("请先配置 API Key 再开始翻译。");
    return;
  }
  setNotice("source-warnings", "");
  const target = Number($("segment-count").value);
  const core = getCore();
  const plan = core.segmentSubtitles(state.doc, target);
  if (!plan.segments.length) {
    setPill("translation-status", "无可翻译内容", "err");
    return;
  }
  if (!state.translated) $("translation-output").value = "";
  renderPlan(plan);
  const versionAtStart = state.version;
  const targetLanguage = $("target-lang").value;
  const images = imageAttachments(state.context);

  const task = new TranslationTask({
    segments: plan.segments,
    isCurrentVersion: () => versionAtStart === state.version,
    request: (text, ctx) =>
      llm.stream(buildPrompt(text, targetLanguage), {
        signal: ctx.signal,
        onChunk: ctx.onChunk,
        attachments: images,
      }),
    onEvent: (event) => renderTask(event, plan),
  });
  state.task = task;
  setPill("translation-status", "运行中", "busy");
  syncButtons();

  const snapshot = await task.start();
  finishTask(snapshot, plan, target);
}

function renderTask(event, plan) {
  const { snapshot } = event;
  const list = $("progress-list");
  plan.segments.forEach((segment, i) => {
    const row = list.children[i];
    if (!row) return;
    const seg = snapshot.segments[i];
    row.dataset.state = seg.state;
    row.querySelector(".seg-meta").textContent =
      seg.state === "failed" && seg.error ? seg.error : stateLabel(seg.state) + (seg.attempts > 1 ? ` · 第 ${seg.attempts} 次尝试` : "");
  });
  setPill(
    "translation-status",
    snapshot.state === "running"
      ? `运行中 ${snapshot.done}/${snapshot.total}`
      : stateLabel(snapshot.state),
    snapshot.state === "failed" ? "err" : snapshot.state === "done" ? "ok" : snapshot.state === "running" ? "busy" : "",
  );
}

function finishTask(snapshot, plan, target) {
  const core = getCore();
  const task = state.task;
  const translations = task.translations();
  const format = state.doc.format;
  const applied = core.applyTranslations(state.doc, target, translations, format);
  state.translated = applied.document;
  $("translation-output").value = core.serializeSubtitles(applied.document, format);
  $("output-stats").textContent = `${core.utf8ByteLen($("translation-output").value)} 字节`;

  const notes = [];
  if (snapshot.state === "canceled") {
    notes.push(
      `任务已停止：完成 ${snapshot.done}/${snapshot.total} 段` +
        (snapshot.reason ? `（${snapshot.reason}）` : "") +
        "。未完成段落保留原文，可继续编辑或重试。",
    );
  } else if (snapshot.state === "failed") {
    notes.push(`有 ${snapshot.failed} 段失败，其余已完成；未完成段落保留原文。`);
  } else {
    notes.push("翻译完成，时间轴已保留。");
  }
  applied.warnings.forEach((w) => notes.push(w));
  buildContextBlock(state.context).warnings.forEach((w) => notes.push(w));
  setNotice("source-warnings", notes.join("\n"), snapshot.state === "done" ? "success" : "warning");
  setPill("translation-status", stateLabel(snapshot.state), snapshot.state === "done" ? "ok" : snapshot.state === "failed" ? "err" : "");
  syncButtons();
}

// ---------------------------------------------------------------- 导出

function exportAs(format) {
  const text = $("translation-output").value;
  if (!text.trim()) return;
  let output = text;
  const core = getCore();
  try {
    // 先按**原文格式**解析（用户可能手工改过译文），再按目标格式序列化，
    // 这样 SRT→VTT 是格式转换而不是"用 VTT 规则去解析 SRT 文本"。
    const sourceFormat = state.doc?.format || format;
    const doc = core.parseSubtitles(text, sourceFormat);
    if (format !== "txt" && !(doc.cues || []).length) {
      setNotice("source-warnings", "当前内容是纯文本、没有时间轴，无法导出为 SRT/VTT。请导出 TXT。", "error");
      return;
    }
    output = core.serializeSubtitles(doc, format);
  } catch (error) {
    if (format !== "txt") {
      setNotice("source-warnings", `导出失败：译文结构不完整（${error.message}）。请检查是否有条目被删改。`, "error");
      return;
    }
  }
  downloadText(output, suggestFilename(state.sourceName, format), MIME[format]);
}

// ---------------------------------------------------------------- 媒体能力

/**
 * Media 配置来源（按优先级）：
 * 1. window.MEDIA_API_BASE（宿主页面自行注入时）
 * 2. <meta name="media-api-base">（发布时由 CI 把 __MEDIA_API_BASE__ 占位符替换掉）
 * 3. 空 → 不显示媒体区，明确说明未接入
 * 不做"额外请求配置 JSON"或"改 index.html 插 script"：前者每次多一个 404，
 * 后者依赖 HTML 片段精确匹配，格式化一次就静默失效。
 */
function readMetaBase() {
  const content = document.querySelector('meta[name="media-api-base"]')?.content?.trim() || "";
  if (!content || content === "__MEDIA_API_BASE__") return "";
  return content;
}

async function setupMedia() {
  const params = new URLSearchParams(location.search);
  const mock = params.get("mock") === "1" || localStorage.getItem("yms.mock") === "1";
  const baseUrl = window.MEDIA_API_BASE || readMetaBase();
  state.provider = createMediaProvider({ baseUrl, mock });
  if (!state.provider) {
    $("media-block").hidden = true;
    return;
  }
  $("media-block").hidden = false;
  if (state.provider.isMock) {
    setNotice("mock-banner", "当前使用 Mock 演示数据，视频标题、字幕和格式均非真实解析结果。", "warning");
    $("video-url").value = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  }
}

async function resolveVideo() {
  if (!state.provider) return;
  hide("media-error");
  $("resolve-video").disabled = true;
  setPill("media-status", "解析中", "busy");
  try {
    state.resolved = await state.provider.resolve($("video-url").value.trim());
    $("media-status").textContent = state.resolved.mock
      ? "演示数据（非真实解析）"
      : `${state.resolved.video.title || "未提供标题"}`;
    const tracks = $("track-select");
    tracks.replaceChildren(new Option("选择字幕轨道", ""));
    state.resolved.subtitles.forEach((track) => {
      tracks.add(new Option(`${track.language || "未知"} · ${track.kind || "字幕"} · ${track.name || track.id}`, track.id));
    });
    tracks.disabled = !state.resolved.subtitles.length;
    $("fetch-subtitles").disabled = !state.resolved.subtitles.length;
    const formats = $("format-select");
    formats.replaceChildren(new Option("选择媒体格式", ""));
    state.resolved.formats.forEach((f) => formats.add(new Option(`${f.label || f.resolution || f.id}`, f.id)));
    $("download-video").disabled = !state.resolved.formats.length;
    setPill("media-status", state.resolved.mock ? "演示数据" : "解析成功", state.resolved.mock ? "" : "ok");
  } catch (error) {
    setPill("media-status", "解析失败", "err");
    setNotice("media-error", error.message, "error");
  } finally {
    $("resolve-video").disabled = false;
  }
}

async function fetchSubtitles() {
  try {
    const content = await state.provider.subtitles(state.resolved.video.id, $("track-select").value);
    $("raw-subtitles").value = content;
    state.version += 1;
    applyParsed(content, "");
  } catch (error) {
    setNotice("media-error", error.message, "error");
  }
}

async function downloadMedia() {
  if (!state.provider || !state.resolved) return;
  const task = state.provider.createDownload({
    videoId: state.resolved.video.id,
    formatId: $("format-select").value,
    onProgress: ({ received, total }) => {
      const percent = total ? ` (${Math.round((received / total) * 100)}%)` : "";
      $("download-status").textContent = `下载中 ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ""}${percent}`;
    },
  });
  state.download = task;
  $("download-cancel").disabled = false;
  $("download-video").disabled = true;
  try {
    const blob = await task.run();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = task.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("download-status").textContent = `下载完成 ${formatBytes(blob.size)}`;
  } catch (error) {
    $("download-status").textContent = `下载失败：${task.error || error.message}`;
  } finally {
    $("download-video").disabled = false;
    $("download-cancel").disabled = true;
    state.download = null;
  }
}

// ---------------------------------------------------------------- 配置

function refreshConfigList(selected = llm.getActiveConfig().id) {
  const select = $("config-list");
  select.replaceChildren();
  llm.listConfigs().forEach((cfg) => select.add(new Option(cfg.name, cfg.id)));
  select.value = selected;
  loadConfigForm(llm.getConfig(selected));
}

function loadConfigForm(config) {
  $("cfg-name").value = config.name || "";
  $("cfg-base-url").value = config.baseUrl || "";
  $("cfg-api-key").value = config.apiKey || "";
  $("cfg-model").value = config.model || "";
  $("cfg-temperature").value = config.temperature ?? 0.3;
  $("cfg-max-tokens").value = config.maxTokens ?? 4096;
  $("cfg-timeout").value = config.timeout ?? 60000;
  $("cfg-vision").checked = Boolean(config.capabilities?.vision);
  $("cfg-system-prompt").value = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
}

function collectConfig() {
  const previous = llm.getConfig($("config-list").value);
  const keyInput = $("cfg-api-key").value;
  return {
    ...previous,
    name: $("cfg-name").value.trim(),
    baseUrl: $("cfg-base-url").value.trim(),
    apiKey: keyInput.startsWith("••") ? previous.apiKey : keyInput,
    model: $("cfg-model").value.trim(),
    temperature: Number($("cfg-temperature").value),
    maxTokens: Number($("cfg-max-tokens").value),
    timeout: Number($("cfg-timeout").value),
    capabilities: { vision: $("cfg-vision").checked },
    systemPrompt: $("cfg-system-prompt").value,
  };
}

function saveConfig() {
  const id = llm.saveConfig(collectConfig());
  llm.setActiveConfig(id);
  refreshConfigList(id);
  return id;
}

function openConfig(message = "") {
  try {
    refreshConfigList();
  } catch {
    // 存储结构异常时仍然把对话框打开，让用户能重建配置
  }
  setNotice("config-message", message, message ? "info" : "");
  if (!$("config-dialog").open) $("config-dialog").showModal();
}

// ---------------------------------------------------------------- 事件绑定

function bindEvents() {
  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("yms.theme", next);
  };
  $("theme-toggle").addEventListener("click", toggleTheme);
  $("open-config").addEventListener("click", () => openConfig());

  // 文件导入
  const zone = $("drop-zone");
  zone.addEventListener("click", () => $("file-input").click());
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      $("file-input").click();
    }
  });
  $("file-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) loadSubtitleFile(file);
    event.target.value = "";
  });
  ["dragenter", "dragover"].forEach((type) =>
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add("dragging");
    }),
  );
  ["dragleave", "drop"].forEach((type) =>
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove("dragging");
    }),
  );
  zone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) loadSubtitleFile(file);
  });

  // 编辑原字幕
  const onEdit = debounce(() => {
    state.version += 1;
    if (state.task?.state === TaskState.RUNNING) state.task.cancel("原字幕已修改，当前翻译已停止");
    applyParsed($("raw-subtitles").value, "");
  }, 220);
  $("raw-subtitles").addEventListener("input", () => {
    state.version += 1;
    if (state.task?.state === TaskState.RUNNING) state.task.cancel("原字幕已修改，当前翻译已停止");
    onEdit();
  });

  $("segment-count").addEventListener("change", () => {
    if (state.doc) renderDocStats();
  });

  // 翻译
  $("translate").addEventListener("click", () => {
    startTranslation().catch((error) => {
      setPill("translation-status", "失败", "err");
      setNotice("source-warnings", `翻译失败：${error.message}`, "error");
      syncButtons();
    });
  });
  $("stop-translation").addEventListener("click", () => {
    state.task?.cancel();
  });
  $("retry-translation").addEventListener("click", async () => {
    if (!state.task || !state.plan) return;
    setPill("translation-status", "运行中", "busy");
    const snapshot = await state.task.retryFailed();
    finishTask(snapshot, state.plan, Number($("segment-count").value));
  });

  // 输出
  $("translation-output").addEventListener("input", () => {
    const core = getCore();
    $("output-stats").textContent = `${core.utf8ByteLen($("translation-output").value)} 字节`;
    syncButtons();
  });
  $("export-srt").addEventListener("click", () => exportAs("srt"));
  $("export-vtt").addEventListener("click", () => exportAs("vtt"));
  $("export-txt").addEventListener("click", () => exportAs("txt"));
  $("copy-result").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("translation-output").value);
      setNotice("source-warnings", "已复制到剪贴板。", "success");
    } catch (error) {
      setNotice("source-warnings", `复制失败：${error.message}`, "error");
    }
  });

  // 媒体
  $("resolve-video").addEventListener("click", resolveVideo);
  $("fetch-subtitles").addEventListener("click", fetchSubtitles);
  $("download-video").addEventListener("click", downloadMedia);
  $("download-cancel").addEventListener("click", () => state.download?.cancel());

  // 参考资料
  $("context-input").addEventListener("change", async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) return;
    const list = $("context-list");
    for (const file of files) {
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = file.name;
      const meta = document.createElement("span");
      meta.className = "file-meta";
      meta.textContent = "读取中…";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-quiet";
      remove.textContent = "移除";
      row.append(name, meta, remove);
      list.append(row);
      try {
        const item = await extractFile(file);
        state.context.push(item);
        const chars = item.kind === "image" ? "图片（随请求发送）" : `${item.text.length} 字符`;
        meta.textContent = chars;
        meta.className = "file-meta ok";
      } catch (error) {
        meta.textContent = error.message;
        meta.className = "file-meta err";
      }
      remove.addEventListener("click", () => {
        state.context = state.context.filter((c) => c.name !== file.name);
        row.remove();
      });
    }
    const vision = llm.capabilities.vision;
    if (state.context.some((c) => c.kind === "image") && !vision) {
      setNotice("context-status", "当前模型未声明视觉能力，图片不会参与请求；请在配置里勾选「支持视觉输入」。", "warning");
    } else {
      $("context-status").textContent = `已附加 ${state.context.length} 个文件，内容会随请求发送给模型服务。`;
    }
  });

  // 配置对话框
  $("config-list").addEventListener("change", (event) => {
    llm.setActiveConfig(event.target.value);
    loadConfigForm(llm.getActiveConfig());
  });
  $("new-config").addEventListener("click", () => {
    const config = { ...llm.getActiveConfig(), id: `cfg_${Date.now()}`, name: "新配置", apiKey: "" };
    llm.saveConfig(config);
    llm.setActiveConfig(config.id);
    refreshConfigList(config.id);
  });
  $("delete-config").addEventListener("click", () => {
    try {
      llm.deleteConfig($("config-list").value);
      refreshConfigList();
      setNotice("config-message", "已删除。", "success");
    } catch (error) {
      setNotice("config-message", error.message, "error");
    }
  });
  $("save-config").addEventListener("click", () => {
    try {
      saveConfig();
      setNotice("config-message", "配置已保存（仅存于当前浏览器）。", "success");
    } catch (error) {
      setNotice("config-message", error.message, "error");
    }
  });
  $("test-config").addEventListener("click", async () => {
    const button = $("test-config");
    button.disabled = true;
    try {
      const id = saveConfig();
      await llm.testConnection({ configId: id });
      setNotice("config-message", "连接成功。", "success");
    } catch (error) {
      setNotice("config-message", `连接失败：${error.message}${error.detail ? `（${error.detail}）` : ""}`, "error");
    } finally {
      button.disabled = false;
    }
  });
  $("toggle-key").addEventListener("click", () => {
    const input = $("cfg-api-key");
    input.type = input.type === "password" ? "text" : "password";
    $("toggle-key").textContent = input.type === "password" ? "显示" : "隐藏";
  });
  $("export-config").addEventListener("click", () => {
    downloadText(llm.exportConfigs(), "llm-configs.json", "application/json");
  });
  $("import-config").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const count = llm.importConfigs(await file.text(), { merge: true });
      refreshConfigList();
      setNotice("config-message", `已导入 ${count} 个配置（不含密钥，需要重新填写）。`, "success");
    } catch (error) {
      setNotice("config-message", error.message, "error");
    }
  });
}

// ---------------------------------------------------------------- 启动

async function boot() {
  const savedTheme = localStorage.getItem("yms.theme");
  if (savedTheme === "dark") document.documentElement.dataset.theme = "dark";

  bindEvents();
  await setupMedia();

  const info = await initCore();
  const badge = $("core-badge");
  if (info.engine === "wasm") {
    badge.textContent = `WASM 核心 v${info.version}`;
    badge.classList.remove("warn");
  } else {
    badge.textContent = "JS 降级核心";
    badge.classList.add("warn");
    badge.title = `WASM 不可用：${info.reason}`;
  }
  $("core-note").textContent =
    info.engine === "wasm" ? "Rust / WebAssembly · 独立子应用" : "纯 JS 降级模式（WASM 未加载，功能完整）";

  if (!location.pathname.includes("/youtube-media-studio/")) {
    hide("back-link");
  }

  renderDocStats();
  syncButtons();
  setPill("translation-status", "就绪");
}

boot().catch((error) => {
  setNotice("source-warnings", `启动失败：${error.message}`, "error");
  setPill("doc-stats", "启动失败", "err");
});
