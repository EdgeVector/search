import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicMiniLmCompatEmbedder } from "../src/vector/deterministic.ts";
import {
  fieldIsIndexable,
  selectIndexableFields,
} from "../src/vector/field_policy.ts";
import { SemanticSearchPlane } from "../src/vector/plane.ts";
import { VectorIndex } from "../src/vector/vector_index.ts";
import { MINILM_L6_V2_DIMS } from "../src/vector/embedder.ts";
import { applyBatchBoth, openSearchSession } from "../src/semantic.ts";
import type { IndexChangeBatch } from "../src/types.ts";
import { createProgressReporter, silentProgress } from "../src/progress.ts";

describe("field_policy", () => {
  test("excludes secret and no_index; requires word when classifications present", () => {
    expect(fieldIsIndexable(["word"])).toBe(true);
    expect(fieldIsIndexable(["word", "title"])).toBe(true);
    expect(fieldIsIndexable(["secret"])).toBe(false);
    expect(fieldIsIndexable(["word", "secret"])).toBe(false);
    expect(fieldIsIndexable(["no_index"])).toBe(false);
    expect(fieldIsIndexable(["no-index"])).toBe(false);
    expect(fieldIsIndexable(undefined)).toBe(true);
  });

  test("selectIndexableFields drops secret body", () => {
    const fields = selectIndexableFields(
      { title: "hello", body: "secret-body", tags: "a" },
      ["title", "body", "tags"],
      {
        title: ["word"],
        body: ["secret"],
        tags: ["word"],
      },
    );
    expect(fields.title).toBe("hello");
    expect(fields.tags).toBe("a");
    expect(fields.body).toBeUndefined();
  });
});

describe("DeterministicMiniLmCompatEmbedder", () => {
  test("dimensions match all-MiniLM-L6-v2 (384)", async () => {
    const e = new DeterministicMiniLmCompatEmbedder();
    expect(e.dimensions).toBe(MINILM_L6_V2_DIMS);
    const [v] = await e.embed(["alpha beta gamma"]);
    expect(v!.length).toBe(384);
    const norm = Math.sqrt(v!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe("VectorIndex structural schema scope", () => {
  test("scoped query never returns out-of-schema hits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vec-scope-"));
    const emb = new DeterministicMiniLmCompatEmbedder();
    const idx = new VectorIndex(join(dir, "v.json"));
    await idx.indexText(emb, {
      schema_name: "schema-A",
      key_hash: "a1",
      key_range: null,
      text: "unique-aardvark-token-xyz for schema A only",
    });
    await idx.indexText(emb, {
      schema_name: "schema-B",
      key_hash: "b1",
      key_range: null,
      text: "unique-aardvark-token-xyz also in schema B document",
    });
    idx.persist();

    const scoped = await idx.semanticSearch(emb, "unique-aardvark-token-xyz", {
      k: 10,
      schemas: ["schema-A"],
    });
    expect(scoped.length).toBeGreaterThanOrEqual(1);
    for (const h of scoped) {
      expect(h.schema_name).toBe("schema-A");
    }

    const other = await idx.semanticSearch(emb, "unique-aardvark-token-xyz", {
      k: 10,
      schemas: ["schema-B"],
    });
    expect(other.length).toBeGreaterThanOrEqual(1);
    for (const h of other) {
      expect(h.schema_name).toBe("schema-B");
    }
  });

  test("min_score and exact filters apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vec-filt-"));
    const emb = new DeterministicMiniLmCompatEmbedder();
    const idx = new VectorIndex(join(dir, "v.json"));
    await idx.indexText(emb, {
      schema_name: "S",
      key_hash: "k1",
      key_range: null,
      text: "the quick brown fox jumps",
    });
    const high = await idx.semanticSearch(emb, "quick brown fox", {
      k: 5,
      min_score: 0.01,
    });
    expect(high.length).toBeGreaterThanOrEqual(1);
    const exactMiss = await idx.semanticSearch(emb, "quick brown fox", {
      k: 5,
      exact: true,
    });
    // query string must appear as substring — "quick brown fox" is in text
    expect(exactMiss.some((h) => h.text.includes("quick brown fox"))).toBe(true);
    const exactFail = await idx.semanticSearch(emb, "NOTEXISTINGSUBSTRING99", {
      k: 5,
      exact: true,
    });
    expect(exactFail).toEqual([]);
  });
});

describe("progress reporter", () => {
  test("silent and quiet reporters are no-ops", () => {
    const s = silentProgress();
    s.startPhase("x", 10);
    s.tick({ phase: "x", done: 1, total: 10 });
    s.finish("ok");
    const q = createProgressReporter({ quiet: true });
    q.startPhase("y", 1);
    q.tick({ phase: "y", done: 1, total: 1 });
    q.finish();
  });
});

describe("resumable indexPlainDocs", () => {
  test("second pass skips fresh vectors and re-embed only on text change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-"));
    const emb = new DeterministicMiniLmCompatEmbedder();
    const plane = new SemanticSearchPlane({
      searchHome: dir,
      embedder: emb,
      healthDetail: "test",
    });
    const docs = [
      {
        schema_name: "S",
        key_hash: "k1",
        key_range: null as string | null,
        text: "resume-marker-alpha-111",
        mutation_id: "m1",
      },
      {
        schema_name: "S",
        key_hash: "k2",
        key_range: null as string | null,
        text: "resume-marker-beta-222",
        mutation_id: "m2",
      },
    ];
    const first = await plane.indexPlainDocs(docs, { flushEvery: 1 });
    expect(first.embedded).toBe(2);
    expect(first.skipped).toBe(0);
    expect(first.flushes).toBeGreaterThanOrEqual(1);
    expect(plane.health().vectors).toBe(2);

    const second = await plane.indexPlainDocs(docs, { flushEvery: 1 });
    expect(second.embedded).toBe(0);
    expect(second.skipped).toBe(2);

    const changed = await plane.indexPlainDocs(
      [
        {
          ...docs[0]!,
          text: "resume-marker-alpha-111-CHANGED",
          mutation_id: "m1b",
        },
        docs[1]!,
      ],
      { flushEvery: 1 },
    );
    expect(changed.embedded).toBe(1);
    expect(changed.skipped).toBe(1);

    // force re-embeds even when fresh
    const forced = await plane.indexPlainDocs(docs, { force: true, flushEvery: 10 });
    expect(forced.embedded).toBe(2);
    expect(forced.skipped).toBe(0);
  });

  test("persist mid-run so reopen loads progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-disk-"));
    const emb = new DeterministicMiniLmCompatEmbedder();
    const path = join(dir, "vector-index.v1.json");
    const plane1 = new SemanticSearchPlane({
      searchHome: dir,
      vectorStorePath: path,
      embedder: emb,
    });
    await plane1.indexPlainDocs(
      [
        {
          schema_name: "S",
          key_hash: "p1",
          key_range: null,
          text: "persist-checkpoint-doc-one",
          mutation_id: "p1",
        },
      ],
      { flushEvery: 1 },
    );
    const plane2 = new SemanticSearchPlane({
      searchHome: dir,
      vectorStorePath: path,
      embedder: new DeterministicMiniLmCompatEmbedder(),
    });
    const r = await plane2.indexPlainDocs(
      [
        {
          schema_name: "S",
          key_hash: "p1",
          key_range: null,
          text: "persist-checkpoint-doc-one",
          mutation_id: "p1",
        },
        {
          schema_name: "S",
          key_hash: "p2",
          key_range: null,
          text: "persist-checkpoint-doc-two",
          mutation_id: "p2",
        },
      ],
      { flushEvery: 1 },
    );
    expect(r.skipped).toBe(1);
    expect(r.embedded).toBe(1);
    expect(plane2.health().vectors).toBe(2);
  });
});

describe("SemanticSearchPlane health + apply", () => {
  test("health transitions to healthy and reports vectors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plane-"));
    const emb = new DeterministicMiniLmCompatEmbedder();
    const plane = new SemanticSearchPlane({
      searchHome: dir,
      embedder: emb,
      healthDetail: "test",
    });
    expect(plane.health().state).toBe("healthy");
    await plane.ensureReady();
    const batch: IndexChangeBatch = {
      schema_name: "fbrain/Concept",
      searchable_fields: ["title", "body"],
      changes: [
        {
          mutation_id: "m1",
          kind: "upsert",
          key_value: { hash: "concept-vector-1", range: null },
          fields_and_values: {
            title: "vector plane",
            body: "distinctive-semantic-phrase-zz9",
          },
        },
      ],
    };
    const n = await plane.applyBatch(batch);
    expect(n).toBe(1);
    const h = plane.health();
    expect(h.state).toBe("healthy");
    expect(h.vectors).toBe(1);
    expect(h.dimensions).toBe(384);
    const hits = await plane.query("distinctive-semantic-phrase-zz9", { k: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.key_hash).toBe("concept-vector-1");
  });
});

describe("session applyBatchBoth", () => {
  test("keyword + semantic both index the same batch", async () => {
    const home = mkdtempSync(join(tmpdir(), "sess-"));
    process.env.SEARCH_HOME = home;
    process.env.SEARCH_EMBEDDER = "deterministic";
    try {
      const session = openSearchSession({
        embedder: new DeterministicMiniLmCompatEmbedder(),
      });
      const marker = `sess-marker-${Date.now()}-qq`;
      const batch: IndexChangeBatch = {
        schema_name: "fkanban/Card",
        searchable_fields: ["title", "body"],
        changes: [
          {
            mutation_id: "m2",
            kind: "upsert",
            key_value: { hash: "card-1", range: null },
            fields_and_values: { title: "t", body: marker },
          },
        ],
      };
      const r = await applyBatchBoth(session, batch);
      expect(r.keyword).toBe(1);
      expect(r.semantic).toBe(1);
      const sem = await session.semantic.query(marker, { k: 3 });
      expect(sem.length).toBeGreaterThanOrEqual(1);
      expect(sem[0]!.schema_name).toBe("fkanban/Card");
    } finally {
      delete process.env.SEARCH_HOME;
      delete process.env.SEARCH_EMBEDDER;
    }
  });
});
