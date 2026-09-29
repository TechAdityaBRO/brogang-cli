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

// OpenAICompatible talks to any service exposing the OpenAI chat completions
// API. One implementation therefore covers OpenAI, Cloudflare Workers AI,
// Groq, Together AI, OpenRouter, and a local Ollama or LM Studio server.
type OpenAICompatible struct {
	// Key is the API key or bearer token. Cloudflare requires an account id in
	// addition to the token, which AccountID supplies.
	Key       string
	AccountID string
	// BaseURL is the API root without a trailing slash.
	BaseURL string
	// KeyName labels the credential in setup prompts, for example "API key".
	KeyName string
	// DefaultModel is used when the config leaves the model empty.
	DefaultModel string
	// StaticModels lets a backend declare its catalogue without a network call.
	StaticModels []string
	// NoKey marks a backend that needs no credential, such as the hosted
	// Bro Gang AI endpoint or a local runtime.
	NoKey bool

	name  string
	label string
	http  *http.Client
}

// NewOpenAICompatibleNoKey builds a provider that requires no credentials.
func NewOpenAICompatibleNoKey(name, label, baseURL, defaultModel string, staticModels []string) *OpenAICompatible {
	return &OpenAICompatible{
		name:         name,
		label:        label,
		BaseURL:      strings.TrimRight(baseURL, "/"),
		KeyName:      "no key needed",
		DefaultModel: defaultModel,
		StaticModels: staticModels,
		NoKey:        true,
		http:         &http.Client{Timeout: 180 * time.Second},
	}
}

// NewOpenAICompatible builds an OpenAI-compatible provider.
func NewOpenAICompatible(name, label, baseURL, keyName, defaultModel string, staticModels []string) *OpenAICompatible {
	return &OpenAICompatible{
		name:         name,
		label:        label,
		BaseURL:      strings.TrimRight(baseURL, "/"),
		KeyName:      keyName,
		DefaultModel: defaultModel,
		StaticModels: staticModels,
		http:         &http.Client{Timeout: 180 * time.Second},
	}
}

// Name implements Provider.
func (p *OpenAICompatible) Name() string { return p.name }

// Label implements Provider.
func (p *OpenAICompatible) Label() string { return p.label }

// RequiresAPIKey implements Provider.
func (p *OpenAICompatible) RequiresAPIKey() bool { return !p.NoKey }

// ListModels implements Provider. Static catalogues short circuit the request.
func (p *OpenAICompatible) ListModels(ctx context.Context) ([]string, error) {
	if len(p.StaticModels) > 0 {
		return append([]string(nil), p.StaticModels...), nil
	}
	if p.Key == "" && !p.NoKey {
		return nil, ErrNoAPIKey
	}

	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := p.doJSON(ctx, http.MethodGet, p.BaseURL+"/models", nil, &out); err != nil {
		return nil, err
	}
	models := make([]string, 0, len(out.Data))
	for _, m := range out.Data {
		models = append(models, m.ID)
	}
	return models, nil
}

// Complete implements Provider.
func (p *OpenAICompatible) Complete(ctx context.Context, req Request) (*Response, error) {
	if p.Key == "" && !p.NoKey {
		return nil, ErrNoAPIKey
	}
	if req.Model == "" {
		req.Model = p.DefaultModel
	}

	body := map[string]any{"model": req.Model, "messages": req.Messages}
	if req.Temperature > 0 {
		body["temperature"] = req.Temperature
	}
	if req.MaxTokens > 0 {
		body["max_tokens"] = req.MaxTokens
	}
	if len(req.Tools) > 0 {
		body["tools"] = req.Tools
		body["tool_choice"] = "auto"
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content   string     `json:"content"`
				ToolCalls []ToolCall `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage Usage  `json:"usage"`
		Model string `json:"model"`
	}
	if err := p.doJSON(ctx, http.MethodPost, p.BaseURL+"/chat/completions", body, &out); err != nil {
		return nil, err
	}
	if len(out.Choices) == 0 {
		return nil, fmt.Errorf("%s returned no choices", p.label)
	}

	choice := out.Choices[0]
	return &Response{
		Content:      choice.Message.Content,
		ToolCalls:    choice.Message.ToolCalls,
		FinishReason: choice.FinishReason,
		Model:        out.Model,
		Usage:        out.Usage,
	}, nil
}

// doJSON performs a request with the provider's auth headers and decodes the
// response into out. Non 2xx responses are surfaced with the server's message.
func (p *OpenAICompatible) doJSON(ctx context.Context, method, url string, body, out any) error {
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
	req.Header.Set("Authorization", "Bearer "+p.Key)
	if p.AccountID != "" {
		req.Header.Set("CF-Access-Client-Id", p.AccountID)
	}

	resp, err := p.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s request failed: %w", p.label, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s returned %s: %s", p.label, resp.Status, extractError(data))
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

// extractError pulls the human readable message out of a provider error body,
// falling back to the raw payload when the shape is unfamiliar.
func extractError(data []byte) string {
	var env struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
		Detail  string `json:"detail"`
	}
	if err := json.Unmarshal(data, &env); err == nil {
		for _, candidate := range []string{env.Error.Message, env.Message, env.Detail} {
			if candidate != "" {
				return candidate
			}
		}
	}
	trimmed := strings.TrimSpace(string(data))
	if len(trimmed) > 400 {
		trimmed = trimmed[:400] + "…"
	}
	if trimmed == "" {
		return "empty response body"
	}
	return trimmed
}
