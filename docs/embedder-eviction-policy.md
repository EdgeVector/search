# Embedder eviction policy

A vector index is only meaningful when every vector in it lives in the same
embedding space. Cosine similarity between a query embedded by model A and a
document embedded by model B is not "less accurate" — it is noise that
happens to be shaped like a score.

## The invariant

`VectorIndex.indexText()` refuses any write whose `embedder_id` differs from
an `embedder_id` already present in the index (see
`src/vector/vector_index.ts`). This is enforced at write time, not warned
about, and it cannot be routed around by env config — the same shape of guard
already existed for the deterministic-into-production case
(`search-deterministic-embedder-must-not-reach-production-index`); this
generalizes it to any embedder swap, not just the deterministic one.

This means: **you cannot incrementally roll a new embedder into a
production index.** The first write under the new `embedder_id` throws until
every vector under the old `embedder_id` is gone.

## How 2,981 deterministic vectors reached production once

See `search-deterministic-embedder-must-not-reach-production-index` for the
provenance writeup. The short version: nothing structurally prevented a
deterministic-embedder write from landing in the real index home, so a
config/init-failure edge case (silently falling back, or an explicit
`SEARCH_ALLOW_DETERMINISTIC=1`) mixed 2,981 lexical-hash vectors into an
11,012-vector MiniLM index. This invariant, plus the earlier
production-home guard, close both the specific hole (deterministic) and the
general one (any future embedder change).

## The procedure for a deliberate embedder change

1. **Evict.** Run `search reindex-embedder <old-embedder-id-substring>`
   against the target index home. This deletes every vector whose
   `embedder_id` matches, persists the index, and (unless
   `--keep-checkpoint` is passed) removes the online-backfill checkpoint so
   the next backfill treats those records as needing embedding again rather
   than skipping them as "already fresh."
2. **Reindex.** Run `search bootstrap` (or wait for the scheduled
   drain/backfill routine). This replays `inbox/done/*.json` batches and any
   configured live source; records with no vector are no longer "fresh," so
   they re-embed under whichever embedder the running process resolves via
   `SEARCH_EMBEDDER` (production default: FastEmbed/`all-MiniLM-L6-v2`
   neural).
3. **Verify.** `search status` reports `embedder` (via
   `embedderBreakdown()`/`computeEmbedderBreakdown`) — confirm it shows a
   single `embedder_id` and the vector count has recovered.

Evict-and-reindex is deliberately the *only* supported path — there is no
in-place re-embed/migration tool, so there is exactly one code path to keep
correct instead of two.

## Why not warn-and-continue

A warning is silent once nobody is watching the logs — that is exactly how
the original 2,981 deterministic vectors sat undetected in production. Once
an index can be provably single-embedder, keeping it that way at write time
is cheaper than re-auditing it later.
