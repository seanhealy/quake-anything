#!/usr/bin/env bash
# Install or update Docker Sandboxes (sbx) under ~/.docker/sbx and symlink it
# into ~/.local/bin. Safe to re-run — it updates when a newer release exists.
set -euo pipefail

REPO="docker/sbx-releases"
PREFIX="$HOME/.docker/sbx"
ASSET="DockerSandboxes-linux-amd64.tar.gz"

latest="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -oP '"tag_name":\s*"\K[^"]+')"

current=""
[ -x "$PREFIX/bin/sbx" ] && current="$("$PREFIX/bin/sbx" version 2>/dev/null | grep -oP 'v\d+\.\d+\.\d+' | head -1)"

if [ "$current" = "$latest" ]; then
  echo "sbx $latest is already up to date."
  exit 0
elif [ -n "$current" ]; then
  echo "Updating sbx $current -> $latest ..."
  "$PREFIX/bin/sbx" daemon stop >/dev/null 2>&1 || true
else
  echo "Installing sbx $latest ..."
fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fL "https://github.com/$REPO/releases/download/$latest/$ASSET" -o "$tmp/sbx.tar.gz"
tar -xzf "$tmp/sbx.tar.gz" -C "$tmp"
PREFIX="$PREFIX" "$tmp/docker-sbx/install.sh"

mkdir -p "$HOME/.local/bin"
ln -sfn "$PREFIX/bin/sbx" "$HOME/.local/bin/sbx"
"$HOME/.local/bin/sbx" version
