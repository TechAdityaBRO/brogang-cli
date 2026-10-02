"""Provider interface and registry.

Mirrors ts/src/provider.ts. Uses urllib from the standard library so the
package stays dependency free.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

HTTP_TIMEOUT_MS = 180_000
HTTP_TIMEOUT = HTTP_TIMEOUT_MS / 1000


def _truncate(text: str) -> str:
    t = text.strip()
    if len(t) > 400:
        return t[:400] + "…"
    return t or "empty response body"


def extract_error(data: str) -> str:
    try:
        parsed = json.loads(data)
    except Exception:
        parsed = None
    if isinstance(parsed, dict):
        for c in (
            parsed.get("error", {}).get("message") if isinstance(parsed.get("error"), dict) else None,
            parsed.get("message"),
            parsed.get("detail"),
        ):
            if isinstance(c, str) and c:
                return c
    return _truncate(data)


def _do_json(method: str, url: str, body: Any = None, headers: Optional[Dict[str, str]] = None) -> Any:
    h = {"content-type": "application/json"}
    if headers:
        h.update(headers)
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=payload, method=method.upper(), headers=h)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as res:
            text = res.read().decode("utf-8")
            if res.status >= 400:
                raise RuntimeError(f"{res.status}: {extract_error(text)}")
            return json.loads(text)
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{err.code} {err.reason}: {extract_error(text)}") from err


class NoAPIKeyError(Exception):
    pass


ErrNoAPIKey = NoAPIKeyError()


def _role_from(v: Any) -> str:
    return v if isinstance(v, str) else "user"


class ToolSpec:
    def __init__(self, name: str, description: str, parameters: Dict[str, Any]):
        self.name = name
        self.description = description
        self.parameters = parameters

    def to_dict(self) -> dict:
        return {
            "type": "function",
            "function": {"name": self.name, "description": self.description, "parameters": self.parameters},
        }


class ToolCall:
    def __init__(self, id: str, name: str, arguments: str):
        self.id = id
        self.type = "function"
        self.function = type("F", (), {"name": name, "arguments": arguments})()

    @classmethod
    def from_dict(cls, d: dict) -> "ToolCall":
        return cls(
            id=d.get("id", ""),
            name=(d.get("function") or {}).get("name", ""),
            arguments=(d.get("function") or {}).get("arguments", ""),
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "function": {"name": self.function.name, "arguments": self.function.arguments},
        }


class Message:
    def __init__(self, role: str, content: str = "", name: Optional[str] = None,
                 tool_call_id: Optional[str] = None, tool_calls: Optional[List[ToolCall]] = None):
        self.role = role
        self.content = content
        self.name = name
        self.tool_call_id = tool_call_id
        self.tool_calls = tool_calls

    def to_dict(self) -> dict:
        d: Dict[str, Any] = {"role": self.role, "content": self.content}
        if self.name:
            d["name"] = self.name
        if self.tool_call_id:
            d["tool_call_id"] = self.tool_call_id
        if self.tool_calls:
            d["tool_calls"] = [c.to_dict() for c in self.tool_calls]
        return d


class CompletionRequest:
    def __init__(self, model: str, messages: List[Message], tools: Optional[List[ToolSpec]] = None,
                 temperature: Optional[float] = None, max_tokens: Optional[int] = None):
        self.model = model
        self.messages = messages
        self.tools = tools
        self.temperature = temperature
        self.max_tokens = max_tokens


class Usage:
    def __init__(self, prompt_tokens=0, completion_tokens=0, total_tokens=0):
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.total_tokens = total_tokens

    @classmethod
    def from_dict(cls, d: Optional[dict]) -> "Usage":
        d = d or {}
        return cls(int(d.get("prompt_tokens", 0) or 0), int(d.get("completion_tokens", 0) or 0), int(d.get("total_tokens", 0) or 0))


class CompletionResponse:
    def __init__(self, content: str, tool_calls: Optional[List[ToolCall]] = None,
                 finish_reason: Optional[str] = None, model: Optional[str] = None,
                 usage: Optional[Usage] = None):
        self.content = content
        self.tool_calls = tool_calls
        self.finish_reason = finish_reason
        self.model = model
        self.usage = usage


class Provider:
    name: str = ""
    label: str = ""

    def name_(self) -> str:
        return self.name

    def label_(self) -> str:
        return self.label

    def requires_api_key(self) -> bool:
        return True

    def list_models(self) -> List[str]:
        return []

    def complete(self, req: CompletionRequest) -> CompletionResponse:
        raise NotImplementedError


class OpenAICompatible(Provider):
    def __init__(self, name: str, label: str, base_url: str, key_name: str,
                 default_model: str, static_models: Optional[List[str]] = None, no_key: bool = False):
        self.id = name
        self.lbl = label
        self.base_url = base_url.rstrip("/")
        self.key_name = key_name
        self.default_model = default_model
        self.static_models = static_models or []
        self.no_key = no_key
        self.key = ""
        self.account_id = ""

    def name_(self) -> str:
        return self.id

    def label_(self) -> str:
        return self.lbl

    def requires_api_key(self) -> bool:
        return not self.no_key

    def _auth_headers(self) -> Dict[str, str]:
        h: Dict[str, str] = {}
        if self.key:
            h["authorization"] = f"Bearer {self.key}"
        if self.account_id:
            h["CF-Access-Client-Id"] = self.account_id
        return h

    def list_models(self) -> List[str]:
        if self.static_models:
            return list(self.static_models)
        if not self.key and not self.no_key:
            raise NoAPIKeyError()
        out = _do_json("GET", self.base_url + "/models", headers=self._auth_headers())
        data = out.get("data", []) if isinstance(out, dict) else []
        return [m.get("id", "") for m in data if isinstance(m, dict)]

    def complete(self, req: CompletionRequest) -> CompletionResponse:
        if not self.key and not self.no_key:
            raise NoAPIKeyError()
        model = req.model or self.default_model
        body: Dict[str, Any] = {"model": model, "messages": [m.to_dict() for m in req.messages]}
        if req.temperature is not None:
            body["temperature"] = req.temperature
        if req.max_tokens is not None:
            body["max_tokens"] = req.max_tokens
        if req.tools:
            body["tools"] = [t.to_dict() for t in req.tools]
            body["tool_choice"] = "auto"
        out = _do_json("POST", self.base_url + "/chat/completions", body=body, headers=self._auth_headers())
        choices = out.get("choices") or []
        if not choices:
            raise RuntimeError(f"{self.lbl} returned no choices")
        c = choices[0]
        msg = c.get("message", {}) or {}
        calls = msg.get("tool_calls")
        tool_calls = [ToolCall.from_dict(x) for x in calls] if isinstance(calls, list) else None
        return CompletionResponse(
            content=msg.get("content", "") or "",
            tool_calls=tool_calls,
            finish_reason=c.get("finish_reason"),
            model=out.get("model"),
            usage=Usage.from_dict(out.get("usage")) if "usage" in out else None,
        )


class Anthropic(Provider):
    """Claude Messages API."""

    def __init__(self, key: str = "", base_url: str = "https://api.anthropic.com",
                 default_model: str = "claude-sonnet-4-5", max_tokens: int = 4096,
                 static_models: Optional[List[str]] = None):
        self.key = key
        self.base_url = base_url.rstrip("/")
        self.default_model = default_model
        self.max_tokens = max_tokens
        self.static_models = static_models or []

    def name_(self) -> str:
        return "anthropic"

    def label_(self) -> str:
        return "Anthropic"

    def complete(self, req: CompletionRequest) -> CompletionResponse:
        if not self.key:
            raise NoAPIKeyError()
        model = req.model or self.default_model
        system = ""
        msgs = []
        for m in req.messages:
            if m.role == "system":
                system = m.content
            else:
                msgs.append(m.to_dict())
        body: Dict[str, Any] = {
            "model": model,
            "max_tokens": req.max_tokens or self.max_tokens,
            "messages": msgs,
        }
        if system:
            body["system"] = system
        if req.temperature is not None:
            body["temperature"] = req.temperature
        if req.tools:
            body["tools"] = [
                {"name": t.name, "description": t.description, "input_schema": t.parameters}
                for t in req.tools
            ]
        out = _do_json(
            "POST",
            self.base_url + "/v1/messages",
            body=body,
            headers={"x-api-key": self.key, "anthropic-version": "2023-06-01"},
        )
        blocks = out.get("content") or []
        text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
        first = blocks[0] if blocks and isinstance(blocks[0], dict) else {}
        return CompletionResponse(content=text, finish_reason=out.get("stop_reason"), model=out.get("model"))

    def list_models(self) -> List[str]:
        return list(self.static_models) or [self.default_model]


class _Registry:
    def __init__(self):
        self._impls: Dict[str, Provider] = {
            "brogang": OpenAICompatible(
                "brogang",
                "BRO GANG AI",
                "https://brogangaicli.pages.dev/v1",
                "API key",
                "llama-3.3-70b",
                static_models=["llama-3.3-70b"],
                no_key=True,
            ),
            "ollama": OpenAICompatible(
                "ollama",
                "Ollama",
                "http://localhost:11434/v1",
                "API key",
                "llama3.2",
                no_key=True,
            ),
            "cloudflare": OpenAICompatible(
                "cloudflare",
                "Cloudflare Workers AI",
                "https://api.cloudflare.com/client/v4/accounts",
                "API token",
                "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            ),
            "groq": OpenAICompatible(
                "groq",
                "Groq",
                "https://api.groq.com/openai/v1",
                "API key",
                "llama-3.3-70b-versatile",
            ),
            "openai": OpenAICompatible(
                "openai",
                "OpenAI",
                "https://api.openai.com/v1",
                "API key",
                "gpt-4o-mini",
            ),
            "together": OpenAICompatible(
                "together",
                "Together",
                "https://api.together.xyz/v1",
                "API key",
                "meta-llama/Llama-3-70b-chat-hf",
            ),
            "openrouter": OpenAICompatible(
                "openrouter",
                "OpenRouter",
                "https://openrouter.ai/api/v1",
                "API key",
                "openai/gpt-4o-mini",
            ),
            "anthropic": Anthropic(),
        }

    def get(self, name: str) -> Provider:
        p = self._impls.get(name.lower())
        if p is None:
            raise KeyError(f"unknown provider {name!r}")
        return p

    def names(self) -> List[str]:
        return list(self._impls.keys())

    def labels(self) -> Dict[str, str]:
        return {k: v.label_() for k, v in self._impls.items()}


registry = _Registry()
