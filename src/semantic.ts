/**
 * Product semantic entry points for CLI and consumers.
 *
 * Search is **vector-only** (2026-07-30). Keyword LastStore is not on the
 * product path; brain/fkanban query semantic (or their own BM25 rescue).
 */
import {
  ensureSearchDirs,
  resolveSearchPaths,
  type SearchPaths,
} from "./paths.ts";
import type { IndexChangeBatch } from "./types.ts";
import {
  openSemanticPlane,
  type SemanticSearchPlane,
} from "./vector/plane.ts";
import type { SemanticHit } from "./vector/vector_index.ts";
import type { Embedder } from "./vector/embedder.ts";
import type { ProgressReporter } from "./progress.ts";

export type SearchSession = {
  paths: SearchPaths;
  semantic: SemanticSearchPlane;
};

export function openSearchSession(opts?: {
  lastDbHome?: string;
  embedder?: Embedder;
}): SearchSession {
  const paths = resolveSearchPaths({ lastDbHome: opts?.lastDbHome });
  ensureSearchDirs(paths);
  const semantic = openSemanticPlane(paths.home, {
    vectorStorePath: paths.vectorIndexPath,
    inboxDir: paths.inbox,
    embedder: opts?.embedder,
  });
  return { paths, semantic };
}

/** Apply one IndexChangeBatch to the semantic plane. */
export async function applyBatch(
  session: SearchSession,
  batch: IndexChangeBatch,
): Promise<{ semantic: number }> {
  const semantic = await session.semantic.applyBatch(batch);
  return { semantic };
}

/**
 * Drain the inbox into the vector plane. Resumable via skipIfFresh on vectors.
 */
export async function onlineBackfill(
  session: SearchSession,
  opts?: {
    force?: boolean;
    progress?: ProgressReporter;
  },
): Promise<{
  drained_files: number;
  drain_errors: string[];
  /** Inbox files still queued when this run's drain stopped. */
  drain_remaining: number;
  /** Set when the drain stopped before emptying the inbox — run again. */
  drain_stopped?: "max_files" | "rss_ceiling" | "aborted";
  rebuild_scope: "local_batches_only";
  vectors: number;
  resumable: true;
  daemon_stop_required: false;
}> {
  const skipIfFresh = !opts?.force;
  const progress = opts?.progress;

  progress?.startPhase("drain-inbox");
  const drained = await session.semantic.drainInbox({ skipIfFresh });
  progress?.tick({
    phase: "drain-inbox",
    done: drained.files,
    total: drained.files + drained.remaining,
    detail: drained.stopped
      ? `files=${drained.files} remaining=${drained.remaining} stopped=${drained.stopped}`
      : `files=${drained.files}`,
  });

  const health = session.semantic.health();
  progress?.finish(
    `vectors=${health.vectors}` +
      (drained.remaining > 0 ? ` inbox_remaining=${drained.remaining}` : ""),
  );
  return {
    drained_files: drained.files,
    drain_errors: drained.errors,
    drain_remaining: drained.remaining,
    drain_stopped: drained.stopped,
    rebuild_scope: "local_batches_only",
    vectors: health.vectors,
    resumable: true,
    daemon_stop_required: false,
  };
}

export async function semanticQuery(
  session: SearchSession,
  q: string,
  opts: {
    k?: number;
    schemas?: string[];
    exact?: boolean;
    min_score?: number;
  } = {},
): Promise<SemanticHit[]> {
  return session.semantic.query(q, opts);
}
