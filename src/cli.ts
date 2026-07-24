#!/usr/bin/env bun
/**
 * search — first-party LastDB Search app CLI
 *
 *   search drain [--last-db-home DIR]
 *   search query <text> [--k N] [--schema S]... [--json]
 *   search apply --file batch.json   (test/dev ingest one batch)
 *   search status
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openSearchEngine } from "./engine.ts";
import { drainInbox } from "./inbox.ts";
import { ensureSearchDirs, resolveSearchPaths } from "./paths.ts";
import type { IndexChangeBatch } from "./types.ts";

function usage(): never {
  console.error(`usage:
  search drain [--last-db-home DIR]
  search query <text> [--k N] [--schema S]... [--json] [--last-db-home DIR]
  search apply --file <batch.json> [--last-db-home DIR]
  search status [--last-db-home DIR]
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
  let k = 20;
  let json = false;
  const schemas: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--last-db-home" || a === "--data-dir") {
      lastDbHome = rest[++i];
    } else if (a === "--file") {
      file = rest[++i];
    } else if (a === "--k" || a === "-k") {
      k = Number(rest[++i]);
    } else if (a === "--schema") {
      schemas.push(rest[++i]!);
    } else if (a === "--json") {
      json = true;
    } else if (a.startsWith("-")) {
      console.error(`unknown flag ${a}`);
      usage();
    } else {
      positionals.push(a);
    }
  }
  return { cmd, lastDbHome, file, k, json, schemas, positionals };
}

function main(): void {
  const opts = parseArgs(process.argv);
  const paths = resolveSearchPaths({ lastDbHome: opts.lastDbHome });
  ensureSearchDirs(paths);
  const engine = openSearchEngine(paths.indexDir);

  if (opts.cmd === "status") {
    const body = {
      home: paths.home,
      inbox: paths.inbox,
      indexDir: paths.indexDir,
      docs: engine.size,
      plane: "search-app-keyword-v1",
    };
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (opts.cmd === "drain") {
    const r = drainInbox(engine, paths.inbox);
    console.log(JSON.stringify({ ok: true, ...r, docs: engine.size }, null, 2));
    return;
  }

  if (opts.cmd === "apply") {
    if (!opts.file) {
      console.error("search apply requires --file");
      process.exit(2);
    }
    const batch = JSON.parse(readFileSync(resolve(opts.file), "utf8")) as IndexChangeBatch;
    const n = engine.applyChangeBatch(batch);
    engine.persist();
    console.log(JSON.stringify({ ok: true, applied: n, docs: engine.size }));
    return;
  }

  if (opts.cmd === "query") {
    // Drain inbox first so host-delivered batches are visible.
    drainInbox(engine, paths.inbox);
    const q = opts.positionals.join(" ").trim();
    if (!q) {
      console.error("search query requires text");
      process.exit(2);
    }
    const hits = engine.search(q, {
      k: opts.k,
      schemas: opts.schemas.length ? opts.schemas : undefined,
    });
    if (opts.json) {
      console.log(JSON.stringify({ query: q, hits, docs: engine.size }));
    } else {
      console.log(`# ${hits.length} hit(s) (docs=${engine.size})`);
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

main();
