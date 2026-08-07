import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeCoverage,
  computeEmbedderBreakdown,
  overallState,
  DEFAULT_COVERAGE_FLOOR,
} from "../src/coverage.ts";
import { isContentSchema } from "../src/vector/corpus_counts.ts";
import { inboxStatus } from "../src/inbox.ts";

const CORPUS = {
  "hash-reference": {
    descriptive_name: "Reference",
    owner_app_id: "fbrain",
    record_count: 1758,
  },
  "hash-papercut": {
    descriptive_name: "Papercut",
    owner_app_id: "fbrain",
    record_count: 576,
  },
  "hash-task": {
    descriptive_name: "Task",
    owner_app_id: "fbrain",
    record_count: 13,
  },
  "hash-recordlist": {
    descriptive_name: "RecordListEntry_hashrange_v2",
    owner_app_id: "fbrain",
    record_count: 9999,
  },
  "hash-untracked": {
    descriptive_name: "GoalRevision",
    owner_app_id: "dogfood-graph",
    record_count: 500,
  },
};

describe("isContentSchema", () => {
  test("excludes rollup/index/attachment bookkeeping schemas", () => {
    expect(isContentSchema("Reference")).toBe(true);
    expect(isContentSchema("Papercut")).toBe(true);
    expect(isContentSchema("RecordListEntry_hashrange_v2")).toBe(false);
    expect(isContentSchema("BoardCards_hashrange_v1")).toBe(false);
    expect(isContentSchema("CardListIndex")).toBe(false);
    expect(isContentSchema("BrainAttachmentBlob")).toBe(false);
    expect(isContentSchema("BrainAdminSnapshot")).toBe(false);
  });
});

describe("computeCoverage", () => {
  test("undrained state: whole-ledger schema at 0 vectors reports degraded — the regression witness", () => {
    // Matches the measured state that motivated this card: papercut and task
    // held zero vectors while reference sat far under floor.
    const report = computeCoverage(
      { "hash-reference": 255 },
      CORPUS,
    );
    expect(report.available).toBe(true);
    const papercut = report.by_schema.find((s) => s.schema_name === "hash-papercut");
    expect(papercut?.vectors).toBe(0);
    expect(papercut?.ratio).toBe(0);
    expect(papercut?.degraded).toBe(true);
    const task = report.by_schema.find((s) => s.schema_name === "hash-task");
    expect(task?.degraded).toBe(true);
    expect(report.degraded_schemas).toContain("hash-papercut");
    expect(report.degraded_schemas).toContain("hash-task");
    // Rollup/index and untracked-app schemas never appear in the table.
    expect(report.by_schema.some((s) => s.schema_name === "hash-recordlist")).toBe(false);
    expect(report.by_schema.some((s) => s.schema_name === "hash-untracked")).toBe(false);
  });

  test("a schema at 0% is degraded regardless of a lax floor", () => {
    const report = computeCoverage(
      { "hash-reference": 1758, "hash-papercut": 0, "hash-task": 13 },
      CORPUS,
      { floor: 0.01 },
    );
    const papercut = report.by_schema.find((s) => s.schema_name === "hash-papercut");
    expect(papercut?.degraded).toBe(true);
  });

  test("full coverage above floor reports healthy per-schema and in total", () => {
    const report = computeCoverage(
      { "hash-reference": 1758, "hash-papercut": 576, "hash-task": 13 },
      CORPUS,
      { floor: 0.95 },
    );
    expect(report.degraded_schemas).toEqual([]);
    expect(report.total.ratio).toBe(1);
  });

  test("unreachable schema catalog reports unavailable, not zero", () => {
    const report = computeCoverage({ "hash-reference": 255 }, null);
    expect(report.available).toBe(false);
    expect(report.total.ratio).toBeNull();
    expect(report.by_schema).toEqual([]);
  });
});

describe("computeEmbedderBreakdown", () => {
  test("flags any deterministic share as present", () => {
    const b = computeEmbedderBreakdown({
      "all-MiniLM-L6-v2": 100,
      "all-MiniLM-L6-v2+deterministic": 25,
    });
    expect(b.deterministic_vectors).toBe(25);
    expect(b.total_vectors).toBe(125);
    expect(b.deterministic_share).toBeCloseTo(0.2, 5);
  });

  test("zero deterministic vectors reports zero share", () => {
    const b = computeEmbedderBreakdown({ "all-MiniLM-L6-v2": 40 });
    expect(b.deterministic_share).toBe(0);
  });
});

describe("overallState", () => {
  test("degraded when total coverage sits under the floor", () => {
    const coverage = computeCoverage(
      { "hash-reference": 10 },
      { "hash-reference": CORPUS["hash-reference"] },
      { floor: DEFAULT_COVERAGE_FLOOR },
    );
    const state = overallState({
      vectorPlaneHealthy: true,
      coverage,
      embedder: computeEmbedderBreakdown({ "all-MiniLM-L6-v2": 10 }),
    });
    expect(state).toBe("degraded");
  });

  test("degraded when any content schema is starved even if total ratio looks fine", () => {
    // One huge fully-covered schema can mathematically hide a starved small
    // one from the total ratio — per-schema gating exists for exactly this.
    const coverage = computeCoverage(
      { "hash-reference": 1758, "hash-task": 0 },
      {
        "hash-reference": CORPUS["hash-reference"],
        "hash-task": { descriptive_name: "Task", owner_app_id: "fbrain", record_count: 1 },
      },
      { floor: 0.5 },
    );
    expect(coverage.total.ratio).toBeGreaterThan(0.99);
    const state = overallState({
      vectorPlaneHealthy: true,
      coverage,
      embedder: computeEmbedderBreakdown({ "all-MiniLM-L6-v2": 1758 }),
    });
    expect(state).toBe("degraded");
  });

  test("degraded when a nonzero deterministic share is present, even at full coverage", () => {
    const coverage = computeCoverage(
      { "hash-reference": 1758 },
      { "hash-reference": CORPUS["hash-reference"] },
      { floor: 0.95 },
    );
    const state = overallState({
      vectorPlaneHealthy: true,
      coverage,
      embedder: computeEmbedderBreakdown({
        "all-MiniLM-L6-v2": 1000,
        "all-MiniLM-L6-v2+deterministic": 758,
      }),
    });
    expect(state).toBe("degraded");
  });

  test("healthy when plane is healthy, coverage clears the floor, and no deterministic vectors exist", () => {
    const coverage = computeCoverage(
      { "hash-reference": 1758 },
      { "hash-reference": CORPUS["hash-reference"] },
      { floor: 0.95 },
    );
    const state = overallState({
      vectorPlaneHealthy: true,
      coverage,
      embedder: computeEmbedderBreakdown({ "all-MiniLM-L6-v2": 1758 }),
    });
    expect(state).toBe("healthy");
  });

  test("degraded when the vector plane itself is unhealthy regardless of coverage", () => {
    const coverage = computeCoverage(
      { "hash-reference": 1758 },
      { "hash-reference": CORPUS["hash-reference"] },
      { floor: 0.95 },
    );
    const state = overallState({
      vectorPlaneHealthy: false,
      coverage,
      embedder: computeEmbedderBreakdown({ "all-MiniLM-L6-v2": 1758 }),
    });
    expect(state).toBe("degraded");
  });
});

describe("inboxStatus", () => {
  test("empty/missing inbox reports zero pending and null age", () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-empty-"));
    const status = inboxStatus(join(dir, "does-not-exist"));
    expect(status.pending_files).toBe(0);
    expect(status.oldest_pending_batch_age_seconds).toBeNull();
  });

  test("reports pending depth and the oldest batch age", () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-depth-"));
    writeFileSync(join(dir, "a.json"), "{}");
    writeFileSync(join(dir, "b.json"), "{}");
    const oldMtime = new Date(Date.now() - 3600_000);
    utimesSync(join(dir, "a.json"), oldMtime, oldMtime);
    const now = () => new Date();
    const status = inboxStatus(dir, { now });
    expect(status.pending_files).toBe(2);
    expect(status.oldest_pending_batch_age_seconds).toBeGreaterThanOrEqual(3500);
  });

  test("done/ subdirectory files do not count as pending", () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-done-"));
    writeFileSync(join(dir, "pending.json"), "{}");
    const status = inboxStatus(dir);
    expect(status.pending_files).toBe(1);
  });
});
