import { LLMError, ErrorCode } from "./errors.js";
import { ProviderRegistry, defaultRegistry, DEFAULT_SYSTEM_PROMPT } from "./providers.js";

const STORAGE_KEY = "youtube_media_studio_llm_configs_v1";

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `cfg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function defaults() {
  const id = "default_openai_compatible";
  return {
    activeId: id,
    configs: {
      [id]: {
        id,
        name: "OpenAI-compatible",
        providerType: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
        temperature: 0.3,
        maxTokens: 4096,
        timeout: 60000,
        capabilities: { vision: false },
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
      },
    },
  };
}

/**
 * 配置管理 + 请求门面。
 * 只依赖注入了 `storage`，不碰 DOM —— 其他项目可直接 `new LLMModule({storage})` 复用。
 */
export class LLMModule {
  constructor({ storage = globalThis.localStorage, storageKey = STORAGE_KEY, registry = defaultRegistry, fetchImpl } = {}) {
    this.storage = storage;
    this.storageKey = storageKey;
    this.registry = registry;
    this.fetchImpl = fetchImpl;
    this.store = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(this.storage?.getItem(this.storageKey) || "null");
      if (parsed?.configs && Object.keys(parsed.configs).length) return parsed;
    } catch {
      // 存储损坏时回落到默认配置，避免整个应用起不来
    }
    return defaults();
  }

  #persist() {
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify(this.store));
    } catch (error) {
      throw new LLMError(`无法保存配置：${error.message}`, { code: ErrorCode.CONFIG });
    }
  }

  listConfigs() {
    return Object.values(this.store.configs).map((c) => ({ ...c, apiKey: c.apiKey ? "••••••••" : "" }));
  }

  getConfig(id = this.store.activeId) {
    const config = this.store.configs[id];
    if (!config) throw new LLMError("配置不存在", { code: ErrorCode.CONFIG });
    return { ...config, capabilities: { ...(config.capabilities || {}) } };
  }

  getActiveConfig() {
    return this.getConfig();
  }

  hasApiKey(id = this.store.activeId) {
    return Boolean(this.store.configs[id]?.apiKey);
  }

  saveConfig(input) {
    const config = { ...input, id: input.id || makeId() };
    if (!config.name?.trim()) throw new LLMError("配置名称不能为空", { code: ErrorCode.CONFIG });
    if (!config.baseUrl?.trim()) throw new LLMError("Base URL 不能为空", { code: ErrorCode.CONFIG });
    if (!config.model?.trim()) throw new LLMError("模型名称不能为空", { code: ErrorCode.CONFIG });
    config.baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    config.providerType = config.providerType || "openai-compatible";
    config.capabilities = { vision: false, ...(config.capabilities || {}) };
    this.store.configs[config.id] = config;
    if (!this.store.activeId) this.store.activeId = config.id;
    this.#persist();
    return config.id;
  }

  setActiveConfig(id) {
    if (!this.store.configs[id]) throw new LLMError("配置不存在", { code: ErrorCode.CONFIG });
    this.store.activeId = id;
    this.#persist();
    return true;
  }

  deleteConfig(id) {
    if (!this.store.configs[id]) return false;
    if (Object.keys(this.store.configs).length === 1) {
      throw new LLMError("至少保留一个配置", { code: ErrorCode.CONFIG });
    }
    delete this.store.configs[id];
    if (this.store.activeId === id) this.store.activeId = Object.keys(this.store.configs)[0];
    this.#persist();
    return true;
  }

  /** 导出恒不带密钥：配置文件经常被随手贴到聊天窗口或提交进仓库。 */
  exportConfigs() {
    return JSON.stringify(
      {
        activeId: this.store.activeId,
        configs: Object.fromEntries(
          Object.entries(this.store.configs).map(([id, c]) => [id, { ...c, apiKey: "" }]),
        ),
      },
      null,
      2,
    );
  }

  importConfigs(json, { merge = false } = {}) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new LLMError("配置文件不是合法 JSON", { code: ErrorCode.CONFIG });
    }
    if (!parsed?.configs || !Object.keys(parsed.configs).length) {
      throw new LLMError("配置文件缺少 configs 字段", { code: ErrorCode.CONFIG });
    }
    for (const [id, config] of Object.entries(parsed.configs)) {
      if (!config.name || !config.baseUrl || !config.model) {
        throw new LLMError(`配置 ${id} 缺少 name / baseUrl / model`, { code: ErrorCode.CONFIG });
      }
      parsed.configs[id] = { id, capabilities: { vision: false }, ...config };
    }
    this.store = merge
      ? { activeId: parsed.activeId || this.store.activeId, configs: { ...this.store.configs, ...parsed.configs } }
      : parsed;
    if (!this.store.configs[this.store.activeId]) this.store.activeId = Object.keys(this.store.configs)[0];
    this.#persist();
    return Object.keys(parsed.configs).length;
  }

  provider(config = this.getActiveConfig()) {
    return this.registry.create(config, { fetchImpl: this.fetchImpl });
  }

  get capabilities() {
    return this.provider().capabilities;
  }

  async complete(prompt, options = {}) {
    const config = options.configId ? this.getConfig(options.configId) : this.getActiveConfig();
    return this.registry.create(config, { fetchImpl: this.fetchImpl }).complete(prompt, options);
  }

  async stream(prompt, options = {}) {
    const config = options.configId ? this.getConfig(options.configId) : this.getActiveConfig();
    return this.registry.create(config, { fetchImpl: this.fetchImpl }).stream(prompt, options);
  }

  /** 列举某个配置（或当前配置）可用的模型；不修改已保存的默认模型。 */
  async listModels(options = {}) {
    const config = options.config || (options.configId ? this.getConfig(options.configId) : this.getActiveConfig());
    return this.registry.create(config, { fetchImpl: this.fetchImpl }).listModels(options);
  }

  async testConnection(options = {}) {
    const config = options.configId ? this.getConfig(options.configId) : this.getActiveConfig();
    return this.registry.create(config, { fetchImpl: this.fetchImpl }).testConnection(options);
  }
}

export { ProviderRegistry, defaultRegistry, DEFAULT_SYSTEM_PROMPT, LLMError, ErrorCode };
