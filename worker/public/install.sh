#!/usr/bin/env bash
set -e
# Bro Gang AI CLI installer for Linux & macOS
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH"; exit 1 ;;
esac
case "$OS" in
  linux|darwin) ;;
  *) echo "unsupported os: $OS"; exit 1 ;;
esac
URL="https://github.com/TechAdityaBRO/brogang-cli/releases/latest/download/brogang-${OS}-${ARCH}.tar.gz"
TMP="$(mktemp -d)"
curl -fsSL "$URL" -o "$TMP/brogang.tar.gz"
tar -xzf "$TMP/brogang.tar.gz" -C "$TMP"
BIN="${TMP}/brogang"
if [ -w /usr/local/bin ]; then
  install -m 0755 "$BIN" /usr/local/bin/brogang
  echo "Installed to /usr/local/bin/brogang"
else
  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$BIN" "$HOME/.local/bin/brogang"
  echo "Installed to $HOME/.local/bin/brogang (add to PATH)"
fi
