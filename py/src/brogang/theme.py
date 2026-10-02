"""The BRO GANG "Bang Mach" terminal theme.

Raw ANSI escapes are used directly so the package stays dependency free and
works on any terminal that speaks ANSI. Mirrors ts/src/theme.ts.
"""

import os
import re

RESET = "\x1b[0m"
BOLD = "\x1b[1m"
DIM = "\x1b[2m"
ITALIC = "\x1b[3m"
UNDERLINE = "\x1b[4m"

ColReset = RESET
ColBold = BOLD
ColDim = DIM
ColItalic = ITALIC
ColUnderline = UNDERLINE

ColPink = "\x1b[38;5;197m"  # #FF3B9E neon pink
ColCyan = "\x1b[38;5;51m"  # #00E5FF neon cyan
ColPurple = "\x1b[38;5;141m"
ColOrange = "\x1b[38;5;208m"
ColGreen = "\x1b[38;5;46m"
ColYellow = "\x1b[38;5;226m"
ColRed = "\x1b[38;5;196m"
ColGrey = "\x1b[38;5;245m"
ColWhite = "\x1b[38;5;255m"

TL = "┌─"
TR = "─┐"
BL = "└─"
BR = "─┘"
H = "─"
V = "│"


def colour_enabled() -> bool:
    if os.environ.get("NO_COLOR") or os.environ.get("BG_NO_COLOR"):
        return False
    if os.environ.get("BG_FORCE_COLOR"):
        return True
    return os.environ.get("TERM") != "dumb"


def paint(colour: str, text: str) -> str:
    if not colour_enabled():
        return text
    return colour + text + RESET


Paint = paint

Pink = lambda t: paint(ColPink, t)  # noqa: E731
Cyan = lambda t: paint(ColCyan, t)  # noqa: E731
Purple = lambda t: paint(ColPurple, t)  # noqa: E731
Orange = lambda t: paint(ColOrange, t)  # noqa: E731
Green = lambda t: paint(ColGreen, t)  # noqa: E731
Yellow = lambda t: paint(ColYellow, t)  # noqa: E731
Red = lambda t: paint(ColRed, t)  # noqa: E731
Grey = lambda t: paint(ColGrey, t)  # noqa: E731
White = lambda t: paint(ColWhite, t)  # noqa: E731
Bold = lambda t: paint(ColBold, t)  # noqa: E731
Dim = lambda t: paint(ColDim, t)  # noqa: E731
Italic = lambda t: paint(ColItalic, t)  # noqa: E731
Underline = lambda t: paint(ColUnderline, t)  # noqa: E731

BANNER_LINES = [
    " ██████╗ ██████╗  ██████╗      ██████╗  █████╗ ███╗   ██╗ ██████╗ ",
    " ██╔══██╗██╔══██╗██╔═══██╗    ██╔════╝ ██╔══██╗████╗  ██║██╔════╝ ",
    " ██████╔╝██████╔╝██║   ██║    ██║  ███╗███████║██╔██╗ ██║██║  ███╗",
    " ██╔══██╗██╔══██╗██║   ██║    ██║   ██║██╔══██║██║╚██╗██║██║   ██║",
    " ██████╔╝██║  ██║╚██████╔╝    ╚██████╔╝██║  ██║██║ ╚████║╚██████╔╝",
    " ╚═════╝ ╚═╝  ╚═╝ ╚═════╝      ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝ ",
]


def banner(version: str) -> str:
    out = ["\n"]
    for i, line in enumerate(BANNER_LINES):
        out.append((Pink(line) if i == 2 else Cyan(line)) + "\n")
    out.append("\n")
    out.append(
        "  "
        + Pink("Bro Gang AI CLI")
        + Grey("  ·  ")
        + Cyan("v" + version)
        + Grey("  ·  ")
        + White("East 2022")
        + Grey("  ·  ")
        + Orange("Bang Mach")
        + "\n"
    )
    out.append("  " + Grey("Free forever — no key, no signup. Chat, read, edit, run."))
    out.append("\n\n")
    return "".join(out)


def _visible_len(s: str) -> int:
    return len(re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", s))


visibleLen = _visible_len


def frame(title: str, body: list) -> str:
    width = 0
    for line in body:
        width = max(width, _visible_len(line))
    width = max(width, _visible_len(title) + 4)
    out = []
    out.append(
        Pink(TL + H) + Pink(" " + title + " ") + Pink(H * max(0, width - _visible_len(title) - 4) + TR) + "\n"
    )
    for line in body:
        out.append(Pink(V) + " " + line + " " * max(0, width - _visible_len(line)) + " " + Pink(V) + "\n")
    out.append(Pink(BL + H * (width + 2) + BR) + "\n")
    return "".join(out)


def rule(width: int = 60) -> str:
    return Grey(H * (width or 60))


def promptText(provider: str) -> str:
    return Pink("") + " " + Cyan(provider) + Grey(" › ")


def ok(msg: str) -> str:
    return Green("✔") + " " + msg


def warn(msg: str) -> str:
    return Yellow("!") + " " + msg


def fail(msg: str) -> str:
    return Red("✖") + " " + msg


def info(msg: str) -> str:
    return Cyan("ℹ") + " " + msg
