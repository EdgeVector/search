import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorIndex } from "../src/vector/vector_index.ts";
import type { Embedder } from "../src/vector/embedder.ts";

function fakeEmbedder(id: string, dims = 4): Embedder {
  return {
    id,
    dimensions: dims,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const v = new Array(dims).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dims] += t.charCodeAt(i);
        return v;
      });
    },
  };
}

describe("single-embedder-per-index invariant", () => {
  test("first write into an empty index is always allowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vec-inv-empty-"));
    const idx = new VectorIndex(join(dir, "v.json"));
    const a = fakeEmbedder("model-a");
    const action = await idx.indexText(a, {
      schema_name: "S",
      key_hash: "k1",
      key_range: null,
      text: "hello world",
    });
    expect(action).toBe("embedded");
    expect(idx.embedderBreakdown()).toEqual({ "model-a": 1 });
  });

  test("a write under a second embedder_id is refused, not warned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vec-inv-mixed-"));
    const idx = new VectorIndex(join(dir, "v.json"));
    const a = fakeEmbedder("model-a");
    const b = fakeEmbedder("model-b");
    await idx.indexText(a, {
      schema_name: "S",
      key_hash: "k1",
      key_range: null,
      text: "hello world",
    });
    await expect(
      idx.indexText(b, {
        schema_name: "S",
        key_hash: "k2",
        key_range: null,
        text: "goodbye world",
      }),
    ).rejects.toThrow(/already holds/);
    // The refused write must not land — index stays single-embedder.
    expect(idx.embedderBreakdown()).toEqual({ "model-a": 1 });
    expect(idx.size).toBe(1);
  });

  test("re-writing under the SAME embedder_id that is already present is fine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vec-inv-same-"));
    const idx = new VectorIndex(join(dir, "v.json"));
    const a = fakeEmbedder("model-a");
    await idx.indexText(a, {
      schema_name: "S",
      key_hash: "k1",
      key_range: null,
      text: "hello world",
    });
    const action = await idx.indexText(a, {
      schema_name: "S",
      key_hash: "k2",
      key_range: null,
      text: "second doc",
    });
    expect(action).toBe("embedded");
    expect(idx.embedderBreakdown()).toEqual({ "model-a": 2 });
  });

  test("evictByEmbedder removes only the matching embedder's vectors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vec-inv-evict-"));
    const idx = new VectorIndex(join(dir, "v.json"));
    const det = fakeEmbedder("all-MiniLM-L6-v2+deterministic");
    // Bypass the invariant to seed a pre-existing mixed index the way
    // production got into this state (raw upsert, not indexText).
    const stale1 = await det.embed(["stale doc one"]);
    idx.upsert({
      id: "rec-h1-body",
      schema_name: "S",
      key_hash: "h1",
      key_range: null,
      fragment_key: "body",
      text: "stale doc one",
      embedder_id: det.id,
      vector: stale1[0]!,
    });
    const stale2 = await det.embed(["stale doc two"]);
    idx.upsert({
      id: "rec-h2-body",
      schema_name: "S",
      key_hash: "h2",
      key_range: null,
      fragment_key: "body",
      text: "stale doc two",
      embedder_id: det.id,
      vector: stale2[0]!,
    });
    expect(idx.size).toBe(2);
    expect(idx.embedderBreakdown()).toEqual({
      "all-MiniLM-L6-v2+deterministic": 2,
    });

    const evictResult = idx.evictByEmbedder((id) => id.includes("+deterministic"));
    expect(evictResult.removed).toBe(2);
    expect(evictResult.removedIds.length).toBe(2);
    expect(idx.size).toBe(0);
    expect(idx.embedderBreakdown()).toEqual({});

    // Now the index is empty, so a real embedder can write into it cleanly —
    // proving evict-and-reindex actually unblocks the invariant.
    const real = fakeEmbedder("all-MiniLM-L6-v2");
    const action = await idx.indexText(real, {
      schema_name: "S",
      key_hash: "h1",
      key_range: null,
      text: "stale doc one",
    });
    expect(action).toBe("embedded");
    expect(idx.embedderBreakdown()).toEqual({ "all-MiniLM-L6-v2": 1 });
  });

  test("evictByEmbedder leaves other embedders' vectors untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vec-inv-evict-selective-"));
    const idx = new VectorIndex(join(dir, "v.json"));
    const real = fakeEmbedder("all-MiniLM-L6-v2");
    const realVecs = await real.embed(["real doc"]);
    idx.upsert({
      id: "rec-r1-body",
      schema_name: "S",
      key_hash: "r1",
      key_range: null,
      fragment_key: "body",
      text: "real doc",
      embedder_id: real.id,
      vector: realVecs[0]!,
    });
    const det = fakeEmbedder("all-MiniLM-L6-v2+deterministic");
    const detVecs = await det.embed(["stale doc"]);
    idx.upsert({
      id: "rec-d1-body",
      schema_name: "S",
      key_hash: "d1",
      key_range: null,
      fragment_key: "body",
      text: "stale doc",
      embedder_id: det.id,
      vector: detVecs[0]!,
    });

    const evictResult = idx.evictByEmbedder((id) => id.includes("+deterministic"));
    expect(evictResult.removed).toBe(1);
    expect(idx.size).toBe(1);
    expect(idx.embedderBreakdown()).toEqual({ "all-MiniLM-L6-v2": 1 });
  });

  test("evicted+reindexed records survive a persist/reload roundtrip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vec-inv-roundtrip-"));
    const path = join(dir, "v.json");
    const idx1 = new VectorIndex(path);
    const det = fakeEmbedder("all-MiniLM-L6-v2+deterministic");
    const staleVecs = await det.embed(["stale"]);
    idx1.upsert({
      id: "rec-k1-body",
      schema_name: "S",
      key_hash: "k1",
      key_range: null,
      fragment_key: "body",
      text: "stale",
      embedder_id: det.id,
      vector: staleVecs[0]!,
    });
    idx1.persist();
    idx1.evictByEmbedder("all-MiniLM-L6-v2+deterministic");
    idx1.persist();

    const idx2 = new VectorIndex(path);
    expect(idx2.size).toBe(0);
    expect(idx2.embedderBreakdown()).toEqual({});

    const real = fakeEmbedder("all-MiniLM-L6-v2");
    const action = await idx2.indexText(real, {
      schema_name: "S",
      key_hash: "k1",
      key_range: null,
      text: "stale",
    });
    expect(action).toBe("embedded");
    idx2.persist();

    const idx3 = new VectorIndex(path);
    expect(idx3.size).toBe(1);
    expect(idx3.embedderBreakdown()).toEqual({ "all-MiniLM-L6-v2": 1 });
  });
});
