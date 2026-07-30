/**
 * Product semantic entry points for CLI and consumers.
 *
 * Search is **vector-only** (2026-07-30). Keyword LastStore is not on the
 * product path; brain/fkanban query semantic (or their own BM25 rescue).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { drainInbox } from "./inbox.ts";
// readdir/readFile used for done/ batch replay only
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
    progress?: ProgressReporter;
  },
): Promise<{
  drained_files: number;
  batches_replayed: number;
  vectors: number;
  resumable: true;
  daemon_stop_required: false;
}> {
  const skipIfFresh = !opts?.force;
  const progress = opts?.progress;

  progress?.startPhase("drain-inbox");
  const drained = await drainInbox(session.paths.inbox, {
    onBatch: async (b) => {
      await session.semantic.applyBatch(b, null, { skipIfFresh });
    },
  });
  progress?.tick({
    phase: "drain-inbox",
    done: drained.files,
    total: drained.files,
    detail: `files=${drained.files}`,
  });

  let batchesReplayed = 0;
  const doneDir = join(session.paths.inbox, "done");
  if (existsSync(doneDir)) {
    const max = opts?.maxDoneFiles ?? 50_000;
    const files = readdirSync(doneDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .slice(-max);
    progress?.startPhase("replay-done", files.length);
    for (const f of files) {
      try {
        const batch = JSON.parse(
          readFileSync(join(doneDir, f), "utf8"),
        ) as IndexChangeBatch;
        await session.semantic.applyBatch(batch, null, { skipIfFresh });
        batchesReplayed++;
      } catch {
        /* skip corrupt */
      }
      progress?.tick({
        phase: "replay-done",
        done: batchesReplayed,
        total: files.length,
      });
    }
  }

  const health = session.semantic.health();
  progress?.finish(
    `done batches=${batchesReplayed} vectors=${health.vectors}`,
  );
  return {
    drained_files: drained.files,
    batches_replayed: batchesReplayed,
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
