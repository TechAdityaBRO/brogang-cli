"""The conversation loop. Mirrors ts/src/agent.ts."""

from __future__ import annotations

import json
from typing import Callable, Dict, List, Optional

from .config import Config
from .provider import CompletionRequest, Message, Provider, ToolCall, ToolSpec
from .tools import ToolRegistry

SystemPrompt = """You are BRO GANG CLI, a free and open source AI coding agent.

You work directly inside a user's codebase on a terminal. You can read files,
write files, edit files, list directories, search file contents, and run shell
commands.

Operating principles:
- Investigate before you act. Read the relevant files before proposing a change.
- Prefer edit_file over write_file when changing part of a file; prefer
  write_file only for new files or full rewrites.
- Make the smallest change that fully solves the problem.
- Match the surrounding code's style, naming, and conventions.
- Never invent APIs, file paths, or library behaviour. Verify by reading.
- When you run a command that may modify state or need network access, the
  user is asked to approve it first. Do not work around a denial.
- After a tool call, briefly state what you learned before the next action.
- When the task is done, summarise what changed in two or three sentences.

Be concise. Skip preamble and flattery. Answer the question that was asked."""

DefaultMaxSteps = 24


class MaxStepsError(Exception):
    def __init__(self, steps: int):
        super().__init__(f"step limit reached without a final answer ({steps})")
        self.steps = steps


class CancelledError(Exception):
    pass


class Agent:
    def __init__(self, provider: Provider, model: str = "", tools: Optional[ToolRegistry] = None,
                 config: Optional[Config] = None,
                 confirm: Optional[Callable[[str, str], None]] = None,
                 max_steps: int = DefaultMaxSteps,
                 system_prompt: Optional[str] = None):
        self.provider = provider
        self.model = model
        self.tools = tools
        self.config = config
        self.confirm = confirm
        self.max_steps = max_steps or DefaultMaxSteps
        self.messages: List[Message] = [Message(role="system", content=system_prompt or SystemPrompt)]

    def transcript(self) -> List[Message]:
        return list(self.messages)

    def reset(self) -> None:
        self.messages = self.messages[:1]

    def _specs(self) -> List[ToolSpec]:
        if not self.tools:
            return []
        out: List[ToolSpec] = []
        for s in self.tools.specs():
            out.append(ToolSpec(s["name"], s["description"], s.get("parameters", {})))
        return out

    def send(self, input: str) -> str:
        if not input or not input.strip():
            raise ValueError("empty input")
        self.messages.append(Message(role="user", content=input))
        specs = self._specs()
        for step in range(1, self.max_steps + 1):
            resp = self.provider.complete(
                CompletionRequest(
                    model=self.model,
                    messages=self.messages,
                    tools=specs or None,
                    temperature=self.config.temperature if self.config else None,
                    max_tokens=self.config.max_tokens if self.config else None,
                )
            )
            if resp.content:
                final = resp.content
            else:
                final = ""
            if not resp.tool_calls:
                self.messages.append(Message(role="assistant", content=resp.content))
                return final
            self.messages.append(
                Message(role="assistant", content=resp.content or "", tool_calls=resp.tool_calls)
            )
            self.messages.extend(self._run_tool_calls(resp.tool_calls))
        raise MaxStepsError(self.max_steps)

    def _run_tool_calls(self, calls: List[ToolCall]) -> List[Message]:
        out: List[Message] = []
        if not self.tools:
            return out
        for call in calls:
            name = call.function.name or ""
            raw = call.function.arguments or "{}"
            try:
                parsed: Dict = json.loads(raw)
            except Exception:
                parsed = {}
            tool = self.tools.get(name)
            if not tool:
                msg = (
                    f'Unknown tool {name!r}. Available tools: '
                    + ", ".join(self.tools.names())
                )
                out.append(Message(role="tool", name=name, tool_call_id=call.id, content=msg))
                continue
            if self.confirm:
                self.confirm(name, raw)
            try:
                result = tool.run(parsed)
            except Exception as err:  # noqa: BLE001
                result = "Error: " + str(err)
            out.append(Message(role="tool", name=name, tool_call_id=call.id, content=result))
        return out
