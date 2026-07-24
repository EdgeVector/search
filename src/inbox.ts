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

export function drainInbox(engine: SearchEngine, inboxDir: string): DrainResult {
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
      result.files++;
      renameSync(path, join(doneDir, name));
    } catch (e) {
      result.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  engine.persist();
  return result;
}
