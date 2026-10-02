"""Command line entry point."""

from __future__ import annotations

import argparse
import os
import sys
from typing import Optional

from . import __version__
from .agent import Agent, MaxStepsError
from .config import (
    api_key,
    account_id,
    base_url_for,
    default_config,
    load,
    model_for,
    save,
)
from .provider import Anthropic, OpenAICompatible, registry
from .theme import banner, fail, info, promptText
from .tools import ToolRegistry


def _provider_instance(cfg_name: str, cfg):
    p = registry.get(cfg_name)
    if isinstance(p, OpenAICompatible):
        p.key = api_key(cfg, cfg_name)
        p.account_id = account_id(cfg, cfg_name)
    elif p.name_() == "anthropic":
        p = Anthropic(key=api_key(cfg, cfg_name))
    return p


def _confirm_interactive(name: str, raw: str) -> None:
    answer = input(f"\nAllow tool {name} with args {raw}? [y/N] ").strip().lower()
    if answer not in ("y", "yes"):
        raise PermissionError("user declined")


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(prog="brogang", description="Bro Gang AI CLI")
    ap.add_argument("prompt", nargs="?", help="One-shot prompt. Omit to start an interactive session.")
    ap.add_argument("-p", "--provider", default=None, help="Provider name (brogang, ollama, openai, ...)")
    ap.add_argument("-m", "--model", default=None, help="Model override.")
    ap.add_argument("--yolo", action="store_true", help="Auto-approve every tool call.")
    ap.add_argument("--list-providers", action="store_true", help="List available providers.")
    ap.add_argument("--setup", action="store_true", help="Interactively configure a paid provider.")
    ap.add_argument("-v", "--version", action="version", version=f"brogang {__version__}")
    args = ap.parse_args(argv)

    cfg = load()
    if args.list_providers:
        for name in registry.names():
            print(name)
        return 0

    if args.setup:
        name = input("Provider name: ").strip()
        key = input("API key (blank to skip): ").strip()
        url = input("Base URL (blank for default): ").strip()
        model = input("Model (blank for default): ").strip()
        providers = cfg.providers
        from .config import ProviderConfig

        providers[name] = ProviderConfig(api_key=key or None, base_url=url or None, model=model or None)
        cfg.provider = name
        save(cfg)
        print(info("Saved to ~/.brogang/config.json"))
        return 0

    name = args.provider or cfg.provider
    try:
        provider = _provider_instance(name, cfg)
    except KeyError:
        print(fail(f"Unknown provider {name!r}. Use --list-providers."))
        return 2
    model = model_for(cfg, name, args.model or "")
    reg = ToolRegistry.default(os.getcwd())
    agent = Agent(
        provider=provider,
        model=model,
        tools=reg if not args.yolo else reg,
        config=cfg,
        confirm=None if args.yolo else _confirm_interactive,
    )

    print(banner(__version__))
    if args.prompt:
        try:
            print(agent.send(args.prompt))
        except MaxStepsError as err:
            print(fail(str(err)))
            return 1
        return 0

    print(promptText(provider.name_()) + 'Type /help for commands, /exit to quit.\n')
    while True:
        try:
            user = input(promptText(provider.name_())).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if user in ("/exit", "/quit", "exit"):
            break
        if user in ("/clear",):
            agent.reset()
            continue
        if user == "/help":
            print("/help  /clear  /model  /exit")
            continue
        if user == "/model":
            print(model)
            continue
        if not user:
            continue
        try:
            print(agent.send(user))
        except MaxStepsError as err:
            print(fail(str(err)))
        except Exception as err:  # noqa: BLE001
            print(fail(str(err)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
