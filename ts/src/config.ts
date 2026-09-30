// Settings live in ~/.brogang/config.json. API keys may also come from the
// environment, which takes precedence so CI and shared machines never write
// secrets to disk.
//
// Mirrors internal/config/config.ts's Go original.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ProviderConfig {
  api_key?: string;
  account_id?: string;
  base_url?: string;
  model?: string;
}

export interface Config {
  /** Provider is the default provider key when none is given on the command line. */
  provider: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  theme?: string;
  auto_approve?: boolean;
  providers: Record<string, ProviderConfig>;
}

/** defaultConfig returns a config populated with the built-in defaults. */
export function defaultConfig(): Config {
  return {
    provider: "brogang",
    theme: "bang-mach",
    providers: {
      brogang: { model: "llama-3.3-70b" },
      ollama: { base_url: "http://localhost:11434", model: "llama3.2" },
      cloudflare: { account_id: "", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
      groq: { model: "llama-3.3-70b-versatile" },
      openai: { model: "gpt-4o-mini" },
      anthropic: { model: "claude-sonnet-4-5" },
    },
  };
}

/** configDir returns the configuration directory, honouring BG_HOME. */
export function configDir(): string {
  const custom = (process.env.BG_HOME ?? "").trim();
  if (custom) return custom;
  return path.join(os.homedir(), ".brogang");
}

/** configPath returns the full path to config.json. */
export function configPath(): string {
  return path.join(configDir(), "config.json");
}

/**
 * load reads config.json, returning defaults when the file is absent and
 * merging any provider keys the defaults know about but the file omits.
 */
export function load(): Config {
  const cfg = defaultConfig();
  const file = configPath();

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return cfg;
    throw new Error(`read ${file}: ${(err as Error).message}`);
  }

  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(raw) as Partial<Config>;
  } catch (err) {
    throw new Error(`parse ${file}: ${(err as Error).message}`);
  }

  if (typeof parsed.provider === "string") cfg.provider = parsed.provider;
  if (typeof parsed.model === "string") cfg.model = parsed.model;
  if (typeof parsed.temperature === "number") cfg.temperature = parsed.temperature;
  if (typeof parsed.max_tokens === "number") cfg.max_tokens = parsed.max_tokens;
  if (typeof parsed.theme === "string") cfg.theme = parsed.theme;
  if (typeof parsed.auto_approve === "boolean") cfg.auto_approve = parsed.auto_approve;
  if (parsed.providers && typeof parsed.providers === "object") {
    cfg.providers = { ...cfg.providers, ...parsed.providers };
  }

  // A blank field in the file falls back to the built-in default so an
  // upgrade that introduces a new model does not require edits.
  const defaults = defaultConfig().providers;
  for (const name of Object.keys(defaults)) {
    const d = defaults[name];
    const existing = cfg.providers[name] ?? {};
    if (!existing.model && d.model) existing.model = d.model;
    if (!existing.base_url && d.base_url) existing.base_url = d.base_url;
    cfg.providers[name] = existing;
  }
  return cfg;
}

/** save writes config.json with owner-only permissions. */
export function save(cfg: Config): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const file = configPath();
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") {
    // writeFileSync does not apply the mode to an existing file.
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
  return file;
}

type Field = "api_key" | "key" | "account_id" | "account" | "base_url" | "url" | "model";

/** set stores a value for a provider key. */
export function set(cfg: Config, key: string, field: string, value: string): void {
  const entry = cfg.providers[key] ?? {};
  switch (field.toLowerCase() as Field) {
    case "api_key":
    case "key":
      entry.api_key = value;
      break;
    case "account_id":
    case "account":
      entry.account_id = value;
      break;
    case "base_url":
    case "url":
      entry.base_url = value;
      break;
    case "model":
      entry.model = value;
      break;
    default:
      return;
  }
  cfg.providers[key] = entry;
}

/**
 * apiKey returns the effective key for a provider. The environment wins over
 * the file so CI tokens never get written to disk.
 */
export function apiKey(cfg: Config, key: string): string {
  const envVar = envVarFor(key);
  if (envVar) {
    const env = (process.env[envVar] ?? "").trim();
    if (env) return env;
  }
  return cfg.providers[key]?.api_key ?? "";
}

/** accountID returns the effective Cloudflare account id for a provider. */
export function accountID(cfg: Config, key: string): string {
  const env = (process.env.CF_ACCOUNT_ID ?? "").trim();
  if (env) return env;
  return cfg.providers[key]?.account_id ?? "";
}

/** modelFor returns the model a provider should use. */
export function modelFor(cfg: Config, key: string, override = ""): string {
  if (override) return override;
  const model = cfg.providers[key]?.model;
  if (model) return model;
  return cfg.model ?? "";
}

/** baseURLFor returns a provider's base URL, honouring BG_BASE_URL. */
export function baseURLFor(cfg: Config, key: string, fallback: string): string {
  const env = (process.env.BG_BASE_URL ?? "").trim();
  if (env) return env;
  return cfg.providers[key]?.base_url || fallback;
}

/** envVarFor maps a provider key to the environment variable holding its key. */
export function envVarFor(key: string): string {
  switch (key.toLowerCase()) {
    case "cloudflare":
    case "cf":
      return "CLOUDFLARE_API_TOKEN";
    case "anthropic":
    case "claude":
      return "ANTHROPIC_API_KEY";
    case "groq":
      return "GROQ_API_KEY";
    case "together":
      return "TOGETHER_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "ollama":
    case "lmstudio":
      return ""; // local runtimes need no credential
    default:
      return key.toUpperCase().replace(/-/g, "_") + "_API_KEY";
  }
}
