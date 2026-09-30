// The BRO GANG "Bang Mach" terminal theme.
//
// Mirrors internal/theme/theme.go. Raw ANSI escapes are used directly so the
// package stays dependency free and works on any terminal that speaks ANSI.

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";

export const ColReset = RESET;
export const ColBold = BOLD;
export const ColDim = DIM;
export const ColItalic = ITALIC;
export const ColUnderline = UNDERLINE;

// Brand palette.
export const ColPink = "\x1b[38;5;197m"; // #FF3B9E neon pink
export const ColCyan = "\x1b[38;5;51m"; // #00E5FF neon cyan
export const ColPurple = "\x1b[38;5;141m";
export const ColOrange = "\x1b[38;5;208m";
export const ColGreen = "\x1b[38;5;46m";
export const ColYellow = "\x1b[38;5;226m";
export const ColRed = "\x1b[38;5;196m";
export const ColGrey = "\x1b[38;5;245m";
export const ColWhite = "\x1b[38;5;255m";

// Box drawing for the Bang Mach frame.
export const TL = "╔";
export const TR = "╗";
export const BL = "╚";
export const BR = "╝";
export const H = "═";
export const V = "║";

/**
 * colourEnabled reports whether ANSI output should be emitted.
 *
 * NO_COLOR follows the no-color.org convention, BG_NO_COLOR is the BRO GANG
 * opt out, and TERM=dumb means the terminal cannot render escapes.
 */
export function colourEnabled(): boolean {
  if (process.env.NO_COLOR || process.env.BG_NO_COLOR) return false;
  if (process.env.BG_FORCE_COLOR) return true;
  return process.env.TERM !== "dumb";
}

function paint(colour: string, text: string): string {
  if (!colourEnabled()) return text;
  return colour + text + RESET;
}

/** paint applies a BRO GANG colour, respecting NO_COLOR. */
export function paint_(colour: string, text: string): string {
  return paint(colour, text);
}
export { paint_ as Paint };

export const Pink = (text: string) => paint(ColPink, text);
export const Cyan = (text: string) => paint(ColCyan, text);
export const Purple = (text: string) => paint(ColPurple, text);
export const Orange = (text: string) => paint(ColOrange, text);
export const Green = (text: string) => paint(ColGreen, text);
export const Yellow = (text: string) => paint(ColYellow, text);
export const Red = (text: string) => paint(ColRed, text);
export const Grey = (text: string) => paint(ColGrey, text);
export const White = (text: string) => paint(ColWhite, text);
export const Bold = (text: string) => paint(ColBold, text);
export const Dim = (text: string) => paint(ColDim, text);
export const Italic = (text: string) => paint(ColItalic, text);
export const Underline = (text: string) => paint(ColUnderline, text);

const BANNER_LINES = [
  "██████╗ ██████╗  ██████╗  ██████╗  █████╗ ███╗   ██╗ ████████╗",
  "██╔══██╗██╔══██╗██╔═══██╗██╔═══██╗██╔══██╗████╗  ██║ ╚══██╔══╝",
  "██████╔╝██████╔╝██║   ██║██║   ██║███████║██╔██╗ ██║    ██║   ",
  "██╔══██╗██╔══██╗██║   ██║██║   ██║██╔══██║██║╚██╗██║    ██║   ",
  "██║  ██║██████╔╝╚██████╔╝╚██████╔╝██║  ██║██║ ╚████║    ██║   ",
  "╚═╝  ╚═╝╚═════╝  ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝    ╚═╝   ",
];

/** banner returns the BRO GANG ASCII banner. */
export function banner(version: string): string {
  const out: string[] = ["\n"];
  BANNER_LINES.forEach((line, i) => {
    out.push((i === 2 ? Pink(line) : Cyan(line)) + "\n");
  });
  out.push("\n");
  out.push(
    "  " +
      Pink("Bro Gang AI CLI") +
      Grey(" · ") +
      Cyan("v" + version) +
      Grey(" · ") +
      White("East 2022") +
      Grey(" · ") +
      Orange("Bang Mach") +
      "\n",
  );
  out.push("  " + Grey("Free forever — no key, no signup. Chat, read, edit, run."));
  out.push("\n\n");
  return out.join("");
}

/** frame draws a titled box around body lines. */
export function frame(title: string, body: string[]): string {
  let width = 0;
  for (const line of body) {
    const l = visibleLen(line);
    if (l > width) width = l;
  }
  const titleWidth = visibleLen(title) + 4;
  if (titleWidth > width) width = titleWidth;

  const out: string[] = [];
  out.push(
    Pink(TL + H) +
      Pink(" " + title + " ") +
      Pink(H.repeat(Math.max(0, width - visibleLen(title) - 4)) + TR) +
      "\n",
  );
  for (const line of body) {
    const pad = " ".repeat(Math.max(0, width - visibleLen(line)));
    out.push(Pink(V) + " " + line + pad + " " + Pink(V) + "\n");
  }
  out.push(Pink(BL + H.repeat(width + 2) + BR) + "\n");
  return out.join("");
}

/** rule prints a horizontal divider. */
export function rule(width = 60): string {
  if (width <= 0) width = 60;
  return Grey(H.repeat(width));
}

/** promptText renders the interactive input prompt. */
export function promptText(provider: string): string {
  return Pink("❯") + " " + Cyan(provider) + Grey(" ▸ ");
}

export function ok(msg: string): string {
  return Green("✔") + " " + msg;
}
export function warn(msg: string): string {
  return Yellow("!") + " " + msg;
}
export function fail(msg: string): string {
  return Red("✖") + " " + msg;
}
export function info(msg: string): string {
  return Cyan("•") + " " + msg;
}

/**
 * visibleLen counts display width, ignoring ANSI escape sequences so themed
 * text does not inflate the computed box width.
 */
export function visibleLen(s: string): number {
  let n = 0;
  let inEscape = false;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (inEscape) {
      // A CSI sequence ends on a byte in the range @ to ~.
      if (code >= 0x40 && code <= 0x7e) inEscape = false;
    } else if (code === 0x1b) {
      inEscape = true;
    } else {
      n++;
    }
  }
  return n;
}
