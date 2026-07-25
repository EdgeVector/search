/**
 * LastStore-backed persist + cold rebuild tests.
 * Requires `cargo build -p search-store` (ci.sh builds it first).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openSearchEngine,
  resolveSearchStoreBin,
  resolveLastStorePath,
} from "../src/engine.ts";
import type { IndexChangeBatch } from "../src/types.ts";

const UNIQUE = `ls-fixture-${Date.now()}-aabb`;

function batch(text: string, hash = "pref-1"): IndexChangeBatch {
  return {
    schema_name: "fbrain/Preference",
    searchable_fields: ["title", "body"],
    changes: [
      {
        mutation_id: "m1",
        kind: "upsert",
        key_value: { hash, range: null },
        fields_and_values: { title: "t", body: text },
      },
    ],
  };
}

describe("LastStore Search index", () => {
  test("search-store binary is available for durable LastStore path", () => {
    const bin = resolveSearchStoreBin();
    expect(bin).not.toBeNull();
  });

  test("apply then reopen finds distinctive string via LastStore", () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-eng-"));
    const indexDir = join(dir, "index");
    mkdirSync(indexDir, { recursive: true });
    {
      const eng = openSearchEngine(indexDir);
      expect(eng.backend).toBe("laststore");
      eng.applyChangeBatch(batch(UNIQUE));
      eng.persist();
      expect(eng.search(UNIQUE).length).toBeGreaterThanOrEqual(1);
    }
    // Reopen — memory empty; must load hits from LastStore.
    const eng2 = openSearchEngine(indexDir);
    const hits = eng2.search(UNIQUE, { k: 10 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.text).toContain(UNIQUE);
    const lsPath = resolveLastStorePath(indexDir);
    expect(lsPath.includes("laststore")).toBe(true);
  });

  test("cold rebuild from batches dir then query", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-rebuild-"));
    const indexDir = join(root, "index");
    const batchesDir = join(root, "batches");
    mkdirSync(indexDir, { recursive: true });
    mkdirSync(batchesDir, { recursive: true });
    const marker = `cold-rebuild-${Date.now()}-zz9`;
    writeFileSync(join(batchesDir, "001.json"), JSON.stringify(batch(marker, "c1")));
    writeFileSync(
      join(batchesDir, "002.json"),
      JSON.stringify(batch("noise-other-doc", "c2")),
    );

    const eng = openSearchEngine(indexDir);
    // Empty plane
    expect(eng.search(marker).length).toBe(0);

    const report = eng.rebuildFromBatches(
      [
        batch(marker, "c1"),
        batch("noise-other-doc", "c2"),
      ],
      true,
    );
    expect(report.batches).toBe(2);
    expect(report.docs).toBeGreaterThanOrEqual(1);

    const hits = eng.search(marker);
    expect(hits.some((h) => h.text.includes(marker))).toBe(true);

    // Reopen after cold rebuild
    const eng2 = openSearchEngine(indexDir);
    expect(eng2.search(marker).some((h) => h.text.includes(marker))).toBe(true);
  });
});
