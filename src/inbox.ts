/**
 * Drain host-written IndexChangeBatch JSON files from the Search inbox.
 * Fold writes one JSON object per file under apps/search/inbox/.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import type { SearchEngine } from "./engine.ts";
import type { IndexChangeBatch } from "./types.ts";

export type DrainResult = {
  files: number;
  changes: number;
  errors: string[];
};

function isBatch(x: unknown): x is IndexChangeBatch {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.schema_name === "string" && Array.isArray(o.changes);
}

export type DrainOptions = {
  /** Optional async hook after keyword apply (e.g. semantic plane). */
  onBatch?: (batch: IndexChangeBatch) => void | Promise<void>;
};

export function drainInbox(
  engine: SearchEngine,
  inboxDir: string,
  opts?: DrainOptions,
): DrainResult {
  const result: DrainResult = { files: 0, changes: 0, errors: [] };
  if (!existsSync(inboxDir)) return result;
  const doneDir = join(inboxDir, "done");
  if (!existsSync(doneDir)) mkdirSync(doneDir, { recursive: true, mode: 0o700 });

  const files = readdirSync(inboxDir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort();

  for (const name of files) {
    const path = join(inboxDir, name);
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isBatch(raw)) {
        result.errors.push(`${name}: not an IndexChangeBatch`);
        continue;
      }
      result.changes += engine.applyChangeBatch(raw);
      if (opts?.onBatch) {
        const p = opts.onBatch(raw);
        // Best-effort sync wait if promise returned from sync drain path
        if (p && typeof (p as Promise<void>).then === "function") {
          // Note: callers that need dual-index should use drainInboxAsync
        }
      }
      result.files++;
      renameSync(path, join(doneDir, name));
    } catch (e) {
      result.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  engine.persist();
  return result;
}

/** Async drain with dual-index support (keyword + optional semantic). */
export async function drainInboxAsync(
  engine: SearchEngine,
  inboxDir: string,
  opts?: DrainOptions,
): Promise<DrainResult> {
  const result: DrainResult = { files: 0, changes: 0, errors: [] };
  if (!existsSync(inboxDir)) return result;
  const doneDir = join(inboxDir, "done");
  if (!existsSync(doneDir)) mkdirSync(doneDir, { recursive: true, mode: 0o700 });

  const files = readdirSync(inboxDir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort();

  for (const name of files) {
    const path = join(inboxDir, name);
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isBatch(raw)) {
        result.errors.push(`${name}: not an IndexChangeBatch`);
        continue;
      }
      result.changes += engine.applyChangeBatch(raw);
      if (opts?.onBatch) await opts.onBatch(raw);
      result.files++;
      renameSync(path, join(doneDir, name));
    } catch (e) {
      result.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  engine.persist();
  return result;
}
