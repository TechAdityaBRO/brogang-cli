package provider

import "fmt"

// Defaults for every supported backend. Cloudflare is listed first because it
// is the free option the BRO GANG AI site already runs on, and the project
// should work with zero cost.
const (
	// BroGangBaseURL is the hosted, keyless endpoint run by BRO GANG on
	// Cloudflare Pages. It is the CLI default so a fresh install works with
	// no account, no key, and no setup.
	BroGangBaseURL = "https://brogang.techaditya.workers.dev/v1"
	BroGangModel   = "llama-3.3-70b"

	// Cloudflare Workers AI, for users who bring their own token.
	CloudflareBaseURL = "https://api.cloudflare.com/client/v4/accounts/%s/ai/v1"
	CloudflareModel   = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

	// Cloudflare free catalogue, used to avoid a network round trip.
	CloudflareModel2 = "@cf/meta/llama-3.1-8b-instruct"

	// Groq.
	GroqBaseURL = "https://api.groq.com/openai/v1"
	GroqModel   = "llama-3.3-70b-versatile"

	// OpenAI.
	OpenAIBaseURL = "https://api.openai.com/v1"
	OpenAIModel   = "gpt-4o-mini"

	// OpenRouter.
	OpenRouterBaseURL = "https://openrouter.ai/api/v1"
	OpenRouterModel   = "anthropic/claude-3.5-sonnet"

	// Together AI.
	TogetherBaseURL = "https://api.together.xyz/v1"
	TogetherModel   = "meta-llama/Llama-3.3-70B-Instruct-Turbo"

	// Ollama, local, no key required.
	OllamaBaseURL = "http://localhost:11434/v1"
	OllamaModel   = "llama3.2"
)

// Build assembles a registry from saved configuration, wiring every known
// provider with its credentials, base URL, and default model.
func Build(cfg ProviderSettings) *Registry {
	r := NewRegistry()

	// The hosted BRO GANG endpoint comes first: it is free, keyless, and the
	// default, so the CLI is useful the moment it is installed.
	r.Register(NewOpenAICompatibleNoKey(
		"brogang", "Bro Gang AI (free, no key)", pick(cfg.BroGangBaseURL, BroGangBaseURL),
		pick(cfg.BroGangModel, BroGangModel), nil,
	))

	// Cloudflare needs the account id interpolated into the URL.
	cfURL := fmt.Sprintf(CloudflareBaseURL, cfg.CloudflareAccountID)
	r.Register(NewOpenAICompatible(
		"cloudflare", "Cloudflare Workers AI", cfURL, "API token",
		pick(cfg.CloudflareModel, CloudflareModel),
		[]string{CloudflareModel, CloudflareModel2},
	))

	r.Register(NewOpenAICompatible(
		"groq", "Groq", GroqBaseURL, "API key",
		pick(cfg.GroqModel, GroqModel), nil,
	))
	r.Register(NewOpenAICompatible(
		"openai", "OpenAI", OpenAIBaseURL, "API key",
		pick(cfg.OpenAIModel, OpenAIModel), nil,
	))
	r.Register(NewOpenAICompatible(
		"openrouter", "OpenRouter", OpenRouterBaseURL, "API key",
		pick(cfg.OpenRouterModel, OpenRouterModel), nil,
	))
	r.Register(NewOpenAICompatible(
		"together", "Together AI", TogetherBaseURL, "API key",
		pick(cfg.TogetherModel, TogetherModel), nil,
	))
	r.Register(NewOpenAICompatible(
		"ollama", "Ollama (local)", pick(cfg.OllamaBaseURL, OllamaBaseURL), "no key needed",
		pick(cfg.OllamaModel, OllamaModel), nil,
	))
	r.Register(NewAnthropic(cfg.AnthropicKey, pick(cfg.AnthropicModel, "claude-sonnet-4-5"), nil))

	// Apply credentials to the OpenAI-compatible backends.
	for _, p := range r.List() {
		switch compat := p.(type) {
		case *OpenAICompatible:
			switch p.Name() {
			case "cloudflare":
				compat.Key = cfg.CloudflareKey
				compat.AccountID = cfg.CloudflareAccountID
			case "groq":
				compat.Key = cfg.GroqKey
			case "openai":
				compat.Key = cfg.OpenAIKey
			case "openrouter":
				compat.Key = cfg.OpenRouterKey
			case "together":
				compat.Key = cfg.TogetherKey
			}
		}
	}
	return r
}

// ProviderSettings carries the credentials and models needed to build a
// registry. It is a flat view over the nested config file.
type ProviderSettings struct {
	BroGangBaseURL      string
	BroGangModel        string
	CloudflareKey       string
	CloudflareAccountID string
	CloudflareModel     string
	GroqKey             string
	GroqModel           string
	OpenAIKey           string
	OpenAIModel         string
	OpenRouterKey       string
	OpenRouterModel     string
	TogetherKey         string
	TogetherModel       string
	OllamaBaseURL       string
	OllamaModel         string
	AnthropicKey        string
	AnthropicModel      string
}

// pick returns value when non-empty, otherwise fallback.
func pick(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}
