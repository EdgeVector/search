# EdgeVector Search

First-party **semantic** search app for LastDB (`http://localhost:3300/EdgeVector/search.git`).

Search owns a local regenerable **MiniLM vector index** for Brain, F-Kanban, and
other EdgeVector apps. The LastDB kernel keeps thin contracts for durable
records and index-change outbox; it does **not** ship embeddings in default
`lastdbd`. Keyword LastStore indexing was **removed** (2026-07-30).

## Product Contract

- Search is a first-party app hosted from `http://localhost:3300/EdgeVector/search.git`.
- Index data is **local-only and regenerable** from product text
  (`IndexChangeBatch` from the host).
- Index data is **not CloudSync product data**.
- Default embedder: **Xenova/all-MiniLM-L6-v2** (384-d) via `@xenova/transformers`.
- After cloud restore / cold home, run **`search init`** (online backfill) while
  the daemon may stay up.

## Layout (under Mini home)

```text
{LASTDB_HOME}/apps/search/inbox/                 # host-written IndexChangeBatch JSON
{LASTDB_HOME}/apps/search/vector-index.v1.json   # semantic vector snapshot
```

Override: `SEARCH_HOME`, `SEARCH_INBOX`, `SEARCH_VECTOR_INDEX`,
`SEARCH_EMBEDDER=fastembed|deterministic`, `TRANSFORMERS_CACHE`.

## CLI

```bash
search init [--force] [--quiet]     # dirs + online-backfill (resumable; progress on stderr)
search bootstrap [--live-url URL]   # online bootstrap against a running daemon
search doctor [--live-url URL]      # scriptable readiness/config report
search drain                        # apply inbox batches to vectors
search query "meaning query" --json # semantic k-NN (alias: semantic-query)
search apply --file batch.json
search rebuild --batches-dir ./batches
search online-backfill
search status | vector-status
```

`search init` / `online-backfill` are **resumable** (skip fresh vectors; flush
every N embeds). Final JSON is on **stdout**; progress bar on **stderr**.
`search bootstrap` is the named online install path and uses the same resumable
engine. `search doctor --strict` exits non-zero only when a required check such
as the model or live endpoint is degraded; an empty index or missing checkpoint
is reported with a next action.

Use `--live-url` or `SEARCH_LIVE_BACKFILL_URL` for the LastDB live backfill
endpoint. Client config checks report `BRAIN_SEARCH_URL` and
`FKANBAN_SEARCH_URL` (or shared `SEARCH_HTTP_URL`) so brain and fkanban install
issues are visible in one report. Offline `search rebuild --batches-dir` remains
the disaster recovery path when online bootstrap cannot be used.

`search status` / `vector-status` report a machine-readable `state`
(`healthy` | `degraded`) driven by coverage, not just index consistency:
per-schema `vectors held / source records available` (from the LastDB schema
catalog, scoped by default to `SEARCH_COVERAGE_APPS=brain,fbrain,fkanban,kanban`
— override to track other apps), an inbox `pending_files` / oldest-batch-age
signal, and an `embedder` breakdown that flags any nonzero
`+deterministic`-suffixed vector share. `state` goes `degraded` when total or
any single schema's coverage falls under the floor (`SEARCH_COVERAGE_FLOOR`,
default `0.95`), when a schema with source records holds zero vectors, or when
deterministic vectors are present at all. Set `SEARCH_LASTDB_SOCKET` (default
`~/.lastdb/data/folddb.sock`) or `SEARCH_LASTDB_API_URL` to point coverage at a
non-default LastDB node; catalog-unreachable reports `coverage.available:
false` (unknown, not zero).

## Library

```ts
import { openSearchSession, applyBatch, semanticQuery } from "@edgevector/search/semantic";

const session = openSearchSession({ lastDbHome: "~/.lastdb" });
await session.semantic.ensureReady();
await applyBatch(session, batch);
const hits = await semanticQuery(session, "query", { k: 10 });
```

## Validation

```bash
.lastgit/ci.sh
```

## Host-track install

```bash
host-track refresh search
# post-install: npm install (sharp + transformers) + PATH link for search
```

For a cold public install, use npm for the runtime dependencies. npm runs the
native transformer dependency setup that Bun may block as an untrusted
postinstall script.

```bash
npm ci --omit=dev --no-audit --no-fund
```

## License

MIT © 2026 Edge Vector Foundation. See [LICENSE](./LICENSE).

**GitHub** is a public read-only mirror (`https://github.com/EdgeVector/search`).
Canonical source of truth: `http://localhost:3300/EdgeVector/search.git` (LastGit). Do not open merge PRs on GitHub.

Source: LastGit
