# brogang-cli

**Bro Gang AI CLI — a free forever AI coding agent for your terminal.**

No signup. No API key. Just run it.

```bash
brogang
```

The default provider is a hosted, keyless endpoint running Llama 3.3 70B on
Cloudflare Workers AI, so the very first command works with **zero
configuration**.

---

## Install

```bash
# pip (works everywhere)
pip install brogang-cli

# poetry
poetry add brogang-cli

# uv (fastest)
uv pip install brogang-cli

# or run it without installing
uvx brogang-cli
```

---

## Usage

```bash
brogang                                  # interactive session
brogang "refactor the auth middleware"   # one shot, print, exit
brogang --yolo "fix the failing tests"   # auto-approve every tool
brogang -p ollama "explain this repo"    # fully local, no network
brogang --list-providers                 # see what's available
brogang --setup                          # optional paid key
```
