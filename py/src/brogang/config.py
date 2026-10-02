"""Settings live in ~/.brogang/config.json. Environment takes precedence.

Mirrors ts/src/config.ts.
"""

from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional


@dataclass
class ProviderConfig:
    api_key: Optional[str] = None
    account_id: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Optional[dict]) -> "ProviderConfig":
        d = d or {}
        return cls(
            api_key=d.get("api_key"),
            account_id=d.get("account_id"),
            base_url=d.get("base_url"),
            model=d.get("model"),
        )

    def to_dict(self) -> dict:
        out: dict = {}
        if self.api_key:
            out["api_key"] = self.api_key
        if self.account_id:
            out["account_id"] = self.account_id
        if self.base_url:
            out["base_url"] = self.base_url
        if self.model:
            out["model"] = self.model
        return out


@dataclass
class Config:
    provider: str = "brogang"
    model: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    theme: str = "bang-mach"
    auto_approve: Optional[bool] = None
    providers: Dict[str, ProviderConfig] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Optional[dict]) -> "Config":
        cfg = default_config()
        d = d or {}
        if isinstance(d.get("provider"), str):
            cfg.provider = d["provider"]
        if isinstance(d.get("model"), str):
            cfg.model = d["model"]
        if isinstance(d.get("temperature"), (int, float)):
            cfg.temperature = d["temperature"]
        if isinstance(d.get("max_tokens"), int):
            cfg.max_tokens = d["max_tokens"]
        if isinstance(d.get("theme"), str):
            cfg.theme = d["theme"]
        if isinstance(d.get("auto_approve"), bool):
            cfg.auto_approve = d["auto_approve"]
        if isinstance(d.get("providers"), dict):
            for name, val in d["providers"].items():
                cfg.providers[name] = ProviderConfig.from_dict(val)
        merged: Dict[str, ProviderConfig] = {}
        defaults = default_config().providers
        for name, dcfg in defaults.items():
            existing = cfg.providers.get(name, ProviderConfig())
            if not existing.model and dcfg.model:
                existing.model = dcfg.model
            if not existing.base_url and dcfg.base_url:
                existing.base_url = dcfg.base_url
            merged[name] = existing
        for name, val in cfg.providers.items():
            merged.setdefault(name, val)
        cfg.providers = merged
        return cfg

    def to_dict(self) -> dict:
        out: dict = {"provider": self.provider, "theme": self.theme}
        if self.model:
            out["model"] = self.model
        if self.temperature is not None:
            out["temperature"] = self.temperature
        if self.max_tokens is not None:
            out["max_tokens"] = self.max_tokens
        if self.auto_approve is not None:
            out["auto_approve"] = self.auto_approve
        out["providers"] = {k: v.to_dict() for k, v in self.providers.items()}
        return out


def default_config() -> Config:
    return Config(
        provider="brogang",
        theme="bang-mach",
        providers={
            "brogang": ProviderConfig(model="llama-3.3-70b"),
            "ollama": ProviderConfig(base_url="http://localhost:11434", model="llama3.2"),
            "cloudflare": ProviderConfig(account_id="", model="@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
            "groq": ProviderConfig(model="llama-3.3-70b-versatile"),
            "openai": ProviderConfig(model="gpt-4o-mini"),
            "anthropic": ProviderConfig(model="claude-sonnet-4-5"),
        },
    )


def config_dir() -> Path:
    custom = os.environ.get("BG_HOME", "").strip()
    if custom:
        return Path(custom)
    return Path.home() / ".brogang"


def config_path() -> Path:
    return config_dir() / "config.json"


def load() -> Config:
    file = config_path()
    cfg = default_config()
    try:
        raw = file.read_text(encoding="utf-8")
    except FileNotFoundError:
        return cfg
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as err:
        raise ValueError(f"parse {file}: {err}") from err
    return Config.from_dict(parsed)


def save(cfg: Config) -> Path:
    d = config_dir()
    d.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        try:
            os.chmod(d, 0o700)
        except OSError:
            pass
    file = config_path()
    file.write_text(json.dumps(cfg.to_dict(), indent=2) + "\n", encoding="utf-8")
    if os.name != "nt":
        try:
            os.chmod(file, 0o600)
        except OSError:
            pass
    return file


def env_var_for(key: str) -> str:
    k = key.lower()
    if k in ("cloudflare", "cf"):
        return "CLOUDFLARE_API_TOKEN"
    if k in ("anthropic", "claude"):
        return "ANTHROPIC_API_KEY"
    if k == "groq":
        return "GROQ_API_KEY"
    if k == "together":
        return "TOGETHER_API_KEY"
    if k == "openrouter":
        return "OPENROUTER_API_KEY"
    if k == "openai":
        return "OPENAI_API_KEY"
    if k in ("ollama", "lmstudio"):
        return ""
    return key.upper().replace("-", "_") + "_API_KEY"


def api_key(cfg: Config, key: str) -> str:
    env = os.environ.get(env_var_for(key), "").strip()
    if env:
        return env
    return cfg.providers.get(key, ProviderConfig()).api_key or ""


def account_id(cfg: Config, key: str) -> str:
    env = os.environ.get("CF_ACCOUNT_ID", "").strip()
    if env:
        return env
    return cfg.providers.get(key, ProviderConfig()).account_id or ""


def model_for(cfg: Config, key: str, override: str = "") -> str:
    if override:
        return override
    m = cfg.providers.get(key, ProviderConfig()).model
    return m or cfg.model or ""


def base_url_for(cfg: Config, key: str, fallback: str) -> str:
    env = os.environ.get("BG_BASE_URL", "").strip()
    if env:
        return env
    return cfg.providers.get(key, ProviderConfig()).base_url or fallback


def set_value(cfg: Config, key: str, field: str, value: str) -> None:
    entry = cfg.providers.setdefault(key, ProviderConfig())
    f = field.lower()
    if f in ("api_key", "key"):
        entry.api_key = value
    elif f in ("account_id", "account"):
        entry.account_id = value
    elif f in ("base_url", "url"):
        entry.base_url = value
    elif f == "model":
        entry.model = value
