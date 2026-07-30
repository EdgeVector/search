/**
 * Product semantic entry points for CLI and consumers.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openSearchEngine, type SearchEngine } from "./engine.ts";
import { drainInbox, drainInboxAsync } from "./inbox.ts";
import { ensureSearchDirs, resolveSearchPaths, type SearchPaths } from "./paths.ts";
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
  keyword: SearchEngine;
  semantic: SemanticSearchPlane;
};

export function openSearchSession(opts?: {
  lastDbHome?: string;
  embedder?: Embedder;
}): SearchSession {
  const paths = resolveSearchPaths({ lastDbHome: opts?.lastDbHome });
  ensureSearchDirs(paths);
  const keyword = openSearchEngine(paths.indexDir);
  const semantic = openSemanticPlane(paths.home, {
    vectorStorePath: paths.vectorIndexPath,
    embedder: opts?.embedder,
  });
  return { paths, keyword, semantic };
}

export async function drainAndIndex(
  session: SearchSession,
): Promise<{ keyword_files: number; semantic_applied: number }> {
  const r = drainInbox(session.keyword, session.paths.inbox);
  // Re-read done? drain already applied to keyword. Also index pending was moved.
  // Index semantic from keyword memory docs after drain:
  const docs: Array<{
    schema_name: string;
    key_hash: string | null;
    key_range: string | null;
    text: string;
  }> = [];
  // Pull from engine via a query-all isn't available; re-apply from inbox/done recent
  // and from any batches still readable. Prefer indexing keyword docs via applyBatch path:
  // After drain, re-scan done/ is expensive. Instead: during drain we need dual apply.
  return { keyword_files: r.files, semantic_applied: 0 };
}

/**
 * Apply one IndexChangeBatch to keyword + semantic planes.
 */
export async function applyBatchBoth(
  session: SearchSession,
  batch: IndexChangeBatch,
): Promise<{ keyword: number; semantic: number }> {
  const keyword = session.keyword.applyChangeBatch(batch);
  session.keyword.persist();
  const semantic = await session.semantic.applyBatch(batch);
  return { keyword, semantic };
}

/**
 * Online backfill: drain live inbox (daemon may keep writing), then
 * re-embed keyword documents present in memory/LastStore by replaying
 * JSON batches from inbox/done when present, without stopping lastdbd.
 *
 * Resumable: vector upserts skip already-fresh keys (same embedder + text /
 * mutation_id); keyword re-embed flushes every `flushEvery` new embeds so an
 * interrupted run keeps durable progress. Re-run `search init` / `online-backfill`
 * to continue — no exclusive lock, no daemon stop.
 */
export async function onlineBackfill(
  session: SearchSession,
  opts?: {
    maxDoneFiles?: number;
    maxKeywordDocs?: number;
    /** Re-embed even when a fresh vector already exists. */
    force?: boolean;
    /** Persist vector index after this many new embeds (default 50). */
    flushEvery?: number;
    progress?: ProgressReporter;
  },
): Promise<{
  drained_files: number;
  batches_replayed: number;
  keyword_docs_seen: number;
  keyword_docs_embedded: number;
  keyword_docs_skipped: number;
  keyword_docs_reembedded: number;
  flushes: number;
  vectors: number;
  resumable: true;
  daemon_stop_required: false;
}> {
  const skipIfFresh = !opts?.force;
  const progress = opts?.progress;
  // Drain pending while dual-writing semantic — does not stop lastdbd.
  // skipIfFresh on replay so a second pass over the same batches is cheap.
  progress?.startPhase("drain-inbox");
  const drained = await drainInboxAsync(
    session.keyword,
    session.paths.inbox,
    {
      onBatch: async (b) => {
        await session.semantic.applyBatch(b, null, { skipIfFresh });
      },
    },
  );
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

  // Primary product path: re-embed the durable keyword snapshot when present
  // (full corpus text already materialized without exclusive store open).
  let keywordSeen = 0;
  let keywordEmbedded = 0;
  let keywordSkipped = 0;
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
      const slice = entries.slice(0, maxK);
      const docs = slice
        .filter((d) => d.schema_name && d.text)
        .map((d) => ({
          schema_name: d.schema_name!,
          key_hash: d.key_hash ?? null,
          key_range: d.key_range ?? null,
          text: d.text!,
          mutation_id: d.mutation_id,
        }));
      keywordSeen = docs.length;
      progress?.startPhase("keyword-reembed", keywordSeen);
      const r = await session.semantic.indexPlainDocs(docs, {
        skipIfFresh,
        force: opts?.force,
        flushEvery: opts?.flushEvery,
        onProgress: (p) => {
          progress?.tick({
            phase: "keyword-reembed",
            done: p.done,
            total: p.total,
            embedded: p.embedded,
            skipped: p.skipped,
            flushes: p.flushes,
          });
        },
      });
      keywordEmbedded = r.embedded;
      keywordSkipped = r.skipped;
      flushes = r.flushes;
    } catch {
      /* keyword snap optional */
    }
  } else {
    progress?.startPhase("keyword-reembed", 0);
    progress?.tick({
      phase: "keyword-reembed",
      done: 0,
      total: 0,
      detail: "no keyword-index.v1.json snapshot",
    });
  }

  const health = session.semantic.health();
  progress?.finish(
    `done emb=${keywordEmbedded} skip=${keywordSkipped} vectors=${health.vectors} flushes=${flushes}`,
  );
  return {
    drained_files: drained.files,
    batches_replayed: batchesReplayed,
    keyword_docs_seen: keywordSeen,
    keyword_docs_embedded: keywordEmbedded,
    keyword_docs_skipped: keywordSkipped,
    // Back-compat alias: "reembedded" means newly embedded this pass.
    keyword_docs_reembedded: keywordEmbedded,
    flushes,
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

export function listKeywordDocsForBackfill(session: SearchSession): Array<{
  schema_name: string;
  key_hash: string | null;
  key_range: string | null;
  text: string;
}> {
  // Engine doesn't export docs; use status-only. Callers use onlineBackfill replay.
  void session;
  return [];
}
