import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve Search data roots (semantic-only).
 *
 * Default layout under a LastDB Mini home:
 *   {LASTDB_HOME}/apps/search/inbox/              — IndexChangeBatch JSON from host
 *   {LASTDB_HOME}/apps/search/vector-index.v1.json — MiniLM vector snapshot
 *   {LASTDB_HOME}/apps/search/index/              — optional text snapshot for re-embed
 *
 * Override with SEARCH_HOME, SEARCH_INBOX, SEARCH_INDEX_DIR, SEARCH_VECTOR_INDEX.
 */
export type SearchPaths = {
  home: string;
  inbox: string;
  /** Optional index dir (unused by semantic path; kept for path layout). */
  indexDir: string;
  /** Durable semantic vector snapshot (regenerable). */
  vectorIndexPath: string;
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
      vectorIndexPath:
        process.env.SEARCH_VECTOR_INDEX?.trim() ||
        join(home, "vector-index.v1.json"),
    };
  }
  const lastDb = opts?.lastDbHome || resolveLastDbHome();
  const home = opts?.home || join(lastDb, "apps", "search");
  const indexDir = process.env.SEARCH_INDEX_DIR?.trim() || join(home, "index");
  return {
    home,
    inbox: process.env.SEARCH_INBOX?.trim() || join(home, "inbox"),
    indexDir,
    vectorIndexPath:
      process.env.SEARCH_VECTOR_INDEX?.trim() ||
      join(home, "vector-index.v1.json"),
  };
}

/**
 * True when `home` resolves to the real user's production Search index home
 * (`~/.lastdb/apps/search`) — checked against the actual OS home directory,
 * not `LASTDB_HOME`/`SEARCH_HOME` overrides, so the check can't be routed
 * around by env config. Used to structurally refuse deterministic-embedder
 * writes against production (2,981 deterministic vectors reached production
 * this way once already — see fastembed.ts / vector_index.ts guards).
 */
export function isProductionSearchHome(home: string): boolean {
  const real = resolve(join(homedir(), ".lastdb", "apps", "search"));
  return resolve(home) === real;
}

export function ensureSearchDirs(paths: SearchPaths): void {
  for (const d of [paths.home, paths.inbox, paths.indexDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}
