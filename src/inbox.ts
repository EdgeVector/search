/**
 * Drain host-written IndexChangeBatch JSON files from the Search inbox.
 * Fold writes one JSON object per file under apps/search/inbox/.
 *
 * Drain applies batches via `onBatch` (semantic vector plane).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { IndexChangeBatch } from "./types.ts";

export type InboxStatus = {
  pending_files: number;
  oldest_pending_batch_age_seconds: number | null;
};

/**
 * Pending file count and the age of the oldest undrained batch. Both are
 * leading indicators of a stalled drain — the inbox backlog that produced
 * this coverage tool grew silently for a week with nothing surfacing depth
 * or age (see papercut-search-app-inbox-never-drained...).
 */
export function inboxStatus(
  inboxDir: string,
  opts?: { now?: () => Date },
): InboxStatus {
  if (!existsSync(inboxDir)) return { pending_files: 0, oldest_pending_batch_age_seconds: null };
  const now = (opts?.now ?? (() => new Date()))();
  const files = readdirSync(inboxDir).filter(
    (f) => f.endsWith(".json") && !f.startsWith("."),
  );
  let oldestMs: number | null = null;
  for (const f of files) {
    try {
      const mtimeMs = statSync(join(inboxDir, f)).mtimeMs;
      if (oldestMs === null || mtimeMs < oldestMs) oldestMs = mtimeMs;
    } catch {
      /* file raced away between readdir and stat */
    }
  }
  return {
    pending_files: files.length,
    oldest_pending_batch_age_seconds:
      oldestMs === null ? null : Math.max(0, (now.getTime() - oldestMs) / 1000),
  };
}

type DrainResult = {
  files: number;
  changes: number;
  errors: string[];
};

function isBatch(x: unknown): x is IndexChangeBatch {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.schema_name === "string" && Array.isArray(o.changes);
}

type DrainOptions = {
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
