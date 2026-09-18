import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { isProductionSearchHome } from "../src/paths.ts";
import { DeterministicMiniLmCompatEmbedder } from "../src/vector/deterministic.ts";
import {
  fieldIsIndexable,
  selectIndexableFields,
} from "../src/vector/field_policy.ts";
import { SemanticSearchPlane } from "../src/vector/plane.ts";
import { VectorIndex } from "../src/vector/vector_index.ts";
import { MINILM_L6_V2_DIMS } from "../src/vector/embedder.ts";
import { applyBatch, onlineBackfill, openSearchSession } from "../src/semantic.ts";
import type { IndexChangeBatch } from "../src/types.ts";
import { createProgressReporter } from "../src/progress.ts";
import { drainInbox } from "../src/inbox.ts";
import {
  defaultLiveBackfillCheckpointPath,
  type LiveBackfillSource,
} from "../src/live_backfill.ts";
import { runSearchDoctor } from "../src/doctor.ts";

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
    const s = createProgressReporter({ quiet: true });
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

describe("onlineBackfill live source", () => {
  test("pages a live source, checkpoints cursor, and resumes idempotently", async () => {
    const home = mkdtempSync(join(tmpdir(), "live-backfill-"));
    const checkpoint = join(home, "checkpoint.json");
    process.env.SEARCH_HOME = home;
    process.env.SEARCH_EMBEDDER = "deterministic";
    try {
      const pageCursors: Array<string | null> = [];
      const source: LiveBackfillSource = {
        id: "fake-live",
        async listPage({ cursor }) {
          pageCursors.push(cursor);
          if (cursor === null) {
            return {
              records: [
                {
                  schema_name: "brain/Concept",
                  key_hash: "concept-live-1",
                  mutation_id: "m-live-1",
                  searchable_fields: ["title", "body", "secret"],
                  classifications: {
                    title: ["word"],
                    body: ["word"],
                    secret: ["secret"],
                  },
                  fields_and_values: {
                    title: "live alpha",
                    body: "needle-live-alpha",
                    secret: "do-not-index-secret-marker",
                  },
                },
              ],
              next_cursor: "page-2",
              total: 2,
            };
          }
          return {
            records: [
              {
                schema_name: "fkanban/Card",
                key_hash: "card-live-2",
                mutation_id: "m-live-2",
                searchable_fields: ["title", "body"],
                classifications: {
                  title: ["word"],
                  body: ["no_index"],
                },
                fields_and_values: {
                  title: "live beta",
                  body: "do-not-index-noindex-marker",
                },
              },
            ],
            next_cursor: null,
            total: 2,
          };
        },
      };

      const session1 = openSearchSession({
        embedder: new DeterministicMiniLmCompatEmbedder(),
      });
      const first = await onlineBackfill(session1, {
        liveSource: source,
        liveCheckpointFile: checkpoint,
        maxLivePages: 1,
        flushEvery: 1,
        progress: createProgressReporter({ quiet: true }),
      });
      expect(first.live?.live_completed).toBe(false);
      expect(first.live?.live_records).toBe(1);
      expect(pageCursors).toEqual([null]);

      const session2 = openSearchSession({
        embedder: new DeterministicMiniLmCompatEmbedder(),
      });
      const second = await onlineBackfill(session2, {
        liveSource: source,
        liveCheckpointFile: checkpoint,
        flushEvery: 1,
        progress: createProgressReporter({ quiet: true }),
      });
      expect(second.live?.live_completed).toBe(true);
      expect(second.live?.live_records).toBe(1);
      expect(pageCursors).toEqual([null, "page-2"]);

      const hits = await session2.semantic.query("needle-live-alpha", { k: 5 });
      expect(hits.some((h) => h.key_hash === "concept-live-1")).toBe(true);
      const secretHits = await session2.semantic.query("do-not-index-secret-marker", {
        k: 5,
        exact: true,
      });
      expect(secretHits).toEqual([]);
      const noIndexHits = await session2.semantic.query(
        "do-not-index-noindex-marker",
        { k: 5, exact: true },
      );
      expect(noIndexHits).toEqual([]);

      const third = await onlineBackfill(session2, {
        liveSource: source,
        liveCheckpointFile: checkpoint,
        progress: createProgressReporter({ quiet: true }),
      });
      expect(third.live?.live_pages).toBe(0);
    } finally {
      delete process.env.SEARCH_HOME;
      delete process.env.SEARCH_EMBEDDER;
    }
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

describe("session semantic-only apply + drain", () => {
  test("applyBatch indexes semantic only", async () => {
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
      const r = await applyBatch(session, batch);
      expect(r.semantic).toBe(1);
      const sem = await session.semantic.query(marker, { k: 3 });
      expect(sem.length).toBeGreaterThanOrEqual(1);
      expect(sem[0]!.schema_name).toBe("fkanban/Card");
    } finally {
      delete process.env.SEARCH_HOME;
      delete process.env.SEARCH_EMBEDDER;
    }
  });

  test("drainInbox applies batches to semantic plane", async () => {
    const home = mkdtempSync(join(tmpdir(), "drain-sem-"));
    const inbox = join(home, "inbox");
    mkdirSync(inbox, { recursive: true });
    process.env.SEARCH_HOME = home;
    process.env.SEARCH_EMBEDDER = "deterministic";
    try {
      const session = openSearchSession({
        embedder: new DeterministicMiniLmCompatEmbedder(),
      });
      const marker = `drain-sem-${Date.now()}`;
      writeFileSync(
        join(inbox, "b1.json"),
        JSON.stringify({
          schema_name: "S",
          searchable_fields: ["body"],
          changes: [
            {
              mutation_id: "d1",
              kind: "upsert",
              key_value: { hash: "h1", range: null },
              fields_and_values: { body: marker },
            },
          ],
        }),
      );
      const r = await drainInbox(inbox, {
        onBatch: async (b) => {
          await session.semantic.applyBatch(b);
        },
      });
      expect(r.files).toBe(1);
      const hits = await session.semantic.query(marker, { k: 3 });
      expect(hits.length).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.SEARCH_HOME;
      delete process.env.SEARCH_EMBEDDER;
    }
  });

  test("query drains fresh inbox batches before returning hits", async () => {
    const home = mkdtempSync(join(tmpdir(), "query-drain-sem-"));
    const inbox = join(home, "apps", "search", "inbox");
    mkdirSync(inbox, { recursive: true });
    const session = openSearchSession({
      lastDbHome: home,
      embedder: new DeterministicMiniLmCompatEmbedder(),
    });
    const marker = `query-drain-${Date.now()}`;
    writeFileSync(
      join(inbox, "fresh.json"),
      JSON.stringify({
        schema_name: "S",
        searchable_fields: ["body"],
        changes: [
          {
            mutation_id: "q1",
            kind: "upsert",
            key_value: { hash: "query-h1", range: null },
            fields_and_values: { body: marker },
          },
        ],
      }),
    );

    const hits = await session.semantic.query(marker, { k: 3 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.key_hash).toBe("query-h1");
  });
});

describe("search doctor", () => {
  test("reports healthy model and configured clients", async () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-ok-"));
    const session = openSearchSession({
      lastDbHome: home,
      embedder: new DeterministicMiniLmCompatEmbedder(),
    });
    await session.semantic.indexPlainDocs(
      [
        {
          schema_name: "S",
          key_hash: "ok",
          key_range: null,
          text: "doctor healthy vector",
        },
      ],
      { flushEvery: 1 },
    );
    const checkpoint = defaultLiveBackfillCheckpointPath(session.paths);
    writeFileSync(
      checkpoint,
      JSON.stringify({
        version: 1,
        source_id: "fake-live",
        cursor: null,
        completed: true,
        updated_at: new Date(0).toISOString(),
      }),
    );
    const liveSource: LiveBackfillSource = {
      id: "fake-live",
      async listPage() {
        return { records: [], next_cursor: null, total: 0 };
      },
    };
    const report = await runSearchDoctor({
      session,
      liveSource,
      env: {
        BRAIN_SEARCH_URL: "http://search.local",
        FKANBAN_SEARCH_URL: "http://search.local",
      },
      now: () => new Date(0),
    });
    expect(report.status).toBe("healthy");
    expect(report.checks.find((c) => c.name === "vector_index")?.level).toBe("ok");
    expect(report.checks.find((c) => c.name === "lastdb_live_backfill")?.level).toBe("ok");
  });

  test("reports missing model as degraded", async () => {
    const old = process.env.SEARCH_EMBEDDER;
    process.env.SEARCH_EMBEDDER = "not-a-model";
    try {
      const home = mkdtempSync(join(tmpdir(), "doctor-model-"));
      const session = openSearchSession({ lastDbHome: home });
      const report = await runSearchDoctor({
        session,
        env: {},
        now: () => new Date(0),
      });
      const model = report.checks.find((c) => c.name === "fastembed_model");
      expect(report.status).toBe("degraded");
      expect(model?.level).toBe("error");
      expect(String(model?.detail?.detail ?? "")).toContain("Unknown SEARCH_EMBEDDER");
    } finally {
      if (old === undefined) delete process.env.SEARCH_EMBEDDER;
      else process.env.SEARCH_EMBEDDER = old;
    }
  });

  test("reports empty index and in-progress backfill checkpoint", async () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-empty-"));
    process.env.SEARCH_HOME = home;
    process.env.SEARCH_EMBEDDER = "deterministic";
    try {
      const session = openSearchSession();
      writeFileSync(
        defaultLiveBackfillCheckpointPath(session.paths),
        JSON.stringify({
          version: 1,
          source_id: "fake-live",
          cursor: "next-page",
          completed: false,
          updated_at: new Date(0).toISOString(),
        }),
      );
      const report = await runSearchDoctor({
        session,
        env: {},
        now: () => new Date(0),
      });
      expect(report.status).toBe("healthy");
      expect(report.checks.find((c) => c.name === "vector_index")?.level).toBe("warn");
      expect(report.checks.find((c) => c.name === "online_backfill")?.summary).toContain("in progress");
    } finally {
      delete process.env.SEARCH_HOME;
      delete process.env.SEARCH_EMBEDDER;
    }
  });

  test("reports unavailable live daemon as degraded", async () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-down-"));
    const session = openSearchSession({
      lastDbHome: home,
      embedder: new DeterministicMiniLmCompatEmbedder(),
    });
    const liveSource: LiveBackfillSource = {
      id: "down",
      async listPage() {
        throw new Error("connection refused");
      },
    };
    const report = await runSearchDoctor({
      session,
      liveSource,
      env: {},
      now: () => new Date(0),
    });
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "lastdb_live_backfill")?.level).toBe("error");
  });

  test("reports undrained inbox backlog above the error floor as degraded", async () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-backlog-"));
    const session = openSearchSession({
      lastDbHome: home,
      embedder: new DeterministicMiniLmCompatEmbedder(),
    });
    mkdirSync(session.paths.inbox, { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(session.paths.inbox, `b${i}.json`), "{}");
    }
    const report = await runSearchDoctor({
      session,
      env: { SEARCH_INBOX_WARN_DEPTH: "1", SEARCH_INBOX_ERROR_DEPTH: "2" },
      now: () => new Date(0),
    });
    const backlog = report.checks.find((c) => c.name === "inbox_backlog");
    expect(report.status).toBe("degraded");
    expect(backlog?.level).toBe("error");
    expect(backlog?.detail?.pending).toBe(3);
  });

  test("reports inbox backlog below the warn floor as ok", async () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-backlog-ok-"));
    const session = openSearchSession({
      lastDbHome: home,
      embedder: new DeterministicMiniLmCompatEmbedder(),
    });
    const report = await runSearchDoctor({
      session,
      env: {},
      now: () => new Date(0),
    });
    const backlog = report.checks.find((c) => c.name === "inbox_backlog");
    expect(backlog?.level).toBe("ok");
    expect(backlog?.detail?.pending).toBe(0);
  });
});

describe("deterministic embedder cannot reach the production index home", () => {
  // The real ~/.lastdb/apps/search path — constructed the same way
  // isProductionSearchHome does, but I/O below always targets a tmpdir
  // storePath, so these tests never touch a real user's LastDB data.
  const prodHome = join(homedir(), ".lastdb", "apps", "search");

  test("isProductionSearchHome matches only the real home, not overrides", () => {
    expect(isProductionSearchHome(prodHome)).toBe(true);
    expect(isProductionSearchHome(join(prodHome, ""))).toBe(true);
    expect(isProductionSearchHome(mkdtempSync(join(tmpdir(), "not-prod-")))).toBe(
      false,
    );
    expect(isProductionSearchHome(join(homedir(), ".lastdb", "apps", "other"))).toBe(
      false,
    );
  });

  test("VectorIndex.indexText refuses a deterministic write against the production home", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "vec-prod-guard-"));
    const idx = new VectorIndex(join(storeDir, "v.json"), prodHome);
    const emb = new DeterministicMiniLmCompatEmbedder();
    await expect(
      idx.indexText(emb, {
        schema_name: "schema-A",
        key_hash: "a1",
        key_range: null,
        text: "should never be written",
      }),
    ).rejects.toThrow(/production/i);
    expect(idx.size).toBe(0);
  });

  test("VectorIndex.indexText allows a deterministic write against a non-production home", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "vec-nonprod-"));
    const idx = new VectorIndex(join(storeDir, "v.json"), storeDir);
    const emb = new DeterministicMiniLmCompatEmbedder();
    const action = await idx.indexText(emb, {
      schema_name: "schema-A",
      key_hash: "a1",
      key_range: null,
      text: "fine in tests",
    });
    expect(action).toBe("embedded");
    expect(idx.size).toBe(1);
  });

  test("SemanticSearchPlane refuses to go healthy on deterministic mode against the production home", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "plane-prod-guard-"));
    process.env.SEARCH_EMBEDDER = "deterministic";
    try {
      const plane = new SemanticSearchPlane({
        searchHome: prodHome,
        vectorStorePath: join(storeDir, "v.json"),
      });
      await plane.ensureReady();
      const health = plane.health();
      expect(health.state).toBe("degraded");
      expect(health.detail).toMatch(/production/i);
      const applied = await plane.applyBatch({
        schema_name: "schema-A",
        searchable_fields: ["body"],
        changes: [
          {
            kind: "upsert",
            key_value: { hash: "a1", range: null },
            mutation_id: "m1",
            fields_and_values: { body: "must not be written" },
          },
        ],
      });
      expect(applied).toBe(0);
      expect(plane.index.size).toBe(0);
    } finally {
      delete process.env.SEARCH_EMBEDDER;
    }
  });
});
