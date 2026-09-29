// Package provider defines the AI provider interface shared by every BRO GANG
// CLI backend, plus the concrete implementations for the supported services.
package provider

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Role identifies who produced a message in a conversation.
type Role string

const (
	// RoleSystem carries system and developer instructions.
	RoleSystem Role = "system"
	// RoleUser is input from the human operator.
	RoleUser Role = "user"
	// RoleAssistant is output from the model.
	RoleAssistant Role = "assistant"
	// RoleTool is the result of a tool invocation fed back to the model.
	RoleTool Role = "tool"
)

// Message is a single turn in a conversation.
type Message struct {
	Role    Role   `json:"role"`
	Content string `json:"content"`
	Name    string `json:"name,omitempty"`
	// ToolCallID links a tool result back to the call that produced it.
	ToolCallID string `json:"tool_call_id,omitempty"`
	// ToolCalls is set on an assistant message that requested tools.
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`
}

// ToolCall is a model request to invoke a tool. The OpenAI-compatible shape is
// used across providers so one struct covers them all.
type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
}

// FunctionCall names the tool and carries JSON-encoded arguments.
type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Tool is a capability exposed to the model.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// Request is a single completion call.
type Request struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Tools       []Tool    `json:"tools,omitempty"`
	Temperature float64   `json:"temperature,omitempty"`
	MaxTokens   int       `json:"max_tokens,omitempty"`
}

// Response is the model's reply.
type Response struct {
	Content      string     `json:"content"`
	ToolCalls    []ToolCall `json:"tool_calls,omitempty"`
	FinishReason string     `json:"finish_reason,omitempty"`
	Model        string     `json:"model,omitempty"`
	Usage        Usage      `json:"usage,omitempty"`
}

// Usage reports token accounting when the provider supplies it.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// Provider is the contract every backend implements.
type Provider interface {
	// Name returns the registry key, for example "cloudflare".
	Name() string
	// Label returns a human readable name for display.
	Label() string
	// ListModels returns the model identifiers the provider exposes.
	ListModels(ctx context.Context) ([]string, error)
	// Complete performs a chat completion, optionally with tool calls.
	Complete(ctx context.Context, req Request) (*Response, error)
	// RequiresAPIKey reports whether the provider needs credentials configured.
	RequiresAPIKey() bool
}

// ErrNoAPIKey is returned when a provider is selected but unconfigured.
var ErrNoAPIKey = errors.New("no API key configured for this provider")

// ErrModelNotFound is returned when a requested model is not offered.
var ErrModelNotFound = errors.New("model not found")

// Registry holds the providers available to the CLI, keyed by name.
type Registry struct {
	providers map[string]Provider
	order     []string
}

// NewRegistry returns an empty provider registry.
func NewRegistry() *Registry {
	return &Registry{providers: make(map[string]Provider)}
}

// Register adds a provider. The first registered name for a provider keeps its
// position in the listing order.
func (r *Registry) Register(p Provider) {
	if _, exists := r.providers[p.Name()]; !exists {
		r.order = append(r.order, p.Name())
	}
	r.providers[p.Name()] = p
}

// Get returns a provider by name.
func (r *Registry) Get(name string) (Provider, error) {
	p, ok := r.providers[strings.ToLower(strings.TrimSpace(name))]
	if !ok {
		return nil, fmt.Errorf("unknown provider %q", name)
	}
	return p, nil
}

// List returns providers in registration order.
func (r *Registry) List() []Provider {
	out := make([]Provider, 0, len(r.order))
	for _, name := range r.order {
		out = append(out, r.providers[name])
	}
	return out
}

// Names returns registered provider names in registration order.
func (r *Registry) Names() []string {
	return append([]string(nil), r.order...)
}

// NamesSorted returns provider names alphabetically.
func (r *Registry) NamesSorted() []string {
	out := r.Names()
	sort.Strings(out)
	return out
}
