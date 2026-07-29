/**
 * Semantic Search plane — FastEmbed (or compatible) + schema-scoped vector index.
 */

import type { IndexChangeBatch } from "../types.ts";
import {
  type Embedder,
  type VectorHealth,
  type VectorHealthState,
} from "./embedder.ts";
import { createDefaultEmbedder } from "./fastembed.ts";
import {
  fieldsToIndexText,
  selectIndexableFields,
  type FieldClassifications,
} from "./field_policy.ts";
import {
  defaultVectorStorePath,
  type SemanticHit,
  type SemanticQueryOpts,
  VectorIndex,
} from "./vector_index.ts";

export type SemanticPlaneOptions = {
  searchHome: string;
  vectorStorePath?: string;
  /** Inject embedder (tests). */
  embedder?: Embedder;
  /** Force health detail. */
  healthDetail?: string;
  neural?: boolean;
};

export class SemanticSearchPlane {
  readonly index: VectorIndex;
  private embedder: Embedder | null = null;
  private state: VectorHealthState = "disabled";
  private detail = "";
  private neural = false;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly opts: SemanticPlaneOptions) {
    const path =
      opts.vectorStorePath ?? defaultVectorStorePath(opts.searchHome);
    this.index = new VectorIndex(path);
    if (opts.embedder) {
      this.embedder = opts.embedder;
      this.state = "healthy";
      this.detail = opts.healthDetail ?? `injected ${opts.embedder.id}`;
      this.neural = opts.neural ?? false;
    }
  }

  async ensureReady(): Promise<void> {
    if (this.embedder && this.state === "healthy") return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    this.state = "starting";
    try {
      if (!this.embedder) {
        const created = await createDefaultEmbedder();
        this.embedder = created.embedder;
        this.detail = created.healthDetail;
        this.neural = created.neural;
      }
      // Warm embed
      await this.embedder.embed(["search-plane-warmup"]);
      this.state = "healthy";
    } catch (e) {
      this.state = "degraded";
      this.detail = e instanceof Error ? e.message : String(e);
    }
  }

  health(): VectorHealth {
    return {
      state: this.state,
      embedder_id: this.embedder?.id ?? null,
      dimensions: this.embedder?.dimensions ?? null,
      vectors: this.index.size,
      detail: this.detail || undefined,
    };
  }

  async applyBatch(
    batch: IndexChangeBatch,
    classifications?: FieldClassifications | null,
  ): Promise<number> {
    await this.ensureReady();
    if (!this.embedder || this.state === "disabled") return 0;
    let n = 0;
    for (const ch of batch.changes) {
      if (ch.kind === "tombstone") {
        n += this.index.removeByKey(
          batch.schema_name,
          ch.key_value.hash,
          ch.key_value.range,
        );
        continue;
      }
      const fields = selectIndexableFields(
        ch.fields_and_values,
        batch.searchable_fields,
        classifications,
      );
      const text = fieldsToIndexText(fields);
      await this.index.indexText(this.embedder, {
        schema_name: batch.schema_name,
        key_hash: ch.key_value.hash,
        key_range: ch.key_value.range,
        fragment_key: "body",
        text,
        mutation_id: ch.mutation_id,
      });
      n++;
    }
    this.index.persist();
    return n;
  }

  async query(q: string, opts: SemanticQueryOpts = {}): Promise<SemanticHit[]> {
    await this.ensureReady();
    if (!this.embedder || this.state === "disabled") return [];
    return this.index.semanticSearch(this.embedder, q, opts);
  }

  /**
   * Re-embed plain text docs (e.g. from keyword plane) while the host daemon
   * stays up — online backfill path without exclusive store open.
   */
  async indexPlainDocs(
    docs: Array<{
      schema_name: string;
      key_hash: string | null;
      key_range: string | null;
      text: string;
      mutation_id?: string;
    }>,
  ): Promise<number> {
    await this.ensureReady();
    if (!this.embedder) return 0;
    let n = 0;
    for (const d of docs) {
      if (!d.text.trim()) continue;
      await this.index.indexText(this.embedder, {
        schema_name: d.schema_name,
        key_hash: d.key_hash,
        key_range: d.key_range,
        text: d.text,
        mutation_id: d.mutation_id,
      });
      n++;
    }
    this.index.persist();
    return n;
  }
}

export function openSemanticPlane(
  searchHome: string,
  opts?: Partial<SemanticPlaneOptions>,
): SemanticSearchPlane {
  return new SemanticSearchPlane({ searchHome, ...opts });
}
