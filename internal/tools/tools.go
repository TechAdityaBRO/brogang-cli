// Package tools implements the capabilities the agent exposes to the model:
// reading and writing files, searching the workspace, and running shell
// commands. Every tool is sandboxed to the workspace root.
package tools

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/TechAdityaBRO/brogang-cli/internal/provider"
)

// Limits applied to tool output so a single call cannot flood the context.
const (
	// MaxReadBytes caps a single file read.
	MaxReadBytes = 256 << 10 // 256 KiB
	// MaxToolOutputChars caps any tool result handed back to the model.
	MaxToolOutputChars = 40_000
	// MaxSearchResults caps grep matches.
	MaxSearchResults = 200
	// CommandTimeout bounds a single shell invocation.
	CommandTimeout = 120 * time.Second
	// MaxDirEntries caps directory listings.
	MaxDirEntries = 500
)

// Tool is an executable agent capability.
type Tool interface {
	// Spec returns the model facing declaration.
	Spec() provider.Tool
	// Run executes the tool with JSON encoded arguments and returns the text
	// handed back to the model.
	Run(ctx context.Context, args json.RawMessage) (string, error)
}

// Registry holds the available tools keyed by name.
type Registry struct {
	tools   map[string]Tool
	order   []string
	root    string
	allowed map[string]bool // command allowlist when AutoApprove is on
}

// NewRegistry builds a registry whose file tools are confined to root.
func NewRegistry(root string) *Registry {
	abs, err := filepath.Abs(root)
	if err != nil {
		abs = root
	}
	r := &Registry{
		tools:   make(map[string]Tool),
		root:    abs,
		allowed: make(map[string]bool),
	}
	r.add(&ReadFile{root: abs})
	r.add(&WriteFile{root: abs})
	r.add(&EditFile{root: abs})
	r.add(&ListDir{root: abs})
	r.add(&Search{root: abs})
	r.add(&RunCommand{root: abs, allowlist: r.allowed})
	return r
}

func (r *Registry) add(t Tool) {
	name := t.Spec().Name
	if _, exists := r.tools[name]; !exists {
		r.order = append(r.order, name)
	}
	r.tools[name] = t
}

// Root returns the workspace root the registry is confined to.
func (r *Registry) Root() string { return r.root }

// AllowCommand marks a command as safe to run without confirmation.
func (r *Registry) AllowCommand(name string) {
	if r.allowed != nil {
		r.allowed[name] = true
	}
}

// Specs returns every tool declaration in registration order.
func (r *Registry) Specs() []provider.Tool {
	out := make([]provider.Tool, 0, len(r.order))
	for _, name := range r.order {
		out = append(out, r.tools[name].Spec())
	}
	return out
}

// Get returns a tool by name.
func (r *Registry) Get(name string) (Tool, bool) {
	t, ok := r.tools[name]
	return t, ok
}

// Names returns registered tool names in registration order.
func (r *Registry) Names() []string { return append([]string(nil), r.order...) }

// resolve turns a caller supplied path into an absolute path inside the
// workspace, refusing anything that escapes via .. or an absolute path.
func (r *Registry) resolve(p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", fmt.Errorf("path is required")
	}
	abs := p
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(r.root, abs)
	}
	abs = filepath.Clean(abs)

	// Compare against the root with a separator so /root2 is not treated as
	// living inside /root.
	if abs != r.root && !strings.HasPrefix(abs, r.root+string(os.PathSeparator)) {
		return "", fmt.Errorf("path %q is outside the workspace %q", p, r.root)
	}
	return abs, nil
}

// truncate shortens s to limit characters, appending a marker that states how
// much was cut so the model knows output was clipped.
func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit - 80
	if cut < 0 {
		cut = 0
	}
	return s[:cut] + fmt.Sprintf("\n… truncated, %d more bytes", len(s)-cut)
}

// lineNumbered renders content with 1 based line numbers, which makes model
// references to specific lines actionable.
func lineNumbered(content string) string {
	var sb strings.Builder
	scanner := bufio.NewScanner(strings.NewReader(content))
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	n := 0
	for scanner.Scan() {
		n++
		fmt.Fprintf(&sb, "%6d\t%s\n", n, scanner.Text())
	}
	return sb.String()
}

// skipDirs are directories never walked during search or listing.
var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "dist": true,
	"build": true, "target": true, ".next": true, ".nuxt": true,
	"__pycache__": true, ".venv": true, "venv": true, ".cache": true,
	".gradle": true, "bin": true, "obj": true, ".idea": true, ".vscode": true,
}

// ReadFile returns the contents of a file in the workspace.
type ReadFile struct{ root string }

// Spec implements Tool.
func (t *ReadFile) Spec() provider.Tool {
	return provider.Tool{
		Name:        "read_file",
		Description: "Read a text file from the workspace. Returns contents with line numbers. Use offset and limit to page through large files.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":   map[string]any{"type": "string", "description": "File path, relative to the workspace root or absolute inside it."},
				"offset": map[string]any{"type": "integer", "description": "First line to return, 1 based. Default 1."},
				"limit":  map[string]any{"type": "integer", "description": "Maximum number of lines. Default 400."},
			},
			"required": []string{"path"},
		},
	}
}

// Run implements Tool.
func (t *ReadFile) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var a struct {
		Path   string `json:"path"`
		Offset int    `json:"offset"`
		Limit  int    `json:"limit"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return "", fmt.Errorf("read_file: invalid arguments: %w", err)
	}

	abs, err := resolveIn(t.root, a.Path)
	if err != nil {
		return "", err
	}

	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("read_file: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("read_file: %s is a directory, use list_dir", abs)
	}
	if info.Size() > MaxReadBytes {
		// Large files are windowed rather than refused so the model can still
		// inspect them a piece at a time.
		return "", fmt.Errorf("read_file: %s is %d bytes, too large; use offset and limit or grep for it", a.Path, info.Size())
	}

	data, err := os.ReadFile(abs)
	if err != nil {
		return "", fmt.Errorf("read_file: %w", err)
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")

	offset := a.Offset
	if offset < 1 {
		offset = 1
	}
	limit := a.Limit
	if limit <= 0 {
		limit = 400
	}
	if offset > len(lines) {
		return fmt.Sprintf("(no lines: %s has %d lines)", a.Path, len(lines)), nil
	}

	end := offset - 1 + limit
	if end > len(lines) {
		end = len(lines)
	}
	window := strings.Join(lines[offset-1:end], "\n")

	var sb strings.Builder
	fmt.Fprintf(&sb, "%s (%d lines, showing %d-%d)\n\n", a.Path, len(lines), offset, end)
	sb.WriteString(lineNumbered(window))
	return truncate(sb.String(), MaxToolOutputChars), nil
}

// WriteFile creates or overwrites a file.
type WriteFile struct{ root string }

// Spec implements Tool.
func (t *WriteFile) Spec() provider.Tool {
	return provider.Tool{
		Name:        "write_file",
		Description: "Create a new file or replace an existing file's contents with the supplied text. Creates parent directories as needed.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":    map[string]any{"type": "string", "description": "File path relative to the workspace root."},
				"content": map[string]any{"type": "string", "description": "Full file contents to write."},
			},
			"required": []string{"path", "content"},
		},
	}
}

// Run implements Tool.
func (t *WriteFile) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var a struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return "", fmt.Errorf("write_file: invalid arguments: %w", err)
	}

	abs, err := resolveIn(t.root, a.Path)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", fmt.Errorf("write_file: %w", err)
	}
	if err := os.WriteFile(abs, []byte(a.Content), 0o644); err != nil {
		return "", fmt.Errorf("write_file: %w", err)
	}

	verb := "Created"
	if _, statErr := os.Stat(abs); statErr == nil {
		verb = "Overwrote"
	}
	return fmt.Sprintf("%s %s (%d bytes)", verb, a.Path, len(a.Content)), nil
}

// EditFile performs an exact string replacement, which is safer than a
// full rewrite when changing part of a large file.
type EditFile struct{ root string }

// Spec implements Tool.
func (t *EditFile) Spec() provider.Tool {
	return provider.Tool{
		Name:        "edit_file",
		Description: "Replace an exact string in a file. The old string must appear exactly once unless replace_all is set. Include enough surrounding context to make it unique.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":        map[string]any{"type": "string", "description": "File path relative to the workspace root."},
				"old_string":  map[string]any{"type": "string", "description": "Exact text to find, including indentation."},
				"new_string":  map[string]any{"type": "string", "description": "Replacement text."},
				"replace_all": map[string]any{"type": "boolean", "description": "Replace every occurrence instead of requiring a unique match."},
			},
			"required": []string{"path", "old_string", "new_string"},
		},
	}
}

// Run implements Tool.
func (t *EditFile) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var a struct {
		Path       string `json:"path"`
		OldString  string `json:"old_string"`
		NewString  string `json:"new_string"`
		ReplaceAll bool   `json:"replace_all"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return "", fmt.Errorf("edit_file: invalid arguments: %w", err)
	}
	if a.OldString == "" {
		return "", fmt.Errorf("edit_file: old_string is required")
	}

	abs, err := resolveIn(t.root, a.Path)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return "", fmt.Errorf("edit_file: %w", err)
	}
	content := string(data)
	old := strings.ReplaceAll(a.OldString, "\r\n", "\n")

	count := strings.Count(content, old)
	switch {
	case count == 0:
		return "", fmt.Errorf("edit_file: old_string not found in %s", a.Path)
	case count > 1 && !a.ReplaceAll:
		return "", fmt.Errorf("edit_file: old_string appears %d times in %s; add more context or set replace_all", count, a.Path)
	}

	updated := strings.ReplaceAll(content, old, a.NewString)
	if err := os.WriteFile(abs, []byte(updated), 0o644); err != nil {
		return "", fmt.Errorf("edit_file: %w", err)
	}
	if a.ReplaceAll && count > 1 {
		return fmt.Sprintf("Replaced %d occurrences in %s", count, a.Path), nil
	}
	return fmt.Sprintf("Replaced 1 occurrence in %s", a.Path), nil
}

// ListDir lists the workspace or a subdirectory.
type ListDir struct{ root string }

// Spec implements Tool.
func (t *ListDir) Spec() provider.Tool {
	return provider.Tool{
		Name:        "list_dir",
		Description: "List files and directories, optionally recursing. Skips dependency and build directories.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":   map[string]any{"type": "string", "description": "Directory to list. Defaults to the workspace root."},
				"depth":  map[string]any{"type": "integer", "description": "Recursion depth. Default 2."},
				"ignore": map[string]any{"type": "string", "description": "Comma separated glob patterns to skip."},
			},
		},
	}
}

// Run implements Tool.
func (t *ListDir) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var a struct {
		Path   string `json:"path"`
		Depth  int    `json:"depth"`
		Ignore string `json:"ignore"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &a); err != nil {
			return "", fmt.Errorf("list_dir: invalid arguments: %w", err)
		}
	}

	base := t.root
	if a.Path != "" {
		resolved, err := resolveIn(t.root, a.Path)
		if err != nil {
			return "", err
		}
		base = resolved
	}
	depth := a.Depth
	if depth <= 0 {
		depth = 2
	}

	excludes, err := parseGlobs(a.Ignore)
	if err != nil {
		return "", err
	}

	var entries []string
	err = filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries rather than aborting
		}
		rel, relErr := filepath.Rel(base, path)
		if relErr != nil {
			return nil
		}
		if rel == "." {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if skipDirs[name] || matchesAny(excludes, name) {
				return fs.SkipDir
			}
		} else if matchesAny(excludes, name) {
			return nil
		}

		depthHere := strings.Count(rel, string(os.PathSeparator)) + 1
		if depthHere > depth {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}

		prefix := strings.Repeat("  ", depthHere-1)
		if d.IsDir() {
			entries = append(entries, prefix+name+"/")
		} else {
			size := ""
			if info, statErr := d.Info(); statErr == nil {
				size = fmt.Sprintf(" (%d B)", info.Size())
			}
			entries = append(entries, prefix+name+size)
		}
		if len(entries) >= MaxDirEntries {
			return fs.SkipAll
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("list_dir: %w", err)
	}

	sort.Strings(entries)
	header := fmt.Sprintf("%s (%d entries)\n\n", t.pathOrRoot(base, t.root), len(entries))
	return truncate(header+strings.Join(entries, "\n"), MaxToolOutputChars), nil
}

func (t *ListDir) pathOrRoot(base, root string) string {
	if base == root {
		return "."
	}
	rel, err := filepath.Rel(root, base)
	if err != nil {
		return base
	}
	return rel
}

// Search performs a regex search across workspace files.
type Search struct{ root string }

// Spec implements Tool.
func (t *Search) Spec() provider.Tool {
	return provider.Tool{
		Name:        "search",
		Description: "Search file contents with a regular expression. Returns matching file, line number, and line text.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern":     map[string]any{"type": "string", "description": "Go regular expression to search for."},
				"path":        map[string]any{"type": "string", "description": "Directory or file to search. Defaults to the workspace root."},
				"glob":        map[string]any{"type": "string", "description": "Only search files matching this glob, for example *.go or *.ts."},
				"ignore_case": map[string]any{"type": "boolean", "description": "Match case insensitively."},
			},
			"required": []string{"pattern"},
		},
	}
}

// Run implements Tool.
func (t *Search) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var a struct {
		Pattern    string `json:"pattern"`
		Path       string `json:"path"`
		Glob       string `json:"glob"`
		IgnoreCase bool   `json:"ignore_case"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return "", fmt.Errorf("search: invalid arguments: %w", err)
	}
	if strings.TrimSpace(a.Pattern) == "" {
		return "", fmt.Errorf("search: pattern is required")
	}

	expr := a.Pattern
	if a.IgnoreCase {
		expr = "(?i)" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return "", fmt.Errorf("search: invalid regular expression: %w", err)
	}

	base := t.root
	if a.Path != "" {
		resolved, err := resolveIn(t.root, a.Path)
		if err != nil {
			return "", err
		}
		base = resolved
	}

	var matches []string
	truncated := false
	err = filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
		if err != nil || truncated {
			return nil
		}
		if d.IsDir() {
			if skipDirs[d.Name()] && path != base {
				return fs.SkipDir
			}
			return nil
		}
		if a.Glob != "" {
			ok, globErr := filepath.Match(a.Glob, d.Name())
			if globErr != nil || !ok {
				return nil
			}
		}
		if isBinary(path) {
			return nil
		}

		data, readErr := os.ReadFile(path)
		if readErr != nil || len(data) > MaxReadBytes {
			return nil
		}
		rel, _ := filepath.Rel(t.root, path)
		for i, line := range strings.Split(string(data), "\n") {
			if len(line) > 400 {
				line = line[:400] + "…"
			}
			if re.MatchString(line) {
				matches = append(matches, fmt.Sprintf("%s:%d: %s", rel, i+1, strings.TrimSpace(line)))
				if len(matches) >= MaxSearchResults {
					truncated = true
					return fs.SkipAll
				}
			}
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("search: %w", err)
	}

	if len(matches) == 0 {
		return fmt.Sprintf("No matches for %q in %s", a.Pattern, t.pathOrRoot(base)), nil
	}
	header := fmt.Sprintf("%d match(es) for %q\n\n", len(matches), a.Pattern)
	if truncated {
		header += fmt.Sprintf("(capped at %d results)\n\n", MaxSearchResults)
	}
	return truncate(header+strings.Join(matches, "\n"), MaxToolOutputChars), nil
}

func (t *Search) pathOrRoot(base string) string {
	rel, err := filepath.Rel(t.root, base)
	if err != nil {
		return base
	}
	return rel
}

// RunCommand executes a shell command in the workspace.
type RunCommand struct {
	root      string
	allowlist map[string]bool
}

// Spec implements Tool.
func (t *RunCommand) Spec() provider.Tool {
	return provider.Tool{
		Name:        "run_command",
		Description: "Run a shell command in the workspace and return its combined output. Commands time out after 120 seconds.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{"type": "string", "description": "The shell command to execute."},
			},
			"required": []string{"command"},
		},
	}
}

// IsAllowed reports whether a command may run without confirmation.
func (t *RunCommand) IsAllowed(command string) bool {
	if len(t.allowlist) == 0 {
		return false
	}
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return false
	}
	return t.allowlist[filepath.Base(fields[0])]
}

// Run implements Tool.
func (t *RunCommand) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var a struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return "", fmt.Errorf("run_command: invalid arguments: %w", err)
	}
	if strings.TrimSpace(a.Command) == "" {
		return "", fmt.Errorf("run_command: command is required")
	}

	ctx, cancel := context.WithTimeout(ctx, CommandTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, shell(), shellFlag(), a.Command)
	cmd.Dir = t.root
	cmd.Env = append(os.Environ(), "BG_CLI=1")

	output, err := cmd.CombinedOutput()
	result := string(output)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			result += fmt.Sprintf("\n[timed out after %s]", CommandTimeout)
		} else {
			result += fmt.Sprintf("\n[exit status: %v]", err)
		}
	}
	if strings.TrimSpace(result) == "" {
		result = "(no output)"
	}
	return truncate(fmt.Sprintf("$ %s\n\n%s", a.Command, result), MaxToolOutputChars), nil
}

func shell() string {
	if runtime.GOOS == "windows" {
		if comspec := os.Getenv("COMSPEC"); comspec != "" {
			return comspec
		}
		return "cmd.exe"
	}
	return "/bin/sh"
}

func shellFlag() string {
	if runtime.GOOS == "windows" {
		return "/C"
	}
	return "-c"
}

// isBinary reports whether a file looks binary, by sniffing for NUL bytes in
// the first 8 KiB.
func isBinary(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return true
	}
	defer f.Close()

	buf := make([]byte, 8192)
	n, err := f.Read(buf)
	if err != nil && n == 0 {
		return true
	}
	return strings.IndexByte(string(buf[:n]), 0) >= 0
}

// resolveIn is the package level path guard, mirroring Registry.resolve so
// tools can be constructed directly in tests.
func resolveIn(root, p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", fmt.Errorf("path is required")
	}
	abs := p
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(root, abs)
	}
	abs = filepath.Clean(abs)
	if abs != root && !strings.HasPrefix(abs, root+string(os.PathSeparator)) {
		return "", fmt.Errorf("path %q is outside the workspace %q", p, root)
	}
	return abs, nil
}

// parseGlobs turns a comma separated list into matchers.
func parseGlobs(list string) ([]string, error) {
	var out []string
	for _, item := range strings.Split(list, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, err := filepath.Match(item, "probe"); err != nil {
			return nil, fmt.Errorf("invalid glob %q: %w", item, err)
		}
		out = append(out, item)
	}
	return out, nil
}

func matchesAny(patterns []string, name string) bool {
	for _, p := range patterns {
		if ok, err := filepath.Match(p, name); err == nil && ok {
			return true
		}
	}
	return false
}
