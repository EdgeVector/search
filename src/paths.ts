import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve Search data roots.
 *
 * Default layout under a LastDB Mini home:
 *   {LASTDB_HOME}/apps/search/inbox/       — IndexChangeBatch JSON files from the host
 *   {LASTDB_HOME}/apps/search/laststore/   — LastStore-backed keyword index (primary)
 *   {LASTDB_HOME}/apps/search/index/       — logical index dir (engine maps to laststore)
 *
 * Override with SEARCH_HOME, SEARCH_INBOX, SEARCH_INDEX_DIR, SEARCH_LASTSTORE_DIR.
 */
export type SearchPaths = {
  home: string;
  inbox: string;
  indexDir: string;
  lastStoreDir: string;
};

export function resolveLastDbHome(): string {
  const env =
    process.env.LASTDB_HOME?.trim() ||
    process.env.FOLDDB_HOME?.trim() ||
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
    const indexDir = process.env.SEARCH_INDEX_DIR?.trim() || join(home, "index");
    return {
      home,
      inbox: process.env.SEARCH_INBOX?.trim() || join(home, "inbox"),
      indexDir,
      lastStoreDir:
        process.env.SEARCH_LASTSTORE_DIR?.trim() || join(home, "laststore"),
    };
  }
  const lastDb = opts?.lastDbHome || resolveLastDbHome();
  const home = opts?.home || join(lastDb, "apps", "search");
  const indexDir = process.env.SEARCH_INDEX_DIR?.trim() || join(home, "index");
  return {
    home,
    inbox: process.env.SEARCH_INBOX?.trim() || join(home, "inbox"),
    indexDir,
    lastStoreDir:
      process.env.SEARCH_LASTSTORE_DIR?.trim() || join(home, "laststore"),
  };
}

export function ensureSearchDirs(paths: SearchPaths): void {
  for (const d of [paths.home, paths.inbox, paths.indexDir, paths.lastStoreDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}
