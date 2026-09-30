// The conversation loop: send the transcript to the model, execute whatever
// tools it asks for, feed the results back, and repeat until the model replies
// with plain text.
//
// Mirrors internal/agent/agent.go

import type {
  CompletionRequest,
  Message,
  Provider,
  ToolCall,
  ToolSpec,
} from "./provider.js";
import type { Config } from "./config.js";
import type { ToolRegistry } from "./tools.js";

/** SystemPrompt is the agent's operating brief, sent at session start. */
export const SystemPrompt = `You are BRO GANG CLI, a free and open source AI coding agent.

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

Be concise. Skip preamble and flattery. Answer the question that was asked.`;

/** DefaultMaxSteps caps tool calling rounds per user turn. */
export const DefaultMaxSteps = 24;

export type EventKind = "step" | "tool_start" | "tool_done" | "text" | "done";

export interface AgentEvent {
  kind: EventKind;
  step?: number;
  total?: number;
  name?: string;
  args?: Record<string, unknown>;
  rawArgs?: string;
  result?: string;
  error?: Error;
  delta?: string;
}

export interface AgentOptions {
  /** provider is the model backend. */
  provider: Provider;
  /** model overrides the provider's configured model. */
  model?: string;
  /** tools is the tool registry. Omit to disable tool use entirely. */
  tools?: ToolRegistry;
  /** config supplies sampling defaults. */
  config?: Config;
  /**
   * confirm is awaited before a tool runs. Omitting it auto approves.
   * Throwing aborts the call and the reason is shown to the model.
   */
  confirm?: (name: string, rawArgs: string) => Promise<void>;
  /** maxSteps bounds tool calling rounds. 0 means DefaultMaxSteps. */
  maxSteps?: number;
  /** onEvent receives progress notifications for the UI layer. */
  onEvent?: (event: AgentEvent) => void;
  /** systemPrompt overrides the default operating brief. */
  systemPrompt?: string;
  /** signal cancels an in-flight turn. */
  signal?: AbortSignal;
}

export class MaxStepsError extends Error {
  constructor(readonly steps: number) {
    super(`step limit reached without a final answer (${steps})`);
    this.name = "MaxStepsError";
  }
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export class Agent {
  private opts: AgentOptions;
  private messages: Message[];

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.messages = [
      { role: "system", content: opts.systemPrompt || SystemPrompt },
    ];
  }

  /** transcript returns a copy of the conversation so far. */
  transcript(): Message[] {
    return [...this.messages];
  }

  /** reset clears the conversation, keeping the system prompt. */
  reset(): void {
    this.messages = this.messages.slice(0, 1);
  }

  /**
   * setSignal swaps the cancellation signal for the next turn. A session
   * reuses one Agent so the transcript accumulates, but Ctrl+C must abandon
   * only the turn in flight — so each turn installs a fresh controller.
   */
  setSignal(signal: AbortSignal): void {
    this.opts.signal = signal;
  }

  systemPromptText(): string {
    return this.messages[0]?.content ?? "";
  }

  /**
   * send runs one full turn: the user message is appended, then the model and
   * tool loop runs until the model answers with text only.
   */
  async send(input: string): Promise<string> {
    if (!input || input.trim() === "") throw new Error("empty input");

    const maxSteps = this.opts.maxSteps && this.opts.maxSteps > 0
      ? this.opts.maxSteps
      : DefaultMaxSteps;

    this.messages.push({ role: "user", content: input });

    const toolsEnabled = Boolean(this.opts.tools);
    const specs: ToolSpec[] = toolsEnabled ? this.opts.tools!.specs() : [];

    let final = "";
    for (let step = 1; step <= maxSteps; step++) {
      this.throwIfAborted();
      this.emit({ kind: "step", step, total: maxSteps });

      let resp;
      try {
        resp = await this.complete(specs);
      } catch (err) {
        if (this.aborted()) throw new CancelledError();
        throw err;
      }

      if (resp.content) {
        final = resp.content;
        this.emit({ kind: "text", delta: resp.content });
      }

      // No tool calls means the model is done for this turn.
      if (!resp.tool_calls || resp.tool_calls.length === 0) {
        this.messages.push({ role: "assistant", content: resp.content });
        this.emit({ kind: "done" });
        return final;
      }

      this.messages.push({
        role: "assistant",
        content: resp.content,
        tool_calls: resp.tool_calls,
      });

      const results = await this.runToolCalls(resp.tool_calls, step);
      this.messages.push(...results);
    }

    throw new MaxStepsError(maxSteps);
  }

  private async complete(specs: ToolSpec[]) {
    const req: CompletionRequest = {
      model: this.opts.model ?? "",
      messages: this.messages,
    };
    if (specs.length > 0) req.tools = specs;
    if (this.opts.config) {
      req.temperature = this.opts.config.temperature;
      req.max_tokens = this.opts.config.max_tokens;
    }
    return this.opts.provider.complete(req);
  }

  private async runToolCalls(calls: ToolCall[], step: number): Promise<Message[]> {
    const out: Message[] = [];
    if (!this.opts.tools) return out;

    for (const call of calls) {
      const name = call.function?.name ?? "";
      let raw = call.function?.arguments ?? "";
      if (raw === "") raw = "{}";

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }

      this.emit({ kind: "tool_start", step, name, rawArgs: raw, args: parsed });

      const tool = this.opts.tools.get(name);
      if (!tool) {
        const msg = `Unknown tool ${JSON.stringify(name)}. Available tools: ${this.opts.tools.names().join(", ")}`;
        out.push({ role: "tool", name, tool_call_id: call.id, content: msg });
        this.emit({ kind: "tool_done", step, name, error: new Error(msg) });
        continue;
      }

      if (this.opts.confirm) {
        try {
          await this.opts.confirm(name, raw);
        } catch (err) {
          const e = err as Error;
          const msg = `User declined ${name}: ${e.message}`;
          out.push({ role: "tool", name, tool_call_id: call.id, content: msg });
          this.emit({ kind: "tool_done", step, name, error: e });
          continue;
        }
      }

      let result: string;
      let runErr: Error | undefined;
      try {
        this.throwIfAborted();
        result = await tool.run(parsed);
      } catch (err) {
        runErr = err as Error;
        result = "Error: " + runErr.message;
      }

      out.push({ role: "tool", name, tool_call_id: call.id, content: result });
      this.emit({ kind: "tool_done", step, name, result, error: runErr });
    }
    return out;
  }

  private aborted(): boolean {
    return this.opts.signal?.aborted === true;
  }

  private throwIfAborted(): void {
    if (this.aborted()) throw new CancelledError();
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent?.(event);
  }
}
