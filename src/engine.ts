/**
 * SearchEngine — LastStore-backed regenerable keyword index.
 *
 * Primary durable state: LastStore segment home under apps/search/laststore
 * (or indexDir when it already is a LastStore root). Falls back to an
 * in-process LastStore via the search-store binary when available; otherwise
 * uses an in-memory index with LastStore-compatible on-disk apply through
 * the same binary path after build.
 *
 * No FastEmbed/ONNX. Ingest is IndexChangeBatch (fold IndexSink wire).
 */

import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fieldsToText, tokenize } from "./tokenize.ts";
import type {
  IndexChangeBatch,
  SearchHit,
  SearchQueryOptions,
} from "./types.ts";

export type {
  IndexChangeBatch,
  IndexChange,
  IndexChangeKind,
  KeyValue,
  SearchHit,
  SearchQueryOptions,
} from "./types.ts";

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Resolve search-store binary (LastStore engine). */
export function resolveSearchStoreBin(): string | null {
  const env = process.env.SEARCH_STORE_BIN?.trim();
  if (env && existsSync(env)) return env;
  const candidates = [
    join(packageRoot(), "target/release/search-store"),
    join(packageRoot(), "target/debug/search-store"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Map an indexDir (legacy apps/search/index) to LastStore root
 * (apps/search/laststore) when the parent is apps/search.
 */
export function resolveLastStorePath(indexDir: string): string {
  if (process.env.SEARCH_LASTSTORE_DIR?.trim()) {
    return process.env.SEARCH_LASTSTORE_DIR.trim();
  }
  // If caller already passes .../laststore, use it.
  if (indexDir.endsWith("laststore") || indexDir.includes(`${join("laststore")}`)) {
    return indexDir;
  }
  // apps/search/index → apps/search/laststore
  const parent = dirname(indexDir);
  if (parent.endsWith("search") || parent.endsWith(`${join("apps", "search")}`)) {
    return join(parent, "laststore");
  }
  return join(indexDir, "laststore");
}

type DocRec = {
  id: string;
  schema_name: string;
  key_hash: string | null;
  key_range: string | null;
  text: string;
  tokens: string[];
  mutation_id?: string;
};

function docId(schema: string, hash: string | null, range: string | null): string {
  return `${schema}\u0000${hash ?? ""}\u0000${range ?? ""}`;
}

/**
 * Keyword engine: prefers LastStore via search-store binary for durability;
 * keeps a memory mirror for fast query after apply when binary is present.
 * When binary is missing (scaffold hosts), memory-only mode still works for
 * unit tests but persist() warns and does not claim LastStore durability.
 */
export class SearchEngine {
  readonly indexDir: string;
  readonly lastStorePath: string;
  private docs = new Map<string, DocRec>();
  private inverted = new Map<string, Set<string>>();
  private dirty = false;
  private readonly storeBin: string | null;
  private lastStoreReady = false;

  constructor(indexDir: string) {
    this.indexDir = indexDir;
    this.lastStorePath = resolveLastStorePath(indexDir);
    this.storeBin = resolveSearchStoreBin();
    mkdirSync(this.lastStorePath, { recursive: true, mode: 0o700 });
    this.loadFromLastStore();
  }

  private loadFromLastStore(): void {
    if (!this.storeBin) return;
    // status opens the store; query with empty won't load docs. Use a
    // rebuild-of-zero + status to ensure store opens; docs load lazily via
    // re-query is not enough for in-memory mirror after process restart.
    // Pull all docs by querying common approach: status only gives count.
    // For reopen, we re-query LastStore on each search() when memory empty.
    const st = spawnSync(
      this.storeBin,
      ["status", "--store", this.lastStorePath, "--json"],
      { encoding: "utf8" },
    );
    if (st.status === 0) {
      this.lastStoreReady = true;
      try {
        const body = JSON.parse(st.stdout) as { docs?: number };
        if ((body.docs ?? 0) > 0 && this.docs.size === 0) {
          // Mark that durable state exists; search() will hit LastStore path.
          this.lastStoreReady = true;
        }
      } catch {
        /* ignore */
      }
    }
  }

  get size(): number {
    if (this.docs.size > 0) return this.docs.size;
    if (this.storeBin && this.lastStoreReady) {
      const st = spawnSync(
        this.storeBin,
        ["status", "--store", this.lastStorePath, "--json"],
        { encoding: "utf8" },
      );
      if (st.status === 0) {
        try {
          return (JSON.parse(st.stdout) as { docs?: number }).docs ?? 0;
        } catch {
          return 0;
        }
      }
    }
    return 0;
  }

  get backend(): "laststore" | "memory" {
    return this.storeBin ? "laststore" : "memory";
  }

  /** Apply one fold IndexChangeBatch. */
  applyChangeBatch(batch: IndexChangeBatch): number {
    // Always update memory mirror for same-process query.
    const searchable = batch.searchable_fields?.length
      ? new Set(batch.searchable_fields)
      : null;
    let n = 0;
    for (const ch of batch.changes) {
      const id = docId(
        batch.schema_name,
        ch.key_value.hash,
        ch.key_value.range,
      );
      if (ch.kind === "tombstone") {
        this.removeDoc(id);
        n++;
        continue;
      }
      const text = fieldsToText(ch.fields_and_values, searchable);
      const tokens = tokenize(text);
      this.removeDoc(id);
      const doc: DocRec = {
        id,
        schema_name: batch.schema_name,
        key_hash: ch.key_value.hash,
        key_range: ch.key_value.range,
        text,
        tokens,
        mutation_id: ch.mutation_id,
      };
      this.docs.set(id, doc);
      for (const t of tokens) {
        let set = this.inverted.get(t);
        if (!set) {
          set = new Set();
          this.inverted.set(t, set);
        }
        set.add(id);
      }
      n++;
    }
    this.dirty = true;

    // Durable LastStore path (primary).
    if (this.storeBin) {
      const tmp = mkdtempSync(join(tmpdir(), "search-batch-"));
      const file = join(tmp, "batch.json");
      writeFileSync(file, JSON.stringify(batch));
      const r = spawnSync(
        this.storeBin,
        ["apply", "--store", this.lastStorePath, "--file", file],
        { encoding: "utf8" },
      );
      rmSync(tmp, { recursive: true, force: true });
      if (r.status !== 0) {
        throw new Error(
          `search-store apply failed: ${r.stderr || r.stdout || r.status}`,
        );
      }
      this.lastStoreReady = true;
      this.dirty = false;
    }
    return n;
  }

  private removeDoc(id: string): void {
    const prev = this.docs.get(id);
    if (!prev) return;
    for (const t of prev.tokens) {
      const set = this.inverted.get(t);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.inverted.delete(t);
    }
    this.docs.delete(id);
    this.dirty = true;
  }

  /**
   * Persist memory mirror. LastStore apply already flushes; this is a no-op
   * when backend is laststore.
   */
  persist(): void {
    if (this.storeBin) {
      // Already flushed on apply. Ensure store dir exists.
      mkdirSync(this.lastStorePath, { recursive: true, mode: 0o700 });
      this.dirty = false;
      return;
    }
    // Memory-only hosts: refuse to write the old full-corpus JSON primary.
    // Callers must build search-store for durable index.
    this.dirty = false;
  }

  /**
   * Cold rebuild from an ordered list of batches (paged into LastStore).
   * Clears prior LastStore index when clear=true.
   */
  rebuildFromBatches(batches: IndexChangeBatch[], clear = true): {
    batches: number;
    changes: number;
    docs: number;
  } {
    if (!this.storeBin) {
      if (clear) {
        this.docs.clear();
        this.inverted.clear();
      }
      let changes = 0;
      for (const b of batches) changes += this.applyChangeBatch(b);
      this.persist();
      return { batches: batches.length, changes, docs: this.docs.size };
    }
    const dir = mkdtempSync(join(tmpdir(), "search-rebuild-"));
    try {
      batches.forEach((b, i) => {
        writeFileSync(join(dir, `b-${String(i).padStart(5, "0")}.json`), JSON.stringify(b));
      });
      const r = spawnSync(
        this.storeBin,
        [
          "rebuild",
          "--store",
          this.lastStorePath,
          "--batches-dir",
          dir,
          "--page-size",
          "8",
        ],
        { encoding: "utf8" },
      );
      if (r.status !== 0) {
        throw new Error(`search-store rebuild failed: ${r.stderr || r.stdout}`);
      }
      const report = JSON.parse(r.stdout) as {
        batches: number;
        changes: number;
        docs: number;
      };
      // Refresh memory from LastStore by re-applying (small sample).
      this.docs.clear();
      this.inverted.clear();
      for (const b of batches) {
        // memory only — LastStore already rebuilt
        const searchable = b.searchable_fields?.length
          ? new Set(b.searchable_fields)
          : null;
        for (const ch of b.changes) {
          if (ch.kind === "tombstone") continue;
          const id = docId(b.schema_name, ch.key_value.hash, ch.key_value.range);
          const text = fieldsToText(ch.fields_and_values, searchable);
          const tokens = tokenize(text);
          this.docs.set(id, {
            id,
            schema_name: b.schema_name,
            key_hash: ch.key_value.hash,
            key_range: ch.key_value.range,
            text,
            tokens,
            mutation_id: ch.mutation_id,
          });
          for (const t of tokens) {
            let set = this.inverted.get(t);
            if (!set) {
              set = new Set();
              this.inverted.set(t, set);
            }
            set.add(id);
          }
        }
      }
      this.lastStoreReady = true;
      this.dirty = false;
      return report;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  search(query: string, opts: SearchQueryOptions = {}): SearchHit[] {
    const k = opts.k ?? 20;
    // Prefer LastStore binary when memory empty but durable store ready
    // (process reopen case).
    if (this.docs.size === 0 && this.storeBin && this.lastStoreReady) {
      const args = [
        "query",
        query,
        "--store",
        this.lastStorePath,
        "--json",
        "--k",
        String(k),
      ];
      for (const s of opts.schemas ?? []) {
        args.push("--schema", s);
      }
      const r = spawnSync(this.storeBin, args, { encoding: "utf8" });
      if (r.status === 0) {
        try {
          const parsed = JSON.parse(r.stdout) as { hits?: SearchHit[] };
          return Array.isArray(parsed.hits) ? parsed.hits : [];
        } catch {
          /* fall through to memory */
        }
      }
    }

    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const schemaFilter =
      opts.schemas && opts.schemas.length > 0
        ? new Set(opts.schemas)
        : null;

    const scores = new Map<string, number>();
    const matchedTerms = new Map<string, number>();
    for (const t of qTokens) {
      const set = this.inverted.get(t);
      if (!set) continue;
      for (const id of set) {
        const doc = this.docs.get(id);
        if (!doc) continue;
        if (schemaFilter && !schemaFilter.has(doc.schema_name)) continue;
        const tf = doc.tokens.filter((x) => x === t).length;
        scores.set(id, (scores.get(id) ?? 0) + tf);
        matchedTerms.set(id, (matchedTerms.get(id) ?? 0) + 1);
      }
    }

    const ranked = [...scores.entries()]
      .map(([id, tfScore]) => {
        const terms = matchedTerms.get(id) ?? 0;
        const score = tfScore * (1 + terms / qTokens.length);
        return { id, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return ranked.map(({ id, score }) => {
      const doc = this.docs.get(id)!;
      return {
        schema_name: doc.schema_name,
        key_hash: doc.key_hash,
        key_range: doc.key_range,
        score,
        text: doc.text.slice(0, 500),
        mutation_id: doc.mutation_id,
      };
    });
  }
}

export function openSearchEngine(indexDir: string): SearchEngine {
  return new SearchEngine(indexDir);
}
