# @brogang/cli

**Bro Gang AI CLI — a free forever AI coding agent for your terminal.**

No signup. No API key. Just run it.

```bash
npm install -g @brogang/cli
brogang
```

The default provider is a hosted, keyless endpoint running Llama 3.3 70B on
Cloudflare Workers AI, so the very first command works with **zero
configuration**. No config file is written, no account is created, nothing is
charged.

---

## Install

```bash
# npm (works everywhere)
npm install -g @brogang/cli

# pnpm
pnpm add -g @brogang/cli

# yarn
yarn global add @brogang/cli
```

Prebuilt binaries for Linux, Windows and macOS (amd64 + arm64) are published on
[GitHub Releases](https://github.com/TechAdityaBRO/brogang-cli/releases) if you
would rather not install through a package manager.

## Usage

```bash
brogang                                  # interactive session
brogang "refactor the auth middleware"   # one shot, print, exit
brogang --yolo "fix the failing tests"   # auto-approve every tool
brogang -p ollama "explain this repo"    # fully local, no network
brogang --list-providers                 # see what's available
brogang --setup                          # optional paid provider
```

### Flags

| Flag | Effect |
|:--|:--|
| `-p, --provider <name>` | AI backend (default: `brogang`) |
| `-m, --model <id>` | Override the model |
| `-C, --cwd <dir>` | Workspace root (default: current directory) |
| `--yolo` | Approve every tool call without asking |
| `--no-tools` | Chat only, no file or command access |
| `--max-steps <n>` | Tool calling rounds per turn (default: 24) |
| `--list-providers` | Show backends and exit |
| `--list-models` | Show models for the active provider |
| `--setup` | Configure an optional paid provider |
| `--version`, `-v` | Print the version |
| `-h, --help` | Show help |

### Inside the session

`/help` · `/clear` · `/model` · `/provider` · `/exit`

## Tools

The agent has six capabilities, all **sandboxed to your workspace root**:

| Tool | What it does |
|:--|:--|
| `read_file` | Read a file with line numbers, paged by `offset`/`limit` |
| `write_file` | Create or replace a file |
| `edit_file` | Exact string replacement, unique match or `replace_all` |
| `list_dir` | Recursive listing, skips `node_modules`, `.git`, etc. |
| `search` | Regex search across file contents |
| `run_command` | Shell command, 120s timeout |

Every path is resolved against the workspace root and rejected if it escapes —
including `..` traversal and absolute paths outside the project. Commands ask
for approval before running unless you pass `--yolo`.

## Providers

| Key | Backend | Cost | Needs key |
|:--|:--|:--|:--|
| `brogang` | Bro Gang AI · Cloudflare Workers AI | **Free** | **No** |
| `ollama` | Local Ollama server | **Free** | **No** |
| `cloudflare` | Your own Cloudflare Workers AI | Free tier | Yes |
| `groq` | Groq | Free tier | Yes |
| `openai` | OpenAI | Paid | Yes |
| `anthropic` | Anthropic Claude | Paid | Yes |
| `openrouter` | OpenRouter | Paid | Yes |
| `together` | Together AI | Paid | Yes |

Switch with `-p <name>`.

### Configuration

`~/.brogang/config.json` — created **only** if you run `--setup`. The default
provider needs no file at all.

Environment variables always win over the file:

```bash
export CLOUDFLARE_API_TOKEN=...
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export BG_BASE_URL=https://your-endpoint/v1
export BG_MODEL=llama-3.3-70b
```

| Variable | Purpose |
|:--|:--|
| `NO_COLOR` / `BG_NO_COLOR` | Disable all ANSI colour |
| `BG_FORCE_COLOR` | Force colour on |
| `BG_HOME` | Override the config directory |

## Programmatic use

The pieces are exported separately if you want the agent without the CLI:

```ts
import { buildRegistry, BroGangBaseURL } from "@brogang/cli/provider";
import { Agent } from "@brogang/cli/agent";
import { ToolRegistry } from "@brogang/cli/tools";
```

```ts
import { buildRegistry, BroGangBaseURL } from "@brogang/cli/provider";

const registry = buildRegistry({ brogangBaseURL: BroGangBaseURL });
const provider = registry.get("brogang");

const res = await provider.complete({
  model: "",
  messages: [{ role: "user", content: "hello" }],
});
console.log(res.content);
```

## The free endpoint

Bro Gang AI is served from Cloudflare Pages and speaks the OpenAI chat
completions shape, so it works with any OpenAI-compatible client:

```bash
curl https://brogangaicli.pages.dev/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```

## License

MIT — see [LICENSE](https://github.com/TechAdityaBRO/brogang-cli/blob/main/LICENSE).

Llama 3.3 70B is provided under the Llama 3.3 Community License by Meta.

---

Built by **BRO GANG** · East 2022 · Made in India 🇮🇳
