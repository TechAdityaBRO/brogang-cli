// Agent capabilities: reading and writing files, searching the workspace, and
// running shell commands. Every tool is sandboxed to the workspace root.
//
// Mirrors internal/tools/tools.go — the path guard in particular is the
// security boundary the agent relies on and is ported verbatim.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ToolSpec } from "./provider.js";

// Limits applied to tool output so a single call cannot flood the context.
/** MaxReadBytes caps a single file read (256 KiB). */
export const MaxReadBytes = 256 * 1024;
/** MaxToolOutputChars caps any tool result handed back to the model. */
export const MaxToolOutputChars = 40_000;
/** MaxSearchResults caps grep matches. */
export const MaxSearchResults = 200;
/** CommandTimeout bounds a single shell invocation. */
export const CommandTimeout = 120_000;
/** MaxDirEntries caps directory listings. */
export const MaxDirEntries = 500;

export interface Tool {
  /** spec returns the model facing declaration. */
  spec(): ToolSpec;
  /** run executes the tool and returns the text handed back to the model. */
  run(args: Record<string, unknown>): Promise<string>;
}

// ---------------------------------------------------------------------------
// Path sandbox
// ---------------------------------------------------------------------------

/**
 * resolveIn turns a caller supplied path into an absolute path inside the
 * workspace, refusing anything that escapes via .. or an absolute path.
 *
 * This is the security boundary: it must stay equivalent to the Go version.
 */
export function resolveIn(root: string, p: string): string {
  if (!p || p.trim() === "") {
    throw new Error("path is required");
  }

  // path.resolve mirrors Go's filepath.Join + Clean: it joins relative paths
  // against root and normalises any ".." segments.
  const abs = path.resolve(root, p);

  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path ${JSON.stringify(p)} is outside the workspace ${JSON.stringify(root)}`);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function byteSlice(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // Back off the cut point so we never split a multi-byte sequence.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * truncate shortens s to limit characters, appending a marker that states how
 * much was cut so the model knows output was clipped.
 */
export function truncate(s: string, limit: number): string {
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= limit) return s;
  let cut = limit - 80;
  if (cut < 0) cut = 0;
  return byteSlice(s, cut) + `\n… truncated, ${bytes - cut} more bytes`;
}

/**
 * lineNumbered renders content with 1 based line numbers, which makes model
 * references to specific lines actionable.
 *
 * The trailing empty segment is dropped to match Go's bufio.Scanner, which
 * does not emit a final empty line after a trailing newline.
 */
export function lineNumbered(content: string): string {
  if (content === "") return "";
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  let out = "";
  lines.forEach((line, i) => {
    out += String(i + 1).padStart(6, " ") + "\t" + line + "\n";
  });
  return out;
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

/** Directories never walked during search or listing. */
const skipDirs = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  ".gradle",
  "bin",
  "obj",
  ".idea",
  ".vscode",
]);

type WalkAction = "skipdir" | "stop" | undefined;

const STOP = Symbol("walk-stop");

/**
 * walk visits every entry under base in lexical order, mirroring Go's
 * filepath.WalkDir. Unreadable entries are skipped rather than aborting.
 *
 * Returning "skipdir" prunes a directory, "stop" aborts the whole walk.
 */
function walk(
  base: string,
  cb: (abs: string, rel: string, name: string, isDir: boolean, size: number) => WalkAction,
): void {
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(base, abs);
      if (rel === "") continue;

      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(abs).isDirectory();
        } catch {
          continue;
        }
      }

      let size = 0;
      if (!isDir) {
        try {
          size = fs.statSync(abs).size;
        } catch {
          size = 0;
        }
      }

      let action: WalkAction;
      try {
        action = cb(abs, rel, entry.name, isDir, size);
      } catch (err) {
        if (err === STOP) throw err;
        return; // unreadable entry: skip rather than abort
      }

      if (action === STOP) throw STOP;
      if (isDir && action !== "skipdir") visit(abs);
    }
  };

  try {
    visit(base);
  } catch (err) {
    if (err !== STOP) throw err;
  }
}

// ---------------------------------------------------------------------------
// Glob matching (Go's filepath.Match subset: *, ?, [...])
// ---------------------------------------------------------------------------

function escapeRe(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
}

/** globValid reports whether a pattern is well formed, like filepath.Match. */
export function globValid(pattern: string): boolean {
  let inClass = false;
  for (const ch of pattern) {
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
  }
  return !inClass; // an unterminated class is ErrBadPattern in Go
}

/** globMatch matches a pattern against a single path segment. */
export function globMatch(pattern: string, name: string): boolean {
  if (!globValid(pattern)) return false;

  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      out += "[^/]*";
      i++;
    } else if (ch === "?") {
      out += "[^/]";
      i++;
    } else if (ch === "[") {
      let j = i + 1;
      let cls = "";
      if (pattern[j] === "!" || pattern[j] === "^") {
        cls += "^";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        cls += escapeRe(pattern[j]);
        j++;
      }
      out += "[" + cls + "]";
      i = j + 1;
    } else {
      out += escapeRe(ch);
      i++;
    }
  }

  try {
    return new RegExp("^" + out + "$").test(name);
  } catch {
    return false;
  }
}

function parseGlobs(list: string): string[] {
  const out: string[] = [];
  for (const raw of list.split(",")) {
    const item = raw.trim();
    if (item === "") continue;
    if (!globValid(item)) throw new Error(`invalid glob ${JSON.stringify(item)}`);
    out.push(item);
  }
  return out;
}

function matchesAny(patterns: string[], name: string): boolean {
  return patterns.some((p) => globMatch(p, name));
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

class ReadFileTool implements Tool {
  constructor(private readonly root: string) {}

  spec(): ToolSpec {
    return {
      name: "read_file",
      description:
        "Read a text file from the workspace. Returns contents with line numbers. Use offset and limit to page through large files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path, relative to the workspace root or absolute inside it.",
          },
          offset: {
            type: "integer",
            description: "First line to return, 1 based. Default 1.",
          },
          limit: {
            type: "integer",
            description: "Maximum number of lines. Default 400.",
          },
        },
        required: ["path"],
      },
    };
  }

  async run(raw: Record<string, unknown>): Promise<string> {
    const p = String(raw.path ?? "");
    const offsetRaw = Number(raw.offset ?? 0);
    const limitRaw = Number(raw.limit ?? 0);

    const abs = resolveIn(this.root, p);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      throw new Error(`read_file: ${(err as Error).message}`);
    }
    if (stat.isDirectory()) {
      throw new Error(`read_file: ${abs} is a directory, use list_dir`);
    }
    if (stat.size > MaxReadBytes) {
      throw new Error(
        `read_file: ${p} is ${stat.size} bytes, too large; use offset and limit or grep for it`,
      );
    }

    const data = fs.readFileSync(abs, "utf8");
    const lines = data.replace(/\r\n/g, "\n").split("\n");

    let offset = offsetRaw < 1 ? 1 : Math.trunc(offsetRaw) || 1;
    let limit = limitRaw <= 0 ? 400 : Math.trunc(limitRaw);

    if (offset > lines.length) {
      return `(no lines: ${p} has ${lines.length} lines)`;
    }

    let end = offset - 1 + limit;
    if (end > lines.length) end = lines.length;
    const window = lines.slice(offset - 1, end).join("\n");

    const header =
      `${p} (${lines.length} lines, showing ${offset}-${end})\n\n` + lineNumbered(window);
    return truncate(header, MaxToolOutputChars);
  }
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

class WriteFileTool implements Tool {
  constructor(private readonly root: string) {}

  spec(): ToolSpec {
    return {
      name: "write_file",
      description:
        "Create a new file or replace an existing file's contents with the supplied text. Creates parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
          content: { type: "string", description: "Full file contents to write." },
        },
        required: ["path", "content"],
      },
    };
  }

  async run(raw: Record<string, unknown>): Promise<string> {
    const p = String(raw.path ?? "");
    const content = typeof raw.content === "string" ? raw.content : String(raw.content ?? "");

    const abs = resolveIn(this.root, p);
    const existed = fs.existsSync(abs);

    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    } catch (err) {
      throw new Error(`write_file: ${(err as Error).message}`);
    }

    const verb = existed ? "Overwrote" : "Created";
    return `${verb} ${p} (${Buffer.byteLength(content, "utf8")} bytes)`;
  }
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

class EditFileTool implements Tool {
  constructor(private readonly root: string) {}

  spec(): ToolSpec {
    return {
      name: "edit_file",
      description:
        "Replace an exact string in a file. The old string must appear exactly once unless replace_all is set. Include enough surrounding context to make it unique.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
          old_string: {
            type: "string",
            description: "Exact text to find, including indentation.",
          },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: {
            type: "boolean",
            description: "Replace every occurrence instead of requiring a unique match.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    };
  }

  async run(raw: Record<string, unknown>): Promise<string> {
    const p = String(raw.path ?? "");
    const oldRaw = typeof raw.old_string === "string" ? raw.old_string : "";
    const newStr = typeof raw.new_string === "string" ? raw.new_string : "";
    const replaceAll = raw.replace_all === true;

    if (oldRaw === "") throw new Error("edit_file: old_string is required");

    const abs = resolveIn(this.root, p);
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch (err) {
      throw new Error(`edit_file: ${(err as Error).message}`);
    }

    const needle = oldRaw.replace(/\r\n/g, "\n");
    const count = content.split(needle).length - 1;

    if (count === 0) {
      throw new Error(`edit_file: old_string not found in ${p}`);
    }
    if (count > 1 && !replaceAll) {
      throw new Error(
        `edit_file: old_string appears ${count} times in ${p}; add more context or set replace_all`,
      );
    }

    try {
      fs.writeFileSync(abs, content.split(needle).join(newStr), "utf8");
    } catch (err) {
      throw new Error(`edit_file: ${(err as Error).message}`);
    }

    if (count > 1) return `Replaced ${count} occurrences in ${p}`;
    return `Replaced 1 occurrence in ${p}`;
  }
}

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

function pathOrRoot(base: string, root: string): string {
  if (base === root) return ".";
  const rel = path.relative(root, base);
  return rel === "" ? "." : rel;
}

class ListDirTool implements Tool {
  constructor(private readonly root: string) {}

  spec(): ToolSpec {
    return {
      name: "list_dir",
      description:
        "List files and directories, optionally recursing. Skips dependency and build directories.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory to list. Defaults to the workspace root.",
          },
          depth: { type: "integer", description: "Recursion depth. Default 2." },
          ignore: { type: "string", description: "Comma separated glob patterns to skip." },
        },
      },
    };
  }

  async run(raw: Record<string, unknown>): Promise<string> {
    const p = typeof raw.path === "string" ? raw.path : "";
    const depthRaw = Number(raw.depth ?? 0);
    const ignore = typeof raw.ignore === "string" ? raw.ignore : "";

    let base = this.root;
    if (p !== "") base = resolveIn(this.root, p);
    const depth = depthRaw <= 0 ? 2 : Math.trunc(depthRaw);

    const excludes = parseGlobs(ignore);
    const entries: string[] = [];

    walk(base, (_abs, rel, name, isDir, size) => {
      if (isDir) {
        if (skipDirs.has(name) || matchesAny(excludes, name)) return "skipdir";
      } else if (matchesAny(excludes, name)) {
        return;
      }

      // depthHere mirrors strings.Count(rel, sep) + 1 in the Go original.
      const depthHere = rel.split(path.sep).length;
      if (depthHere > depth) return isDir ? "skipdir" : undefined;

      const prefix = "  ".repeat(depthHere - 1);
      if (isDir) {
        entries.push(prefix + name + "/");
      } else {
        entries.push(prefix + name + ` (${size} B)`);
      }
      if (entries.length >= MaxDirEntries) return "stop";
      return;
    });

    entries.sort();
    const header = `${pathOrRoot(base, this.root)} (${entries.length} entries)\n\n`;
    return truncate(header + entries.join("\n"), MaxToolOutputChars);
  }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

function isBinary(abs: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    if (n === 0) return false;
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

class SearchTool implements Tool {
  constructor(private readonly root: string) {}

  spec(): ToolSpec {
    return {
      name: "search",
      description:
        "Search file contents with a regular expression. Returns matching file, line number, and line text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          path: {
            type: "string",
            description: "Directory or file to search. Defaults to the workspace root.",
          },
          glob: {
            type: "string",
            description: "Only search files matching this glob, for example *.go or *.ts.",
          },
          ignore_case: { type: "boolean", description: "Match case insensitively." },
        },
        required: ["pattern"],
      },
    };
  }

  async run(raw: Record<string, unknown>): Promise<string> {
    const pattern = typeof raw.pattern === "string" ? raw.pattern : "";
    const p = typeof raw.path === "string" ? raw.path : "";
    const glob = typeof raw.glob === "string" ? raw.glob : "";
    const ignoreCase = raw.ignore_case === true;

    if (pattern.trim() === "") throw new Error("search: pattern is required");

    // Go's regexp supports a "(?i)" prefix; JavaScript needs a flag instead.
    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (err) {
      throw new Error(`search: invalid regular expression: ${(err as Error).message}`);
    }

    let base = this.root;
    if (p !== "") base = resolveIn(this.root, p);

    const matches: string[] = [];
    let truncated = false;

    walk(base, (abs, _rel, name, isDir) => {
      if (isDir) {
        if (skipDirs.has(name) && abs !== base) return "skipdir";
        return;
      }
      if (glob !== "" && !globMatch(glob, name)) return;
      if (isBinary(abs)) return;

      let data: string;
      try {
        const buf = fs.readFileSync(abs);
        if (buf.length > MaxReadBytes) return;
        data = buf.toString("utf8");
      } catch {
        return;
      }

      const rel = path.relative(this.root, abs);
      const lines = data.split("\n");
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (line.length > 400) line = line.slice(0, 400) + "…";
        if (re.test(line)) {
          matches.push(`${rel}:${i + 1}: ${line.trim()}`);
          if (matches.length >= MaxSearchResults) {
            truncated = true;
            return "stop";
          }
        }
      }
      return;
    });

    if (matches.length === 0) {
      return `No matches for ${JSON.stringify(pattern)} in ${pathOrRoot(base, this.root)}`;
    }
    let header = `${matches.length} match(es) for ${JSON.stringify(pattern)}\n\n`;
    if (truncated) header += `(capped at ${MaxSearchResults} results)\n\n`;
    return truncate(header + matches.join("\n"), MaxToolOutputChars);
  }
}

// ---------------------------------------------------------------------------
// run_command
// ---------------------------------------------------------------------------

function shellPath(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  return "/bin/sh";
}

function shellFlag(): string {
  return process.platform === "win32" ? "/C" : "-c";
}

class RunCommandTool implements Tool {
  private readonly allowed = new Set<string>();

  constructor(private readonly root: string) {}

  spec(): ToolSpec {
    return {
      name: "run_command",
      description:
        "Run a shell command in the workspace and return its combined output. Commands time out after 120 seconds.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
        },
        required: ["command"],
      },
    };
  }

  /** allow marks a command as safe to run without confirmation. */
  allow(name: string): void {
    this.allowed.add(name);
  }

  /** isAllowed reports whether a command may run without confirmation. */
  isAllowed(command: string): boolean {
    if (this.allowed.size === 0) return false;
    const fields = command.trim().split(/\s+/).filter(Boolean);
    if (fields.length === 0) return false;
    return this.allowed.has(path.basename(fields[0]));
  }

  async run(raw: Record<string, unknown>): Promise<string> {
    const command = typeof raw.command === "string" ? raw.command : "";
    if (command.trim() === "") throw new Error("run_command: command is required");

    const output = await new Promise<string>((resolve) => {
      const child = spawn(shellPath(), [shellFlag(), command], {
        cwd: this.root,
        env: { ...process.env, BG_CLI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let combined = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, CommandTimeout);

      child.stdout?.on("data", (chunk: Buffer) => (combined += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (combined += chunk.toString()));

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(combined + `\n[exit status: ${err.message}]`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve(combined + `\n[timed out after ${CommandTimeout}ms]`);
        } else if (code !== 0 && code !== null) {
          resolve(combined + `\n[exit status: ${code}]`);
        } else {
          resolve(combined);
        }
      });
    });

    let result = output;
    if (result.trim() === "") result = "(no output)";
    return truncate(`$ ${command}\n\n${result}`, MaxToolOutputChars);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** ToolRegistry holds the available tools keyed by name. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly order: string[] = [];
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.add(new ReadFileTool(this.root));
    this.add(new WriteFileTool(this.root));
    this.add(new EditFileTool(this.root));
    this.add(new ListDirTool(this.root));
    this.add(new SearchTool(this.root));
    this.add(new RunCommandTool(this.root));
  }

  private add(t: Tool): void {
    const name = t.spec().name;
    if (!this.tools.has(name)) this.order.push(name);
    this.tools.set(name, t);
  }

  /** specs returns every tool declaration in registration order. */
  specs(): ToolSpec[] {
    return this.order.map((n) => this.tools.get(n)!.spec());
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** names returns registered tool names in registration order. */
  names(): string[] {
    return [...this.order];
  }

  /** allowCommand marks a command as safe to run without confirmation. */
  allowCommand(name: string): void {
    const t = this.tools.get("run_command");
    if (t instanceof RunCommandTool) t.allow(name);
  }

  /** isCommandAllowed reports whether a command runs without confirmation. */
  isCommandAllowed(command: string): boolean {
    const t = this.tools.get("run_command");
    return t instanceof RunCommandTool ? t.isAllowed(command) : false;
  }
}
