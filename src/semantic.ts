/**
 * Product semantic entry points for CLI and consumers.
 *
 * Search is **vector-only** (2026-07-30). Keyword LastStore is not on the
 * product path; brain/fkanban query semantic (or their own BM25 rescue).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { drainInbox } from "./inbox.ts";
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

/** Apply one IndexChangeBatch to the semantic plane only. */
export async function applyBatch(
  session: SearchSession,
  batch: IndexChangeBatch,
): Promise<{ semantic: number }> {
  const semantic = await session.semantic.applyBatch(batch);
  return { semantic };
}

/** @deprecated use applyBatch — keyword dual-write removed. */
export async function applyBatchBoth(
  session: SearchSession,
  batch: IndexChangeBatch,
): Promise<{ keyword: number; semantic: number }> {
  const r = await applyBatch(session, batch);
  return { keyword: 0, semantic: r.semantic };
}

/**
 * Online backfill: drain live inbox + replay done batches into the vector
 * plane without stopping lastdbd. Resumable (skip fresh vectors; periodic flush).
 *
 * No keyword LastStore. Optional legacy `keyword-index.v1.json` text snapshot
 * is still accepted as a bulk re-embed source if present (read-only).
 */
export async function onlineBackfill(
  session: SearchSession,
  opts?: {
    maxDoneFiles?: number;
    maxKeywordDocs?: number;
    force?: boolean;
    flushEvery?: number;
    progress?: ProgressReporter;
  },
): Promise<{
  drained_files: number;
  batches_replayed: number;
  docs_seen: number;
  docs_embedded: number;
  docs_skipped: number;
  /** @deprecated alias of docs_embedded */
  keyword_docs_reembedded: number;
  flushes: number;
  vectors: number;
  resumable: true;
  daemon_stop_required: false;
  keyword_plane: "removed";
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

  // Optional legacy text snapshot (no keyword engine).
  let docsSeen = 0;
  let docsEmbedded = 0;
  let docsSkipped = 0;
  let flushes = 0;
  const keywordSnap = join(session.paths.indexDir, "keyword-index.v1.json");
  if (existsSync(keywordSnap)) {
    try {
      const snap = JSON.parse(readFileSync(keywordSnap, "utf8")) as {
        docs?: Record<
          string,
          {
            schema_name?: string;
            key_hash?: string | null;
            key_range?: string | null;
            text?: string;
            mutation_id?: string;
          }
        >;
      };
      const entries = Object.values(snap.docs ?? {});
      const maxK = opts?.maxKeywordDocs ?? entries.length;
      const docs = entries
        .slice(0, maxK)
        .filter((d) => d.schema_name && d.text)
        .map((d) => ({
          schema_name: d.schema_name!,
          key_hash: d.key_hash ?? null,
          key_range: d.key_range ?? null,
          text: d.text!,
          mutation_id: d.mutation_id,
        }));
      docsSeen = docs.length;
      progress?.startPhase("snapshot-reembed", docsSeen);
      const r = await session.semantic.indexPlainDocs(docs, {
        skipIfFresh,
        force: opts?.force,
        flushEvery: opts?.flushEvery,
        onProgress: (p) => {
          progress?.tick({
            phase: "snapshot-reembed",
            done: p.done,
            total: p.total,
            embedded: p.embedded,
            skipped: p.skipped,
            flushes: p.flushes,
          });
        },
      });
      docsEmbedded = r.embedded;
      docsSkipped = r.skipped;
      flushes = r.flushes;
    } catch {
      /* optional */
    }
  }

  const health = session.semantic.health();
  progress?.finish(
    `done emb=${docsEmbedded} skip=${docsSkipped} vectors=${health.vectors} flushes=${flushes}`,
  );
  return {
    drained_files: drained.files,
    batches_replayed: batchesReplayed,
    docs_seen: docsSeen,
    docs_embedded: docsEmbedded,
    docs_skipped: docsSkipped,
    keyword_docs_reembedded: docsEmbedded,
    flushes,
    vectors: health.vectors,
    resumable: true,
    daemon_stop_required: false,
    keyword_plane: "removed",
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
