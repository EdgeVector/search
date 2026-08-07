/**
 * In-memory vector index with structural schema scope, durable via a binary
 * snapshot plus an append-only op log (see ./store.ts).
 *
 * Scoped search only scores vectors whose schema_name is in the allow-set
 * (never global top-k then filter).
 *
 * `persist()` writes only what changed since the last flush. It used to
 * re-serialize the entire index to JSON every call, which made a flush cost
 * O(total index) no matter how few records moved — that is what froze the
 * machine on 2026-08-07.
 */

import { dirname, join } from "node:path";
import { cosine, type Embedder } from "./embedder.ts";
import { isProductionSearchHome } from "../paths.ts";
import {
  appendOps,
  fileSize,
  loadStore,
  removeIfPresent,
  storePaths,
  writeSnapshot,
  STORE_VERSION,
  type StoreOp,
  type StorePaths,
} from "./store.ts";

export type VectorRecord = {
  id: string;
  schema_name: string;
  key_hash: string | null;
  key_range: string | null;
  fragment_key: string;
  text: string;
  embedder_id: string;
  vector: number[];
  mutation_id?: string;
};

export type SemanticHit = {
  schema_name: string;
  key_hash: string | null;
  key_range: string | null;
  fragment_key: string;
  score: number;
  text: string;
  mutation_id?: string;
};

export type SemanticQueryOpts = {
  k?: number;
  /** Structural schema allow-list (identity hashes or display names). */
  schemas?: string[];
  exact?: boolean;
  min_score?: number;
};

function recId(
  schema: string,
  hash: string | null,
  range: string | null,
  fragment: string,
): string {
  return `${schema}\u0000${hash ?? ""}\u0000${range ?? ""}\u0000${fragment}`;
}

/**
 * Compact once the log exceeds this fraction of the snapshot. Bounds total
 * write amplification to roughly (1 + 1/COMPACT_RATIO) x bytes logged while
 * keeping compactions rare; the floor stops tiny indexes compacting constantly.
 */
const COMPACT_RATIO = 0.5;
const COMPACT_FLOOR_BYTES = 8 * 1024 * 1024;

export class VectorIndex {
  private records = new Map<string, VectorRecord>();
  private bySchema = new Map<string, Set<string>>();
  /** Ids upserted since the last flush. */
  private dirty = new Set<string>();
  /** Ids removed since the last flush. */
  private removed = new Set<string>();
  readonly storePath: string;
  readonly paths: StorePaths;
  /** Search home used only for the production-write guard below, not I/O. */
  readonly searchHome: string;
  embedderId = "";
  dimensions = 0;

  constructor(storePath: string, searchHome?: string) {
    this.storePath = storePath;
    this.paths = storePaths(storePath);
    this.searchHome = searchHome ?? dirname(storePath);
    this.load();
  }

  get size(): number {
    return this.records.size;
  }

  /** Vector count per schema_name (structural key — usually a schema identity hash). */
  countsBySchema(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [schema, set] of this.bySchema) out[schema] = set.size;
    return out;
  }

  /** Vector count per embedder_id, e.g. distinguishing real neural runs from
   * the `+deterministic` compat embedder that must never carry production
   * coverage (see field_policy note on deterministic vectors). */
  embedderBreakdown(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const rec of this.records.values()) {
      out[rec.embedder_id] = (out[rec.embedder_id] ?? 0) + 1;
    }
    return out;
  }

  clear(): void {
    this.records.clear();
    this.bySchema.clear();
    this.dirty.clear();
    this.removed.clear();
  }

  upsert(rec: VectorRecord): void {
    const prev = this.records.get(rec.id);
    if (prev) this.unlinkSchema(prev.schema_name, rec.id);
    this.records.set(rec.id, rec);
    let set = this.bySchema.get(rec.schema_name);
    if (!set) {
      set = new Set();
      this.bySchema.set(rec.schema_name, set);
    }
    set.add(rec.id);
    this.embedderId = rec.embedder_id;
    this.dimensions = rec.vector.length;
    this.dirty.add(rec.id);
    this.removed.delete(rec.id);
  }

  removeByKey(
    schema: string,
    hash: string | null,
    range: string | null,
  ): number {
    let n = 0;
    for (const id of [...this.records.keys()]) {
      const rec = this.records.get(id);
      if (
        rec &&
        rec.schema_name === schema &&
        rec.key_hash === hash &&
        rec.key_range === range
      ) {
        this.unlinkSchema(rec.schema_name, id);
        this.records.delete(id);
        this.dirty.delete(id);
        this.removed.add(id);
        n++;
      }
    }
    return n;
  }

  private unlinkSchema(schema: string, id: string): void {
    const set = this.bySchema.get(schema);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.bySchema.delete(schema);
  }

  /**
   * Schema-scoped k-NN. When schemas is set and non-empty, only those
   * schemas' vectors are scored (structural scope).
   */
  search(queryVec: number[], opts: SemanticQueryOpts = {}): SemanticHit[] {
    const k = opts.k ?? 20;
    const minScore = opts.min_score ?? Number.NEGATIVE_INFINITY;
    const allowed =
      opts.schemas && opts.schemas.length > 0
        ? new Set(opts.schemas)
        : null;

    const candidateIds: string[] = [];
    if (allowed) {
      for (const schema of allowed) {
        const set = this.bySchema.get(schema);
        if (set) for (const id of set) candidateIds.push(id);
      }
    } else {
      for (const id of this.records.keys()) candidateIds.push(id);
    }

    const scored: SemanticHit[] = [];
    for (const id of candidateIds) {
      const rec = this.records.get(id);
      if (!rec) continue;
      if (allowed && !allowed.has(rec.schema_name)) continue; // belt
      const score = cosine(queryVec, rec.vector);
      if (score < minScore) continue;
      scored.push({
        schema_name: rec.schema_name,
        key_hash: rec.key_hash,
        key_range: rec.key_range,
        fragment_key: rec.fragment_key,
        score,
        text: rec.text,
        mutation_id: rec.mutation_id,
      });
    }
    scored.sort((a, b) => b.score - a.score || a.schema_name.localeCompare(b.schema_name));
    let out = scored.slice(0, Math.max(1, k));
    // exact substring gate applied by caller who has query string — see semanticSearch
    return out;
  }

  async semanticSearch(
    embedder: Embedder,
    query: string,
    opts: SemanticQueryOpts = {},
  ): Promise<SemanticHit[]> {
    const [qvec] = await embedder.embed([query]);
    let hits = this.search(qvec!, opts);
    if (opts.exact) {
      const needle = query.toLowerCase();
      hits = hits.filter((h) => h.text.toLowerCase().includes(needle));
    }
    return hits;
  }

  get(
    schema: string,
    hash: string | null,
    range: string | null,
    fragment = "body",
  ): VectorRecord | undefined {
    return this.records.get(recId(schema, hash, range, fragment));
  }

  /**
   * True when an existing vector is still valid for this text/mutation under
   * the same embedder — used so online-backfill can skip re-embedding.
   */
  isFresh(
    embedder: Embedder,
    args: {
      schema_name: string;
      key_hash: string | null;
      key_range: string | null;
      fragment_key?: string;
      text: string;
      mutation_id?: string;
    },
  ): boolean {
    const fragment = args.fragment_key ?? "body";
    const text = args.text.trim();
    if (!text) return false;
    const prev = this.get(
      args.schema_name,
      args.key_hash,
      args.key_range,
      fragment,
    );
    if (!prev) return false;
    if (prev.embedder_id !== embedder.id) return false;
    if (prev.vector.length !== embedder.dimensions) return false;
    // Prefer mutation identity when both sides have it (product writes).
    if (args.mutation_id && prev.mutation_id) {
      return prev.mutation_id === args.mutation_id && prev.text === text;
    }
    return prev.text === text;
  }

  /**
   * Embed and upsert. Returns whether a new embed ran (`embedded`) or an
   * existing fresh vector was kept (`skipped`). With `skipIfFresh` (default
   * false for live apply; true for backfill), already-indexed docs are free.
   */
  async indexText(
    embedder: Embedder,
    args: {
      schema_name: string;
      key_hash: string | null;
      key_range: string | null;
      fragment_key?: string;
      text: string;
      mutation_id?: string;
    },
    opts?: { skipIfFresh?: boolean },
  ): Promise<"embedded" | "skipped" | "removed"> {
    const fragment = args.fragment_key ?? "body";
    const text = args.text.trim();
    if (!text) {
      this.removeByKey(args.schema_name, args.key_hash, args.key_range);
      return "removed";
    }
    if (opts?.skipIfFresh && this.isFresh(embedder, { ...args, text })) {
      return "skipped";
    }
    if (embedder.id.includes("+deterministic") && isProductionSearchHome(this.searchHome)) {
      throw new Error(
        `Refusing to write a deterministic vector (embedder_id=${embedder.id}) into the ` +
          `production Search index home (${this.searchHome}). Deterministic embeddings are ` +
          `test/CI-only; this check is independent of SEARCH_EMBEDDER/SEARCH_ALLOW_DETERMINISTIC ` +
          `so it cannot be routed around by env config.`,
      );
    }
    const [vec] = await embedder.embed([text]);
    this.upsert({
      id: recId(args.schema_name, args.key_hash, args.key_range, fragment),
      schema_name: args.schema_name,
      key_hash: args.key_hash,
      key_range: args.key_range,
      fragment_key: fragment,
      text,
      embedder_id: embedder.id,
      vector: vec!,
      mutation_id: args.mutation_id,
    });
    return "embedded";
  }

  private header() {
    return {
      version: STORE_VERSION,
      embedder_id: this.embedderId,
      dimensions: this.dimensions,
    };
  }

  /** Bytes pending in the log — exposed so callers can reason about flushes. */
  get pendingChanges(): number {
    return this.dirty.size + this.removed.size;
  }

  /**
   * Durably record everything changed since the last call.
   *
   * Appends one frame per changed record, then compacts if the log has grown
   * past COMPACT_RATIO of the snapshot. Cost is O(changed), not O(index).
   */
  persist(): void {
    if (this.dirty.size === 0 && this.removed.size === 0) return;

    const ops: StoreOp[] = [];
    for (const id of this.dirty) {
      const rec = this.records.get(id);
      if (rec) ops.push({ op: "upsert", rec });
    }
    for (const id of this.removed) ops.push({ op: "delete", id });

    appendOps(this.paths.log, this.header(), ops);
    this.dirty.clear();
    this.removed.clear();

    const logBytes = fileSize(this.paths.log);
    const snapBytes = fileSize(this.paths.snapshot);
    if (logBytes > Math.max(COMPACT_FLOOR_BYTES, snapBytes * COMPACT_RATIO)) {
      this.compact();
    }
  }

  /**
   * Fold the log into a fresh snapshot and drop it. Streams record-by-record,
   * so peak memory does not scale with snapshot size.
   */
  compact(): void {
    writeSnapshot(this.paths.snapshot, this.header(), this.records.values());
    removeIfPresent(this.paths.log);
  }

  private load(): void {
    const loaded = loadStore(this.paths);
    if (!loaded.header && loaded.ops.length === 0) return;

    this.clear();
    for (const op of loaded.ops) {
      if (op.op === "upsert") this.upsert(op.rec);
      else {
        const rec = this.records.get(op.id);
        if (rec) {
          this.unlinkSchema(rec.schema_name, op.id);
          this.records.delete(op.id);
        }
      }
    }
    if (loaded.header) {
      this.embedderId = loaded.header.embedder_id || this.embedderId;
      this.dimensions = loaded.header.dimensions || this.dimensions;
    }

    // Replaying is not a change: nothing above needs writing back.
    this.dirty.clear();
    this.removed.clear();

    // A legacy v1 index becomes a v2 snapshot once, so the next flush is cheap.
    if (loaded.migratedFromLegacy) this.compact();
  }
}

export function defaultVectorStorePath(searchHome: string): string {
  return join(searchHome, "vector-index.v1.json");
}
