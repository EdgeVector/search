#!/usr/bin/env bash
# Required merge gate (`ci-required`) for the first-party Search app (semantic-only).
# Runs on GitHub Actions since 2026-09-30.
set -euo pipefail
cd "$(dirname "$0")/.."

case "$(head -n 1 .last-stack/pr-venue)" in
  lastgit|forgejo|github) ;;
  *) echo "unexpected .last-stack/pr-venue" >&2; exit 1 ;;
esac

grep -q "https://github.com/EdgeVector/search" README.md
grep -q "local-only and regenerable" README.md
grep -q "not CloudSync product data" README.md
grep -q "semantic" README.md
test ! -f src/engine.ts
test ! -f src/tokenize.ts
test ! -d crates
test ! -d vendor/laststore

bash -n .lastgit/ci.sh
bash -n bin/search-host-track-post-install

# Unit tests: deterministic embedder so CI does not download ONNX weights.
if command -v bun >/dev/null 2>&1; then
  SEARCH_EMBEDDER=deterministic bun test
else
  echo "bun not on PATH" >&2
  exit 1
fi

echo "lastgit ci gate PASSED"
