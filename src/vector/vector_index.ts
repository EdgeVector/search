/**
 * In-memory + JSON-durable vector index with structural schema scope.
 * Scoped search only scores vectors whose schema_name is in the allow-set
 * (never global top-k then filter).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cosine, type Embedder } from "./embedder.ts";

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

type Snapshot = {
  version: 1;
  embedder_id: string;
  dimensions: number;
  records: VectorRecord[];
};

export class VectorIndex {
  private records = new Map<string, VectorRecord>();
  private bySchema = new Map<string, Set<string>>();
  readonly storePath: string;
  embedderId = "";
  dimensions = 0;

  constructor(storePath: string) {
    this.storePath = storePath;
    this.load();
  }

  get size(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
    this.bySchema.clear();
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
    const exact = opts.exact === true;
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

  persist(): void {
    mkdirSync(dirname(this.storePath), { recursive: true, mode: 0o700 });
    const snap: Snapshot = {
      version: 1,
      embedder_id: this.embedderId,
      dimensions: this.dimensions,
      records: [...this.records.values()],
    };
    const tmp = `${this.storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, this.storePath);
  }

  private load(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const snap = JSON.parse(readFileSync(this.storePath, "utf8")) as Snapshot;
      if (snap.version !== 1 || !Array.isArray(snap.records)) return;
      this.clear();
      for (const r of snap.records) this.upsert(r);
    } catch {
      /* empty */
    }
  }
}

export function defaultVectorStorePath(searchHome: string): string {
  return join(searchHome, "vector-index.v1.json");
}
