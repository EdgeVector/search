# Embedder eviction policy

A vector index is only meaningful when every vector in it lives in the same
embedding space. Cosine similarity between a query embedded by model A and a
document embedded by model B is not "less accurate" — it is noise that
happens to be shaped like a score.

## The invariant

`VectorIndex.indexText()` refuses any write whose `embedder_id` differs from
an `embedder_id` already present in the index (see
`src/vector/vector_index.ts`). This is enforced at write time, not warned
about.

This means: **you cannot incrementally roll a new embedder into a
production index.** The first write under the new `embedder_id` throws until
every vector under the old `embedder_id` is gone.

## The procedure for a deliberate embedder change

1. **Evict.** Run `search reindex-embedder <old-embedder-id-substring>`
   against the target index home. This deletes every vector whose
   `embedder_id` matches and persists the index.
2. **Reindex.** Re-deliver the records into the Search inbox, then run
   `search init` or `search drain` until the inbox is empty. Records with
   no vector are no longer fresh, so the drain embeds them again with
   FastEmbed `all-MiniLM-L6-v2`.
   `lastdb admin search-rebuild` writes that inbox from a stopped home.
   Stopping the primary needs Tom.
3. **Verify.** `search status` reports `embedder` (via
   `embedderBreakdown()`/`computeEmbedderBreakdown`) — confirm it shows a
   single `embedder_id` and the vector count has recovered.

Evict-and-reindex is deliberately the *only* supported path — there is no
in-place re-embed/migration tool, so there is exactly one code path to keep
correct instead of two.

## Why not warn-and-continue

A warning is silent once nobody is watching the logs. Once an index can be
provably single-embedder, keeping it that way at write time is cheaper than
re-auditing it later.
