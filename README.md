# EdgeVector Search

First-party embedded index app for LastDB.

Search owns local semantic and keyword indexing for Brain, F-Kanban, and other
EdgeVector apps. The LastDB kernel should keep thin contracts for durable
records, change notification, index sinks, and grant-scoped query routing; it
should not ship FastEmbed, ONNX, model weights, or vector-index internals in the
default `lastdbd` binary.

## Product Contract

- Search is a first-party app hosted from `lastdb:///search`.
- Search index data is local-only and regenerable from atoms, tips, and app
  text projections.
- Search index data is not CloudSync product data.
- Search provides a shared node-mediated capability, not a per-app private
  vector database.
- Brain and F-Kanban should migrate to this shared Search plane before LastDB
  peels embedding/model dependencies from the default binary.

## Current Slice

This repository starts as the landing zone for the Search app program:

1. Keep LastGit as the gate of record.
2. Keep the scaffold CI small and deterministic.
3. Add app code only behind concrete PR cards after the fold `IndexSink` and
   change-feed contracts land.

## Validation

Run the required gate:

```bash
.lastgit/ci.sh
```
