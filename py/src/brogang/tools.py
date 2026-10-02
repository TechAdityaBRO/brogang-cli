"""Agent capabilities. Mirrors ts/src/tools.ts."""

from __future__ import annotations

import fnmatch
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

MaxReadBytes = 256 * 1024
MaxToolOutputChars = 40_000
MaxSearchResults = 200
CommandTimeout = 120_000
MaxDirEntries = 500

SKIP_DIRS = {
    ".git", "node_modules", "vendor", "dist", "build", "target", ".next", ".nuxt",
    "__pycache__", ".venv", "venv", ".cache", ".gradle", "bin", "obj", ".idea", ".vscode",
}


class Tool:
    def spec(self) -> Dict[str, Any]:
        raise NotImplementedError

    def run(self, args: Dict[str, Any]) -> str:
        raise NotImplementedError


def resolve_in(root: str, p: str) -> str:
    if not p or not p.strip():
        raise ValueError("path is required")
    root_p = os.path.abspath(root)
    abs_p = os.path.abspath(os.path.join(root_p, p))
    if abs_p != root_p and not abs_p.startswith(root_p + os.sep):
        raise ValueError(f'path {p!r} is outside the workspace {root!r}')
    return abs_p


def truncate(s: str, limit: int) -> str:
    b = s.encode("utf-8")
    if len(b) <= limit:
        return s
    cut = max(0, limit - 80)
    return b[:cut].decode("utf-8", errors="ignore") + f"\n… truncated, {len(b) - cut} more bytes"


def line_numbered(content: str) -> str:
    if content == "":
        return ""
    lines = content.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return "".join(f"{i + 1:6}\t{line}\n" for i, line in enumerate(lines))


def walk(base: str, cb: Callable[[str, str, str, bool, int], Any]):
    base_p = os.path.abspath(base)
    for dirpath, dirnames, filenames in os.walk(base_p, topdown=True):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(os.listdir(dirpath)):
            abs_p = os.path.join(dirpath, name)
            rel = os.path.relpath(abs_p, base_p)
            is_dir = os.path.isdir(abs_p)
            if name in SKIP_DIRS:
                continue
            size = 0 if is_dir else os.path.getsize(abs_p)
            action = cb(abs_p, rel, name, is_dir, size)
            if action == "skipdir" and is_dir:
                dirnames[:] = [d for d in dirnames if d != name]
            elif action == "stop":
                return


def glob_match(pattern: str, name: str) -> bool:
    if pattern.startswith("**/"):
        return fnmatch.fnmatch(name, pattern[3:]) or fnmatch.fnmatch(name, pattern)
    return fnmatch.fnmatch(name, pattern)


class ReadFileTool(Tool):
    def __init__(self, root: str):
        self.root = root

    def spec(self) -> Dict[str, Any]:
        return {
            "name": "read_file",
            "description": (
                "Read a text file from the workspace. Returns contents with line numbers. "
                "Use offset and limit to page through large files."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path, relative to the workspace root or absolute inside it."},
                    "offset": {"type": "integer", "description": "First line to return, 1 based. Default 1."},
                    "limit": {"type": "integer", "description": "Maximum number of lines. Default 400."},
                },
                "required": ["path"],
            },
        }

    def run(self, raw: Dict[str, Any]) -> str:
        p = str(raw.get("path", ""))
        offset = int(raw.get("offset", 0) or 0) or 1
        limit = int(raw.get("limit", 0) or 0) or 400
        abs_p = resolve_in(self.root, p)
        if os.path.isdir(abs_p):
            raise ValueError(f"read_file: {abs_p} is a directory, use list_dir")
        size = os.path.getsize(abs_p)
        if size > MaxReadBytes:
            raise ValueError(f"read_file: {p} is {size} bytes, too large")
        with open(abs_p, "r", encoding="utf-8", errors="replace") as f:
            data = f.read()
        lines = data.replace("\r\n", "\n").split("\n")
        offset = max(1, offset)
        if offset > len(lines):
            return f"(no lines: {p} has {len(lines)} lines)"
        end = min(len(lines), offset - 1 + limit)
        window = "\n".join(lines[offset - 1 : end])
        header = f"{p} ({len(lines)} lines, showing {offset}-{end})\n\n" + line_numbered(window)
        return truncate(header, MaxToolOutputChars)


class WriteFileTool(Tool):
    def __init__(self, root: str):
        self.root = root

    def spec(self) -> Dict[str, Any]:
        return {
            "name": "write_file",
            "description": "Create a new file or replace an existing file's contents with the supplied text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path relative to the workspace root."},
                    "content": {"type": "string", "description": "Full file contents to write."},
                },
                "required": ["path", "content"],
            },
        }

    def run(self, raw: Dict[str, Any]) -> str:
        p = str(raw.get("path", ""))
        content = raw.get("content")
        if not isinstance(content, str):
            raise ValueError("write_file: content is required")
        abs_p = resolve_in(self.root, p)
        os.makedirs(os.path.dirname(abs_p) or abs_p, exist_ok=True)
        with open(abs_p, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return f"Wrote {len(content)} bytes to {p}"


class EditFileTool(Tool):
    def __init__(self, root: str):
        self.root = root

    def spec(self) -> Dict[str, Any]:
        return {
            "name": "edit_file",
            "description": (
                "Replace an exact string in a file. The old string must appear exactly once "
                "unless replace_all is set."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_string": {"type": "string"},
                    "new_string": {"type": "string"},
                    "replace_all": {"type": "boolean"},
                },
                "required": ["path", "old_string", "new_string"],
            },
        }

    def run(self, raw: Dict[str, Any]) -> str:
        p = str(raw.get("path", ""))
        old = raw.get("old_string")
        new = raw.get("new_string")
        replace_all = raw.get("replace_all") is True
        if not isinstance(old, str) or old == "":
            raise ValueError("edit_file: old_string is required")
        if not isinstance(new, str):
            raise ValueError("edit_file: new_string is required")
        abs_p = resolve_in(self.root, p)
        with open(abs_p, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        needle = old.replace("\r\n", "\n")
        count = content.count(needle)
        if count == 0:
            raise ValueError(f"edit_file: old_string not found in {p}")
        if count > 1 and not replace_all:
            raise ValueError(f"edit_file: old_string appears {count} times in {p}")
        content = content.replace(needle, new) if replace_all else content.replace(needle, new, 1)
        with open(abs_p, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return f"Replaced {count if replace_all else 1} occurrence(s) in {p}"


class ListDirTool(Tool):
    def __init__(self, root: str):
        self.root = root

    def spec(self) -> Dict[str, Any]:
        return {
            "name": "list_dir",
            "description": "List files and directories, optionally recursing. Skips dependency and build directories.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory relative to workspace root. Default '.'."},
                    "recursive": {"type": "boolean", "description": "Recurse into subdirectories."},
                },
            },
        }

    def run(self, raw: Dict[str, Any]) -> str:
        rel = str(raw.get("path") or ".")
        recursive = raw.get("recursive") is True
        abs_p = resolve_in(self.root, rel)
        if not os.path.isdir(abs_p):
            raise ValueError(f"list_dir: {rel} is not a directory")
        lines: List[str] = []

        def emit(abs_p2: str, rel2: str, name: str, is_dir: bool, size: int):
            if name in SKIP_DIRS and is_dir:
                return "skipdir"
            if len(lines) >= MaxDirEntries:
                return "stop"
            mark = "/" if is_dir else ""
            right = "" if is_dir else f"  ({size} bytes)"
            lines.append(f"{rel2}{mark}{right}")
            if not recursive and is_dir:
                return "skipdir"
            return None

        walk(abs_p, emit)
        header = f"{rel}: {len(lines)} entries\n\n"
        return truncate(header + "\n".join(lines), MaxToolOutputChars)


class SearchTool(Tool):
    def __init__(self, root: str):
        self.root = root

    def spec(self) -> Dict[str, Any]:
        return {
            "name": "search",
            "description": "Search file contents for a text or regex pattern across the workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Pattern to search for. May be regex."},
                    "glob": {"type": "string", "description": "Optional glob to limit files, e.g. '*.py'."},
                },
                "required": ["pattern"],
            },
        }

    def run(self, raw: Dict[str, Any]) -> str:
        pattern = str(raw.get("pattern", ""))
        glob = str(raw.get("glob", "") or "")
        if not pattern:
            raise ValueError("search: pattern is required")
        try:
            rx = re.compile(pattern)
        except re.error:
            rx = re.compile(re.escape(pattern))
        hits: List[str] = []

        def scan(abs_p: str, rel: str, name: str, is_dir: bool, size: int):
            if len(hits) >= MaxSearchResults:
                return "stop"
            if is_dir:
                return None
            if glob and not fnmatch.fnmatch(name, glob):
                return None
            if name in SKIP_DIRS:
                return None
            try:
                with open(abs_p, "r", encoding="utf-8", errors="replace") as f:
                    for i, line in enumerate(f, 1):
                        if rx.search(line):
                            hits.append(f"{rel}:{i}:{line.rstrip()}")
                            if len(hits) >= MaxSearchResults:
                                return "stop"
            except (OSError, UnicodeError):
                pass
            return None

        walk(self.root, scan)
        return truncate("\n".join(hits) or f"No matches for {pattern!r}", MaxToolOutputChars)


class RunCommandTool(Tool):
    def __init__(self, root: str):
        self.root = root

    def spec(self) -> Dict[str, Any]:
        return {
            "name": "run_command",
            "description": "Run a shell command in the workspace root. Ask for approval unless auto-approve is on.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The command to execute."},
                    "timeout_ms": {"type": "integer", "description": "Max runtime in milliseconds."},
                },
                "required": ["command"],
            },
        }

    def run(self, raw: Dict[str, Any]) -> str:
        cmd = raw.get("command")
        if not isinstance(cmd, str) or not cmd.strip():
            raise ValueError("run_command: command is required")
        timeout = int(raw.get("timeout_ms", 0) or 0)
        timeout = timeout if timeout > 0 else CommandTimeout
        try:
            proc = subprocess.run(
                cmd,
                shell=True,
                cwd=os.path.abspath(self.root),
                capture_output=True,
                text=True,
                timeout=timeout / 1000,
            )
            out = proc.stdout or ""
            err = proc.stderr or ""
            reply = out
            if err.strip():
                reply += (("\n" if reply else "") + err)
            if proc.returncode != 0:
                reply += (("\n" if reply else "") + f"(exit code {proc.returncode})")
            return truncate(reply or "(no output)", MaxToolOutputChars)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"run_command: timed out after {timeout}ms")


class ToolRegistry:
    def __init__(self, root: Optional[str] = None):
        self.root = os.path.abspath(root or os.getcwd())
        self._tools: Dict[str, Tool] = {}

    def register(self, t: Tool) -> None:
        self._tools[t.spec()["name"]] = t

    def get(self, name: str) -> Optional[Tool]:
        return self._tools.get(name)

    def names(self) -> List[str]:
        return list(self._tools.keys())

    def specs(self) -> List[Dict[str, Any]]:
        return [t.spec() for t in self._tools.values()]

    @classmethod
    def default(cls, root: Optional[str] = None) -> "ToolRegistry":
        r = cls(root)
        r.register(ReadFileTool(r.root))
        r.register(WriteFileTool(r.root))
        r.register(EditFileTool(r.root))
        r.register(ListDirTool(r.root))
        r.register(SearchTool(r.root))
        r.register(RunCommandTool(r.root))
        return r


read_file_tool = ReadFileTool(os.getcwd())
run_command_tool = RunCommandTool(os.getcwd())
