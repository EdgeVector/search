# EdgeVector Search

First-party embedded index app for LastDB (`lastdb:///search`).

Search owns the local **semantic (vector)** index for Brain, F-Kanban, and other
EdgeVector apps. The keyword LastStore plane was removed from the product path
(2026-07-30); consumers query vectors only. The LastDB kernel keeps thin contracts for
durable records, change notification, and index sinks; it **should not ship
FastEmbed**, ONNX, model weights, or vector-index internals in the default
`lastdbd` binary — those live here (Search), typically **all-MiniLM-L6-v2**.

## Product Contract

- Search is a first-party app hosted from `lastdb:///search`.
- Search index data is **local-only and regenerable** from atoms, tips, and app
  text projections (`IndexChangeBatch` from the host).
- Search index data is **not CloudSync product data**.
- Durable index state is stored via **LastStore** (segment document store), not
  a single full-corpus JSON snapshot.
- After cloud restore / cold home, run **rebuild** to regenerate the plane from
  product data (or pre-emitted batches). Live mutations never run a full-corpus
  walk on the write hot path.

## Layout (under Mini home)

```text
{LASTDB_HOME}/apps/search/inbox/              # host-written IndexChangeBatch JSON
{LASTDB_HOME}/apps/search/laststore/          # LastStore-backed keyword index
{LASTDB_HOME}/apps/search/vector-index.v1.json  # semantic vector snapshot
```

Override with `SEARCH_HOME`, `SEARCH_INBOX`, `SEARCH_LASTSTORE_DIR`,
`SEARCH_VECTOR_INDEX`, `SEARCH_STORE_BIN`, `SEARCH_EMBEDDER=deterministic|fastembed|auto`.

## CLI

```bash
cargo build -p search-store   # LastStore engine binary
search init --last-db-home /path/to/home   # bootstrap: dirs + online-backfill (does NOT stop lastdbd)
search drain --last-db-home /path/to/home
search query "distinctive text" --json --last-db-home /path/to/home
search semantic-query "meaning query" --schema <hash> --k 10 --json
search apply --file batch.json --last-db-home ...
search rebuild --batches-dir ./batches --last-db-home ...
search online-backfill --last-db-home ...   # same re-embed path as init; does NOT stop lastdbd
search status
search vector-status
```

`search init` is the install / cold-home entry point: it ensures Search app dirs under
the LastDB home, then runs **online-backfill** (drain live inbox, replay done batches,
re-embed the keyword corpus into the vector plane). You can re-run `init` anytime; it
does not stop `lastdbd`. Prefer `init` after first install, host-track refresh, or
restore; use `online-backfill` when you only want the re-embed step by name.

**Resumable:** both commands skip docs that already have a fresh vector (same embedder +
text / mutation_id) and flush the vector snapshot every 50 new embeds by default
(`--flush-every N`). Interrupt and re-run — progress is kept. Use `--force` to re-embed
everything.

**Progress:** a live bar is written to **stderr** (counts, rate, ETA). Final JSON summary
stays on **stdout**. Use `--quiet` or `SEARCH_PROGRESS=0` to silence the bar; set
`SEARCH_PROGRESS=plain` for line-at-a-time logs (no TTY redraw).

### Embedder (real MiniLM by default)

Production default is a **real neural model**: `@xenova/transformers` pipeline
`Xenova/all-MiniLM-L6-v2` (384-d, mean pool, L2-normalized) — same family as fold
FastEmbed. Host-track post-install uses **`npm install`** so `sharp`'s native binary
is built (bun alone often skips lifecycle scripts and breaks neural load).

```bash
# default: real model
search init --force          # re-embed corpus after switching embedders

# tests / offline CI only
SEARCH_EMBEDDER=deterministic bun test
```

Env:

| Variable | Meaning |
|----------|---------|
| `SEARCH_EMBEDDER=fastembed` | **default** — real MiniLM; fails loudly if model/package missing |
| `SEARCH_EMBEDDER=auto` | try neural; set `SEARCH_ALLOW_DETERMINISTIC=1` to allow hash fallback |
| `SEARCH_EMBEDDER=deterministic` | tests only — not production quality |
| `TRANSFORMERS_CACHE` | optional ONNX model cache dir |

After changing embedder, vectors use a different `embedder_id`, so resume skip will
not match deterministic rows — re-run `search init --force` (or plain `init` after
deleting the old index) to rebuild the neural plane.

`query` / `semantic-query` drain the inbox first so host-delivered batches are visible.
Semantic query supports native-parity knobs: `--schema` (repeatable, structural scope),
`--k`, `--exact`, `--min-score`.

### Host-track / PATH install

Search is a **local-safe** host-track app (`lastdb:///search`). Refresh:

```bash
host-track refresh search
# or: last-stack-safe-upgrade-cli search
```

That materializes a version under `~/.host-track/apps/search/`, runs
`bin/search-host-track-post-install` (`npm install` for MiniLM/sharp +
`cargo build --release -p search-store`), and links:

| Binary | PATH |
|--------|------|
| `search` | `~/.local/bin/search` |
| `search-store` | `~/.local/bin/search-store` |

Cold product rebuild (no remutation) still needs Mini's offline emit:

```bash
# stop lastdbd for that home first
lastdb --data-dir "$HOME_OR_RESTORE" search-rebuild --json
search drain --last-db-home "$HOME_OR_RESTORE"
```

## Library

```ts
import { openSearchEngine } from "@edgevector/search";

const eng = openSearchEngine(indexDir);
eng.applyChangeBatch(batch);
eng.persist(); // LastStore already flushed on apply
const hits = eng.search("needle", { k: 10 });
// Cold restore:
eng.rebuildFromBatches(batches, true);
```

## Validation

```bash
.lastgit/ci.sh
```
