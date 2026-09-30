// Provider interface, the OpenAI-compatible client, the Anthropic Messages
// client, and the registry that wires them up.
//
// Mirrors internal/provider/{provider,openai,anthropic,registry}.go

export const HTTP_TIMEOUT_MS = 180_000;
export const MAX_RESPONSE_BYTES = 8 << 20;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface Message {
  role: Role;
  content: string;
  name?: string;
  /** toolCallID links a tool result back to the call that produced it. */
  tool_call_id?: string;
  /** toolCalls is set on an assistant message that requested tools. */
  tool_calls?: ToolCall[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  temperature?: number;
  max_tokens?: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface CompletionResponse {
  content: string;
  tool_calls?: ToolCall[];
  finish_reason?: string;
  model?: string;
  usage?: Usage;
}

export interface Provider {
  name(): string;
  label(): string;
  requiresAPIKey(): boolean;
  listModels(): Promise<string[]>;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

/** ErrNoAPIKey is thrown when a provider is selected but unconfigured. */
export class NoAPIKeyError extends Error {
  constructor() {
    super("no API key configured for this provider");
    this.name = "NoAPIKeyError";
  }
}
export const ErrNoAPIKey = new NoAPIKeyError();

export function isNoAPIKey(err: unknown): boolean {
  return (
    err instanceof NoAPIKeyError ||
    (err instanceof Error && err.name === "NoAPIKeyError")
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function truncateBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length > 400) return trimmed.slice(0, 400) + "…";
  return trimmed === "" ? "empty response body" : trimmed;
}

/** extractError pulls the human readable message out of a provider error body. */
export function extractError(data: string): string {
  try {
    const parsed = JSON.parse(data) as {
      error?: { message?: string };
      message?: string;
      detail?: string;
    };
    const candidates = [parsed?.error?.message, parsed?.message, parsed?.detail];
    for (const c of candidates) {
      if (typeof c === "string" && c !== "") return c;
    }
  } catch {
    /* fall through to the raw payload */
  }
  return truncateBody(data);
}

interface DoOptions {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function doJSON<T>(opts: DoOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const init: RequestInit = {
      method: opts.method,
      headers: {
        "content-type": "application/json",
        ...(opts.headers ?? {}),
      },
      signal: controller.signal,
    };
    if (opts.body !== undefined && opts.body !== null) {
      init.body = JSON.stringify(opts.body);
    }

    const res = await fetch(opts.url, init);
    const text = await res.text();

    if (!res.ok) {
      const status = `${res.status}${res.statusText ? " " + res.statusText : ""}`;
      throw new Error(`${status}: ${extractError(text)}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// OpenAI compatible
// ---------------------------------------------------------------------------

interface OpenAIOptions {
  name: string;
  label: string;
  /** API root without a trailing slash. */
  baseURL: string;
  /** Labels the credential in setup prompts, e.g. "API key". */
  keyName: string;
  defaultModel: string;
  /** Static catalogues avoid a network round trip. */
  staticModels?: string[];
  /** noKey marks a backend that needs no credential. */
  noKey?: boolean;
}

/**
 * OpenAICompatible talks to any service exposing the OpenAI chat completions
 * API: OpenAI, Cloudflare Workers AI, Groq, Together, OpenRouter, Ollama.
 */
export class OpenAICompatible implements Provider {
  /** API key or bearer token. Cloudflare also needs accountId. */
  key = "";
  accountId = "";

  readonly baseURL: string;
  readonly keyName: string;
  readonly defaultModel: string;
  readonly staticModels: string[];
  readonly noKey: boolean;

  private readonly id: string;
  private readonly lbl: string;

  constructor(opts: OpenAIOptions) {
    this.id = opts.name;
    this.lbl = opts.label;
    this.baseURL = opts.baseURL.replace(/\/+$/, "");
    this.keyName = opts.keyName;
    this.defaultModel = opts.defaultModel;
    this.staticModels = opts.staticModels ?? [];
    this.noKey = opts.noKey ?? false;
  }

  name(): string {
    return this.id;
  }
  label(): string {
    return this.lbl;
  }
  requiresAPIKey(): boolean {
    return !this.noKey;
  }

  async listModels(): Promise<string[]> {
    if (this.staticModels.length > 0) return [...this.staticModels];
    if (!this.key && !this.noKey) throw ErrNoAPIKey;

    const out = await doJSON<{ data?: Array<{ id: string }> }>({
      method: "GET",
      url: this.baseURL + "/models",
      headers: this.authHeaders(),
    });
    return (out.data ?? []).map((m) => m.id);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (!this.key && !this.noKey) throw ErrNoAPIKey;
    const model = req.model || this.defaultModel;

    const body: Record<string, unknown> = { model, messages: req.messages };
    if (req.temperature) body.temperature = req.temperature;
    if (req.max_tokens) body.max_tokens = req.max_tokens;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = "auto";
    }

    const out = await doJSON<{
      choices?: Array<{
        message: { content?: string; tool_calls?: ToolCall[] };
        finish_reason?: string;
      }>;
      usage?: Usage;
      model?: string;
    }>({
      method: "POST",
      url: this.baseURL + "/chat/completions",
      body,
      headers: this.authHeaders(),
    });

    if (!out.choices || out.choices.length === 0) {
      throw new Error(`${this.lbl} returned no choices`);
    }
    const choice = out.choices[0];
    return {
      content: choice.message.content ?? "",
      tool_calls: choice.message.tool_calls,
      finish_reason: choice.finish_reason,
      model: out.model,
      usage: out.usage,
    };
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    if (this.accountId) headers["CF-Access-Client-Id"] = this.accountId;
    return headers;
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

interface AnthropicOptions {
  key?: string;
  baseURL?: string;
  defaultModel?: string;
  maxTokens?: number;
  staticModels?: string[];
}

/**
 * Anthropic talks to the Claude Messages API, which differs from the OpenAI
 * shape: a separate system field, no system role inside messages, and tool
 * use split across content blocks.
 */
export class Anthropic implements Provider {
  key: string;
  readonly baseURL: string;
  readonly defaultModel: string;
  readonly maxTokens: number;
  readonly staticModels: string[];

  constructor(opts: AnthropicOptions = {}) {
    this.key = opts.key ?? "";
    this.baseURL = (opts.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.defaultModel = opts.defaultModel ?? "claude-sonnet-4-5";
    this.maxTokens = opts.maxTokens ?? 4096;
    this.staticModels = opts.staticModels ?? [];
  }

  name(): string {
    return "anthropic";
  }
  label(): string {
    return "Anthropic Claude";
  }
  requiresAPIKey(): boolean {
    return true;
  }

  async listModels(): Promise<string[]> {
    if (this.staticModels.length > 0) return [...this.staticModels];
    if (!this.key) throw ErrNoAPIKey;

    const out = await doJSON<{ data?: Array<{ id: string }> }>({
      method: "GET",
      url: this.baseURL + "/v1/models",
      headers: this.authHeaders(),
    });
    return (out.data ?? []).map((m) => m.id);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (!this.key) throw ErrNoAPIKey;
    const model = req.model || this.defaultModel;

    // The system prompt lives outside the message array for Claude.
    const systemParts: string[] = [];
    const messages: Array<Record<string, unknown>> = [];

    for (const m of req.messages) {
      switch (m.role) {
        case "system":
          if (m.content) systemParts.push(m.content);
          break;
        case "tool":
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: m.tool_call_id,
                content: m.content,
              },
            ],
          });
          break;
        default:
          messages.push({ role: m.role, content: m.content });
      }
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: req.max_tokens && req.max_tokens > 0 ? req.max_tokens : this.maxTokens,
    };
    if (systemParts.length > 0) body.system = systemParts.join("\n\n");
    if (req.temperature) body.temperature = req.temperature;

    // Claude names tools "tools" with an input_schema, not a parameters object.
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const out = await doJSON<{
      content?: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
      }>;
      stop_reason?: string;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>({
      method: "POST",
      url: this.baseURL + "/v1/messages",
      body,
      headers: this.authHeaders(),
    });

    const inputTokens = out.usage?.input_tokens ?? 0;
    const outputTokens = out.usage?.output_tokens ?? 0;
    const response: CompletionResponse = {
      content: "",
      finish_reason: out.stop_reason,
      model: out.model,
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };

    const toolCalls: ToolCall[] = [];
    let text = "";
    for (const block of out.content ?? []) {
      if (block.type === "text") {
        text += block.text ?? "";
      } else if (block.type === "tool_use") {
        let args = block.input === undefined ? "" : JSON.stringify(block.input);
        if (args === "") args = "{}";
        toolCalls.push({
          id: block.id ?? "",
          type: "function",
          function: { name: block.name ?? "", arguments: args },
        });
      }
    }
    response.content = text;
    if (toolCalls.length > 0) response.tool_calls = toolCalls;
    return response;
  }

  private authHeaders(): Record<string, string> {
    return {
      "x-api-key": this.key,
      "anthropic-version": "2023-06-01",
    };
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const BroGangBaseURL = "https://brogangaicli.pages.dev/v1";
export const BroGangModel = "llama-3.3-70b";

const CloudflareBaseURL = "https://api.cloudflare.com/client/v4/accounts/%s/ai/v1";
const CloudflareModel = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const CloudflareModel2 = "@cf/meta/llama-3.1-8b-instruct";

const GroqBaseURL = "https://api.groq.com/openai/v1";
const GroqModel = "llama-3.3-70b-versatile";

const OpenAIBaseURL = "https://api.openai.com/v1";
const OpenAIModel = "gpt-4o-mini";

const OpenRouterBaseURL = "https://openrouter.ai/api/v1";
const OpenRouterModel = "anthropic/claude-3.5-sonnet";

const TogetherBaseURL = "https://api.together.xyz/v1";
const TogetherModel = "meta-llama/Llama-3.3-70B-Instruct-Turbo";

export const OllamaBaseURL = "http://localhost:11434/v1";
const OllamaModel = "llama3.2";

/** ProviderSettings is a flat view over the nested config file. */
export interface ProviderSettings {
  brogangBaseURL?: string;
  brogangModel?: string;
  cloudflareKey?: string;
  cloudflareAccountID?: string;
  cloudflareModel?: string;
  groqKey?: string;
  groqModel?: string;
  openAIKey?: string;
  openAIModel?: string;
  openRouterKey?: string;
  openRouterModel?: string;
  togetherKey?: string;
  togetherModel?: string;
  ollamaBaseURL?: string;
  ollamaModel?: string;
  anthropicKey?: string;
  anthropicModel?: string;
}

function pick(value: string | undefined, fallback: string): string {
  return value ? value : fallback;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ProviderRegistry {
  private readonly map = new Map<string, Provider>();
  private readonly order: string[] = [];

  register(p: Provider): void {
    if (!this.map.has(p.name())) this.order.push(p.name());
    this.map.set(p.name(), p);
  }

  get(name: string): Provider {
    const key = name.trim().toLowerCase();
    const found = this.map.get(key);
    if (!found) throw new Error(`unknown provider "${name}"`);
    return found;
  }

  has(name: string): boolean {
    return this.map.has(name.trim().toLowerCase());
  }

  list(): Provider[] {
    return this.order.map((n) => this.map.get(n)!);
  }

  names(): string[] {
    return [...this.order];
  }

  namesSorted(): string[] {
    return [...this.order].sort();
  }
}

/**
 * build assembles a registry from saved configuration, wiring every known
 * provider with its credentials, base URL, and default model.
 */
export function buildRegistry(settings: ProviderSettings): ProviderRegistry {
  const r = new ProviderRegistry();

  // The hosted BRO GANG endpoint comes first: it is free, keyless, and the
  // default, so the CLI is useful the moment it is installed.
  r.register(
    new OpenAICompatible({
      name: "brogang",
      label: "Bro Gang AI (free, no key)",
      baseURL: pick(settings.brogangBaseURL, BroGangBaseURL),
      keyName: "no key needed",
      defaultModel: pick(settings.brogangModel, BroGangModel),
      noKey: true,
    }),
  );

  // Cloudflare needs the account id interpolated into the URL.
  const cfURL = CloudflareBaseURL.replace(
    "%s",
    encodeURIComponent(settings.cloudflareAccountID ?? ""),
  );
  r.register(
    new OpenAICompatible({
      name: "cloudflare",
      label: "Cloudflare Workers AI",
      baseURL: cfURL,
      keyName: "API token",
      defaultModel: pick(settings.cloudflareModel, CloudflareModel),
      staticModels: [CloudflareModel, CloudflareModel2],
    }),
  );

  r.register(
    new OpenAICompatible({
      name: "groq",
      label: "Groq",
      baseURL: GroqBaseURL,
      keyName: "API key",
      defaultModel: pick(settings.groqModel, GroqModel),
    }),
  );
  r.register(
    new OpenAICompatible({
      name: "openai",
      label: "OpenAI",
      baseURL: OpenAIBaseURL,
      keyName: "API key",
      defaultModel: pick(settings.openAIModel, OpenAIModel),
    }),
  );
  r.register(
    new OpenAICompatible({
      name: "openrouter",
      label: "OpenRouter",
      baseURL: OpenRouterBaseURL,
      keyName: "API key",
      defaultModel: pick(settings.openRouterModel, OpenRouterModel),
    }),
  );
  r.register(
    new OpenAICompatible({
      name: "together",
      label: "Together AI",
      baseURL: TogetherBaseURL,
      keyName: "API key",
      defaultModel: pick(settings.togetherModel, TogetherModel),
    }),
  );
  r.register(
    new OpenAICompatible({
      name: "ollama",
      label: "Ollama (local)",
      baseURL: pick(settings.ollamaBaseURL, OllamaBaseURL),
      keyName: "no key needed",
      defaultModel: pick(settings.ollamaModel, OllamaModel),
      noKey: true,
    }),
  );
  r.register(
    new Anthropic({
      key: settings.anthropicKey,
      defaultModel: pick(settings.anthropicModel, "claude-sonnet-4-5"),
    }),
  );

  // Apply credentials to the OpenAI-compatible backends.
  const apply = (name: string, key?: string) => {
    const p = r.get(name) as OpenAICompatible;
    if (p instanceof OpenAICompatible && key) p.key = key;
  };
  apply("cloudflare", settings.cloudflareKey);
  if (settings.cloudflareAccountID && r.get("cloudflare") instanceof OpenAICompatible) {
    (r.get("cloudflare") as OpenAICompatible).accountId =
      settings.cloudflareAccountID ?? "";
  }
  apply("groq", settings.groqKey);
  apply("openai", settings.openAIKey);
  apply("openrouter", settings.openRouterKey);
  apply("together", settings.togetherKey);

  return r;
}
