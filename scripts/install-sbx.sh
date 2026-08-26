#!/usr/bin/env bash
# Install or update Docker Sandboxes (sbx) under ~/.docker/sbx and symlink it
# into ~/.local/bin. Safe to re-run — it updates when a newer release exists.
set -euo pipefail

REPO="docker/sbx-releases"
PREFIX="$HOME/.docker/sbx"
ASSET="DockerSandboxes-linux-amd64.tar.gz"

version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -oP '"tag_name":\s*"\K[^"]+')"

if [ -x "$PREFIX/bin/sbx" ] && "$PREFIX/bin/sbx" version 2>/dev/null | grep -q "$version"; then
  echo "sbx $version already installed."
  exit 0
fi

echo "Installing sbx $version ..."
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fL "https://github.com/$REPO/releases/download/$version/$ASSET" -o "$tmp/sbx.tar.gz"
tar -xzf "$tmp/sbx.tar.gz" -C "$tmp"
PREFIX="$PREFIX" "$tmp/docker-sbx/install.sh"

mkdir -p "$HOME/.local/bin"
ln -sfn "$PREFIX/bin/sbx" "$HOME/.local/bin/sbx"
echo "Linked ~/.local/bin/sbx -> $PREFIX/bin/sbx"
"$HOME/.local/bin/sbx" version
