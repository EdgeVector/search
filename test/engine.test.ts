import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSearchEngine } from "../src/engine.ts";
import { drainInbox } from "../src/inbox.ts";
import type { IndexChangeBatch } from "../src/types.ts";

const UNIQUE = `search-fixture-${Date.now()}-zxq9`;

function batch(text: string, schema = "fbrain/Preference"): IndexChangeBatch {
  return {
    schema_name: schema,
    searchable_fields: ["title", "body"],
    changes: [
      {
        mutation_id: "mut-1",
        kind: "upsert",
        key_value: { hash: "pref-fixture-1", range: null },
        fields_and_values: {
          title: "fixture preference",
          body: text,
        },
      },
    ],
  };
}

describe("SearchEngine fixture round-trip", () => {
  test("applyChangeBatch then search finds distinctive string", () => {
    const dir = mkdtempSync(join(tmpdir(), "search-eng-"));
    const eng = openSearchEngine(dir);
    const applied = eng.applyChangeBatch(batch(UNIQUE));
    expect(applied).toBe(1);
    eng.persist();

    const hits = eng.search(UNIQUE, { k: 10 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.text).toContain(UNIQUE);
    expect(hits[0]!.schema_name).toBe("fbrain/Preference");
    expect(hits[0]!.key_hash).toBe("pref-fixture-1");
  });

  test("tombstone removes document from search", () => {
    const dir = mkdtempSync(join(tmpdir(), "search-tomb-"));
    const eng = openSearchEngine(dir);
    eng.applyChangeBatch(batch(UNIQUE));
    eng.applyChangeBatch({
      schema_name: "fbrain/Preference",
      changes: [
        {
          mutation_id: "mut-del",
          kind: "tombstone",
          key_value: { hash: "pref-fixture-1", range: null },
        },
      ],
    });
    eng.persist();
    expect(eng.search(UNIQUE)).toEqual([]);
  });

  test("drainInbox applies host outbox files then query hits", () => {
    const root = mkdtempSync(join(tmpdir(), "search-inbox-"));
    const inbox = join(root, "inbox");
    const indexDir = join(root, "index");
    mkdirSync(inbox, { recursive: true });
    mkdirSync(indexDir, { recursive: true });
    const marker = `inbox-marker-${Date.now()}-qwerty`;
    writeFileSync(
      join(inbox, "batch-001.json"),
      JSON.stringify(batch(marker, "fkanban/Card")),
    );
    const eng = openSearchEngine(indexDir);
    const drained = drainInbox(eng, inbox);
    expect(drained.files).toBe(1);
    expect(drained.changes).toBe(1);
    expect(drained.errors).toEqual([]);
    const hits = eng.search(marker);
    expect(hits.length).toBe(1);
    expect(hits[0]!.schema_name).toBe("fkanban/Card");
  });

  test("schema filter excludes other schemas", () => {
    const dir = mkdtempSync(join(tmpdir(), "search-filter-"));
    const eng = openSearchEngine(dir);
    eng.applyChangeBatch(batch(UNIQUE, "schema-a"));
    eng.applyChangeBatch(batch(UNIQUE, "schema-b"));
    const onlyA = eng.search(UNIQUE, { schemas: ["schema-a"] });
    expect(onlyA.every((h) => h.schema_name === "schema-a")).toBe(true);
    expect(onlyA.length).toBe(1);
  });
});
