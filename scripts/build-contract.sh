#!/usr/bin/env bash
# Builds the AgentRegistry Casper contract to Wasm and copies the
# stripped binary to contracts/agent-registry/agent-registry.wasm.
#
# Requires: rustup target add wasm32-unknown-unknown, and (optionally)
# wasm-strip from the WABT toolkit for a smaller binary.
set -euo pipefail

cd "$(dirname "$0")/../contracts/agent-registry"

echo "==> Building agent-registry contract (release, wasm32-unknown-unknown)"
cargo build --release --target wasm32-unknown-unknown

OUT_DIR="target/wasm32-unknown-unknown/release"
WASM_FILE="$OUT_DIR/agent-registry.wasm"

if [ ! -f "$WASM_FILE" ]; then
  echo "Build did not produce $WASM_FILE — check cargo output above." >&2
  exit 1
fi

cp "$WASM_FILE" ./agent-registry.wasm

if command -v wasm-strip >/dev/null 2>&1; then
  echo "==> Stripping debug sections with wasm-strip"
  wasm-strip ./agent-registry.wasm
else
  echo "==> wasm-strip not found (part of WABT) — skipping strip step."
  echo "    Install it (e.g. 'apt install wabt' / 'brew install wabt') for a smaller binary."
fi

echo "==> Done: contracts/agent-registry/agent-registry.wasm"
