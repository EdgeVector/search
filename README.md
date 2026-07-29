# EdgeVector Search

First-party embedded index app for LastDB (`lastdb:///search`).

Search owns local **keyword** and **semantic (vector)** indexing for Brain,
F-Kanban, and other EdgeVector apps. The LastDB kernel keeps thin contracts for
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
search drain --last-db-home /path/to/home
search query "distinctive text" --json --last-db-home /path/to/home
search semantic-query "meaning query" --schema <hash> --k 10 --json
search apply --file batch.json --last-db-home ...
search rebuild --batches-dir ./batches --last-db-home ...
search online-backfill --last-db-home ...   # does NOT stop lastdbd
search status
search vector-status
```

`query` / `semantic-query` drain the inbox first so host-delivered batches are visible.
Semantic query supports native-parity knobs: `--schema` (repeatable, structural scope),
`--k`, `--exact`, `--min-score`.

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
