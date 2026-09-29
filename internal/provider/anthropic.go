package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Anthropic talks to the Claude Messages API, which differs from the OpenAI
// shape: a separate system field, no system role inside messages, and tool
// use split across content blocks.
type Anthropic struct {
	// Key is the Anthropic API key.
	Key string
	// BaseURL is the API root without a trailing slash.
	BaseURL string
	// DefaultModel is used when the config leaves the model empty.
	DefaultModel string
	// MaxTokens is required by the Messages API, so it carries a default.
	MaxTokens int
	// StaticModels lets a backend declare its catalogue without a network call.
	StaticModels []string

	http *http.Client
}

// NewAnthropic builds an Anthropic provider.
func NewAnthropic(key, defaultModel string, staticModels []string) *Anthropic {
	return &Anthropic{
		Key:          key,
		BaseURL:      "https://api.anthropic.com",
		DefaultModel: defaultModel,
		MaxTokens:    4096,
		StaticModels: staticModels,
		http:         &http.Client{Timeout: 180 * time.Second},
	}
}

// Name implements Provider.
func (p *Anthropic) Name() string { return "anthropic" }

// Label implements Provider.
func (p *Anthropic) Label() string { return "Anthropic Claude" }

// RequiresAPIKey implements Provider.
func (p *Anthropic) RequiresAPIKey() bool { return true }

// ListModels implements Provider.
func (p *Anthropic) ListModels(ctx context.Context) ([]string, error) {
	if len(p.StaticModels) > 0 {
		return append([]string(nil), p.StaticModels...), nil
	}
	if p.Key == "" {
		return nil, ErrNoAPIKey
	}

	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := p.doJSON(ctx, http.MethodGet, p.BaseURL+"/v1/models", nil, &out); err != nil {
		return nil, err
	}
	models := make([]string, 0, len(out.Data))
	for _, m := range out.Data {
		models = append(models, m.ID)
	}
	return models, nil
}

// Complete implements Provider, translating the OpenAI-shaped Request into
// Claude's Messages payload and back again.
func (p *Anthropic) Complete(ctx context.Context, req Request) (*Response, error) {
	if p.Key == "" {
		return nil, ErrNoAPIKey
	}
	if req.Model == "" {
		req.Model = p.DefaultModel
	}

	// The system prompt lives outside the message array for Claude.
	var systemParts []string
	messages := make([]map[string]any, 0, len(req.Messages))
	for _, m := range req.Messages {
		switch m.Role {
		case RoleSystem:
			if m.Content != "" {
				systemParts = append(systemParts, m.Content)
			}
		case RoleTool:
			messages = append(messages, map[string]any{
				"role": "user",
				"content": []map[string]any{{
					"type":        "tool_result",
					"tool_use_id": m.ToolCallID,
					"content":     m.Content,
				}},
			})
		default:
			messages = append(messages, map[string]any{
				"role":    string(m.Role),
				"content": m.Content,
			})
		}
	}

	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = p.MaxTokens
	}

	body := map[string]any{
		"model":      req.Model,
		"messages":   messages,
		"max_tokens": maxTokens,
	}
	if len(systemParts) > 0 {
		body["system"] = strings.Join(systemParts, "\n\n")
	}
	if req.Temperature > 0 {
		body["temperature"] = req.Temperature
	}

	// Claude names tools "tools" with an input_schema, not a parameters object.
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			tools = append(tools, map[string]any{
				"name":         t.Name,
				"description":  t.Description,
				"input_schema": t.Parameters,
			})
		}
		body["tools"] = tools
	}

	var out struct {
		Content []struct {
			Type      string          `json:"type"`
			Text      string          `json:"text"`
			ID        string          `json:"id"`
			Name      string          `json:"name"`
			Input     json.RawMessage `json:"input"`
			ToolUseID string          `json:"tool_use_id"`
		} `json:"content"`
		StopReason string `json:"stop_reason"`
		Model      string `json:"model"`
		Usage      struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := p.doJSON(ctx, http.MethodPost, p.BaseURL+"/v1/messages", body, &out); err != nil {
		return nil, err
	}

	resp := &Response{
		FinishReason: out.StopReason,
		Model:        out.Model,
		Usage: Usage{
			PromptTokens:     out.Usage.InputTokens,
			CompletionTokens: out.Usage.OutputTokens,
			TotalTokens:      out.Usage.InputTokens + out.Usage.OutputTokens,
		},
	}

	var text strings.Builder
	for _, block := range out.Content {
		switch block.Type {
		case "text":
			text.WriteString(block.Text)
		case "tool_use":
			args := string(block.Input)
			if args == "" {
				args = "{}"
			}
			resp.ToolCalls = append(resp.ToolCalls, ToolCall{
				ID:   block.ID,
				Type: "function",
				Function: FunctionCall{
					Name:      block.Name,
					Arguments: args,
				},
			})
		}
	}
	resp.Content = text.String()
	return resp, nil
}

func (p *Anthropic) doJSON(ctx context.Context, method, url string, body, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", p.Key)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := p.http.Do(req)
	if err != nil {
		return fmt.Errorf("Anthropic request failed: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Anthropic returned %s: %s", resp.Status, extractError(data))
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}
