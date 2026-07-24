/**
 * SearchEngine — regenerable local keyword index for the first-party Search app.
 *
 * No FastEmbed/ONNX. Ingest is IndexChangeBatch (fold IndexSink wire). Query is
 * BM25-ish TF over an inverted index. Persists to a single JSON snapshot so
 * consumers and the CLI share one on-disk plane under apps/search/index.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fieldsToText, tokenize } from "./tokenize.ts";
import type {
  IndexChangeBatch,
  SearchHit,
  SearchQueryOptions,
} from "./types.ts";

export type { IndexChangeBatch, IndexChange, IndexChangeKind, KeyValue, SearchHit, SearchQueryOptions } from "./types.ts";

type DocRec = {
  id: string;
  schema_name: string;
  key_hash: string | null;
  key_range: string | null;
  text: string;
  tokens: string[];
  mutation_id?: string;
};

type Snapshot = {
  version: 1;
  docs: Record<string, DocRec>;
};

function docId(schema: string, hash: string | null, range: string | null): string {
  return `${schema}\u0000${hash ?? ""}\u0000${range ?? ""}`;
}

export class SearchEngine {
  readonly indexDir: string;
  private docs = new Map<string, DocRec>();
  private inverted = new Map<string, Set<string>>();
  private dirty = false;

  constructor(indexDir: string) {
    this.indexDir = indexDir;
    this.load();
  }

  private snapshotPath(): string {
    return join(this.indexDir, "keyword-index.v1.json");
  }

  private load(): void {
    const p = this.snapshotPath();
    if (!existsSync(p)) return;
    try {
      const snap = JSON.parse(readFileSync(p, "utf8")) as Snapshot;
      if (snap.version !== 1 || !snap.docs) return;
      this.docs.clear();
      this.inverted.clear();
      for (const [id, doc] of Object.entries(snap.docs)) {
        this.docs.set(id, doc);
        for (const t of doc.tokens) {
          let set = this.inverted.get(t);
          if (!set) {
            set = new Set();
            this.inverted.set(t, set);
          }
          set.add(id);
        }
      }
    } catch {
      /* corrupt snapshot — start empty; regenerable */
    }
  }

  persist(): void {
    if (!this.dirty) return;
    const snap: Snapshot = { version: 1, docs: {} };
    for (const [id, doc] of this.docs) snap.docs[id] = doc;
    const p = this.snapshotPath();
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
    renameSync(tmp, p);
    this.dirty = false;
  }

  /** Apply one fold IndexChangeBatch. */
  applyChangeBatch(batch: IndexChangeBatch): number {
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

  get size(): number {
    return this.docs.size;
  }

  /**
   * Keyword search: score = sum of tf for query tokens present in doc,
   * boosted by how many query terms match. Empty query → [].
   */
  search(query: string, opts: SearchQueryOptions = {}): SearchHit[] {
    const k = opts.k ?? 20;
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
        // Prefer docs matching more distinct query terms.
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
