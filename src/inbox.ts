/**
 * Drain host-written IndexChangeBatch JSON files from the Search inbox.
 * Fold writes one JSON object per file under apps/search/inbox/.
 *
 * Product path is **semantic only** (2026-07-30): drain applies batches via
 * `onBatch` (vector plane). No keyword LastStore write on the hot path.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
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
  /** Called for each valid batch before the file moves to done/. */
  onBatch?: (batch: IndexChangeBatch) => void | Promise<void>;
};

/**
 * Drain inbox: parse each batch JSON, invoke onBatch, move to done/.
 * Change count = number of change rows across applied batches.
 */
export async function drainInbox(
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
      result.changes += raw.changes.length;
      if (opts?.onBatch) await opts.onBatch(raw);
      result.files++;
      renameSync(path, join(doneDir, name));
    } catch (e) {
      result.errors.push(
        `${name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return result;
}

/** @deprecated alias — same as drainInbox (semantic-only era). */
export const drainInboxAsync = drainInbox;
