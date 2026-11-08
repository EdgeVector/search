/**
 * Semantic Search plane — FastEmbed (or compatible) + schema-scoped vector index.
 */

import type { IndexChangeBatch } from "../types.ts";
import { DRAIN_ON_QUERY_MAX_FILES, drainInbox } from "../inbox.ts";
import { join } from "node:path";
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
  inboxDir?: string;
  vectorStorePath?: string;
  /** Inject embedder (tests). */
  embedder?: Embedder;
  /** Force health detail. */
  healthDetail?: string;
};

export class SemanticSearchPlane {
  readonly index: VectorIndex;
  private embedder: Embedder | null = null;
  private state: VectorHealthState = "disabled";
  private detail = "";
  private initPromise: Promise<void> | null = null;

  constructor(private readonly opts: SemanticPlaneOptions) {
    const path =
      opts.vectorStorePath ?? defaultVectorStorePath(opts.searchHome);
    this.index = new VectorIndex(path);
    if (opts.embedder) {
      this.embedder = opts.embedder;
      this.state = "healthy";
      this.detail = opts.healthDetail ?? `injected ${opts.embedder.id}`;
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
      }
      // Warm embed
      await this.embedder.embed(["search-plane-warmup"]);
      this.state = "healthy";
    } catch (e) {
      this.state = "degraded";
      this.detail = e instanceof Error ? e.message : String(e);
      // A swallowed init failure would leave the plane degraded with no operator signal.
      console.error(`[search] semantic plane degraded: ${this.detail}`);
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

  private async readyWriter(): Promise<Embedder> {
    await this.ensureReady();
    if (!this.embedder || this.state !== "healthy") {
      throw new Error(`Cannot write Search batch: ${this.detail || this.state}`);
    }
    return this.embedder;
  }

  private async writeBatch(
    embedder: Embedder,
    batch: IndexChangeBatch,
    classifications?: FieldClassifications | null,
    opts?: { skipIfFresh?: boolean },
  ): Promise<number> {
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
        ch.record_fields ?? ch.fields_and_values,
        batch.searchable_fields,
        classifications,
      );
      const text = fieldsToIndexText(fields);
      const action = await this.index.indexText(
        embedder,
        {
          schema_name: batch.schema_name,
          key_hash: ch.key_value.hash,
          key_range: ch.key_value.range,
          fragment_key: "body",
          text,
          mutation_id: ch.mutation_id,
        },
        { skipIfFresh: opts?.skipIfFresh },
      );
      if (action !== "removed") n++;
    }
    return n;
  }

  async applyBatch(
    batch: IndexChangeBatch,
    classifications?: FieldClassifications | null,
    opts?: { skipIfFresh?: boolean },
  ): Promise<number> {
    const embedder = await this.readyWriter();
    return this.index.withWriter(() =>
      this.writeBatch(embedder, batch, classifications, opts)
    );
  }

  /** Keep the writer boundary through durable request removal. */
  async drainInbox(
    opts?: Omit<Parameters<typeof drainInbox>[1], "onBatch"> & {
      skipIfFresh?: boolean;
    },
  ): Promise<Awaited<ReturnType<typeof drainInbox>>> {
    const embedder = await this.readyWriter();
    return this.index.withWriter(() =>
      drainInbox(this.opts.inboxDir ?? join(this.opts.searchHome, "inbox"), {
        ...opts,
        onBatch: async (batch) => {
          await this.writeBatch(embedder, batch, null, opts);
          this.index.persist();
        },
      })
    );
  }

  async query(q: string, opts: SemanticQueryOpts = {}): Promise<SemanticHit[]> {
    await this.ensureReady();
    if (!this.embedder || this.state === "disabled") return [];
    await this.drainInbox({ maxFiles: DRAIN_ON_QUERY_MAX_FILES });
    return this.index.semanticSearch(this.embedder, q, opts);
  }
}

export function openSemanticPlane(
  searchHome: string,
  opts?: Partial<SemanticPlaneOptions>,
): SemanticSearchPlane {
  return new SemanticSearchPlane({ searchHome, ...opts });
}
