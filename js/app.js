/**
 * 工作台 UI 编排层。
 *
 * 职责边界：这里只做"把用户动作映射到核心/任务/模块调用并渲染状态"，
 * 解析、分段、合并、请求、重试全部在各自模块里，换 UI 不需要重写这些逻辑。
 */
import { initCore, getCore, getCoreInfo } from "./core.js";
import { LLMModule, DEFAULT_SYSTEM_PROMPT } from "../lib/llm-module/index.js";
import { downloadText, suggestFilename } from "./subtitle_io.js";
import { extractSource } from "./document_source.js";
import { buildExport, documentToMarkdown, plainTextToMarkdown, stemOf } from "./exporters/index.js";
import { renderMarkdown } from "./markdown.js";
import { TranslationTask, TaskState } from "./task_runner.js";
import {
  YouTubeService,
  formatDuration,
  formatEta,
  saveBlob,
  openSink,
  LocalMediaSession,
  probeMedia,
  describeMedia,
  compatibilityHint,
  buildProvenance,
  describeProvenance,
  provenanceCaveat,
  buildNotes,
  serializeNotes,
  notesFilename,
  buildDownloadCommand,
  describeFollowUp,
  subtitleFilename,
  saveTextFile,
  describeSaveResult,
} from "./youtube/index.js";
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
  yt: null,
  video: null,
  player: null,
  tracks: [],
  formats: [],
  provenance: null,
  downloadJob: null,
  localSession: null,
  localMedia: null,
  context: [],
  sourceName: "subtitles",
  sourceKind: "subtitle",
  model: "",
  outputView: "source",
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
    updateNotesButton();
    return;
  }
  const core = getCore();
  const text = core.serializeSubtitles(doc, doc.format);
  const bytes = core.utf8ByteLen(text);
  const cueCount = doc.cues.length;
  // 文档（txt）没有 cue，显示"0 条字幕"会让用户以为导入失败
  const isDocument = cueCount === 0 && doc.format === "txt";
  setPill(
    "doc-stats",
    isDocument ? `${(doc.text || "").length} 字符 · ${formatBytes(bytes)}` : `${cueCount} 条 · ${formatBytes(bytes)}`,
  );
  $("doc-format").textContent =
    `${doc.format.toUpperCase()}${isDocument ? " · 文档（无时间轴）" : cueCount ? ` · ${cueCount} 条字幕` : ""}` +
    `${bytes >= 5000 ? " · 将分段翻译" : " · 全文翻译"}`;
  const plan = core.segmentSubtitles(doc, Number($("segment-count").value));
  state.plan = plan;
  renderPlan(plan);
  const warnings = doc.warnings || [];
  setNotice("source-warnings", warnings.length ? warnings.join("\n") : "", "warning");
  updateNotesButton();
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
      resetLiveOutput();
      hide("live-block");
      if (state.outputView === "preview") renderPreview();
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
    const result = await extractSource(file);
    $("raw-subtitles").value = result.text;
    state.sourceName = file.name;
    state.sourceKind = result.kind;
    state.version += 1;
    const ok = applyParsed(result.text, result.hint);
    if (ok) {
      const notes = [...result.warnings];
      notes.unshift(`已载入 ${file.name}（${result.encoding}，${formatBytes(result.bytes)}）`);
      if (result.kind === "document") {
        notes.push("这是文档内容：没有时间轴，按段落翻译；SRT / VTT 导出不可用，请用 TXT / MD / HTML / DOCX / PDF。");
      }
      const level = result.warnings.length || result.kind === "document" ? "warning" : "success";
      setNotice("source-warnings", notes.join("\n"), level);
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
  ["export-srt", "export-vtt", "export-txt", "export-document", "copy-result"].forEach((id) => {
    $(id).disabled = !hasOutput;
  });
  // 文档没有时间轴时，SRT/VTT 必然导不出来：提前禁用并说明，比点了再报错好
  const hasTimeline = Boolean(state.doc?.cues?.length);
  $("export-srt").disabled = !hasOutput || !hasTimeline;
  $("export-vtt").disabled = !hasOutput || !hasTimeline;
  // 字幕原文文件：有内容就能存，与是否翻译过无关
  $("save-source").disabled = !hasDoc;
  $("save-source-row").hidden = !hasDoc;
  if (!hasDoc) $("save-source-status").hidden = true;
}

// ---------------------------------------------------------------- 翻译

function buildPrompt(segmentText, targetLanguage) {
  const context = buildContextBlock(state.context);
  return buildTranslationPrompt({
    segmentText,
    targetLanguage,
    contextText: context.text,
    instruction: $("extra-instruction").value,
  });
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
  const model = state.model || undefined;

  resetLiveOutput();
  show("live-block");

  const task = new TranslationTask({
    segments: plan.segments,
    isCurrentVersion: () => versionAtStart === state.version,
    request: (text, ctx) =>
      llm.stream(buildPrompt(text, targetLanguage), {
        signal: ctx.signal,
        // 模型是每次请求的参数，不是全局配置：同一 API 下可随时换
        model,
        onChunk: (chunk) => {
          ctx.onChunk(chunk);
          appendLiveOutput(chunk);
        },
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
  const active = plan.segments.findIndex((_, i) => snapshot.segments[i]?.state === "running");
  if (active >= 0) $("live-meta").textContent = `第 ${active + 1}/${snapshot.total} 段`;
  else if (snapshot.state !== "running") $("live-meta").textContent = `${stateLabel(snapshot.state)} · ${snapshot.total} 段`;

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
  if (state.outputView === "preview") renderPreview();
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

// ---------------------------------------------------------------- 模型选择

/**
 * 一个 API 往往暴露多个模型（同一个 key 既能调快模型也能调强模型）。
 * 配置里的 model 只是**默认值**，翻译区这里选择的是**本次请求**用的模型：
 * 只记在 localStorage，不写回配置，避免"临时换个模型试一下"把默认值改坏。
 */
const modelCacheKey = (id) => `yms.models.${id}`;
const modelChoiceKey = (id) => `yms.model.${id}`;

function readModelCache(id) {
  try {
    const list = JSON.parse(localStorage.getItem(modelCacheKey(id)) || "[]");
    return Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeModelCache(id, ids) {
  try {
    localStorage.setItem(modelCacheKey(id), JSON.stringify([...new Set(ids)].sort()));
  } catch {
    // 隐私模式下写不进去不影响本次使用
  }
}

function renderModelOptions(models = null) {
  const config = llm.getActiveConfig();
  const select = $("model-select");
  const ids = new Set([config.model, ...readModelCache(config.id), ...(models || [])].filter(Boolean));
  const remembered = localStorage.getItem(modelChoiceKey(config.id)) || "";

  select.replaceChildren(new Option(`配置默认（${config.model}）`, ""));
  [...ids].sort().forEach((id) => select.add(new Option(id === config.model ? `${id} · 默认` : id, id)));
  select.value = remembered && ids.has(remembered) ? remembered : "";
  state.model = select.value;

  $("model-hint").textContent =
    ids.size > 1
      ? `当前接口有 ${ids.size} 个候选模型；切换只影响本次翻译，不改配置默认值。`
      : "同一 API 有多个模型时，点「刷新模型」从 /models 拉取列表后可直接切换。";
}

function selectModel(value) {
  const config = llm.getActiveConfig();
  state.model = value;
  try {
    if (value) localStorage.setItem(modelChoiceKey(config.id), value);
    else localStorage.removeItem(modelChoiceKey(config.id));
  } catch {
    // 存不下就只影响下次是否记住，不影响本次请求
  }
  $("model-hint").textContent = value
    ? `本次翻译使用 ${value}（不修改配置默认值）。`
    : `使用配置默认模型 ${config.model}。`;
}

async function refreshModels() {
  const button = $("refresh-models");
  if (!llm.hasApiKey()) {
    openConfig("先配置 API Key，才能从接口拉取模型列表。");
    return;
  }
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "获取中…";
  try {
    const config = llm.getActiveConfig();
    const models = await llm.listModels();
    const ids = models.map((item) => item.id);
    writeModelCache(config.id, ids);
    renderModelOptions(ids);
    button.textContent = `已获取 ${ids.length}`;
  } catch (error) {
    button.textContent = "获取失败";
    $("model-hint").textContent =
      `拉取失败：${error.message}${error.detail ? ` · ${error.detail}` : ""}` +
      " 可在配置弹窗里直接手填模型名，不影响翻译。";
  } finally {
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1600);
  }
}

// ---------------------------------------------------------------- 实时输出 / 预览

let liveBuffer = "";
let liveFrame = 0;

function resetLiveOutput() {
  liveBuffer = "";
  if (liveFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(liveFrame);
  liveFrame = 0;
  $("live-output").textContent = "";
  $("live-meta").textContent = "";
}

/** 流式片段按帧合并写 DOM：每个 token 都写一次会在长段落上把主线程拖住。 */
function appendLiveOutput(chunk) {
  liveBuffer += chunk;
  if (liveFrame) return;
  const flush = () => {
    liveFrame = 0;
    const el = $("live-output");
    el.textContent = liveBuffer;
    el.scrollTop = el.scrollHeight;
  };
  if (typeof requestAnimationFrame === "function") liveFrame = requestAnimationFrame(flush);
  else flush();
}

function setOutputView(view) {
  state.outputView = view === "preview" ? "preview" : "source";
  const preview = state.outputView === "preview";
  $("translation-output").classList.toggle("hidden", preview);
  $("translation-preview").classList.toggle("hidden", !preview);
  $("preview-note").classList.toggle("hidden", !preview);
  $("view-source").classList.toggle("is-active", !preview);
  $("view-preview").classList.toggle("is-active", preview);
  $("view-source").setAttribute("aria-selected", String(!preview));
  $("view-preview").setAttribute("aria-selected", String(preview));
  if (preview) renderPreview();
}

function currentTitle() {
  if (state.video?.meta?.title) return state.video.meta.title;
  // 没导入过文件时 sourceName 是占位值，不能把它当标题导出去
  const stem = state.sourceName && state.sourceName !== "subtitles" ? stemOf(state.sourceName) : "";
  return stem || "译文";
}

/** 预览与导出共用：优先按字幕结构转成带时间轴的 Markdown，失败才按纯文本。 */
function previewMarkdown() {
  const text = $("translation-output").value;
  try {
    const doc = getCore().parseSubtitles(text, state.doc?.format || "txt");
    if (doc.cues?.length) return documentToMarkdown({ doc, title: currentTitle() });
  } catch {
    // 用户编辑到一半或纯文本内容：落到下面的纯文本路径
  }
  return plainTextToMarkdown(text, { title: currentTitle() });
}

function renderPreview() {
  const box = $("translation-preview");
  if (!$("translation-output").value.trim()) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "还没有译文。翻译完成或手动输入后即可预览。";
    box.replaceChildren(empty);
    return;
  }
  // 唯一允许写入 HTML 的地方：输入是 renderMarkdown 的产物——它先转义全部原文，
  // 再拼自己生成的标签，且链接协议经过白名单。模型返回的原文不会以裸 HTML 进入 DOM。
  box.innerHTML = renderMarkdown(previewMarkdown());
}

// ---------------------------------------------------------------- 文档格式导出

function exportDocument() {
  const text = $("translation-output").value;
  if (!text.trim()) return;
  const format = $("export-format").value;
  const model = state.model || llm.getActiveConfig().model;

  // 以内容区的当前文本为准（用户可能手工改过），解析不了就当纯文本，绝不拿原文顶替
  let doc = null;
  try {
    const parsed = getCore().parseSubtitles(text, state.doc?.format || "txt");
    if (parsed.cues?.length) doc = parsed;
  } catch {
    doc = null;
  }

  try {
    const result = buildExport({
      format,
      doc,
      text,
      title: currentTitle(),
      source: state.sourceName,
      model,
    });
    if (result.printHtml) {
      openPrintView(result.printHtml);
      $("export-status").textContent = `已打开打印视图：在打印对话框选择「另存为 PDF」，建议文件名 ${result.filename}`;
      return;
    }
    if (result.bytes) {
      saveBlob(new Blob([result.bytes], { type: result.mime }), result.filename);
    } else {
      downloadText(result.text, result.filename, result.mime);
    }
    $("export-status").textContent = `已导出 ${result.filename}`;
  } catch (error) {
    setNotice("source-warnings", `导出失败：${error.message}`, "error");
  }
}

function openPrintView(html) {
  const win = window.open("", "_blank");
  if (!win) {
    setNotice("source-warnings", "浏览器拦截了新窗口。请允许本页弹出窗口后重试，或先导出 HTML 再打印。", "error");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
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

// ---------------------------------------------------------------- 视频 / 字幕 / 下载

/**
 * 通道偏好只存在本机：这是"我连的是哪台服务器"的部署信息，不该跟着翻译配置走，
 * 也不该被导出。地址不合法时保留用户输入但不切换，避免"切过去了却用不了"。
 */
const BACKEND_KEY = "yms.mediaBackend";
const INSTANCE_KEY = "yms.customInstance";

function readBackendPrefs() {
  try {
    return {
      id: localStorage.getItem(BACKEND_KEY) === "custom" ? "custom" : "executor",
      instanceUrl: localStorage.getItem(INSTANCE_KEY) || "",
    };
  } catch {
    return { id: "executor", instanceUrl: "" };
  }
}

function saveBackendPrefs(id, instanceUrl) {
  try {
    localStorage.setItem(BACKEND_KEY, id);
    localStorage.setItem(INSTANCE_KEY, instanceUrl || "");
  } catch {
    /* 隐私模式下 localStorage 可能不可写；不影响本次会话 */
  }
}

/**
 * 六项能力的真实状态。核心原则：**每一项单独判断，绝不用"需要执行器"一句话
 * 把整块功能判死**。
 *
 *   预览 / 元数据 / 字幕导入 / 本地媒体 —— 纯前端，永远可用；
 *   在线字幕抓取 —— 取决于当前通道，没有就明说"不可用"，并指向导入入口；
 *   YouTube 视频下载 —— 官方播放器不提供文件接口，通道不支持就没有，
 *                        不用任何代理或解析手段假装可以。
 *
 * 通道声明为 false 的能力，操作控件直接隐藏（而不是渲染出来再报错）；
 * 说明文字仍然保留，保证用户知道"为什么没有"和"还有什么替代路径"。
 */
function renderCapabilities(probe = null) {
  const caps = state.yt?.capabilities || { embed: true, metadata: true, subtitles: false, download: false };
  const custom = state.yt?.backendId === "custom";
  setPill("cap-embed", "可用", "ok");
  setPill("cap-import", "可用", "ok");
  setPill("cap-local", "可用", "ok");

  if (state.video?.meta) setPill("cap-meta", "已获取", "ok");
  else if (state.video?.metaError) setPill("cap-meta", "受限", "");
  else setPill("cap-meta", "待解析", "");

  if (!caps.subtitles) setPill("cap-subs", custom ? "需要实例" : "需要执行器", "");
  else if (probe && !probe.ok) setPill("cap-subs", custom ? "实例离线" : "执行器离线", "err");
  else setPill("cap-subs", probe ? "已连接" : "已配置", "ok");

  if (!caps.download) setPill("cap-dl", "官方无接口", "");
  else if (probe && !probe.ok) setPill("cap-dl", custom ? "实例离线" : "执行器离线", "err");
  else setPill("cap-dl", probe ? "已连接" : "已配置", "ok");

  $("subs-controls").hidden = !caps.subtitles;
  $("download-controls").hidden = !caps.download;
  $("track-select").disabled = !caps.subtitles;
  $("fetch-subtitles").disabled = !caps.subtitles;

  // 只在还没有解析视频时写默认说明；解析后由具体动作接管，不覆盖用户看到的真实结果
  if (!state.video) {
    $("subs-status").textContent = caps.subtitles
      ? "解析视频后可选择在线字幕轨道。"
      : "当前通道不提供在线字幕；下面的「导入字幕文件」「粘贴字幕文本」不依赖服务端，效果一样。";
  }
  if (!caps.download && !state.video) {
    $("download-status").textContent =
      "官方播放器不提供视频文件下载接口，纯前端也无法跨源读取媒体流。当前通道不支持下载时，请用下方的「导入本地视频 / 音频」。";
  }
}

/** 通道一句话说明。不同通道的能力边界不同，不能共用一句"已连接"。 */
function renderBackendStatus(probe = null) {
  const el = $("backend-status");
  if (!state.yt) return;
  const backend = state.yt.backend;
  if (state.yt.backendId === "custom") {
    if (!backend.configured) {
      el.textContent = `自建实例未生效：${backend.reason || "地址不合法"}`;
      return;
    }
    const stateText = !probe ? "待检测" : probe.ok ? "可用" : `不可用：${probe.reason}`;
    el.textContent = `通道：自建实例 ${backend.baseUrl} · ${stateText}。该通道的能力取决于实例配置，字幕与视频都会经过这台服务器。`;
    return;
  }
  if (!backend.configured) {
    el.textContent = "通道：自建执行器（未配置地址）。配置 media-api-base 后可获取在线字幕与下载成品文件。";
    return;
  }
  const stateText = !probe ? "待检测" : probe.ok ? `可用${probe.version ? ` · ${probe.version}` : ""}` : `不可用：${probe.reason}`;
  el.textContent = `通道：自建执行器 ${backend.baseUrl} · ${stateText}`;
}

async function refreshProbe() {
  const backend = state.yt?.backend;
  if (!backend?.configured) {
    renderCapabilities();
    renderBackendStatus();
    return null;
  }
  const probe = await state.yt.probe().catch((error) => ({ ok: false, reason: error?.message || "连接失败" }));
  renderCapabilities(probe);
  renderBackendStatus(probe);
  return probe;
}

async function setupMedia() {
  const baseUrl = window.MEDIA_API_BASE || readMetaBase();
  // 令牌由部署方注入（<script>window.EXECUTOR_TOKEN = "..."</script>），界面不提供输入框
  const prefs = readBackendPrefs();
  state.yt = new YouTubeService({
    baseUrl,
    token: window.EXECUTOR_TOKEN || "",
    backendId: prefs.id,
    instanceUrl: prefs.instanceUrl,
  });
  $("media-block").hidden = false;
  $("backend-select").value = state.yt.backendId;
  $("custom-instance-url").value = prefs.instanceUrl;
  $("custom-backend-box").classList.toggle("hidden", state.yt.backendId !== "custom");
  renderCapabilities();
  renderBackendStatus();

  if (!state.yt.backend.configured) return;
  // 探测放在解析之后异步做，不阻塞首屏
  const probe = await refreshProbe();
  if (probe && !probe.ok) {
    setNotice(
      "media-error",
      `${state.yt.backendId === "custom" ? "自建实例" : "媒体执行器"}连接失败：${probe.reason}。字幕与下载暂不可用，预览不受影响。`,
      "warning",
    );
  }
}

async function applyBackend(id, instanceUrl) {
  if (!state.yt) return;
  const trimmed = String(instanceUrl || "").trim();
  const result = state.yt.setBackend(id, { instanceUrl: trimmed, pageProtocol: location.protocol });
  if (!result.ok) {
    $("backend-status").textContent = `未切换：${result.reason}`;
    $("backend-select").value = state.yt.backendId;
    return;
  }
  saveBackendPrefs(state.yt.backendId, trimmed);
  $("backend-select").value = state.yt.backendId;
  $("custom-instance-url").value = trimmed;
  $("custom-backend-box").classList.toggle("hidden", state.yt.backendId !== "custom");
  // 通道变了，之前那份轨道/格式清单已经不属于当前通道，必须清掉重取
  state.tracks = [];
  state.formats = [];
  renderCapabilities();
  renderBackendStatus();
  await refreshProbe();
  if (state.video) await loadTracksAndFormats();
}

function renderVideo(video) {
  $("player-wrap").classList.remove("hidden");
  const meta = video.meta;
  $("video-title").textContent = meta?.title || `视频 ${video.videoId}`;
  $("video-sub").textContent = [
    meta?.author || "",
    video.start > 0 ? `从 ${formatDuration(video.start)} 开始` : "",
    meta ? "" : "（标题获取失败，但预览不受影响）",
  ]
    .filter(Boolean)
    .join(" · ");
  $("video-link").href = video.canonicalUrl;

  const thumb = $("video-thumb");
  thumb.alt = meta?.title || "视频封面";
  thumb.classList.add("hidden"); // 先隐藏：加载失败时不留一个 16:9 的空盒子
  if (meta?.thumbnailCandidates?.length) {
    const queue = [...meta.thumbnailCandidates];
    thumb.onload = () => thumb.classList.remove("hidden");
    thumb.onerror = () => {
      const next = queue.shift();
      if (next) thumb.src = next;
      else thumb.classList.add("hidden");
    };
    thumb.src = queue.shift();
  }

  if (state.player) state.player.destroy();
  state.player = state.yt.mountPlayer($("player"), {
    videoId: video.videoId,
    start: video.start,
  });
  // API 只是增强：拿到真实时长，失败就保持"时长未知"，不编造
  state.player.enhance().then((ok) => {
    if (!ok) return;
    const duration = state.player.getDuration();
    if (duration > 0) {
      $("video-sub").textContent = [state.player && meta?.author, formatDuration(duration)].filter(Boolean).join(" · ");
    }
  });
  renderCliCommand(video);
}

/**
 * 生成"在你自己电脑上下载"的命令。
 *
 * 这是零后端下载的唯一实现方式：浏览器的同源策略不允许页面读取 googlevideo 的字节
 * （WASM 也绕不过，它没有独立网络栈），所以下载必须发生在用户自己的机器上。
 * 网页只拼命令，不发请求、不读 cookie、不写盘。
 */
function renderCliCommand(video = state.video) {
  const box = $("cli-command");
  const button = $("cli-copy");
  if (!video?.canonicalUrl) {
    box.textContent = "先在上面粘贴并解析视频链接";
    button.disabled = true;
    return;
  }
  const quality = $("cli-quality").value;
  const subs = $("cli-subs").value;
  try {
    box.textContent = buildDownloadCommand({ url: video.canonicalUrl, quality, subs });
    button.disabled = false;
    $("cli-status").textContent = describeFollowUp({ subs });
  } catch (error) {
    box.textContent = error.message;
    button.disabled = true;
  }
}

async function copyCliCommand() {
  const text = $("cli-command").textContent;
  try {
    await navigator.clipboard.writeText(text);
    $("cli-status").textContent = "已复制。在你自己的终端里粘贴执行，下载完把文件拖回下面的导入区。";
  } catch {
    // 非 HTTPS 或用户拒绝剪贴板权限：选中文本，让用户自己按 Ctrl+C，不假装成功
    const range = document.createRange();
    range.selectNodeContents($("cli-command"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    $("cli-status").textContent = "浏览器不允许直接写剪贴板，命令已选中，请按 Ctrl+C / ⌘C 复制。";
  }
}

async function resolveVideo() {
  if (!state.yt) return;
  hide("media-error");
  const parsed = state.yt.tryParse($("video-url").value);
  if (!parsed.ok) {
    setPill("media-status", "链接无效", "err");
    setNotice("media-error", parsed.message, "error");
    return;
  }

  $("resolve-video").disabled = true;
  setPill("media-status", "解析中", "busy");
  try {
    state.video = await state.yt.resolve($("video-url").value);
    renderVideo(state.video);
    setPill("media-status", state.video.meta ? "解析成功" : "仅预览可用", state.video.meta ? "ok" : "");
    if (state.video.metaError) {
      setNotice(
        "media-error",
        `标题获取失败：${state.video.metaError.message}。视频仍然可以预览，也可以直接载入字幕。`,
        "warning",
      );
    }
    renderCapabilities();
    updateNotesButton();
    await loadTracksAndFormats();
  } catch (error) {
    setPill("media-status", "解析失败", "err");
    setNotice("media-error", error.message, "error");
  } finally {
    $("resolve-video").disabled = false;
  }
}

async function loadTracksAndFormats() {
  const video = state.video;

  if (!state.yt?.capabilities.subtitles) {
    const select = $("track-select");
    select.replaceChildren(new Option(state.yt?.backendId === "custom" ? "需要配置实例" : "需要执行器", ""));
    select.disabled = true;
    $("fetch-subtitles").disabled = true;
    $("subs-status").textContent =
      "当前通道不提供在线字幕。也可以用下面的「导入字幕文件」或「粘贴字幕文本」直接载入，同样进入分段翻译流程。";
  } else {
    try {
      const tracks = await state.yt.listTracks(video);
      const select = $("track-select");
      select.replaceChildren();
      if (!tracks.length) {
        select.add(new Option("该视频没有可用字幕", ""));
        select.disabled = true;
        $("fetch-subtitles").disabled = true;
        $("subs-status").textContent =
          "该视频没有可用字幕（原生字幕和自动生成字幕都没有）。这是视频本身的状态，不是加载失败。若你手上有字幕文件，可以直接导入。";
      } else {
        select.add(new Option("选择字幕轨道", ""));
        tracks.forEach((track) => {
          const kind = track.kind === "auto" ? "自动生成" : "原生";
          select.add(new Option(`${track.name} · ${kind}`, track.id));
        });
        select.disabled = false;
        $("fetch-subtitles").disabled = false;
        const auto = tracks.filter((t) => t.kind === "auto").length;
        $("subs-status").textContent = `可用字幕 ${tracks.length} 条，其中自动生成 ${auto} 条。`;
      }
      state.tracks = tracks;
    } catch (error) {
      $("subs-status").textContent = error.message;
      setPill("cap-subs", "获取失败", "err");
    }
  }

  if (!state.yt?.capabilities.download) {
    $("download-status").textContent =
      "官方播放器不提供视频文件下载接口，纯前端也无法跨源读取媒体流。当前通道不支持下载时，请用下方的「导入本地视频 / 音频」。";
    fillFormatOptions();
    return;
  }
  try {
    const info = await state.yt.resolveFormats(video);
    state.formats = info.formats || [];
    fillFormatOptions();
    $("download-start").disabled = !state.formats.length;
  } catch (error) {
    $("download-status").textContent = error.message;
  }
}

function fillFormatOptions() {
  const mode = $("download-mode").value;
  const select = $("format-select");
  if (!state.yt?.capabilities.download) {
    select.replaceChildren(new Option("官方无下载接口", ""));
    select.disabled = true;
    $("download-start").disabled = true;
    return;
  }
  const formats = (state.formats || []).filter((f) => f.kind === mode);
  select.replaceChildren();
  if (!formats.length) {
    select.add(new Option(mode === "audio" ? "无独立音频流" : "无可用视频格式", ""));
    select.disabled = true;
    return;
  }
  formats.forEach((f) => {
    const size = f.filesize ? ` · ${formatBytes(f.filesize)}` : "";
    select.add(new Option(`${f.label} ${f.ext}${f.hasAudio ? "" : " · 无声"}${size}`, f.id));
  });
  select.disabled = false;
}

async function fetchSubtitles() {
  const trackId = $("track-select").value;
  if (!trackId) {
    setNotice("media-error", "请先选择一个字幕轨道", "error");
    return;
  }
  $("fetch-subtitles").disabled = true;
  $("subs-status").textContent = "正在获取字幕…";
  try {
    const result = await state.yt.loadSubtitles(state.video, trackId);
    state.version += 1;
    // 通道可能给 SRT 也可能给 VTT（实例默认发 VTT），按它声明的格式解析，
    // 不强行当 SRT 读——那会把 VTT 的头部当成字幕正文。
    const ok = applyParsed(result.text, result.format || "srt");
    if (!ok) throw new Error("返回的字幕无法解析为 SRT/VTT");
    const track = state.tracks.find((t) => t.id === trackId);
    // 来源与时间轴一起记下来，笔记回看时能对回原视频
    state.provenance = buildProvenance({
      video: state.video,
      via: state.yt.backendId === "custom" ? "instance" : "executor",
      track: track ? `${track.name}（${track.kind === "auto" ? "自动生成" : "原生"}）` : trackId,
      cueCount: state.doc?.cues?.length ?? 0,
    });
    state.sourceName = state.video.videoId;
    $("subs-status").textContent = `已载入 ${describeProvenance(state.provenance)} · 来源 ${state.video.canonicalUrl}${
      state.video.start ? `（从 ${formatDuration(state.video.start)} 开始）` : ""
    }`;
    updateNotesButton();
  } catch (error) {
    $("subs-status").textContent = `获取失败：${error.message}`;
    setNotice("media-error", error.message, "error");
  } finally {
    $("fetch-subtitles").disabled = false;
  }
}

/**
 * 保存**字幕原文**为文件。
 *
 * 这是移动端的主路径：iOS Safari 没有 showSaveFilePicker，对 blob: + <a download>
 * 又常常变成"新标签打开一屏字"，所以交给系统分享面板（存到「文件」/ 微信）。
 *
 * 手势约束：从点击到这里不能有 await。下面的 serializeSubtitle 是同步的，
 * saveTextFile 内部第一件事就是同步调用 share()，链条是完整的。
 */
async function saveSourceSubtitles() {
  if (!state.doc) return;
  const hasTimeline = Boolean(state.doc.cues?.length);
  const format = hasTimeline ? "srt" : "txt";
  let text = "";
  try {
    text = getCore().serializeSubtitles(state.doc, format);
  } catch (error) {
    // 文档类内容（无时间轴）没有 SRT 可序列化，直接说明而不是给个空文件
    setNotice("source-warnings", `无法生成 ${format.toUpperCase()}：${error.message}`, "error");
    return;
  }
  const track = (state.tracks || []).find((item) => item.id === $("track-select").value) || null;
  // 导入的文件没有视频信息，用文件名当标题；直接带 .srt 会得到 a.srt.srt
  const fallbackTitle =
    state.sourceName && state.sourceName !== "subtitles" ? stemOf(state.sourceName) : "";
  const filename = subtitleFilename({
    title: state.video?.meta?.title || fallbackTitle,
    videoId: state.video?.videoId || "",
    lang: track?.lang || "",
    ext: format,
  });
  const status = $("save-source-status");
  const button = $("save-source");
  button.disabled = true;
  try {
    const result = await saveTextFile({ text, filename, mime: MIME[format] });
    status.hidden = false;
    status.textContent = describeSaveResult(result, {
      sizeText: formatBytes(new TextEncoder().encode(text).byteLength),
    });
  } catch (error) {
    status.hidden = false;
    status.textContent = `保存失败：${error.message}`;
  } finally {
    button.disabled = !state.doc;
  }
}

async function downloadMedia() {
  if (!state.yt || !state.video) return;
  const mode = $("download-mode").value;
  const formatId = $("format-select").value;
  const progress = $("download-progress");
  const ext = mode === "audio" ? "m4a" : "mp4";
  // 文件名先给一个可读的猜测；服务端返回 Content-Disposition 时以服务端为准
  const guess = `${(state.video.meta?.title || state.video.videoId).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.${ext}`;
  const chosen = (state.formats || []).find((f) => f.id === formatId);
  const totalBytes = Number(chosen?.filesize) || 0;

  $("download-start").disabled = true;
  $("download-cancel").disabled = false;

  // 关键顺序：**先要落盘位置，再发请求**。
  // showSaveFilePicker 需要用户手势，放在 await fetch 之后会因手势过期抛 SecurityError；
  // 先问路径还有一个好处——用户在选择器里停留时，不必先把字节读进内存。
  let sink;
  try {
    sink = await openSink({ filename: guess, totalBytes, mode });
  } catch (error) {
    $("download-start").disabled = false;
    $("download-cancel").disabled = true;
    $("download-status").textContent =
      error.code === "canceled" ? "已取消保存位置选择，未开始下载。" : `无法准备保存位置：${error.message}`;
    return;
  }

  progress.hidden = false;
  // 准备阶段还不知道总大小，进度条必须是不确定态：给 value=0 会被读成"0%"，
  // 而 0% 意味着"一点都没动"，与事实不符。
  progress.removeAttribute("value");
  if (sink.warn) $("download-status").textContent = `${sink.warn}。`;

  try {
    state.downloadJob = state.yt.createDownloadJob(state.video, { mode, formatId });
    const result = await state.downloadJob.start({
      sink,
      onProgress: ({ phase, received, total, bytesPerSecond, etaSeconds }) => {
        // 瞬时速度拿不到时显示 "—"，不显示 0：0 会被理解成"卡住了"
        const speed =
          bytesPerSecond == null
            ? "速度 —"
            : `${formatBytes(bytesPerSecond)}/s${etaSeconds ? ` · 剩余 ${formatEta(etaSeconds)}` : ""}`;
        if (total > 0 && phase !== "preparing") {
          progress.value = Math.min(100, Math.round((received / total) * 100));
          $("download-status").textContent = `${phaseLabel(phase)} ${formatBytes(received)} / ${formatBytes(total)}（${progress.value}%）· ${speed}`;
        } else {
          // 总大小未知（或还在准备）：保持不确定态，只说已接收多少
          progress.removeAttribute("value");
          $("download-status").textContent = `${phaseLabel(phase)} 已接收 ${formatBytes(received)}（总大小未知）· ${speed}`;
        }
      },
    });
    progress.value = 100;
    const average =
      result.averageBytesPerSecond > 0 ? ` · 平均 ${formatBytes(result.averageBytesPerSecond)}/s` : "";
    if (result.saved?.kind === "fs") {
      // 已经写进用户选的文件，不能再触发一次下载
      $("download-status").textContent = `已保存：${result.saved.filename}（${formatBytes(result.saved.bytes)}）${average}`;
    } else {
      // 走 sink 时内容在 saved.blob 里，result.blob 为 null；两个来源都要认
      const blob = result.blob || result.saved?.blob;
      const name = result.filename || result.saved?.filename || guess;
      if (!blob) throw new Error("下载结果缺少文件内容");
      saveBlob(blob, name);
      const warn = result.saved?.warn ? ` · ${result.saved.warn}` : "";
      $("download-status").textContent = `下载完成：${name}（${formatBytes(result.saved?.bytes || blob.size || 0)}）${average}${warn}`;
    }
  } catch (error) {
    progress.hidden = true;
    // 任务没跑起来（建任务就失败）时，sink 还开着，必须显式收掉
    try {
      await sink.abort();
    } catch {
      /* 清理失败不覆盖原始错误 */
    }
    $("download-status").textContent =
      error.code === "canceled" ? "已取消下载。" : `下载失败：${error.message}`;
  } finally {
    $("download-start").disabled = false;
    $("download-cancel").disabled = true;
    state.downloadJob = null;
  }
}

// ---------------------------------------------------------------- 零后端闭环：导入 / 本地媒体 / 笔记素材

/**
 * 导入字幕文件。
 *
 * 走的是和主页拖放区**完全相同**的解析链路（readSubtitleFile → applyParsed →
 * WASM 分段），区别只在来源标注：文件来源不会被记成"来自 YouTube"，
 * 否则笔记回看时会把用户自己的文件错认成官方字幕。
 */
async function importSubtitleFile(file) {
  if (!file) return;
  $("import-status").textContent = `正在读取 ${file.name}…`;
  try {
    const result = await extractSource(file);
    $("raw-subtitles").value = result.text;
    state.version += 1;
    state.sourceName = file.name;
    state.sourceKind = result.kind;
    if (!applyParsed(result.text, result.hint)) {
      $("import-status").textContent = `无法解析 ${file.name}（.${result.ext}）：内容不是可识别的字幕或文本`;
      return;
    }
    state.provenance = buildProvenance({
      video: state.video,
      via: "file",
      filename: file.name,
      cueCount: state.doc?.cues?.length ?? 0,
    });
    $("import-status").textContent = `已载入 ${file.name}（${result.encoding}，${formatBytes(result.bytes)}）· ${
      state.provenance.sourceLabel
    } · ${provenanceCaveat(state.provenance)}`;
  } catch (error) {
    $("import-status").textContent = `读取失败：${error.message}`;
  }
}

function applyPastedSubtitle() {
  const text = $("paste-text").value;
  if (!text.trim()) {
    $("import-status").textContent = "粘贴框是空的";
    return;
  }
  $("raw-subtitles").value = text;
  state.version += 1;
  if (!applyParsed(text, "")) {
    $("import-status").textContent = "无法解析粘贴的内容：请确认是 SRT / VTT，或至少是纯文本";
    return;
  }
  state.provenance = buildProvenance({
    video: state.video,
    via: "paste",
    cueCount: state.doc?.cues?.length ?? 0,
  });
  // 纯文本没时间轴，必须在界面上说清楚，否则用户会以为时间轴丢了
  const timeless = (state.doc?.cues || []).every((cue) => !cue.start);
  $("import-status").textContent = `已载入粘贴内容 · ${describeProvenance(state.provenance)}${
    timeless ? " · 无时间轴（纯文本，按行分段）" : ""
  }`;
}

function setupLocalMedia() {
  state.localSession = new LocalMediaSession();
  $("local-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    // 清空 value：否则再次选择同一个文件不会触发 change
    event.target.value = "";
    if (!file) return;
    try {
      const { url, kind } = state.localSession.select(file);
      state.localMedia = describeMedia(file);
      renderLocalPreview(url, kind, file);
    } catch (error) {
      $("local-status").textContent = error.message;
    }
  });
  $("local-clear").addEventListener("click", () => {
    state.localSession.release();
    state.localMedia = null;
    $("local-preview").replaceChildren();
    hide("local-preview");
    $("local-clear").disabled = true;
    $("local-status").textContent = "已移除，objectURL 已释放";
  });
}

function renderLocalPreview(url, kind, file) {
  const box = $("local-preview");
  const el = document.createElement(kind === "audio" ? "audio" : "video");
  el.className = "local-media";
  el.controls = true;
  el.preload = "metadata";
  el.addEventListener("error", () => {
    $("local-status").textContent =
      "这个文件浏览器无法解码（容器或编码不支持），文件本身仍保留。可换 MP4(H.264) / WebM 再试。";
  });
  el.src = url;
  box.replaceChildren(el);
  box.classList.remove("hidden");
  $("local-clear").disabled = false;

  const base = `${file.name} · ${formatBytes(file.size)}`;
  const hint = compatibilityHint(file);
  $("local-status").textContent = hint ? `${base} · ${hint}` : base;
  updateNotesButton();

  // 时长/分辨率是增强信息：拿不到就不显示，不写"未知"占位
  probeMedia(url, kind, { createElement: (tag) => document.createElement(tag) }).then((info) => {
    if (!info) return;
    const parts = [base];
    if (info.duration) parts.push(formatDuration(info.duration));
    if (info.width) parts.push(`${info.width}×${info.height}`);
    $("local-status").textContent = parts.join(" · ");
  });
}

function updateNotesButton() {
  const cueCount = state.doc?.cues?.length || 0;
  const parts = [
    state.video ? "视频信息" : "",
    cueCount ? `${cueCount} 条字幕` : "",
    state.localMedia ? "本地媒体信息" : "",
  ].filter(Boolean);
  $("export-notes").disabled = parts.length === 0;
  $("notes-status").textContent = parts.length
    ? `将导出：${parts.join(" + ")}`
    : "载入字幕后可导出：视频信息 + 时间轴 + 分段计划";
}

/** 导出笔记素材：这是给分段/翻译/摘要引擎吃的中间结构，不是最终笔记。 */
function exportNotes() {
  const core = getCore();
  const doc = state.doc;
  const sourceText = doc ? core.serializeSubtitles(doc, doc.format) : "";
  // 译文条数与字幕不一致时宁可不带，也不能错位
  const translatedCues = state.translated?.cues;
  const translations =
    doc && translatedCues?.length === doc.cues.length ? translatedCues.map((cue) => cue.text) : null;

  const notes = buildNotes({
    video: state.video,
    provenance: state.provenance,
    doc,
    sourceText,
    plan: state.plan,
    translations,
    localMedia: state.localMedia,
    engine: getCoreInfo().engine,
  });
  const filename = notesFilename({ videoId: state.video?.videoId });
  downloadText(serializeNotes(notes), filename, "application/json;charset=utf-8");
  $("notes-status").textContent = `已导出 ${filename}${
    notes.warnings.length ? ` · 注意：${notes.warnings.join("；")}` : ""
  }`;
}

function phaseLabel(phase) {
  const map = { preparing: "准备中", transferring: "传输中", done: "完成", idle: "等待" };
  return map[phase] || "进行中";
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
  renderModelOptions();
  return id;
}

/** 配置弹窗里的「拉取列表」：用表单当前值请求，不必先保存。 */
async function fetchModelsInConfig() {
  const button = $("fetch-models");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "获取中…";
  try {
    const config = collectConfig();
    const models = await llm.listModels({ config });
    const list = $("cfg-model-options");
    list.replaceChildren(
      ...models.map((item) => {
        const option = document.createElement("option");
        option.value = item.id;
        return option;
      }),
    );
    writeModelCache(config.id, models.map((item) => item.id));
    renderModelOptions(models.map((item) => item.id));
    setNotice("config-message", `已获取 ${models.length} 个模型，点击模型输入框可从下拉里选择。`, "success");
  } catch (error) {
    setNotice(
      "config-message",
      `拉取失败：${error.message}${error.detail ? `（${error.detail}）` : ""}。可直接手填模型名。`,
      "error",
    );
  } finally {
    button.textContent = original;
    button.disabled = false;
  }
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

  // 模型选择
  $("model-select").addEventListener("change", (event) => selectModel(event.target.value));
  $("refresh-models").addEventListener("click", () => refreshModels());

  // 输出
  $("view-source").addEventListener("click", () => setOutputView("source"));
  $("view-preview").addEventListener("click", () => setOutputView("preview"));
  $("export-document").addEventListener("click", exportDocument);
  $("translation-output").addEventListener("input", () => {
    const core = getCore();
    $("output-stats").textContent = `${core.utf8ByteLen($("translation-output").value)} 字节`;
    syncButtons();
  });
  $("export-format").addEventListener("change", () => {
    const format = $("export-format").value;
    $("export-status").textContent =
      format === "pdf"
        ? "PDF 通过浏览器打印生成：会打开排版视图，在打印对话框选择「另存为 PDF」即可。"
        : `将导出 ${format.toUpperCase()} 文档，排版与「预览（Markdown）」一致。`;
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
  $("video-url").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      resolveVideo();
    }
  });
  $("fetch-subtitles").addEventListener("click", fetchSubtitles);
  $("save-source").addEventListener("click", saveSourceSubtitles);
  $("download-start").addEventListener("click", downloadMedia);
  $("download-mode").addEventListener("change", fillFormatOptions);
  $("download-cancel").addEventListener("click", () => state.downloadJob?.cancel());
  // 零后端下载：只拼命令，任何选择变化都不发请求
  $("cli-quality").addEventListener("change", () => renderCliCommand());
  $("cli-subs").addEventListener("change", () => renderCliCommand());
  $("cli-copy").addEventListener("click", copyCliCommand);

  // 媒体通道：默认执行器；自定义实例必须显式保存并检测，不静默生效
  $("backend-select").addEventListener("change", () => {
    const id = $("backend-select").value;
    $("custom-backend-box").classList.toggle("hidden", id !== "custom");
    if (id === "executor") {
      applyBackend("executor", "");
    } else {
      $("backend-status").textContent = "填写你自己部署的实例地址，然后点「保存并检测」。";
    }
  });
  $("backend-apply").addEventListener("click", () =>
    applyBackend($("backend-select").value, $("custom-instance-url").value),
  );
  $("custom-backend-save").addEventListener("click", () =>
    applyBackend("custom", $("custom-instance-url").value),
  );
  $("custom-instance-url").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    applyBackend("custom", $("custom-instance-url").value);
  });

  // 零后端路径：字幕文件 / 粘贴文本 / 本地媒体 / 笔记导出
  $("sub-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    importSubtitleFile(file);
  });
  $("paste-toggle").addEventListener("click", () => {
    const box = $("paste-box");
    const willOpen = box.classList.contains("hidden");
    box.classList.toggle("hidden", !willOpen);
    $("paste-toggle").setAttribute("aria-expanded", String(willOpen));
    if (willOpen) $("paste-text").focus();
  });
  $("paste-apply").addEventListener("click", applyPastedSubtitle);
  $("export-notes").addEventListener("click", exportNotes);
  setupLocalMedia();

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
    renderModelOptions();
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
  $("fetch-models").addEventListener("click", fetchModelsInConfig);
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

  renderModelOptions();
  renderDocStats();
  syncButtons();
  setPill("translation-status", "就绪");
}

boot().catch((error) => {
  setNotice("source-warnings", `启动失败：${error.message}`, "error");
  setPill("doc-stats", "启动失败", "err");
});
