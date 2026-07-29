#!/usr/bin/env bun
/**
 * search — first-party LastDB Search app CLI
 *
 * Keyword (LastStore) + semantic (vector / MiniLM) planes.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { openSearchEngine } from "./engine.ts";
import { drainInbox } from "./inbox.ts";
import { ensureSearchDirs, resolveSearchPaths } from "./paths.ts";
import type { IndexChangeBatch } from "./types.ts";
import {
  applyBatchBoth,
  onlineBackfill,
  openSearchSession,
  semanticQuery,
} from "./semantic.ts";

function usage(): never {
  console.error(`usage:
  search drain [--last-db-home DIR]
  search query <text> [--k N] [--schema S]... [--json] [--last-db-home DIR]
  search semantic-query <text> [--k N] [--schema S]... [--exact] [--min-score F] [--json] [--last-db-home DIR]
  search apply --file <batch.json> [--last-db-home DIR]
  search rebuild --batches-dir DIR [--last-db-home DIR]
  search online-backfill [--last-db-home DIR] [--max-done N]
  search status [--last-db-home DIR]
  search vector-status [--last-db-home DIR]
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
    const body = {
      home: paths.home,
      inbox: paths.inbox,
      indexDir: paths.indexDir,
      lastStoreDir: paths.lastStoreDir,
      vectorIndexPath: paths.vectorIndexPath,
      docs: session.keyword.size,
      backend: session.keyword.backend,
      plane: "search-app-semantic-v1",
      keyword_plane: "search-app-keyword-v1-laststore",
      vector: session.semantic.health(),
    };
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (opts.cmd === "rebuild") {
    if (!opts.batchesDir) {
      console.error("search rebuild requires --batches-dir");
      process.exit(2);
    }
    const engine = openSearchEngine(paths.indexDir);
    const files = readdirSync(opts.batchesDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const batches: IndexChangeBatch[] = files.map((f) =>
      JSON.parse(
        readFileSync(join(opts.batchesDir!, f), "utf8"),
      ) as IndexChangeBatch,
    );
    const report = engine.rebuildFromBatches(batches, true);
    const session = openSearchSession({ lastDbHome: opts.lastDbHome });
    let semantic = 0;
    for (const b of batches) semantic += await session.semantic.applyBatch(b);
    console.log(
      JSON.stringify({
        ok: true,
        backend: engine.backend,
        lastStoreDir: paths.lastStoreDir,
        ...report,
        semantic_vectors: session.semantic.health().vectors,
        semantic_applied: semantic,
      }),
    );
    return;
  }

  if (opts.cmd === "drain") {
    const session = openSearchSession({ lastDbHome: opts.lastDbHome });
    const r = drainInbox(session.keyword, session.paths.inbox);
    // Dual-index: re-apply done file just drained is hard; callers use apply/online-backfill.
    console.log(
      JSON.stringify({
        ok: true,
        ...r,
        docs: session.keyword.size,
        vector: session.semantic.health(),
      }, null, 2),
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
    const r = await applyBatchBoth(session, batch);
    console.log(
      JSON.stringify({
        ok: true,
        applied: r,
        docs: session.keyword.size,
        vector: session.semantic.health(),
      }),
    );
    return;
  }

  if (opts.cmd === "online-backfill") {
    const session = openSearchSession({ lastDbHome: opts.lastDbHome });
    const r = await onlineBackfill(session, { maxDoneFiles: opts.maxDone });
    console.log(
      JSON.stringify({
        ok: true,
        ...r,
        vector: session.semantic.health(),
        note: "daemon_stop_required=false; replays inbox/done + drain; primary may stay up",
      }, null, 2),
    );
    return;
  }

  if (opts.cmd === "semantic-query" || opts.cmd === "query") {
    const session = openSearchSession({ lastDbHome: opts.lastDbHome });
    drainInbox(session.keyword, session.paths.inbox);
    const q = opts.positionals.join(" ").trim();
    if (!q) {
      console.error("search query requires text");
      process.exit(2);
    }
    const useSemantic =
      opts.cmd === "semantic-query" || process.env.SEARCH_QUERY_MODE !== "keyword";
    if (useSemantic) {
      const hits = await semanticQuery(session, q, {
        k: opts.k,
        schemas: opts.schemas.length ? opts.schemas : undefined,
        exact: opts.exact,
        min_score: opts.minScore,
      });
      // Fall back to keyword if semantic empty
      if (hits.length === 0 && opts.cmd === "query") {
        const kh = session.keyword.search(q, {
          k: opts.k,
          schemas: opts.schemas.length ? opts.schemas : undefined,
        });
        if (opts.json) {
          console.log(
            JSON.stringify({
              query: q,
              mode: "keyword-fallback",
              hits: kh,
              docs: session.keyword.size,
              vector: session.semantic.health(),
            }),
          );
        } else {
          console.log(`# keyword-fallback ${kh.length} hit(s)`);
          for (const h of kh) {
            console.log(
              `${h.score.toFixed(3)}\t${h.schema_name}\t${h.key_hash ?? ""}\t${h.text.replace(/\s+/g, " ").slice(0, 80)}`,
            );
          }
        }
        return;
      }
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
    const hits = session.keyword.search(q, {
      k: opts.k,
      schemas: opts.schemas.length ? opts.schemas : undefined,
    });
    if (opts.json) {
      console.log(JSON.stringify({ query: q, mode: "keyword", hits, docs: session.keyword.size }));
    } else {
      console.log(`# ${hits.length} hit(s) (docs=${session.keyword.size})`);
      for (const h of hits) {
        console.log(
          `${h.score.toFixed(3)}\t${h.schema_name}\t${h.key_hash ?? ""}\t${h.key_range ?? ""}\t${h.text.replace(/\s+/g, " ").slice(0, 80)}`,
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
