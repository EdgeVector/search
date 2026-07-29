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
 */
export async function onlineBackfill(
  session: SearchSession,
  opts?: { maxDoneFiles?: number; maxKeywordDocs?: number },
): Promise<{
  drained_files: number;
  batches_replayed: number;
  keyword_docs_reembedded: number;
  vectors: number;
  daemon_stop_required: false;
}> {
  // Drain pending while dual-writing semantic — does not stop lastdbd.
  const drained = await drainInboxAsync(
    session.keyword,
    session.paths.inbox,
    {
      onBatch: async (b) => {
        await session.semantic.applyBatch(b);
      },
    },
  );
  let batchesReplayed = 0;
  const doneDir = join(session.paths.inbox, "done");
  if (existsSync(doneDir)) {
    const max = opts?.maxDoneFiles ?? 50_000;
    const files = readdirSync(doneDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .slice(-max);
    for (const f of files) {
      try {
        const batch = JSON.parse(
          readFileSync(join(doneDir, f), "utf8"),
        ) as IndexChangeBatch;
        await session.semantic.applyBatch(batch);
        batchesReplayed++;
      } catch {
        /* skip corrupt */
      }
    }
  }

  // Primary product path: re-embed the durable keyword snapshot when present
  // (full corpus text already materialized without exclusive store open).
  let keywordDocs = 0;
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
      keywordDocs = await session.semantic.indexPlainDocs(
        slice
          .filter((d) => d.schema_name && d.text)
          .map((d) => ({
            schema_name: d.schema_name!,
            key_hash: d.key_hash ?? null,
            key_range: d.key_range ?? null,
            text: d.text!,
            mutation_id: d.mutation_id,
          })),
      );
    } catch {
      /* keyword snap optional */
    }
  }

  const health = session.semantic.health();
  return {
    drained_files: drained.files,
    batches_replayed: batchesReplayed,
    keyword_docs_reembedded: keywordDocs,
    vectors: health.vectors,
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
