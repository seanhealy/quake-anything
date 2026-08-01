#!/usr/bin/env bash
# Stage a modular extension tree for pack/install (no single-file bundle).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bun run build
bun run schemas

rm -rf build
mkdir -p build
cp -a dist/. build/
cp metadata.json LICENSE build/
cp -a schemas build/
