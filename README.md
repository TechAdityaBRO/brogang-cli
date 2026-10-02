<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=200&section=header&text=Bro%20Gang%20AI%20CLI&fontSize=64&fontColor=ffffff&animation=twinkling&desc=Free%20forever%20AI%20coding%20agent&descSize=18" width="100%"/>

# Bro Gang AI CLI

**A free forever AI coding agent for your terminal.**
No signup. No API key. Just run it.

[![Go](https://img.shields.io/badge/Go-00ADD8?style=for-the-badge&logo=go&logoColor=white&labelColor=0a0a1a)](https://go.dev)
[![License](https://img.shields.io/badge/MIT-License-ff3b9e?style=for-the-badge&labelColor=0a0a1a)](LICENSE)
[![Free](https://img.shields.io/badge/Price-0%20%E2%82%B9%20Forever-5dd65d?style=for-the-badge&labelColor=0a0a1a)](#)
[![BRO GANG](https://img.shields.io/badge/BRO%20GANG-East%202022-00e5ff?style=for-the-badge&labelColor=0a0a1a)](https://brogang.techaditya.workers.dev)

```bash
go install github.com/TechAdityaBRO/brogang-cli/cmd/brogang@latest
brogang
```

</div>

---

## Why

Most AI CLI tools want your credit card before you type your first prompt.
Bro Gang AI ships with a **hosted free provider built in** — powered by
Cloudflare Workers AI running Llama 3.3 70B, the same engine behind
[BRO GANG AI](https://brogang.techaditya.workers.dev).

```
$ brogang "explain what this repo does"
❯ brogang ▸ Bro Gang AI (free, no key)
⚡ read_file path: README.md

Bro Gang AI CLI is a terminal coding agent...
```

## Features

| | |
|:--|:--|
| 🔓 **Zero setup** | Works on first run. No account, no key, no config. |
| 🔌 **Bring your own key** | Optional: OpenAI, Anthropic, Groq, OpenRouter, Together, or your own Cloudflare account. |
| 🖥️ **Full agent mode** | Reads, writes and edits files, lists dirs, greps, runs shell commands. |
| 🔍 **Sandboxed** | Every file tool is confined to your workspace root. `..` escapes are rejected. |
| ✋ **Approval prompts** | Destructive commands ask first. `--yolo` to trust everything. |
| 🎨 **Bang Mach theme** | Neon pink + cyan terminal UI. Honours `NO_COLOR`. |
| 🌐 **Works offline** | Point at a local Ollama server with `-p ollama`. |
| 📦 **One binary** | Static Go binary. No runtime, no node_modules. |

## Install

Two ways — whichever is reachable for you:

```bash
# 1. npm — works everywhere, no GitHub download needed
npm install -g @brogang/cli

#    yarn equivalent:
yarn global add @brogang/cli

# 2. GitHub Releases — prebuilt static binaries, no package manager
#    https://github.com/TechAdityaBRO/brogang-cli/releases
#    brogang-linux-amd64.tar.gz
#    brogang-windows-amd64.zip
#    brogang-darwin-arm64.tar.gz   (+ arm64/amd64 for each OS)
```

Or build from source:

```bash
go install github.com/TechAdityaBRO/brogang-cli/cmd/brogang@latest

git clone https://github.com/TechAdityaBRO/brogang-cli
cd brogang-cli && make build
./bin/brogang
```

| Distribution | Good for |
|:--|:--|
| **npm** (`@brogang/cli`) | Anyone who can reach the npm registry but not GitHub |
| **yarn** (`yarn global add @brogang/cli`) | Anyone who prefers Yarn for global packages |
| **GitHub Releases** | A single static binary, no Node required |
| **`go install`** | Already have a Go toolchain |

## Usage

```bash
brogang                                  # interactive session
brogang "refactor the auth middleware"   # one shot, print, exit
brogang --yolo "fix the failing tests"   # auto-approve every tool
brogang -p ollama "explain this repo"    # fully local, no network
brogang --list-providers                 # see what's available
brogang --setup                          # optional paid key
```

### Commands inside the session

| Command | What it does |
|:--|:--|
| `/help` | Show commands |
| `/clear` | Clear conversation |
| `/model` | Show active model |
| `/provider` | List backends |
| `/exit` | Quit |

## Providers

| Key | Backend | Cost | Needs key |
|:--|:--|:--|:--|
| `brogang` | **Bro Gang AI** (Cloudflare Workers AI) | **Free** | **No** |
| `cloudflare` | Your own Cloudflare Workers AI | Free tier | Yes |
| `groq` | Groq | Free tier | Yes |
| `openai` | OpenAI | Paid | Yes |
| `anthropic` | Anthropic Claude | Paid | Yes |
| `openrouter` | OpenRouter | Paid | Yes |
| `together` | Together AI | Paid | Yes |
| `ollama` | Ollama (localhost) | Free | No |

## Architecture

```
brogang-cli/
├── cmd/brogang/          # CLI entrypoint, flags, REPL, setup wizard
├── internal/
│   ├── agent/            # The loop: model → tool calls → results → repeat
│   ├── provider/         # Provider interface + OpenAI & Anthropic clients
│   ├── tools/            # read/write/edit/list/search/run_command
│   ├── config/           # ~/.brogang/config.json
│   └── theme/            # Bang Mach terminal theme
├── ts/                   # TypeScript port, published as @brogang/cli
└── worker/               # Cloudflare Pages site powering the free endpoint
    ├── functions/[[path]].js   # OpenAI-compatible API handler
    ├── public/index.html       # landing page
    └── wrangler.toml
```

### Distribution

The CLI ships two ways so a blocked or unavailable channel is never a dead end:

- **npm** - `npm install -g @brogang/cli`, built and published by CI
- **yarn** - `yarn global add @brogang/cli`, same registry package
- **GitHub Releases** — static binaries for six platform/arch combinations

### The free endpoint

Bro Gang AI is served from Cloudflare Pages and speaks the OpenAI chat
completions shape, so it also works with any other OpenAI-compatible client.

```bash
cd worker
npx wrangler pages deploy public
```

Then point the CLI at it if you use a custom domain:

```bash
export BG_BASE_URL=https://brogang.pages.dev/v1
```

### Tool sandboxing

File tools resolve every path against the workspace root and reject anything
that escapes it. Binary files are skipped in search. Output is truncated at
40K characters so a single call can't flood the model's context.

### Agent loop

```
user prompt
   → provider.Complete(messages, tools)
   → if tool_calls: execute each (with approval), append results, loop
   → if text only: print and wait for next input
```

Bounded to 24 rounds per turn so a confused model can't spin forever.

## Configuration

`~/.brogang/config.json` — created only if you run `--setup`. The default
provider (`brogang`) needs no file at all.

API keys can also come from the environment, which always wins over the file:

```bash
export CLOUDFLARE_API_TOKEN=...
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

| Variable | Purpose |
|:--|:--|
| `NO_COLOR` | Disable all ANSI colour |
| `BG_NO_COLOR` | Same, BRO GANG specific |
| `BG_FORCE_COLOR` | Force colour on |
| `BG_HOME` | Override the config directory |

## Made in India 🇮🇳

Built by [BRO GANG](https://brogang.techaditya.workers.dev) · East 2022 —
a community of 38 friends, one foot in Vice City, one in the blocky world.

**Fork it, build it, break it, ship it. Bro Gang AI CLI is yours.**

[GitHub](https://github.com/TechAdityaBRO/brogang-cli) ·
[Discord](https://discord.gg/TSWg34Zets) ·
[YouTube](https://www.youtube.com/@BroGangYoutube) ·
[Email](mailto:brogang@atomicmail.io)

<sub>MIT licensed. Llama 3.3 70B is provided under the Llama 3.3 Community License by Meta.</sub>
