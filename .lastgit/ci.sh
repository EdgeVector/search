#!/usr/bin/env bash
# Required LastGit status gate for the first-party Search app.
set -euo pipefail
cd "$(dirname "$0")/.."

test "$(head -n 1 .last-stack/pr-venue)" = "lastgit"
test ! -e .github/workflows

grep -q "lastdb:///search" README.md
grep -q "local-only and regenerable" README.md
grep -q "not CloudSync product data" README.md
grep -q "FastEmbed" README.md
grep -q "LastStore" README.md

bash -n .lastgit/ci.sh

# LastStore-backed engine (Rust)
if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not on PATH — required for LastStore search-store" >&2
  exit 1
fi
cargo test -p search-store
cargo build -p search-store

# Real engine tests (fixture ingest → query, LastStore reopen, cold rebuild)
if command -v bun >/dev/null 2>&1; then
  bun test
else
  echo "bun not on PATH — skip bun test" >&2
  exit 1
fi

echo "lastgit ci gate PASSED"
