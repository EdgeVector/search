# EdgeVector Search

First-party **semantic** search app for LastDB (`https://github.com/EdgeVector/search`).

Search owns a local regenerable **MiniLM vector index** for Brain, F-Kanban, and
other EdgeVector apps. The LastDB kernel keeps thin contracts for durable
records and index-change outbox; it does **not** ship embeddings in default
`lastdbd`. Keyword LastStore indexing was **removed** (2026-07-30).

## Product Contract

- Search is a first-party app hosted from `https://github.com/EdgeVector/search`.
- Index data is **local-only and regenerable** from product text
  (`IndexChangeBatch` from the host).
- Index data is **not CloudSync product data**.
- Default embedder: **Xenova/all-MiniLM-L6-v2** (384-d) via `@xenova/transformers`.
- A full rebuild needs product text from a compatible live source or exported batches.
  `search init` alone uses local pending requests and the legacy archive.
  It does not prove a complete rebuild from LastDB.

## Layout (under Mini home)

```text
{LASTDB_HOME}/apps/search/inbox/                 # pending IndexChangeBatch requests
{LASTDB_HOME}/apps/search/inbox/done/            # optional legacy replay archive
{LASTDB_HOME}/apps/search/vector-index.v2.bin     # semantic vector snapshot
{LASTDB_HOME}/apps/search/vector-index.v2.log     # vector changes since the snapshot
```

Override: `SEARCH_HOME`, `SEARCH_INBOX`, `SEARCH_VECTOR_INDEX`,
`SEARCH_EMBEDDER=fastembed|deterministic`, `TRANSFORMERS_CACHE`.

## CLI

```bash
search init [--force] [--quiet]     # local pending requests + legacy batch replay
search bootstrap --live-url URL    # backfill from a compatible live source
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

Use `--live-url` or `SEARCH_LIVE_BACKFILL_URL` only with a compatible live source.
The source must return current product records and a cursor.
Search does not supply this endpoint, and a LastDB install does not imply one exists.
The result reports `rebuild_scope`, the legacy replay counts, and `live_source_completed`.
A completed cursor describes the supplied source, not every LastDB schema.

Client config checks report `BRAIN_SEARCH_URL` and
`FKANBAN_SEARCH_URL` (or shared `SEARCH_HTTP_URL`) so brain and fkanban install
issues are visible in one report. Offline `search rebuild --batches-dir` remains
a recovery path for the supplied batch directory. It does not read LastDB itself.

Search deletes a completed inbox request after the vector file and its directory
pass a durable flush. Invalid requests and failed writes stay pending.
Search does not create new `inbox/done` files. Existing archive files remain
available for legacy replay. The default newest 50,000 files is a replay limit.
It is not a retention rule or proof of a complete rebuild.
A process interruption before request removal can cause a repeat of the request.
The durable vector data stays on disk.

Each bounded inbox drain or write page holds an exclusive lock through the
current store load, writes, flush, request removal, and LastSeek compaction. A file stamp avoids a repeat load when no writer
changes the files. A failed lock or unreadable store leaves requests pending.
The lock lives beside the vector snapshot as `vector-index.v2.bin.writer.lock`.
A process interruption can leave this lock in place. The lock has no automatic
expiry. Check its recorded process before an explicit owner recovery action.
Long lived consumers must reload Search code before this lock protects all writers.
No LastDB restart is required.
The CLI uses Node for the native model runtime. Host-track post-install builds
the CLI with Bun. Package library exports stay compatible.

Library users who write directly through `VectorIndex` must use `withWriter`.
`persist` and `compact` reject calls outside that write boundary.

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
false` (unknown, not zero), and the overall state stays `degraded` until this check succeeds.

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
npx tsc --noEmit --allowImportingTsExtensions
```

## Host-track install

```bash
host-track refresh search
# post-install: native dependencies + Node CLI bundle + PATH link for search
```

For a cold public install, use npm for the runtime dependencies. npm runs the
native transformer dependency setup that Bun may block as an untrusted
postinstall script.

```bash
npm ci --omit=dev --no-audit --no-fund
bun build src/cli.ts --target=node --packages=external --outfile=bin/search-cli.mjs
```

The cold CLI install needs Bun for the build and Node for the runtime.
The package post-install alone does not create the ignored CLI bundle.
The supported host-track post-install performs both steps.

## License

MIT © 2026 Edge Vector Foundation. See [LICENSE](./LICENSE).

Gate of record: GitHub (`https://github.com/EdgeVector/search`), since 2026-09-30. Open pull requests there; `ci-required` gates `main`. A push to `main` publishes the host-track artifact (`ht-artifact-<sha>`) through `EdgeVector/last-stack` `host-track-artifact.yml`.

Source: GitHub

The tests are deleted (Tom, 2026-10-09). The `gate` job runs the repo layout, shell syntax, and Node CLI build checks in `.lastgit/ci.sh`.
