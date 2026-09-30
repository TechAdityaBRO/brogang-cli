#!/usr/bin/env node
// brogang — a free, open source AI coding agent for the terminal.
//
// Mirrors cmd/brogang/main.go.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as theme from "./theme.js";
import * as cfgmod from "./config.js";
import type { Config, ProviderSettings } from "./config.js";
import {
  BroGangBaseURL,
  OllamaBaseURL,
  buildRegistry,
  isNoAPIKey,
  type Provider,
  type ProviderRegistry,
} from "./provider.js";
import { Agent, CancelledError, DefaultMaxSteps, type AgentEvent } from "./agent.js";
import { ToolRegistry } from "./tools.js";

export const Version = "0.1.0";

const helpText = `Bro Gang AI CLI — a free forever AI coding agent for your terminal.

No signup. No API key. Just run it.

USAGE
  brogang [prompt] [flags]

  With a prompt, brogang runs one turn, prints the answer, and exits.
  With no prompt, it opens an interactive session.

FLAGS
  -p, --provider <name>   AI backend (default: brogang, the free hosted one)
  -m, --model <id>        Override the model
  -C, --cwd <dir>         Workspace root (default: current directory)
      --yolo              Approve every tool call without asking
      --no-tools          Chat only, no file or command access
      --max-steps <n>     Tool calling rounds per turn (default: 24)
      --list-providers    Show available backends and exit
      --list-models       Show models for the active provider and exit
      --setup             Configure an optional paid provider
      --version           Print the version and exit
  -h, --help              Show this help

PROVIDERS
  brogang      Bro Gang AI · FREE, no key, no setup · default
  cloudflare   Cloudflare Workers AI   free tier, Llama 3.3 70B
  groq         Groq                    free tier, very fast
  openai       OpenAI                  GPT models
  anthropic    Anthropic               Claude models
  openrouter   OpenRouter              many models, one key
  together     Together AI             open models
  ollama       Ollama                  local, no key, no network

EXAMPLES
  brogang "explain the auth flow in src/auth"
  brogang "add tests for the parser"
  brogang -p ollama -m qwen2.5-coder "refactor this file"

Made by BRO GANG · East 2022 · MIT licensed.
`;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

interface Flags {
  prompt: string;
  providerName: string;
  model: string;
  cwd: string;
  yolo: boolean;
  noTools: boolean;
  maxSteps: number;
  listProviders: boolean;
  listModels: boolean;
  setup: boolean;
  version: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    prompt: "",
    providerName: "",
    model: "",
    cwd: "",
    yolo: false,
    noTools: false,
    maxSteps: DefaultMaxSteps,
    listProviders: false,
    listModels: false,
    setup: false,
    version: false,
    help: false,
  };

  const takesValue = new Set(["-p", "--provider", "-m", "--model", "-C", "--cwd", "--max-steps"]);

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];

    // Support --flag=value as well as --flag value.
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      const key = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      argv = [...argv.slice(0, i), key, value, ...argv.slice(i + 1)];
      arg = key;
    }

    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i++;
      switch (arg) {
        case "-p":
        case "--provider":
          f.providerName = value;
          break;
        case "-m":
        case "--model":
          f.model = value;
          break;
        case "-C":
        case "--cwd":
          f.cwd = value;
          break;
        case "--max-steps": {
          const n = Number.parseInt(value, 10);
          if (Number.isNaN(n)) {
            throw new Error(`--max-steps needs a number, got ${JSON.stringify(value)}`);
          }
          f.maxSteps = n;
          break;
        }
      }
      continue;
    }

    switch (arg) {
      case "--yolo":
        f.yolo = true;
        break;
      case "--no-tools":
        f.noTools = true;
        break;
      case "--list-providers":
        f.listProviders = true;
        break;
      case "--list-models":
        f.listModels = true;
        break;
      case "--setup":
        f.setup = true;
        break;
      case "--version":
      case "-v":
        f.version = true;
        break;
      case "-h":
      case "--help":
        f.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`unknown flag ${JSON.stringify(arg)}, try --help`);
        }
        if (f.prompt === "") f.prompt = arg;
    }
  }
  return f;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function workspaceRoot(cwd: string): string {
  const dir = cwd === "" ? process.cwd() : cwd;
  const abs = path.resolve(dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    throw new Error(`${abs} is not accessible: ${(err as Error).message}`);
  }
  if (!stat.isDirectory()) throw new Error(`${abs} is a file, not a directory`);
  return abs;
}

/** settingsFrom flattens the config into provider build settings. */
function settingsFrom(cfg: Config, f: Flags): ProviderSettings {
  const overrideModel = (key: string) =>
    f.model !== "" ? f.model : cfgmod.modelFor(cfg, key, "");

  return {
    brogangBaseURL: cfgmod.baseURLFor(cfg, "brogang", BroGangBaseURL),
    brogangModel: overrideModel("brogang"),
    cloudflareKey: cfgmod.apiKey(cfg, "cloudflare"),
    cloudflareAccountID: cfgmod.accountID(cfg, "cloudflare"),
    cloudflareModel: overrideModel("cloudflare"),
    groqKey: cfgmod.apiKey(cfg, "groq"),
    groqModel: overrideModel("groq"),
    openAIKey: cfgmod.apiKey(cfg, "openai"),
    openAIModel: overrideModel("openai"),
    openRouterKey: cfgmod.apiKey(cfg, "openrouter"),
    openRouterModel: overrideModel("openrouter"),
    togetherKey: cfgmod.apiKey(cfg, "together"),
    togetherModel: overrideModel("together"),
    ollamaBaseURL: cfgmod.baseURLFor(cfg, "ollama", OllamaBaseURL),
    ollamaModel: overrideModel("ollama"),
    anthropicKey: cfgmod.apiKey(cfg, "anthropic"),
    anthropicModel: overrideModel("anthropic"),
  };
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function summariseArgs(raw: string): string {
  if (!raw) return "";
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "";
  }
  for (const key of ["path", "command", "pattern", "glob"]) {
    const v = m[key];
    if (typeof v === "string" && v !== "") {
      const firstLine = v.split("\n")[0];
      return key + ": " + (firstLine.length > 48 ? firstLine.slice(0, 48) + "…" : firstLine);
    }
  }
  return "";
}

/** uiHandler renders agent progress with the Bang Mach theme. */
function uiHandler(event: AgentEvent): void {
  switch (event.kind) {
    case "step":
      if ((event.step ?? 1) > 1) {
        console.log(theme.Grey(`  ── step ${event.step}/${event.total}`));
      }
      break;
    case "tool_start":
      console.log(
        `${theme.Pink("⚡")} ${theme.Cyan(event.name ?? "")} ${theme.Grey(
          summariseArgs(event.rawArgs ?? ""),
        )}`,
      );
      break;
    case "tool_done":
      if (event.error) console.log("  " + theme.Red("✖ " + event.error.message));
      break;
    default:
      break;
  }
}

function toolSummary(f: Flags): string {
  if (f.noTools) return theme.Yellow("disabled");
  return theme.Cyan("read · write · edit · list · search · run");
}

function printHelpCommands(): void {
  console.log(
    theme.frame("COMMANDS", [
      theme.Cyan("/help") + "      show this list",
      theme.Cyan("/clear") + "    clear the conversation",
      theme.Cyan("/model") + "     show the active model",
      theme.Cyan("/provider") + "  list providers",
      theme.Cyan("/exit") + "      quit",
    ]),
  );
}

function printProviders(registry: ProviderRegistry, cfg: Config): void {
  console.log();
  console.log(theme.Bold("  Providers"));
  console.log();

  const names = registry.namesSorted();
  for (const name of names) {
    let p: Provider;
    try {
      p = registry.get(name);
    } catch {
      continue;
    }
    let marker = theme.Grey("  ");
    if (name === cfg.provider) marker = theme.Pink("→ ");

    let status = theme.Grey("no key");
    if (!p.requiresAPIKey() || cfgmod.apiKey(cfg, name) !== "") {
      status = theme.Green("ready");
    }
    if (
      name === "cloudflare" &&
      cfgmod.accountID(cfg, "cloudflare") === "" &&
      cfgmod.apiKey(cfg, "cloudflare") !== ""
    ) {
      status = theme.Yellow("needs account id");
    }
    console.log(`${marker}${theme.Cyan(name.padEnd(12))} ${theme.White(p.label().padEnd(22))} ${status}`);
  }
  console.log();
  console.log(theme.Grey("  Configure one with: brogang --setup"));
  console.log();
}

async function printModels(p: Provider): Promise<void> {
  let models: string[];
  try {
    models = await p.listModels();
  } catch (err) {
    if (isNoAPIKey(err)) {
      throw new Error(`${p.label()} needs an API key. Run: brogang --setup`);
    }
    throw err;
  }

  console.log();
  console.log(theme.Bold("  " + p.label() + " models"));
  console.log();
  for (const m of models) console.log("  " + theme.Cyan(m));
  console.log();
}

/**
 * endpointHint appends actionable advice when the free hosted endpoint cannot
 * be reached, so the failure is a next step rather than a dead end.
 */
function endpointHint(err: Error | undefined, active: Provider): string | undefined {
  if (!err) return undefined;
  const lower = err.message.toLowerCase();
  const unreachable =
    lower.includes("404") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("connection refused") ||
    lower.includes("enoent") ||
    lower.includes("getaddrinfo") ||
    err.name === "CancelledError";

  if (unreachable && active.name() === "brogang") {
    return (
      err.message +
      "\n\n" +
      theme.Info("Options:") +
      "\n  " +
      theme.Cyan("1.") +
      " deploy the endpoint:  cd worker && npx wrangler pages deploy public" +
      "\n  " +
      theme.Cyan("2.") +
      " use a local model:     brogang -p ollama" +
      "\n  " +
      theme.Cyan("3.") +
      " or add a free key:     brogang --setup"
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

type Ask = (prompt: string) => Promise<string>;

interface Session {
  ask: Ask;
  confirmer?: (name: string, rawArgs: string) => Promise<void>;
  interrupt(): void;
  close(): void;
  onLineClosed(fn: () => void): void;
}

function createSession(rl: readline.Interface, autoApprove: boolean): Session {
  let pending: ((answer: string) => void) | null = null;
  let closed = false;

  const ask: Ask = (prompt) =>
    new Promise<string>((resolve) => {
      pending = resolve;
      rl.question(prompt, (answer) => {
        pending = null;
        resolve(answer);
      });
    });

  const session: Session = {
    ask,
    interrupt() {
      // A stray answer lets a pending confirmation fall through as a decline.
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve("");
      }
    },
    close() {
      if (closed) return;
      closed = true;
      rl.close();
    },
    onLineClosed(fn: () => void) {
      rl.on("close", fn);
    },
  };

  if (!autoApprove) {
    session.confirmer = async (name: string, rawArgs: string) => {
      console.log(
        `${theme.Orange("⚠")} ${theme.Yellow("allow")} ${theme.Grey(
          name + " " + summariseArgs(rawArgs),
        )}`,
      );
      const answer = (await ask(theme.Pink("  run? [y/N] "))).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") throw new Error("declined by user");
    };
  }

  return session;
}

function newAgent(
  active: Provider,
  cfg: Config,
  root: string,
  f: Flags,
  session: Session,
  controller: AbortController,
): Agent {
  let tools: ToolRegistry | undefined;
  if (!f.noTools) {
    tools = new ToolRegistry(root);
  }

  return new Agent({
    provider: active,
    model: cfgmod.modelFor(cfg, active.name(), f.model),
    tools,
    config: cfg,
    confirm: session.confirmer,
    maxSteps: f.maxSteps,
    onEvent: tools ? uiHandler : undefined,
    signal: controller.signal,
  });
}

async function runOnce(active: Provider, cfg: Config, root: string, f: Flags): Promise<void> {
  if (active.requiresAPIKey() && cfgmod.apiKey(cfg, active.name()) === "") {
    throw new Error(`${active.label()} needs an API key. Run: brogang --setup`);
  }

  // A non interactive invocation reads confirmation from stdin when needed.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const session = createSession(rl, cfg.auto_approve === true || f.yolo);

  process.on("SIGINT", () => controller.abort());

  const agent = newAgent(active, cfg, root, f, session, controller);

  process.stdout.write(theme.promptText(active.name()) + theme.Grey(active.label()) + "\n\n");

  let answer = "";
  let error: Error | undefined;
  try {
    answer = await agent.send(f.prompt);
  } catch (err) {
    error = err as Error;
  } finally {
    session.close();
  }

  if (answer !== "") console.log(theme.White(answer));
  if (error && !(error instanceof CancelledError)) {
    const hint = endpointHint(error, active);
    throw new Error(hint ?? error.message);
  }
}

async function runInteractive(
  active: Provider,
  cfg: Config,
  registry: ProviderRegistry,
  root: string,
  f: Flags,
): Promise<void> {
  if (active.requiresAPIKey() && cfgmod.apiKey(cfg, active.name()) === "") {
    throw new Error(`${active.label()} needs an API key. Run: brogang --setup`);
  }

  console.log(theme.banner(Version));
  console.log(
    theme.frame("SESSION", [
      "Provider  " + theme.Cyan(active.label()),
      "Model     " + theme.Cyan(cfgmod.modelFor(cfg, active.name(), f.model)),
      "Workspace " + theme.White(root),
      "Tools     " + theme.Grey(toolSummary(f)),
    ]),
  );
  console.log();
  console.log(theme.Grey("  /help for commands, /exit to quit, Ctrl+C to interrupt"));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const session = createSession(rl, cfg.auto_approve === true || f.yolo);

  let controller: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (controller) {
      controller.abort();
      session.interrupt();
    } else {
      session.close();
    }
  });
  session.onLineClosed(() => {
    console.log();
    process.exit(0);
  });

  for (;;) {
    const line = await session.ask(theme.promptText(active.name()));
    const input = line.trim();

    if (input === "") continue;
    if (input === "/exit" || input === "/quit") {
      console.log(theme.Grey("  bye — built different."));
      session.close();
      return;
    }
    if (input === "/help") {
      printHelpCommands();
      continue;
    }
    if (input === "/clear") {
      agent.reset();
      console.log(theme.ok("conversation cleared"));
      continue;
    }
    if (input === "/model") {
      console.log(theme.info("current model: " + cfgmod.modelFor(cfg, active.name(), f.model)));
      continue;
    }
    if (input === "/provider") {
      printProviders(registry, cfg);
      continue;
    }

    // Ctrl+C mid-turn abandons the turn, not the session.
    controller = new AbortController();
    const turnAgent = newAgent(active, cfg, root, f, session, controller);

    let answer = "";
    let error: Error | undefined;
    try {
      answer = await turnAgent.send(input);
    } catch (err) {
      error = err as Error;
    } finally {
      controller = null;
    }

    if (answer !== "") {
      console.log();
      console.log(theme.White(answer));
    }
    if (error) {
      if (error instanceof CancelledError) {
        console.log(theme.warn("interrupted"));
      } else {
        console.log(theme.fail(endpointHint(error, active) ?? error.message));
      }
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

async function runSetup(cfg: Config, registry: ProviderRegistry, ask: Ask): Promise<void> {
  console.log(theme.banner(Version));
  console.log(theme.Bold("  Select a provider"));
  console.log();

  const names = registry.namesSorted();
  names.forEach((name, i) => {
    const p = registry.get(name);
    console.log(
      `  ${theme.Pink(String(i + 1).padStart(2) + ")")} ${theme.Cyan(name.padEnd(12))} ${theme.Grey(p.label())}`,
    );
  });
  console.log();

  const choice = (await ask("  " + theme.Cyan("Provider") + theme.Grey(": "))).trim();
  const asNumber = Number.parseInt(choice, 10);
  let selected =
    !Number.isNaN(asNumber) && asNumber >= 1 && asNumber <= names.length
      ? names[asNumber - 1]
      : choice.toLowerCase().trim();

  if (!registry.has(selected)) throw new Error(`unknown provider ${JSON.stringify(selected)}`);

  const p = registry.get(selected);
  if (p.requiresAPIKey()) {
    const envVar = cfgmod.envVarFor(selected);
    if (envVar) {
      console.log(theme.Grey(`  (leave blank to use the ${envVar} environment variable)`));
    }
    const label = selected === "cloudflare" ? "API token" : "API key";
    const key = (await ask("  " + theme.Cyan(label) + theme.Grey(": "))).trim();
    if (key !== "") cfgmod.set(cfg, selected, "api_key", key);
  }

  if (selected === "cloudflare") {
    console.log(theme.Grey("  Account id is in the Cloudflare dashboard sidebar."));
    const account = (await ask("  " + theme.Cyan("Account id") + theme.Grey(": "))).trim();
    if (account !== "") cfgmod.set(cfg, selected, "account_id", account);
  }

  if (selected === "ollama") {
    const url = (
      await ask("  " + theme.Cyan(`Base URL [${OllamaBaseURL}]`) + theme.Grey(": "))
    ).trim();
    if (url !== "") cfgmod.set(cfg, selected, "base_url", url);
  }

  const model = (
    await ask("  " + theme.Cyan("Model (blank for default)") + theme.Grey(": "))
  ).trim();
  if (model !== "") cfgmod.set(cfg, selected, "model", model);

  cfg.provider = selected;
  const file = cfgmod.save(cfg);

  console.log();
  console.log(theme.ok("Saved to " + file));
  console.log(theme.info("Active provider: " + selected));
  console.log();
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    console.error(theme.fail("Error: " + (err as Error).message));
    process.exitCode = 1;
    return;
  }

  if (flags.help) {
    process.stdout.write(helpText);
    return;
  }
  if (flags.version) {
    console.log(`brogang ${Version}`);
    return;
  }

  const cfg = cfgmod.load();
  const registry = buildRegistry(settingsFrom(cfg, flags));

  if (flags.listProviders) {
    printProviders(registry, cfg);
    return;
  }

  if (flags.setup) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask: Ask = (q) =>
      new Promise<string>((resolve) => rl.question(q, (a) => resolve(a)));
    try {
      await runSetup(cfg, registry, ask);
    } finally {
      rl.close();
    }
    return;
  }

  const providerName = flags.providerName || cfg.provider;
  let active: Provider;
  try {
    active = registry.get(providerName);
  } catch (err) {
    throw new Error(`${(err as Error).message}\n\nAvailable: ${registry.names().join(", ")}`);
  }

  if (flags.listModels) {
    await printModels(active);
    return;
  }

  const root = workspaceRoot(flags.cwd);

  if (flags.prompt !== "") {
    await runOnce(active, cfg, root, flags);
    return;
  }
  await runInteractive(active, cfg, registry, root, flags);
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(theme.fail("Error: " + err.message));
  process.exitCode = 1;
});
