# EdgeVector Search

First-party embedded index app for LastDB (`lastdb:///search`).

Search owns local semantic and **keyword** indexing for Brain, F-Kanban, and
other EdgeVector apps. The LastDB kernel should keep thin contracts for durable
records, change notification, index sinks, and grant-scoped query routing; it
**should not ship FastEmbed**, ONNX, model weights, or vector-index internals in
the default `lastdbd` binary.

## Product Contract

- Search is a first-party app hosted from `lastdb:///search`.
- Search index data is **local-only and regenerable** from atoms, tips, and app
  text projections (`IndexChangeBatch` from the host).
- Search index data is **not CloudSync product data**.
- Search provides a shared node-mediated capability, not a per-app private
  vector database.
- Brain and F-Kanban migrate to this shared Search plane.

## Layout (under Mini home)

```text
{LASTDB_HOME}/apps/search/inbox/   # host-written IndexChangeBatch JSON files
{LASTDB_HOME}/apps/search/index/   # regenerable keyword index snapshot
```

Override with `SEARCH_HOME`, `SEARCH_INBOX`, `SEARCH_INDEX_DIR`.

## CLI

```bash
search drain --last-db-home /path/to/ephemeral-home
search query "distinctive text" --json --last-db-home /path/to/ephemeral-home
search apply --file batch.json --last-db-home ...
search status
```

`query` drains the inbox first so host-delivered batches are visible.

## Library

```ts
import { openSearchEngine } from "@edgevector/search";
import type { IndexChangeBatch } from "@edgevector/search/types";

const eng = openSearchEngine(indexDir);
eng.applyChangeBatch(batch);
eng.persist();
const hits = eng.search("needle", { k: 10, schemas: ["fbrain/Preference"] });
```

## Validation

```bash
.lastgit/ci.sh
```
