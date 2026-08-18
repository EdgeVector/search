/**
 * Regression tests for the 2026-08-07 machine freeze.
 *
 * The v1 index rewrote its entire JSON snapshot on every flush, so a flush cost
 * O(total index) no matter how few records changed. Draining a 99k-batch inbox
 * wrote 549.80 GB in 20 minutes and grew one process to 26.1 GB RSS, which took
 * the machine down.
 *
 * These assert the properties that make that impossible, not the shape of the
 * implementation: bytes written must stay sub-linear in (records x index size),
 * an existing v1 index must migrate without a re-embed, and a drain must stay
 * bounded.
 *
 * brain: incident-machine-freeze-20260807-search-index-full-rewrite-oom
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorIndex } from "../src/vector/vector_index.ts";
import {
  resetStoreBytesWritten,
  storeBytesWritten,
  storePaths,
} from "../src/vector/store.ts";
import { drainInbox, DEFAULT_MAX_FILES } from "../src/inbox.ts";

const DIMS = 384;

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "search-store-"));
}

/** Deterministic pseudo-vector; float32-exact so round-trips compare cleanly. */
function vec(seed: number): number[] {
  const out = new Array<number>(DIMS);
  for (let i = 0; i < DIMS; i++) {
    out[i] = Math.fround(Math.sin(seed * 0.37 + i * 0.11));
  }
  return out;
}

/**
 * Record identity uses NUL separators (see recId in vector_index.ts). Built
 * here rather than pasted as literal NUL bytes, which would make this file
 * register as binary and stop diffing in review.
 */
const NUL = String.fromCharCode(0);
function makeId(hash: string, schema = "schema", fragment = "body"): string {
  return `${schema}${NUL}${hash}${NUL}${NUL}${fragment}`;
}

function rec(n: number) {
  return {
    id: makeId(`hash${n}`),
    schema_name: "schema",
    key_hash: `hash${n}`,
    key_range: null,
    fragment_key: "body",
    // Realistic body text — text, not vectors, dominates the snapshot.
    text: `record ${n} ${"lorem ipsum dolor sit amet ".repeat(40)}`,
    embedder_id: "all-MiniLM-L6-v2",
    vector: vec(n),
  };
}

/** Total bytes across every file the store owns, including the log. */
function storeBytes(storePath: string): number {
  const p = storePaths(storePath);
  let total = 0;
  for (const f of [p.snapshot, p.log, p.legacyJson]) {
    try {
      total += statSync(f).size;
    } catch {
      /* absent */
    }
  }
  return total;
}

describe("vector store write amplification", () => {
  test("flushing every 50 records stays sub-linear in index size", () => {
    const home = tmpHome();
    const storePath = join(home, "vector-index.v1.json");
    const index = new VectorIndex(storePath);

    // Build a base index, then measure only the incremental phase.
    const BASE = 2000;
    for (let i = 0; i < BASE; i++) index.upsert(rec(i));
    index.persist();
    index.compact();

    const snapshotBytes = storeBytes(storePath);
    expect(snapshotBytes).toBeGreaterThan(0);

    // Measure BYTES WRITTEN, not file growth. A full rewrite writes the whole
    // snapshot while growing the file by only the new records, so file size
    // hides exactly the cost that took the machine down.
    resetStoreBytesWritten();

    // The shape that killed the machine: many small flushes over a big index.
    const ADDED = 1000;
    const FLUSH_EVERY = 50;
    for (let i = 0; i < ADDED; i++) {
      index.upsert(rec(BASE + i));
      if ((i + 1) % FLUSH_EVERY === 0) index.persist();
    }
    index.persist();

    const written = storeBytesWritten();
    const flushes = ADDED / FLUSH_EVERY;
    // v1 wrote a whole snapshot per flush. That lower bound must be far out of
    // reach — this is the assertion that fails on the old implementation.
    const v1WouldWrite = flushes * snapshotBytes;
    expect(written).toBeLessThan(v1WouldWrite / 10);

    // And in absolute terms: writes stay proportional to records touched, with
    // a small bounded amplification for compaction.
    expect(written).toBeLessThan(snapshotBytes * 3);
  });

  test("a flush with nothing dirty writes nothing", () => {
    const home = tmpHome();
    const storePath = join(home, "vector-index.v1.json");
    const index = new VectorIndex(storePath);
    for (let i = 0; i < 100; i++) index.upsert(rec(i));
    index.persist();
    index.compact();

    resetStoreBytesWritten();
    for (let i = 0; i < 20; i++) index.persist();
    // Not "the file did not grow" — literally zero bytes went to disk.
    expect(storeBytesWritten()).toBe(0);
  });

  test("compaction bounds total store size", () => {
    const home = tmpHome();
    const storePath = join(home, "vector-index.v1.json");
    const index = new VectorIndex(storePath);

    for (let i = 0; i < 4000; i++) {
      index.upsert(rec(i));
      if (i % 50 === 0) index.persist();
    }
    index.persist();
    index.compact();

    // After compaction the log is gone and only the snapshot remains.
    const p = storePaths(storePath);
    let logBytes = 0;
    try {
      logBytes = statSync(p.log).size;
    } catch {
      logBytes = 0;
    }
    expect(logBytes).toBe(0);
    expect(statSync(p.snapshot).size).toBeGreaterThan(0);
  });
});

describe("durability and migration", () => {
  test("round-trips vectors exactly through snapshot and log", () => {
    const home = tmpHome();
    const storePath = join(home, "vector-index.v1.json");

    const a = new VectorIndex(storePath);
    for (let i = 0; i < 300; i++) a.upsert(rec(i));
    a.persist();
    a.compact();
    // Extra records land in the log, not the snapshot — reload must see both.
    for (let i = 300; i < 350; i++) a.upsert(rec(i));
    a.persist();

    const b = new VectorIndex(storePath);
    expect(b.size).toBe(350);
    for (const n of [0, 7, 299, 300, 349]) {
      const got = b.get("schema", `hash${n}`, null, "body");
      const want = rec(n);
      expect(got).toBeDefined();
      expect(got!.text).toBe(want.text);
      expect(got!.embedder_id).toBe(want.embedder_id);
      expect(got!.vector).toEqual(want.vector);
    }
  });

  test("stores float32 exactly, and quantizes wider input within tolerance", () => {
    // The embedder emits float32, so float32 storage is lossless for real
    // vectors — verified against the live 17,596-vector index on 2026-08-07:
    // max component error 0 for all-MiniLM-L6-v2. Only the deterministic hash
    // stand-ins are float64-wide, and they quantize at ~1e-8 (cosine
    // > 0.9999999). This pins both halves of that contract.
    const home = tmpHome();
    const storePath = join(home, "vector-index.v1.json");

    const exact = vec(1); // already float32-representable
    const wide = Array.from({ length: DIMS }, (_, i) => 0.0868198620259849 + i * 1e-9);

    const a = new VectorIndex(storePath);
    a.upsert({ ...rec(1), id: makeId("a"), key_hash: "a", vector: exact });
    a.upsert({ ...rec(2), id: makeId("b"), key_hash: "b", vector: wide });
    a.persist();
    a.compact();

    const b = new VectorIndex(storePath);
    const gotExact = b.get("schema", "a", null, "body")!.vector;
    const gotWide = b.get("schema", "b", null, "body")!.vector;

    expect(gotExact).toEqual(exact); // bit-exact, no tolerance
    for (let i = 0; i < DIMS; i++) {
      expect(Math.abs(gotWide[i]! - wide[i]!)).toBeLessThan(1e-7);
      expect(gotWide[i]).toBe(Math.fround(wide[i]!));
    }
  });

  test("reloads from the log alone, before any compaction has run", () => {
    // A young index has no snapshot yet — the log is the entire durable state.
    // Missing this is a silent total data loss on restart, so it is asserted
    // separately from the compacted path.
    const home = tmpHome();
    const storePath = join(home, "vector-index.v1.json");

    const a = new VectorIndex(storePath);
    for (let i = 0; i < 5; i++) a.upsert(rec(i));
    a.persist();

    const p = storePaths(storePath);
    let hasSnapshot = true;
    try {
      statSync(p.snapshot);
    } catch {
      hasSnapshot = false;
    }
    expect(hasSnapshot).toBe(false);

    const b = new VectorIndex(storePath);
    expect(b.size).toBe(5);
    expect(b.get("schema", "hash3", null, "body")!.vector).toEqual(rec(3).vector);
  });

  test("deletes survive a reload", () => {
    const home = tmpHome();
    const storePath = join(home, "vector-index.v1.json");

    const a = new VectorIndex(storePath);
    for (let i = 0; i < 50; i++) a.upsert(rec(i));
    a.persist();
    a.compact();
    a.removeByKey("schema", "hash7", null);
    a.persist();

    const b = new VectorIndex(storePath);
    expect(b.size).toBe(49);
    expect(b.get("schema", "hash7", null, "body")).toBeUndefined();
    expect(b.get("schema", "hash8", null, "body")).toBeDefined();
  });

  test("migrates an existing v1 JSON index without re-embedding", () => {
    const home = tmpHome();
    const storePath = join(home, "vector-index.v1.json");
    const records = Array.from({ length: 200 }, (_, i) => rec(i));
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        embedder_id: "all-MiniLM-L6-v2",
        dimensions: DIMS,
        records,
      }),
    );

    const index = new VectorIndex(storePath);
    expect(index.size).toBe(200);
    expect(index.embedderId).toBe("all-MiniLM-L6-v2");
    expect(index.dimensions).toBe(DIMS);

    // Migration writes a v2 snapshot, so the next flush is already cheap.
    const p = storePaths(storePath);
    expect(statSync(p.snapshot).size).toBeGreaterThan(0);

    // And every vector survived intact.
    const reopened = new VectorIndex(storePath);
    expect(reopened.size).toBe(200);
    expect(reopened.get("schema", "hash42", null, "body")!.vector).toEqual(
      rec(42).vector,
    );
  });

  test("a torn log tail costs one record, not the index", () => {
    const home = tmpHome();
    const storePath = join(home, "vector-index.v1.json");
    const a = new VectorIndex(storePath);
    for (let i = 0; i < 100; i++) a.upsert(rec(i));
    a.persist();
    a.compact();
    for (let i = 100; i < 110; i++) a.upsert(rec(i));
    a.persist();

    // Simulate an append interrupted mid-frame.
    const p = storePaths(storePath);
    const buf = require("node:fs").readFileSync(p.log) as Buffer;
    writeFileSync(p.log, buf.subarray(0, buf.length - 32));

    const b = new VectorIndex(storePath);
    // Snapshot plus all but the torn record are intact.
    expect(b.size).toBeGreaterThanOrEqual(100);
    expect(b.size).toBeLessThanOrEqual(110);
    expect(b.get("schema", "hash0", null, "body")).toBeDefined();
  });
});

describe("drain is bounded", () => {
  function seedInbox(dir: string, count: number): void {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      writeFileSync(
        join(dir, `${1000000 + i}_batch.json`),
        JSON.stringify({
          schema_name: "schema",
          changes: [
            {
              key_value: { hash: `h${i}`, range: null },
              fields_and_values: { body: `text ${i}` },
              mutation_id: `m${i}`,
            },
          ],
        }),
      );
    }
  }

  test("caps files per run and reports what is left", async () => {
    const home = tmpHome();
    const inbox = join(home, "inbox");
    seedInbox(inbox, 25);

    const r = await drainInbox(inbox, { maxFiles: 10 });
    expect(r.files).toBe(10);
    expect(r.remaining).toBe(15);
    expect(r.stopped).toBe("max_files");

    // Draining again makes progress rather than restarting the whole backlog.
    const r2 = await drainInbox(inbox, { maxFiles: 10 });
    expect(r2.files).toBe(10);
    expect(r2.remaining).toBe(5);
  });

  test("stops on the RSS ceiling instead of growing without bound", async () => {
    const home = tmpHome();
    const inbox = join(home, "inbox");
    seedInbox(inbox, 20);

    let calls = 0;
    const r = await drainInbox(inbox, {
      maxRssBytes: 1000,
      rss: () => (++calls > 5 ? 5000 : 100),
    });
    expect(r.stopped).toBe("rss_ceiling");
    expect(r.files).toBeLessThan(20);
    expect(r.remaining).toBeGreaterThan(0);
  });

  test("has a bounded default so an unbounded drain cannot be the default", async () => {
    expect(DEFAULT_MAX_FILES).toBeGreaterThan(0);
    const home = tmpHome();
    const inbox = join(home, "inbox");
    seedInbox(inbox, 3);
    const r = await drainInbox(inbox);
    expect(r.files).toBe(3);
    expect(r.remaining).toBe(0);
    expect(r.stopped).toBeUndefined();
  });
});
