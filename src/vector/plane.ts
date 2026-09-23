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
import { isProductionSearchHome } from "../paths.ts";
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
    this.index = new VectorIndex(path, opts.searchHome);
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
        if (!created.neural && isProductionSearchHome(this.opts.searchHome)) {
          throw new Error(
            `Refusing non-neural (${created.embedder.id}) embedder for the production Search ` +
              `index home (${this.opts.searchHome}). Fix the neural embedder init (npm install so ` +
              `sharp's native binary installs) — deterministic embeddings are test/CI-only and ` +
              `point SEARCH_HOME at a temp dir for tests.`,
          );
        }
        this.embedder = created.embedder;
        this.detail = created.healthDetail;
      }
      // Warm embed
      await this.embedder.embed(["search-plane-warmup"]);
      this.state = "healthy";
    } catch (e) {
      this.state = "degraded";
      this.detail = e instanceof Error ? e.message : String(e);
      // Loud on purpose: a silently swallowed init failure is how deterministic
      // vectors reached production before (auto-fallback with no console output).
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

  async applyBatch(
    batch: IndexChangeBatch,
    classifications?: FieldClassifications | null,
    opts?: { skipIfFresh?: boolean },
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
      const action = await this.index.indexText(
        this.embedder,
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
    this.index.persist();
    return n;
  }

  async query(q: string, opts: SemanticQueryOpts = {}): Promise<SemanticHit[]> {
    await this.ensureReady();
    if (!this.embedder || this.state === "disabled") return [];
    await drainInbox(join(this.opts.searchHome, "inbox"), {
      maxFiles: DRAIN_ON_QUERY_MAX_FILES,
      onBatch: async (batch) => {
        await this.applyBatch(batch);
      },
    });
    return this.index.semanticSearch(this.embedder, q, opts);
  }

  /**
   * Re-embed plain text docs while the host daemon stays up — online backfill
   * without exclusive store open.
   *
   * Resumable: skips vectors that are already fresh under the current embedder
   * (same mutation_id + text, or same text when mutation_id is absent) and
   * flushes the durable vector snapshot every `flushEvery` embeds (default 50)
   * so Ctrl-C keeps progress.
   */
  async indexPlainDocs(
    docs: Array<{
      schema_name: string;
      key_hash: string | null;
      key_range: string | null;
      text: string;
      mutation_id?: string;
    }>,
    opts?: {
      skipIfFresh?: boolean;
      /** Persist after this many *new* embeds (not skips). Default 50. */
      flushEvery?: number;
      force?: boolean;
      /** Called after each doc (including skips) for progress bars. */
      onProgress?: (p: {
        done: number;
        total: number;
        embedded: number;
        skipped: number;
        flushes: number;
      }) => void;
    },
  ): Promise<{
    embedded: number;
    skipped: number;
    removed: number;
    flushes: number;
  }> {
    await this.ensureReady();
    if (!this.embedder) {
      return { embedded: 0, skipped: 0, removed: 0, flushes: 0 };
    }
    const skipIfFresh = opts?.force ? false : (opts?.skipIfFresh ?? true);
    const flushEvery = Math.max(1, opts?.flushEvery ?? 50);
    const total = docs.length;
    let embedded = 0;
    let skipped = 0;
    let removed = 0;
    let flushes = 0;
    let sinceFlush = 0;
    let done = 0;
    for (const d of docs) {
      if (!d.text.trim()) {
        done++;
        opts?.onProgress?.({ done, total, embedded, skipped, flushes });
        continue;
      }
      const action = await this.index.indexText(
        this.embedder,
        {
          schema_name: d.schema_name,
          key_hash: d.key_hash,
          key_range: d.key_range,
          text: d.text,
          mutation_id: d.mutation_id,
        },
        { skipIfFresh },
      );
      if (action === "skipped") {
        skipped++;
      } else if (action === "removed") {
        removed++;
      } else {
        embedded++;
        sinceFlush++;
        if (sinceFlush >= flushEvery) {
          this.index.persist();
          flushes++;
          sinceFlush = 0;
        }
      }
      done++;
      opts?.onProgress?.({ done, total, embedded, skipped, flushes });
    }
    if (sinceFlush > 0) {
      this.index.persist();
      flushes++;
    }
    opts?.onProgress?.({ done, total, embedded, skipped, flushes });
    return { embedded, skipped, removed, flushes };
  }
}

export function openSemanticPlane(
  searchHome: string,
  opts?: Partial<SemanticPlaneOptions>,
): SemanticSearchPlane {
  return new SemanticSearchPlane({ searchHome, ...opts });
}
