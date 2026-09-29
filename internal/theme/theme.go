// Package theme provides the BRO GANG "Bang Mach" terminal theme.
//
// The palette mirrors the BRO GANG brand: neon pink, neon cyan, and deep
// black backgrounds used across brogang.techaditya.workers.dev and PGlove.
package theme

import (
	"fmt"
	"os"
	"strings"
)

// Raw ANSI escape sequences. Kept as constants so the theme stays dependency
// free and works on every terminal that speaks ANSI (Windows Terminal, modern
// cmd.exe, every POSIX shell).
const (
	ColReset     = "\x1b[0m"
	ColBold      = "\x1b[1m"
	ColDim       = "\x1b[2m"
	ColItalic    = "\x1b[3m"
	ColUnderline = "\x1b[4m"

	// Brand colours.
	ColPink   = "\x1b[38;5;197m" // #FF3B9E neon pink
	ColCyan   = "\x1b[38;5;51m"  // #00E5FF neon cyan
	ColPurple = "\x1b[38;5;141m"
	ColOrange = "\x1b[38;5;208m"
	ColGreen  = "\x1b[38;5;46m"
	ColYellow = "\x1b[38;5;226m"
	ColRed    = "\x1b[38;5;196m"
	ColGrey   = "\x1b[38;5;245m"
	ColWhite  = "\x1b[38;5;255m"
)

// Box drawing characters for the "Bang Mach" frame.
const (
	TL = "╔" // top left
	TR = "╗" // top right
	BL = "╚" // bottom left
	BR = "╝" // bottom right
	H  = "═" // horizontal
	V  = "║" // vertical
)

// colourEnabled reports whether ANSI output should be emitted.
//
// NO_COLOR follows the no-color.org convention, BG_NO_COLOR is the BRO GANG
// specific opt out, and TERM=dumb means the terminal cannot render escapes.
func colourEnabled() bool {
	if os.Getenv("NO_COLOR") != "" || os.Getenv("BG_NO_COLOR") != "" {
		return false
	}
	if os.Getenv("BG_FORCE_COLOR") != "" {
		return true
	}
	return os.Getenv("TERM") != "dumb"
}

// paint wraps text in a colour when colour output is enabled.
func paint(colour, text string) string {
	if !colourEnabled() {
		return text
	}
	return colour + text + ColReset
}

// Paint applies a BRO GANG colour to text, respecting NO_COLOR.
func Paint(colour, text string) string { return paint(colour, text) }

// Pink renders text in neon pink.
func Pink(text string) string { return paint(ColPink, text) }

// Cyan renders text in neon cyan.
func Cyan(text string) string { return paint(ColCyan, text) }

// Purple renders text in purple.
func Purple(text string) string { return paint(ColPurple, text) }

// Orange renders text in orange.
func Orange(text string) string { return paint(ColOrange, text) }

// Green renders text in green.
func Green(text string) string { return paint(ColGreen, text) }

// Yellow renders text in yellow.
func Yellow(text string) string { return paint(ColYellow, text) }

// Red renders text in red.
func Red(text string) string { return paint(ColRed, text) }

// Grey renders dimmed text.
func Grey(text string) string { return paint(ColGrey, text) }

// White renders bright white text.
func White(text string) string { return paint(ColWhite, text) }

// Bold renders bold text.
func Bold(text string) string { return paint(ColBold, text) }

// Banner returns the BRO GANG ASCII banner.
func Banner(version string) string {
	lines := []string{
		"██████╗ ██████╗  ██████╗  ██████╗  █████╗ ███╗   ██╗ ████████╗",
		"██╔══██╗██╔══██╗██╔═══██╗██╔═══██╗██╔══██╗████╗  ██║ ╚══██╔══╝",
		"██████╔╝██████╔╝██║   ██║██║   ██║███████║██╔██╗ ██║    ██║   ",
		"██╔══██╗██╔══██╗██║   ██║██║   ██║██╔══██║██║╚██╗██║    ██║   ",
		"██║  ██║██████╔╝╚██████╔╝╚██████╔╝██║  ██║██║ ╚████║    ██║   ",
		"╚═╝  ╚═╝╚═════╝  ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝    ╚═╝   ",
	}

	out := &strings.Builder{}
	out.WriteString("\n")
	for i, line := range lines {
		if i == 2 {
			out.WriteString(Pink(line) + "\n")
		} else {
			out.WriteString(Cyan(line) + "\n")
		}
	}
	out.WriteString("\n")
	out.WriteString("  " + Pink("Bro Gang AI CLI") + Grey(" · ") + Cyan("v"+version) + Grey(" · ") +
		White("East 2022") + Grey(" · ") + Orange("Bang Mach") + "\n")
	out.WriteString("  " + Grey("Free forever — no key, no signup. Chat, read, edit, run."))
	out.WriteString("\n\n")
	return out.String()
}

// Frame draws a titled box around body lines.
func Frame(title string, body []string) string {
	width := 0
	for _, line := range body {
		if l := visibleLen(line); l > width {
			width = l
		}
	}
	if l := visibleLen(title) + 4; l > width {
		width = l
	}

	out := &strings.Builder{}
	out.WriteString(Pink(TL+H) + Pink(" "+title+" ") + Pink(strings.Repeat(H, maxInt(0, width-visibleLen(title)-4))+TR) + "\n")
	for _, line := range body {
		pad := strings.Repeat(" ", maxInt(0, width-visibleLen(line)))
		out.WriteString(Pink(V) + " " + line + pad + " " + Pink(V) + "\n")
	}
	out.WriteString(Pink(BL+strings.Repeat(H, width+2)+BR) + "\n")
	return out.String()
}

// Rule prints a horizontal divider.
func Rule(width int) string {
	if width <= 0 {
		width = 60
	}
	return Grey(strings.Repeat(H, width))
}

// Prompt renders the interactive input prompt.
func Prompt(provider string) string {
	return Pink("❯") + " " + Cyan(provider) + Grey(" ▸ ")
}

// Step renders a numbered pipeline step, used for startup diagnostics.
func Step(n int, total int, label, value string) string {
	return fmt.Sprintf("%s %s %s",
		Grey(fmt.Sprintf("[%d/%d]", n, total)),
		Cyan(label),
		White(value),
	)
}

// Ok renders a success line.
func Ok(msg string) string { return Green("✔") + " " + msg }

// Warn renders a warning line.
func Warn(msg string) string { return Yellow("!") + " " + msg }

// Fail renders an error line.
func Fail(msg string) string { return Red("✖") + " " + msg }

// Info renders a neutral informational line.
func Info(msg string) string { return Cyan("•") + " " + msg }

// visibleLen counts display width, ignoring ANSI escape sequences so themed
// text does not inflate the computed box width.
func visibleLen(s string) int {
	n, inEscape := 0, false
	for _, r := range s {
		switch {
		case inEscape:
			// A CSI sequence ends on a byte in the range @ to ~.
			if r >= '@' && r <= '~' {
				inEscape = false
			}
		case r == '\x1b':
			inEscape = true
		default:
			n++
		}
	}
	return n
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
