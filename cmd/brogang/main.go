// Command brogang is a free, open source AI coding agent for the terminal.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/TechAdityaBRO/brogang-cli/internal/agent"
	"github.com/TechAdityaBRO/brogang-cli/internal/config"
	"github.com/TechAdityaBRO/brogang-cli/internal/provider"
	"github.com/TechAdityaBRO/brogang-cli/internal/theme"
	"github.com/TechAdityaBRO/brogang-cli/internal/tools"
)

// Version is the CLI version, overridable at build time with
// -ldflags "-X main.Version=1.2.3".
var Version = "0.1.0"

const helpText = `Bro Gang AI CLI — a free forever AI coding agent for your terminal.

No signup. No API key. Just run it.

USAGE
  brogang [prompt] [flags]

  With a prompt, brogang runs one turn, prints the answer, and exits.
  With no prompt, it opens an interactive session.

FLAGS
  -p, --provider <name>   AI backend (default: brogang, the free hosted one)
  -m, --model <id>        Override the model
  -C, --cwd <dir>         Workspace root (default: current directory)
      --yolo              Approve every tool call without asking
      --no-tools          Chat only, no file or command access
      --max-steps <n>     Tool calling rounds per turn (default: 24)
      --list-providers    Show available backends and exit
      --list-models       Show models for the active provider and exit
      --setup             Configure an optional paid provider
      --version           Print the version and exit
  -h, --help              Show this help

PROVIDERS
  brogang      Bro Gang AI · FREE, no key, no setup · default
  cloudflare   Cloudflare Workers AI   free tier, Llama 3.3 70B
  groq         Groq                    free tier, very fast
  openai       OpenAI                  GPT models
  anthropic    Anthropic               Claude models
  openrouter   OpenRouter              many models, one key
  together     Together AI             open models
  ollama       Ollama                  local, no key, no network

EXAMPLES
  brogang "explain the auth flow in internal/auth"
  brogang "add tests for the parser"
  brogang -p ollama -m qwen2.5-coder "refactor this file"

Made by BRO GANG · East 2022 · MIT licensed.
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, theme.Fail("Error: "+err.Error()))
		os.Exit(1)
	}
}

// flags holds the parsed command line.
type flags struct {
	prompt       string
	providerName string
	model        string
	cwd          string
	yolo         bool
	noTools      bool
	maxSteps     int
	listProvider bool
	listModels   bool
	setup        bool
	version      bool
	help         bool
}

func run(args []string) error {
	f, err := parseFlags(args)
	if err != nil {
		return err
	}

	switch {
	case f.help:
		fmt.Print(helpText)
		return nil
	case f.version:
		fmt.Printf("brogang %s\n", Version)
		return nil
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	registry := provider.Build(settingsFrom(cfg, f))

	if f.listProvider {
		printProviders(registry, cfg)
		return nil
	}
	if f.setup {
		return runSetup(cfg, registry)
	}

	providerName := f.providerName
	if providerName == "" {
		providerName = cfg.Provider
	}
	active, err := registry.Get(providerName)
	if err != nil {
		return fmt.Errorf("%w\n\nAvailable: %s", err, strings.Join(registry.Names(), ", "))
	}

	if f.listModels {
		return printModels(active)
	}

	root, err := workspaceRoot(f.cwd)
	if err != nil {
		return err
	}

	// A non interactive invocation with a prompt needs no terminal handling.
	if f.prompt != "" {
		return runOnce(active, cfg, root, f)
	}
	return runInteractive(active, cfg, registry, root, f)
}

// parseFlags reads the command line without pulling in a flag library, so the
// binary keeps a minimal dependency surface.
func parseFlags(args []string) (flags, error) {
	var f flags
	f.maxSteps = agent.DefaultMaxSteps

	for i := 0; i < len(args); i++ {
		arg := args[i]
		// Support --flag=value as well as --flag value.
		if strings.HasPrefix(arg, "--") && strings.Contains(arg, "=") {
			parts := strings.SplitN(arg, "=", 2)
			arg = parts[0]
			args = append(args[:i+1], append([]string{parts[1]}, args[i+1:]...)...)
		}

		next := func() (string, error) {
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s needs a value", arg)
			}
			i++
			return args[i], nil
		}

		switch arg {
		case "-p", "--provider":
			v, err := next()
			if err != nil {
				return f, err
			}
			f.providerName = v
		case "-m", "--model":
			v, err := next()
			if err != nil {
				return f, err
			}
			f.model = v
		case "-C", "--cwd":
			v, err := next()
			if err != nil {
				return f, err
			}
			f.cwd = v
		case "--max-steps":
			v, err := next()
			if err != nil {
				return f, err
			}
			n, convErr := parseInt(v)
			if convErr != nil {
				return f, fmt.Errorf("--max-steps needs a number, got %q", v)
			}
			f.maxSteps = n
		case "--yolo":
			f.yolo = true
		case "--no-tools":
			f.noTools = true
		case "--list-providers":
			f.listProvider = true
		case "--list-models":
			f.listModels = true
		case "--setup":
			f.setup = true
		case "--version", "-v":
			f.version = true
		case "-h", "--help":
			f.help = true
		default:
			if strings.HasPrefix(arg, "-") {
				return f, fmt.Errorf("unknown flag %q, try --help", arg)
			}
			if f.prompt == "" {
				f.prompt = arg
			}
		}
	}
	return f, nil
}

func parseInt(s string) (int, error) {
	var n int
	_, err := fmt.Sscanf(s, "%d", &n)
	return n, err
}

// workspaceRoot resolves and validates the working directory.
func workspaceRoot(cwd string) (string, error) {
	dir := cwd
	if dir == "" {
		var err error
		dir, err = os.Getwd()
		if err != nil {
			return "", fmt.Errorf("determine working directory: %w", err)
		}
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", dir, err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("%s is not accessible: %w", abs, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is a file, not a directory", abs)
	}
	return abs, nil
}

// settingsFrom flattens the config into the provider build settings, letting
// command line flags win.
func settingsFrom(cfg *config.Config, f flags) provider.ProviderSettings {
	overrideModel := func(key string) string {
		if f.model != "" {
			return f.model
		}
		return cfg.ModelFor(key, "")
	}
	return provider.ProviderSettings{
		BroGangBaseURL:      cfg.BaseURLFor("brogang", provider.BroGangBaseURL),
		BroGangModel:        overrideModel("brogang"),
		CloudflareKey:       cfg.APIKey("cloudflare"),
		CloudflareAccountID: cfg.AccountID("cloudflare"),
		CloudflareModel:     overrideModel("cloudflare"),
		GroqKey:             cfg.APIKey("groq"),
		GroqModel:           overrideModel("groq"),
		OpenAIKey:           cfg.APIKey("openai"),
		OpenAIModel:         overrideModel("openai"),
		OpenRouterKey:       cfg.APIKey("openrouter"),
		OpenRouterModel:     overrideModel("openrouter"),
		TogetherKey:         cfg.APIKey("together"),
		TogetherModel:       overrideModel("together"),
		OllamaBaseURL:       cfg.BaseURLFor("ollama", provider.OllamaBaseURL),
		OllamaModel:         overrideModel("ollama"),
		AnthropicKey:        cfg.APIKey("anthropic"),
		AnthropicModel:      overrideModel("anthropic"),
	}
}

// newAgent wires an agent for the given provider and workspace.
func newAgent(active provider.Provider, cfg *config.Config, root string, f flags) (*agent.Agent, *tools.Registry) {
	var registry *tools.Registry
	opts := agent.Options{
		Provider: active,
		Model:    cfg.ModelFor(active.Name(), f.model),
		Config:   cfg,
		MaxSteps: f.maxSteps,
	}

	if !f.noTools {
		registry = tools.NewRegistry(root)
		opts.Tools = registry
		opts.OnEvent = uiHandler
		opts.Confirm = confirmer(cfg.AutoApprove || f.yolo, registry)
	}
	return agent.New(opts), registry
}

// uiHandler renders agent progress with the Bang Mach theme.
func uiHandler(e agent.Event) {
	switch e.Kind {
	case agent.EventStep:
		if e.Step > 1 {
			fmt.Println(theme.Grey(fmt.Sprintf("  ── step %d/%d", e.Step, e.Total)))
		}
	case agent.EventToolStart:
		fmt.Printf("%s %s %s\n",
			theme.Pink("⚡"),
			theme.Cyan(e.Name),
			theme.Grey(summariseArgs(e.Args)),
		)
	case agent.EventToolDone:
		if e.Err != nil {
			fmt.Println("  " + theme.Red("✖ "+e.Err.Error()))
		}
	}
}

// summariseArgs renders a short human readable form of tool arguments.
func summariseArgs(args json.RawMessage) string {
	if len(args) == 0 {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal(args, &m); err != nil {
		return ""
	}
	for _, key := range []string{"path", "command", "pattern", "glob"} {
		if v, ok := m[key]; ok {
			if s, ok := v.(string); ok && s != "" {
				oneLine := strings.SplitN(s, "\n", 2)[0]
				if len(oneLine) > 48 {
					oneLine = oneLine[:48] + "…"
				}
				return key + ": " + oneLine
			}
		}
	}
	return ""
}

// confirmer asks before running a tool, unless auto approval is on.
func confirmer(auto bool, registry *tools.Registry) func(string, json.RawMessage) error {
	if auto {
		return nil
	}
	reader := bufio.NewReader(os.Stdin)
	return func(name string, args json.RawMessage) error {
		fmt.Printf("%s %s %s\n", theme.Orange("⚠"), theme.Yellow("allow"), theme.Grey(name+" "+summariseArgs(args)))
		fmt.Print(theme.Pink("  run? [y/N] "))

		line, err := reader.ReadString('\n')
		if err != nil {
			return errors.New("no answer, treating as declined")
		}
		answer := strings.ToLower(strings.TrimSpace(line))
		if answer != "y" && answer != "yes" {
			return errors.New("declined by user")
		}
		return nil
	}
}

// runOnce handles a single non interactive prompt.
func runOnce(active provider.Provider, cfg *config.Config, root string, f flags) error {
	if active.RequiresAPIKey() && cfg.APIKey(active.Name()) == "" {
		return fmt.Errorf("%s needs an API key. Run: brogang --setup", active.Label())
	}

	a, _ := newAgent(active, cfg, root, f)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	fmt.Print(theme.Prompt(active.Name()) + theme.Grey(active.Label()) + "\n\n")

	resp, err := a.Send(ctx, f.prompt)
	if resp != "" {
		fmt.Println(theme.White(resp))
	}
	return endpointHint(err, active)
}

// endpointHint appends actionable advice when the free hosted endpoint cannot
// be reached, so the failure is a next step rather than a dead end.
func endpointHint(err error, active provider.Provider) error {
	if err == nil {
		return nil
	}
	lower := strings.ToLower(err.Error())
	unreachable := strings.Contains(lower, "404") ||
		strings.Contains(lower, "502") ||
		strings.Contains(lower, "503") ||
		strings.Contains(lower, "connection refused") ||
		strings.Contains(lower, "no such host") ||
		errors.Is(err, context.Canceled)

	if unreachable && active.Name() == "brogang" {
		return fmt.Errorf(
			"%w\n\n%s The free endpoint is not responding right now.\n  %s\n  %s\n  %s",
			err,
			theme.Info("Options:"),
			theme.Cyan("1.")+" deploy the endpoint:  cd worker && npx wrangler pages deploy public",
			theme.Cyan("2.")+" use a local model:     brogang -p ollama",
			theme.Cyan("3.")+" or add a free key:     brogang --setup",
		)
	}
	return err
}

// runInteractive opens the REPL.
func runInteractive(active provider.Provider, cfg *config.Config, registry *provider.Registry, root string, f flags) error {
	if active.RequiresAPIKey() && cfg.APIKey(active.Name()) == "" {
		return fmt.Errorf("%s needs an API key. Run: brogang --setup", active.Label())
	}

	fmt.Print(theme.Banner(Version))
	fmt.Println(theme.Frame("SESSION", []string{
		"Provider  " + theme.Cyan(active.Label()),
		"Model     " + theme.Cyan(cfg.ModelFor(active.Name(), f.model)),
		"Workspace " + theme.White(root),
		"Tools     " + theme.Grey(toolSummary(f)),
	}))
	fmt.Println()
	fmt.Println(theme.Grey("  /help for commands, /exit to quit, Ctrl+C to interrupt"))
	fmt.Println()

	a, _ := newAgent(active, cfg, root, f)
	reader := bufio.NewReader(os.Stdin)

	for {
		fmt.Print(theme.Prompt(active.Name()))
		line, err := reader.ReadString('\n')
		if err != nil {
			if errors.Is(err, os.ErrClosed) || line == "" {
				fmt.Println()
				return nil
			}
			if !errors.Is(err, os.ErrDeadlineExceeded) && strings.TrimSpace(line) == "" {
				fmt.Println()
				return nil
			}
		}

		input := strings.TrimSpace(line)
		switch {
		case input == "":
			continue
		case input == "/exit" || input == "/quit":
			fmt.Println(theme.Grey("  bye — built different."))
			return nil
		case input == "/help":
			printHelp()
			continue
		case input == "/clear":
			a.Reset()
			fmt.Println(theme.Ok("conversation cleared"))
			continue
		case input == "/model":
			fmt.Println(theme.Info("current model: " + cfg.ModelFor(active.Name(), f.model)))
			continue
		case input == "/provider":
			printProviders(registry, cfg)
			continue
		}

		// Ctrl+C mid-turn should abandon the turn, not the session, so each
		// request gets a fresh context.
		ctx, cancel := context.WithCancel(context.Background())
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt)
		done := make(chan struct{})
		go func() {
			select {
			case <-sig:
				cancel()
			case <-done:
			}
		}()

		resp, sendErr := a.Send(ctx, input)
		close(done)
		signal.Stop(sig)
		cancel()

		if resp != "" {
			fmt.Println()
			fmt.Println(theme.White(resp))
		}
		if sendErr != nil {
			if errors.Is(sendErr, context.Canceled) {
				fmt.Println(theme.Warn("interrupted"))
			} else if hint := endpointHint(sendErr, active); hint != nil && hint != sendErr {
				fmt.Println(theme.Fail(hint.Error()))
			} else {
				fmt.Println(theme.Fail(sendErr.Error()))
			}
		}
		fmt.Println()
	}
}

func toolSummary(f flags) string {
	if f.noTools {
		return theme.Yellow("disabled")
	}
	return theme.Cyan("read · write · edit · list · search · run")
}

func printHelp() {
	fmt.Println(theme.Frame("COMMANDS", []string{
		theme.Cyan("/help") + "      show this list",
		theme.Cyan("/clear") + "    clear the conversation",
		theme.Cyan("/model") + "     show the active model",
		theme.Cyan("/provider") + "  list providers",
		theme.Cyan("/exit") + "      quit",
	}))
}

func printProviders(registry *provider.Registry, cfg *config.Config) {
	fmt.Println()
	fmt.Println(theme.Bold("  Providers"))
	fmt.Println()
	names := registry.Names()
	sort.Strings(names)
	for _, name := range names {
		p, err := registry.Get(name)
		if err != nil {
			continue
		}
		marker := theme.Grey("  ")
		if name == cfg.Provider {
			marker = theme.Pink("→ ")
		}
		status := theme.Grey("no key")
		if !p.RequiresAPIKey() || cfg.APIKey(name) != "" {
			status = theme.Green("ready")
		}
		if name == "cloudflare" && cfg.AccountID("cloudflare") == "" && cfg.APIKey("cloudflare") != "" {
			status = theme.Yellow("needs account id")
		}
		fmt.Printf("%s%-12s %-22s %s\n", marker, theme.Cyan(name), theme.White(p.Label()), status)
	}
	fmt.Println()
	fmt.Println(theme.Grey("  Configure one with: brogang --setup"))
	fmt.Println()
}

func printModels(p provider.Provider) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	models, err := p.ListModels(ctx)
	if err != nil {
		if errors.Is(err, provider.ErrNoAPIKey) {
			return fmt.Errorf("%s needs an API key. Run: brogang --setup", p.Label())
		}
		return err
	}
	fmt.Println()
	fmt.Println(theme.Bold("  " + p.Label() + " models"))
	fmt.Println()
	for _, m := range models {
		fmt.Println("  " + theme.Cyan(m))
	}
	fmt.Println()
	return nil
}

// runSetup walks the user through configuring a provider.
func runSetup(cfg *config.Config, registry *provider.Registry) error {
	fmt.Print(theme.Banner(Version))
	reader := bufio.NewReader(os.Stdin)

	fmt.Println(theme.Bold("  Select a provider"))
	fmt.Println()
	names := registry.Names()
	sort.Strings(names)
	for i, name := range names {
		p, _ := registry.Get(name)
		fmt.Printf("  %s %-12s %s\n",
			theme.Pink(fmt.Sprintf("%2d)", i+1)),
			theme.Cyan(name),
			theme.Grey(p.Label()))
	}
	fmt.Println()

	choice, err := prompt(reader, "Provider")
	if err != nil {
		return err
	}
	var selected string
	if n, convErr := parseInt(choice); convErr == nil && n >= 1 && n <= len(names) {
		selected = names[n-1]
	} else {
		selected = strings.ToLower(strings.TrimSpace(choice))
	}
	if _, err := registry.Get(selected); err != nil {
		return fmt.Errorf("unknown provider %q", selected)
	}

	p, _ := registry.Get(selected)
	if p.RequiresAPIKey() {
		envVar := config.EnvVarFor(selected)
		if envVar != "" {
			fmt.Println(theme.Grey("  (leave blank to use the " + envVar + " environment variable)"))
		}
		key, err := prompt(reader, keyLabelFor(selected))
		if err != nil {
			return err
		}
		if key != "" {
			cfg.Set(selected, "api_key", key)
		}
	}

	if selected == "cloudflare" {
		fmt.Println(theme.Grey("  Account id is in the Cloudflare dashboard sidebar."))
		account, err := prompt(reader, "Account id")
		if err != nil {
			return err
		}
		if account != "" {
			cfg.Set(selected, "account_id", account)
		}
	}

	if selected == "ollama" {
		url, err := prompt(reader, fmt.Sprintf("Base URL [%s]", provider.OllamaBaseURL))
		if err != nil {
			return err
		}
		if url != "" {
			cfg.Set(selected, "base_url", url)
		}
	}

	model, err := prompt(reader, "Model (blank for default)")
	if err != nil {
		return err
	}
	if model != "" {
		cfg.Set(selected, "model", model)
	}

	cfg.Provider = selected
	if err := cfg.Save(); err != nil {
		return err
	}

	path, _ := config.Path()
	fmt.Println()
	fmt.Println(theme.Ok("Saved to " + path))
	fmt.Println(theme.Info("Active provider: " + selected))
	fmt.Println()
	return nil
}

func keyLabelFor(provider string) string {
	if provider == "cloudflare" {
		return "API token"
	}
	return "API key"
}

func prompt(reader *bufio.Reader, label string) (string, error) {
	fmt.Print("  " + theme.Cyan(label) + theme.Grey(": "))
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		return "", fmt.Errorf("read input: %w", err)
	}
	return strings.TrimSpace(line), nil
}
