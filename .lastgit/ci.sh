#!/usr/bin/env bash
# Required LastGit status gate for the first-party Search app.
set -euo pipefail
cd "$(dirname "$0")/.."

test "$(head -n 1 .last-stack/pr-venue)" = "lastgit"
test ! -e .github/workflows

grep -q "lastdb:///search" README.md
grep -q "local-only and regenerable" README.md
grep -q "not CloudSync product data" README.md
grep -q "should not ship FastEmbed" README.md

bash -n .lastgit/ci.sh

# Real engine tests (fixture ingest → query)
if command -v bun >/dev/null 2>&1; then
  bun test
else
  echo "bun not on PATH — skip bun test (scaffold-only hosts)"
  exit 1
fi

echo "lastgit ci gate PASSED"
