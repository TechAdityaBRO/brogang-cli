package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestResolveRejectsEscape ensures file tools cannot be talked out of the
// workspace, which is the security boundary the agent relies on.
func TestResolveRejectsEscape(t *testing.T) {
	root := t.TempDir()
	reg := NewRegistry(root)

	cases := []string{
		"../outside.txt",
		"..",
		"foo/../../outside.txt",
		"/etc/passwd",
		filepath.Join(os.TempDir(), "escape.txt"),
		"",
	}
	for _, path := range cases {
		tool, _ := reg.Get("read_file")
		args, _ := json.Marshal(map[string]any{"path": path})
		if _, err := tool.Run(context.Background(), args); err == nil {
			// An empty path is rejected too, so every case must error.
			if path == "" {
				continue
			}
			t.Errorf("read_file(%q): expected escape error, got nil", path)
		}
	}
}

// TestResolveAcceptsInside confirms legitimate relative paths still work.
func TestResolveAcceptsInside(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "hello.txt"), []byte("hi there\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	reg := NewRegistry(root)
	tool, _ := reg.Get("read_file")
	args, _ := json.Marshal(map[string]any{"path": "hello.txt"})

	out, err := tool.Run(context.Background(), args)
	if err != nil {
		t.Fatalf("read_file: %v", err)
	}
	if want := "hi there"; !contains(out, want) {
		t.Errorf("got %q, want it to contain %q", out, want)
	}
	// Line numbers should be present so the model can cite them.
	if !contains(out, "     1\t") {
		t.Errorf("expected line numbers in output, got %q", out)
	}
}

// TestEditFileUniqueAndCount covers the both-sides guard: a non-unique match
// without replace_all must fail rather than clobbering the wrong line.
func TestEditFileUniqueAndCount(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "a.txt")
	if err := os.WriteFile(file, []byte("one\ntwo\nthree\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	reg := NewRegistry(root)
	tool, _ := reg.Get("edit_file")

	run := func(old, neu string, all bool) (string, error) {
		args, _ := json.Marshal(map[string]any{
			"path": "a.txt", "old_string": old, "new_string": neu, "replace_all": all,
		})
		return tool.Run(context.Background(), args)
	}

	// Non-unique match must be refused.
	if _, err := run("two", "2", false); err == nil {
		t.Error("expected error for ambiguous match, got nil")
	}
	// replace_all succeeds and reports the count.
	out, err := run("two", "2", true)
	if err != nil {
		t.Fatalf("replace_all: %v", err)
	}
	if !contains(out, "Replaced 2 occurrences") {
		t.Errorf("got %q, want occurrence count", out)
	}
	// A missing string must fail too.
	if _, err := run("nope", "x", true); err == nil {
		t.Error("expected error for missing string, got nil")
	}
}

// TestTruncate keeps tool output within the documented cap.
func TestTruncate(t *testing.T) {
	big := make([]byte, MaxToolOutputChars*2)
	for i := range big {
		big[i] = 'a'
	}
	got := truncate(string(big), MaxToolOutputChars)
	if len(got) > MaxToolOutputChars {
		t.Errorf("truncate returned %d chars, cap is %d", len(got), MaxToolOutputChars)
	}
	if !contains(got, "truncated") {
		t.Error("expected a truncation marker so the model knows output was clipped")
	}
}

func contains(haystack, needle string) bool {
	return len(needle) == 0 || (len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0)
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}
