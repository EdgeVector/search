# EdgeVector Search

First-party **semantic** search app for LastDB (`lastdb:///search`).

Search owns a local regenerable **MiniLM vector index** for Brain, F-Kanban, and
other EdgeVector apps. The LastDB kernel keeps thin contracts for durable
records and index-change outbox; it does **not** ship embeddings in default
`lastdbd`. Keyword LastStore indexing was **removed** (2026-07-30).

## Product Contract

- Search is a first-party app hosted from `lastdb:///search`.
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
{LASTDB_HOME}/apps/search/index/                 # optional text snapshot for re-embed
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
