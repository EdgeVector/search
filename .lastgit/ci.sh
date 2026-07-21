#!/usr/bin/env bash
# Required LastGit status gate for the first-party Search app scaffold.
set -euo pipefail
cd "$(dirname "$0")/.."

test "$(head -n 1 .last-stack/pr-venue)" = "lastgit"
test ! -e .github/workflows

grep -q "lastdb:///search" README.md
grep -q "local-only and regenerable" README.md
grep -q "not CloudSync product data" README.md
grep -q "should not ship FastEmbed" README.md

bash -n .lastgit/ci.sh

echo "lastgit ci gate PASSED"
