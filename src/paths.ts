import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve Search data roots (semantic-only).
 *
 * Default layout under a LastDB Mini home:
 *   {LASTDB_HOME}/apps/search/inbox/              — IndexChangeBatch JSON from host
 *   {LASTDB_HOME}/apps/search/vector-index.v1.json — base name; the store files
 *     are vector-index.v2.bin and vector-index.v2.log
 *
 * Override with SEARCH_HOME, SEARCH_INBOX, SEARCH_VECTOR_INDEX.
 */
export type SearchPaths = {
  home: string;
  inbox: string;
  /** Durable semantic vector snapshot (regenerable). */
  vectorIndexPath: string;
};

export function resolveLastDbHome(): string {
  const env =
    process.env.LASTDB_HOME?.trim() ||
    process.env.SEARCH_LASTDB_HOME?.trim();
  if (env) return env;
  return join(homedir(), ".lastdb");
}

export function resolveSearchPaths(opts?: {
  home?: string;
  lastDbHome?: string;
}): SearchPaths {
  if (process.env.SEARCH_HOME?.trim()) {
    const home = process.env.SEARCH_HOME.trim();
    return {
      home,
      inbox: process.env.SEARCH_INBOX?.trim() || join(home, "inbox"),
      vectorIndexPath:
        process.env.SEARCH_VECTOR_INDEX?.trim() ||
        join(home, "vector-index.v1.json"),
    };
  }
  const lastDb = opts?.lastDbHome || resolveLastDbHome();
  const home = opts?.home || join(lastDb, "apps", "search");
  return {
    home,
    inbox: process.env.SEARCH_INBOX?.trim() || join(home, "inbox"),
    vectorIndexPath:
      process.env.SEARCH_VECTOR_INDEX?.trim() ||
      join(home, "vector-index.v1.json"),
  };
}

export function ensureSearchDirs(paths: SearchPaths): void {
  for (const d of [paths.home, paths.inbox]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}
