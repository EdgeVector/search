/**
 * Product semantic entry points for CLI and consumers.
 *
 * Search is **vector-only** (2026-07-30). Keyword LastStore is not on the
 * product path; brain/fkanban query semantic (or their own BM25 rescue).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// readdir/readFile used for done/ batch replay only
import {
  ensureSearchDirs,
  resolveSearchPaths,
  type SearchPaths,
} from "./paths.ts";
import type { IndexChangeBatch } from "./types.ts";
import {
  runLiveBackfill,
  type LiveBackfillResult,
  type LiveBackfillSource,
} from "./live_backfill.ts";
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
 * Online backfill: drain live inbox + replay done batches into the vector
 * plane without stopping lastdbd. Resumable via skipIfFresh on vectors.
 */
export async function onlineBackfill(
  session: SearchSession,
  opts?: {
    maxDoneFiles?: number;
    force?: boolean;
    flushEvery?: number;
    liveSource?: LiveBackfillSource;
    liveCheckpointFile?: string;
    livePageLimit?: number;
    maxLivePages?: number;
    maxLiveRetries?: number;
    progress?: ProgressReporter;
  },
): Promise<{
  drained_files: number;
  drain_errors: string[];
  /** Inbox files still queued when this run's drain stopped. */
  drain_remaining: number;
  /** Set when the drain stopped before emptying the inbox — run again. */
  drain_stopped?: "max_files" | "rss_ceiling" | "aborted";
  batches_replayed: number;
  rebuild_scope: "local_batches_only" | "configured_live_source_and_local_batches";
  legacy_archive_files: number;
  legacy_replay_selected: number;
  legacy_replay_errors: number;
  live_source_completed: boolean;
  vectors: number;
  resumable: true;
  daemon_stop_required: false;
  live?: LiveBackfillResult;
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

  let batchesReplayed = 0;
  let legacyArchiveFiles = 0;
  let legacyReplaySelected = 0;
  let legacyReplayErrors = 0;
  const doneDir = join(session.paths.inbox, "done");
  if (existsSync(doneDir)) {
    const max = opts?.maxDoneFiles ?? 50_000;
    const available = readdirSync(doneDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const files = available.slice(-max);
    legacyArchiveFiles = available.length;
    legacyReplaySelected = files.length;
    progress?.startPhase("replay-done", files.length);
    for (const f of files) {
      try {
        const batch = JSON.parse(
          readFileSync(join(doneDir, f), "utf8"),
        ) as IndexChangeBatch;
        await session.semantic.applyBatch(batch, null, { skipIfFresh });
        batchesReplayed++;
      } catch {
        legacyReplayErrors++;
      }
      progress?.tick({
        phase: "replay-done",
        done: batchesReplayed,
        total: files.length,
      });
    }
  }

  let live: LiveBackfillResult | undefined;
  if (opts?.liveSource) {
    live = await runLiveBackfill(session.semantic, session.paths, opts.liveSource, {
      checkpointFile: opts.liveCheckpointFile,
      force: opts.force,
      pageLimit: opts.livePageLimit,
      maxPages: opts.maxLivePages,
      maxRetries: opts.maxLiveRetries,
      flushEvery: opts.flushEvery,
      progress,
    });
  }

  const health = session.semantic.health();
  progress?.finish(
    `done batches=${batchesReplayed} live=${live?.live_records ?? 0} vectors=${health.vectors}` +
      (drained.remaining > 0 ? ` inbox_remaining=${drained.remaining}` : ""),
  );
  return {
    drained_files: drained.files,
    drain_errors: drained.errors,
    drain_remaining: drained.remaining,
    drain_stopped: drained.stopped,
    batches_replayed: batchesReplayed,
    rebuild_scope: opts?.liveSource
      ? "configured_live_source_and_local_batches"
      : "local_batches_only",
    legacy_archive_files: legacyArchiveFiles,
    legacy_replay_selected: legacyReplaySelected,
    legacy_replay_errors: legacyReplayErrors,
    live_source_completed: live?.live_completed ?? false,
    vectors: health.vectors,
    resumable: true,
    daemon_stop_required: false,
    live,
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
