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
  /** Files left in the inbox when the drain stopped early (0 when it finished). */
  remaining: number;
  /** Why the drain stopped, when it stopped before emptying the inbox. */
  stopped?: "max_files" | "rss_ceiling" | "aborted";
};

/**
 * Default per-run file cap. An unbounded drain over a large backlog is how the
 * machine died on 2026-08-07: nothing bounded the loop, so it ran for 11 hours
 * and grew to 26 GB RSS. A cap makes a drain a bounded unit of work that a
 * scheduler can repeat, instead of one run that must survive the whole backlog.
 */
export const DEFAULT_MAX_FILES = 2000;

/** Default RSS ceiling for a drain process (bytes). Abort cleanly above it. */
export const DEFAULT_MAX_RSS_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Cap for the opportunistic drain that runs before a query. A query must stay
 * a query — it should nibble at the backlog, never try to clear it.
 */
export const DRAIN_ON_QUERY_MAX_FILES = 200;

function isBatch(x: unknown): x is IndexChangeBatch {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.schema_name === "string" && Array.isArray(o.changes);
}

type DrainOptions = {
  /** Called for each valid batch before the file moves to done/. */
  onBatch?: (batch: IndexChangeBatch) => void | Promise<void>;
  /** Stop after this many files. Default DEFAULT_MAX_FILES; 0 means unlimited. */
  maxFiles?: number;
  /** Stop when RSS exceeds this. Default DEFAULT_MAX_RSS_BYTES; 0 disables. */
  maxRssBytes?: number;
  /** Cooperative cancel, checked once per file. */
  shouldStop?: () => boolean;
  /** Resident set size probe; injectable so tests need not allocate GBs. */
  rss?: () => number;
};

/**
 * Drain inbox: parse each batch JSON, invoke onBatch, move to done/.
 * Change count = number of change rows across applied batches.
 *
 * Bounded by design — see DEFAULT_MAX_FILES. A caller that wants the whole
 * backlog drains repeatedly and watches `remaining`, so each run stays a unit
 * of work the machine can absorb.
 */
export async function drainInbox(
  inboxDir: string,
  opts?: DrainOptions,
): Promise<DrainResult> {
  const result: DrainResult = {
    files: 0,
    changes: 0,
    errors: [],
    remaining: 0,
  };
  if (!existsSync(inboxDir)) return result;
  const doneDir = join(inboxDir, "done");
  if (!existsSync(doneDir)) mkdirSync(doneDir, { recursive: true, mode: 0o700 });

  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxRss = opts?.maxRssBytes ?? DEFAULT_MAX_RSS_BYTES;
  const rss = opts?.rss ?? (() => process.memoryUsage().rss);

  const all = readdirSync(inboxDir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort();
  const files = maxFiles > 0 ? all.slice(0, maxFiles) : all;
  let stopped: DrainResult["stopped"];

  for (const name of files) {
    if (opts?.shouldStop?.()) {
      stopped = "aborted";
      break;
    }
    if (maxRss > 0 && rss() > maxRss) {
      stopped = "rss_ceiling";
      break;
    }
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

  if (!stopped && files.length < all.length) stopped = "max_files";
  result.remaining = all.length - result.files;
  if (stopped) result.stopped = stopped;
  return result;
}
