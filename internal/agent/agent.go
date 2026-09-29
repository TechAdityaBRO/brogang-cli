// Package agent runs the conversation loop: send the transcript to the model,
// execute whatever tools it asks for, feed the results back, and repeat until
// the model replies with plain text.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/TechAdityaBRO/brogang-cli/internal/config"
	"github.com/TechAdityaBRO/brogang-cli/internal/provider"
	"github.com/TechAdityaBRO/brogang-cli/internal/tools"
)

// SystemPrompt is the agent's operating brief. It states the tool contract and
// the confirmation expectation, and is sent at the start of every session.
const SystemPrompt = `You are BRO GANG CLI, a free and open source AI coding agent.

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

Be concise. Skip preamble and flattery. Answer the question that was asked.`

// Options configures an Agent.
type Options struct {
	// Provider is the model backend.
	Provider provider.Provider
	// Model overrides the provider's configured model.
	Model string
	// Tools is the tool registry. Nil disables tool use entirely.
	Tools *tools.Registry
	// Config supplies sampling defaults.
	Config *config.Config
	// Confirm is called before a tool runs. A nil Confirm auto approves.
	// Returning an error aborts the call and the reason is shown to the model.
	Confirm func(name string, args json.RawMessage) error
	// MaxSteps bounds tool calling rounds so a confused model cannot loop
	// forever. Zero means DefaultMaxSteps.
	MaxSteps int
	// OnEvent receives progress notifications for the UI layer.
	OnEvent func(Event)
	// SystemPrompt overrides the default operating brief.
	SystemPrompt string
}

// DefaultMaxSteps caps tool calling rounds per user turn.
const DefaultMaxSteps = 24

// EventKind classifies an Event.
type EventKind string

const (
	// EventStep announces a new tool calling round.
	EventStep EventKind = "step"
	// EventToolStart fires before a tool executes.
	EventToolStart EventKind = "tool_start"
	// EventToolDone fires after a tool executes, successfully or not.
	EventToolDone EventKind = "tool_done"
	// EventText streams assistant text as it arrives.
	EventText EventKind = "text"
	// EventDone fires once the turn is complete.
	EventDone EventKind = "done"
)

// Event reports agent progress to the UI.
type Event struct {
	Kind   EventKind
	Step   int
	Total  int
	Name   string
	Args   json.RawMessage
	Result string
	Err    error
	Delta  string
}

// Agent holds the conversation and the loop configuration.
type Agent struct {
	opts     Options
	messages []provider.Message
}

// New creates an agent with the system prompt seeded.
func New(opts Options) *Agent {
	if opts.MaxSteps <= 0 {
		opts.MaxSteps = DefaultMaxSteps
	}
	prompt := opts.SystemPrompt
	if prompt == "" {
		prompt = SystemPrompt
	}
	return &Agent{
		opts: opts,
		messages: []provider.Message{
			{Role: provider.RoleSystem, Content: prompt},
		},
	}
}

// Messages returns a copy of the conversation so far.
func (a *Agent) Messages() []provider.Message {
	return append([]provider.Message(nil), a.messages...)
}

// Reset clears the conversation, keeping the system prompt.
func (a *Agent) Reset() {
	a.messages = a.messages[:1]
}

// SystemPromptText returns the system prompt in force for this session.
func (a *Agent) SystemPromptText() string {
	if len(a.messages) == 0 {
		return ""
	}
	return a.messages[0].Content
}

// ErrMaxSteps is returned when a turn exceeds the tool calling budget.
var ErrMaxSteps = errors.New("step limit reached without a final answer")

// Send runs one full turn: the user message is appended, then the model and
// tool loop runs until the model answers with text only.
func (a *Agent) Send(ctx context.Context, input string) (string, error) {
	if strings.TrimSpace(input) == "" {
		return "", errors.New("empty input")
	}
	a.messages = append(a.messages, provider.Message{Role: provider.RoleUser, Content: input})

	toolsEnabled := a.opts.Tools != nil
	var specs []provider.Tool
	if toolsEnabled {
		specs = a.opts.Tools.Specs()
	}

	var final string
	for step := 1; step <= a.opts.MaxSteps; step++ {
		a.emit(Event{Kind: EventStep, Step: step, Total: a.opts.MaxSteps})

		resp, err := a.complete(ctx, toolsEnabled, specs)
		if err != nil {
			return final, err
		}

		if resp.Content != "" {
			final = resp.Content
			a.emit(Event{Kind: EventText, Delta: resp.Content})
		}

		// No tool calls means the model is done for this turn.
		if len(resp.ToolCalls) == 0 {
			a.messages = append(a.messages, provider.Message{
				Role:    provider.RoleAssistant,
				Content: resp.Content,
			})
			a.emit(Event{Kind: EventDone})
			return final, nil
		}

		a.messages = append(a.messages, provider.Message{
			Role:      provider.RoleAssistant,
			Content:   resp.Content,
			ToolCalls: resp.ToolCalls,
		})

		results := a.runToolCalls(ctx, resp.ToolCalls, step)
		a.messages = append(a.messages, results...)
	}

	return final, fmt.Errorf("%w (%d)", ErrMaxSteps, a.opts.MaxSteps)
}

// complete performs one model call with the current transcript.
func (a *Agent) complete(ctx context.Context, toolsEnabled bool, specs []provider.Tool) (*provider.Response, error) {
	req := provider.Request{
		Model:    a.opts.Model,
		Messages: a.messages,
	}
	if toolsEnabled && len(specs) > 0 {
		req.Tools = specs
	}
	if a.opts.Config != nil {
		req.Temperature = a.opts.Config.Temperature
		req.MaxTokens = a.opts.Config.MaxTokens
	}
	return a.opts.Provider.Complete(ctx, req)
}

// runToolCalls executes every requested tool and returns the tool messages to
// append to the transcript.
func (a *Agent) runToolCalls(ctx context.Context, calls []provider.ToolCall, step int) []provider.Message {
	out := make([]provider.Message, 0, len(calls))

	for _, call := range calls {
		a.emit(Event{Kind: EventToolStart, Step: step, Name: call.Function.Name, Args: json.RawMessage(call.Function.Arguments)})

		tool, ok := a.opts.Tools.Get(call.Function.Name)
		if !ok {
			msg := fmt.Sprintf("Unknown tool %q. Available tools: %s", call.Function.Name, strings.Join(a.opts.Tools.Names(), ", "))
			out = append(out, provider.Message{Role: provider.RoleTool, Name: call.Function.Name, ToolCallID: call.ID, Content: msg})
			a.emit(Event{Kind: EventToolDone, Step: step, Name: call.Function.Name, Err: errors.New(msg)})
			continue
		}

		if a.opts.Confirm != nil {
			if err := a.opts.Confirm(call.Function.Name, json.RawMessage(call.Function.Arguments)); err != nil {
				msg := fmt.Sprintf("User declined %s: %v", call.Function.Name, err)
				out = append(out, provider.Message{Role: provider.RoleTool, Name: call.Function.Name, ToolCallID: call.ID, Content: msg})
				a.emit(Event{Kind: EventToolDone, Step: step, Name: call.Function.Name, Err: err})
				continue
			}
		}

		result, err := tool.Run(ctx, json.RawMessage(call.Function.Arguments))
		if err != nil {
			result = "Error: " + err.Error()
		}
		out = append(out, provider.Message{Role: provider.RoleTool, Name: call.Function.Name, ToolCallID: call.ID, Content: result})
		a.emit(Event{Kind: EventToolDone, Step: step, Name: call.Function.Name, Result: result, Err: err})
	}
	return out
}

func (a *Agent) emit(e Event) {
	if a.opts.OnEvent != nil {
		a.opts.OnEvent(e)
	}
}
