#!/usr/bin/env bash
# Required LastGit status gate for the first-party Search app (semantic-only).
set -euo pipefail
cd "$(dirname "$0")/.."

test "$(head -n 1 .last-stack/pr-venue)" = "lastgit"
test ! -e .github/workflows

grep -q "lastdb:///search" README.md
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
