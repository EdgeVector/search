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
- A full rebuild needs product text re-delivered into the inbox.
  `search init` drains local pending requests.
  It does not prove a complete rebuild from LastDB.

## Layout (under Mini home)

```text
{LASTDB_HOME}/apps/search/inbox/                 # pending IndexChangeBatch requests
{LASTDB_HOME}/apps/search/vector-index.v2.bin     # semantic vector snapshot
{LASTDB_HOME}/apps/search/vector-index.v2.log     # vector changes since the snapshot
```

Override: `SEARCH_HOME`, `SEARCH_INBOX`, `SEARCH_VECTOR_INDEX`,
`SEARCH_EMBEDDER=fastembed|deterministic`, `TRANSFORMERS_CACHE`.

## CLI

```bash
search init [--force] [--quiet]     # drain local pending requests
search drain                        # apply inbox batches to vectors
search query "meaning query" --json # semantic k-NN (alias: semantic-query)
search apply --file batch.json
search rebuild --batches-dir ./batches
search bootstrap                    # alias of init
search online-backfill              # alias of init
search doctor                       # scriptable readiness report
search status | vector-status
```

`search init`, `search bootstrap`, and `search online-backfill` drain the inbox.
They are resumable: a vector that is already fresh is skipped.
Final JSON is on stdout; the progress bar is on stderr.
`search doctor --strict` exits non-zero when a required check such as the model
is degraded. An empty index is reported with a next action.

The result reports `rebuild_scope` `local_batches_only`.
`search init` is not a complete rebuild from LastDB.

Client config checks report `BRAIN_SEARCH_URL` and
`FKANBAN_SEARCH_URL` (or shared `SEARCH_HTTP_URL`) so brain and fkanban install
issues are visible in one report. Offline `search rebuild --batches-dir` remains
a recovery path for the supplied batch directory. It does not read LastDB itself.

Search deletes a completed inbox request after the vector file and its directory
pass a durable flush. Invalid requests and failed writes stay pending.
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
The CLI uses Node for the native model runtime. The package `postinstall` builds
the CLI bundle with Bun (`bun run build`), so every install path creates it.
Package library exports stay compatible.

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
lastdb app upgrade search
# post-install: native dependencies + Node CLI bundle + PATH link for search
```

For a cold public install, use npm for the runtime dependencies. npm runs the
native transformer dependency setup that Bun may block as an untrusted
postinstall script.

```bash
npm ci --omit=dev --no-audit --no-fund
# the package postinstall runs: bun run build  (writes the ignored bin/search-cli.mjs)
```

The cold CLI install needs Bun for the build and Node for the runtime.
The package `postinstall` creates the ignored CLI bundle, so a source install
through host-track, the app registry, `bun install`, or `npm ci` all produce it.
The host-track post-install runs the same build again.

## License

MIT © 2026 Edge Vector Foundation. See [LICENSE](./LICENSE).

Gate of record: GitHub (`https://github.com/EdgeVector/search`), since 2026-09-30. Open pull requests there; `ci-required` gates `main`. A push to `main` publishes the host-track artifact (`ht-artifact-<sha>`) through `EdgeVector/last-stack` `host-track-artifact.yml`.

Source: GitHub

The tests are deleted (Tom, 2026-10-09). The `gate` job runs the repo layout, shell syntax, and Node CLI build checks in `.lastgit/ci.sh`.
