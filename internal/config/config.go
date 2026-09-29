// Package config loads and persists BRO GANG CLI settings.
//
// Settings live in ~/.brogang/config.json. API keys may also come from the
// environment, which takes precedence so CI and shared machines never write
// secrets to disk.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// ProviderConfig holds credentials and model selection for one provider.
type ProviderConfig struct {
	APIKey    string `json:"api_key,omitempty"`
	AccountID string `json:"account_id,omitempty"`
	BaseURL   string `json:"base_url,omitempty"`
	Model     string `json:"model,omitempty"`
}

// Config is the full on-disk configuration.
type Config struct {
	// Provider is the default provider key used when none is given on the
	// command line.
	Provider string `json:"provider"`
	// Model overrides the provider's default model.
	Model string `json:"model,omitempty"`
	// Temperature controls sampling; zero means the provider default.
	Temperature float64 `json:"temperature,omitempty"`
	// MaxTokens caps reply length where the provider supports it.
	MaxTokens int `json:"max_tokens,omitempty"`
	// Theme selects the terminal theme; "bang-mach" is the default.
	Theme string `json:"theme,omitempty"`
	// AutoApprove lets the agent run tools without per-call confirmation.
	AutoApprove bool `json:"auto_approve,omitempty"`
	// Providers maps a provider key to its credentials.
	Providers map[string]ProviderConfig `json:"providers"`

	// mutex guards Providers against concurrent reads during the agent loop.
	mutex sync.Mutex
}

// Default returns a config populated with the built-in defaults.
func Default() *Config {
	return &Config{
		Provider: "brogang",
		Theme:    "bang-mach",
		Providers: map[string]ProviderConfig{
			"brogang":    {Model: "llama-3.3-70b"},
			"ollama":     {BaseURL: "http://localhost:11434", Model: "llama3.2"},
			"cloudflare": {AccountID: "", Model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"},
			"groq":       {Model: "llama-3.3-70b-versatile"},
			"openai":     {Model: "gpt-4o-mini"},
			"anthropic":  {Model: "claude-sonnet-4-5"},
		},
	}
}

// Dir returns the configuration directory, honouring BG_HOME so tests and
// parallel checkouts do not share state.
func Dir() (string, error) {
	if custom := strings.TrimSpace(os.Getenv("BG_HOME")); custom != "" {
		return custom, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate home directory: %w", err)
	}
	return filepath.Join(home, ".brogang"), nil
}

// Path returns the full path to config.json.
func Path() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

// Load reads config.json, returning defaults when the file is absent and
// merging any provider keys the defaults know about but the file omits.
func Load() (*Config, error) {
	path, err := Path()
	if err != nil {
		return nil, err
	}

	cfg := Default()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if cfg.Providers == nil {
		cfg.Providers = map[string]ProviderConfig{}
	}
	for name, defaults := range Default().Providers {
		existing, ok := cfg.Providers[name]
		if !ok {
			cfg.Providers[name] = defaults
			continue
		}
		// A blank field in the file falls back to the built-in default so an
		// upgrade that introduces a new model does not require edits.
		if existing.Model == "" {
			existing.Model = defaults.Model
		}
		if existing.BaseURL == "" {
			existing.BaseURL = defaults.BaseURL
		}
		cfg.Providers[name] = existing
	}
	return cfg, nil
}

// Save writes config.json with owner-only permissions, creating the directory
// when needed.
func (c *Config) Save() error {
	dir, err := Dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}

	path, err := Path()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if runtime.GOOS != "windows" {
		// WriteFile does not apply the mode to an existing file, so set it
		// explicitly to keep the key file private.
		_ = os.Chmod(path, 0o600)
	}
	return nil
}

// Set stores a value for a provider, since the interactive setup flow and the
// agent loop can both write concurrently.
func (c *Config) Set(key, field, value string) {
	c.mutex.Lock()
	defer c.mutex.Unlock()

	entry := c.Providers[key]
	switch strings.ToLower(field) {
	case "api_key", "key":
		entry.APIKey = value
	case "account_id", "account":
		entry.AccountID = value
	case "base_url", "url":
		entry.BaseURL = value
	case "model":
		entry.Model = value
	default:
		return
	}
	c.Providers[key] = entry
}

// APIKey returns the effective key for a provider. The environment wins over
// the file so CI tokens never get written to disk.
func (c *Config) APIKey(key string) string {
	if env := strings.TrimSpace(os.Getenv(envVarFor(key))); env != "" {
		return env
	}
	c.mutex.Lock()
	defer c.mutex.Unlock()
	return c.Providers[key].APIKey
}

// AccountID returns the effective Cloudflare account id for a provider.
func (c *Config) AccountID(key string) string {
	if env := strings.TrimSpace(os.Getenv("CF_ACCOUNT_ID")); env != "" {
		return env
	}
	c.mutex.Lock()
	defer c.mutex.Unlock()
	return c.Providers[key].AccountID
}

// ModelFor returns the model a provider should use, letting an explicit
// override take precedence over per-provider and global defaults.
func (c *Config) ModelFor(key, override string) string {
	if override != "" {
		return override
	}
	c.mutex.Lock()
	defer c.mutex.Unlock()
	if model := c.Providers[key].Model; model != "" {
		return model
	}
	return c.Model
}

// BaseURLFor returns a provider's base URL, honouring the BG_BASE_URL override.
func (c *Config) BaseURLFor(key, fallback string) string {
	if env := strings.TrimSpace(os.Getenv("BG_BASE_URL")); env != "" {
		return env
	}
	c.mutex.Lock()
	defer c.mutex.Unlock()
	if url := c.Providers[key].BaseURL; url != "" {
		return url
	}
	return fallback
}

// envVarFor maps a provider key to the environment variable holding its key.
func envVarFor(key string) string {
	switch strings.ToLower(key) {
	case "cloudflare", "cf":
		return "CLOUDFLARE_API_TOKEN"
	case "anthropic", "claude":
		return "ANTHROPIC_API_KEY"
	case "groq":
		return "GROQ_API_KEY"
	case "together":
		return "TOGETHER_API_KEY"
	case "openrouter":
		return "OPENROUTER_API_KEY"
	case "openai":
		return "OPENAI_API_KEY"
	case "ollama", "lmstudio":
		return "" // local runtimes need no credential
	default:
		return strings.ToUpper(strings.ReplaceAll(key, "-", "_")) + "_API_KEY"
	}
}

// EnvVarFor exports the environment variable name for a provider so the setup
// wizard and help text stay in sync with lookup.
func EnvVarFor(key string) string { return envVarFor(key) }
