#!/usr/bin/env bun
/**
 * search — first-party LastDB Search app CLI
 *
 * Semantic vector plane only (all-MiniLM-L6-v2). Keyword LastStore removed
 * from the product path (2026-07-30).
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { drainInbox } from "./inbox.ts";
import { ensureSearchDirs, resolveSearchPaths } from "./paths.ts";
import type { IndexChangeBatch } from "./types.ts";
import {
  applyBatch,
  onlineBackfill,
  openSearchSession,
  semanticQuery,
} from "./semantic.ts";
import { createProgressReporter } from "./progress.ts";
import { createHttpLiveBackfillSource } from "./live_backfill.ts";
import { runSearchDoctor } from "./doctor.ts";
import { inboxStatus } from "./inbox.ts";
import { defaultCorpusCountSource } from "./vector/corpus_counts.ts";
import {
  computeCoverage,
  computeEmbedderBreakdown,
  overallState,
} from "./coverage.ts";

function usage(): never {
  console.error(`usage:
  search init [--last-db-home DIR] [--max-done N] [--flush-every N] [--force] [--quiet]
  search drain [--last-db-home DIR]
  search query <text> [--k N] [--schema S]... [--exact] [--min-score F] [--json] [--last-db-home DIR]
  search semantic-query <text> ...   # alias of query
  search apply --file <batch.json> [--last-db-home DIR]
  search rebuild --batches-dir DIR [--last-db-home DIR]
  search doctor [--last-db-home DIR] [--live-url URL] [--checkpoint-file FILE] [--strict]
  search bootstrap [--last-db-home DIR] [--max-done N] [--live-url URL] [--live-page-size N] [--checkpoint-file FILE] [--flush-every N] [--force] [--quiet]
  search online-backfill [--last-db-home DIR] [--max-done N] [--live-url URL] [--live-page-size N] [--checkpoint-file FILE] [--flush-every N] [--force] [--quiet]
  search status | vector-status [--last-db-home DIR]

  Semantic vector plane only (all-MiniLM-L6-v2).
`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  if (args.length === 0) usage();
  const cmd = args[0]!;
  const rest = args.slice(1);
  let lastDbHome: string | undefined;
  let file: string | undefined;
  let batchesDir: string | undefined;
  let k = 20;
  let json = false;
  let exact = false;
  let minScore: number | undefined;
  let maxDone: number | undefined;
  let flushEvery: number | undefined;
  let liveUrl: string | undefined;
  let livePageSize: number | undefined;
  let checkpointFile: string | undefined;
  let force = false;
  let quiet = false;
  let strict = false;
  const schemas: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--last-db-home" || a === "--data-dir") {
      lastDbHome = rest[++i];
    } else if (a === "--file") {
      file = rest[++i];
    } else if (a === "--batches-dir") {
      batchesDir = rest[++i];
    } else if (a === "--k" || a === "-k") {
      k = Number(rest[++i]);
    } else if (a === "--schema") {
      schemas.push(rest[++i]!);
    } else if (a === "--json") {
      json = true;
    } else if (a === "--exact") {
      exact = true;
    } else if (a === "--min-score") {
      minScore = Number(rest[++i]);
    } else if (a === "--max-done") {
      maxDone = Number(rest[++i]);
    } else if (a === "--live-url" || a === "--backfill-url") {
      liveUrl = rest[++i];
    } else if (a === "--live-page-size" || a === "--page-size") {
      livePageSize = Number(rest[++i]);
    } else if (a === "--checkpoint-file") {
      checkpointFile = rest[++i];
    } else if (a === "--flush-every") {
      flushEvery = Number(rest[++i]);
    } else if (a === "--force") {
      force = true;
    } else if (a === "--quiet" || a === "-q") {
      quiet = true;
    } else if (a === "--strict") {
      strict = true;
    } else if (a.startsWith("-")) {
      console.error(`unknown flag ${a}`);
      usage();
    } else {
      positionals.push(a);
    }
  }
  return {
    cmd,
    lastDbHome,
    file,
    batchesDir,
    k,
    json,
    exact,
    minScore,
    maxDone,
    flushEvery,
    liveUrl,
    livePageSize,
    checkpointFile,
    force,
    quiet,
    strict,
    schemas,
    positionals,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const paths = resolveSearchPaths({ lastDbHome: opts.lastDbHome });
  ensureSearchDirs(paths);

  if (opts.cmd === "status" || opts.cmd === "vector-status") {
    const session = openSearchSession({ lastDbHome: opts.lastDbHome });
    await session.semantic.ensureReady();
    const vector = session.semantic.health();

    let corpusCounts = null;
    let corpusError: string | undefined;
    try {
      corpusCounts = await defaultCorpusCountSource().fetchCounts();
    } catch (e) {
      corpusError = e instanceof Error ? e.message : String(e);
    }
    const trackedAppsEnv = process.env.SEARCH_COVERAGE_APPS?.trim();
    const coverage = computeCoverage(
      session.semantic.index.countsBySchema(),
      corpusCounts,
      {
        trackedAppIds: trackedAppsEnv
          ? trackedAppsEnv.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
      },
    );
    if (!coverage.available && corpusError) coverage.note = corpusError;
    const embedder = computeEmbedderBreakdown(
      session.semantic.index.embedderBreakdown(),
    );
    const inbox = inboxStatus(paths.inbox);
    const state = overallState({
      vectorPlaneHealthy: vector.state === "healthy",
      coverage,
      embedder,
    });

    console.log(
      JSON.stringify(
        {
          home: paths.home,
          inbox: paths.inbox,
          vectorIndexPath: paths.vectorIndexPath,
          plane: "search-app-semantic-v1",
          state,
          vector,
          coverage,
          embedder,
          inbox_status: inbox,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.cmd === "doctor") {
    const report = await runSearchDoctor({
      lastDbHome: opts.lastDbHome,
      liveUrl: opts.liveUrl,
      checkpointFile: opts.checkpointFile,
    });
    console.log(JSON.stringify(report, null, 2));
    if (opts.strict && !report.ok) process.exit(1);
    return;
  }

  if (opts.cmd === "rebuild") {
    if (!opts.batchesDir) {
      console.error("search rebuild requires --batches-dir");
      process.exit(2);
    }
    const session = openSearchSession({ lastDbHome: opts.lastDbHome });
    await session.semantic.ensureReady();
    const files = readdirSync(opts.batchesDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    let semantic = 0;
    for (const f of files) {
      const b = JSON.parse(
        readFileSync(join(opts.batchesDir, f), "utf8"),
      ) as IndexChangeBatch;
      semantic += await session.semantic.applyBatch(b);
    }
    console.log(
      JSON.stringify({
        ok: true,
        batches: files.length,
        semantic_applied: semantic,
        semantic_vectors: session.semantic.health().vectors,
      }),
    );
    return;
  }

  if (opts.cmd === "drain") {
    const session = openSearchSession({ lastDbHome: opts.lastDbHome });
    await session.semantic.ensureReady();
    const r = await drainInbox(session.paths.inbox, {
      onBatch: async (b) => {
        await session.semantic.applyBatch(b);
      },
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          ...r,
          vector: session.semantic.health(),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.cmd === "apply") {
    if (!opts.file) {
      console.error("search apply requires --file");
      process.exit(2);
    }
    const session = openSearchSession({ lastDbHome: opts.lastDbHome });
    const batch = JSON.parse(
      readFileSync(resolve(opts.file), "utf8"),
    ) as IndexChangeBatch;
    const r = await applyBatch(session, batch);
    console.log(
      JSON.stringify({
        ok: true,
        applied: r,
        vector: session.semantic.health(),
      }),
    );
    return;
  }

  if (
    opts.cmd === "init" ||
    opts.cmd === "bootstrap" ||
    opts.cmd === "online-backfill"
  ) {
    const progress = createProgressReporter({ quiet: opts.quiet });
    progress.startPhase("starting");
    const session = openSearchSession({ lastDbHome: opts.lastDbHome });
    progress.startPhase("embedder-ready");
    await session.semantic.ensureReady();
    const liveUrl = opts.liveUrl ?? process.env.SEARCH_LIVE_BACKFILL_URL;
    const r = await onlineBackfill(session, {
      maxDoneFiles: opts.maxDone,
      force: opts.force,
      flushEvery: opts.flushEvery,
      liveSource: liveUrl
        ? createHttpLiveBackfillSource({ url: liveUrl })
        : undefined,
      livePageLimit: opts.livePageSize,
      liveCheckpointFile: opts.checkpointFile,
      progress,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          cmd: opts.cmd,
          home: paths.home,
          inbox: paths.inbox,
          vectorIndexPath: paths.vectorIndexPath,
          ...r,
          vector: session.semantic.health(),
          note: "semantic vector plane only",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.cmd === "semantic-query" || opts.cmd === "query") {
    const session = openSearchSession({ lastDbHome: opts.lastDbHome });
    await drainInbox(session.paths.inbox, {
      onBatch: async (b) => {
        await session.semantic.applyBatch(b);
      },
    });
    const q = opts.positionals.join(" ").trim();
    if (!q) {
      console.error("search query requires text");
      process.exit(2);
    }
    const hits = await semanticQuery(session, q, {
      k: opts.k,
      schemas: opts.schemas.length ? opts.schemas : undefined,
      exact: opts.exact,
      min_score: opts.minScore,
    });
    if (opts.json) {
      console.log(
        JSON.stringify({
          query: q,
          mode: "semantic",
          hits,
          vector: session.semantic.health(),
        }),
      );
    } else {
      console.log(`# semantic ${hits.length} hit(s)`);
      for (const h of hits) {
        console.log(
          `${h.score.toFixed(4)}\t${h.schema_name}\t${h.key_hash ?? ""}\t${h.fragment_key}\t${h.text.replace(/\s+/g, " ").slice(0, 80)}`,
        );
      }
    }
    return;
  }

  usage();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
