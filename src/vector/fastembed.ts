/**
 * Local all-MiniLM-L6-v2 embedder (real neural model).
 *
 * Production default: `@xenova/transformers` ONNX pipeline
 * `Xenova/all-MiniLM-L6-v2` (384-d, mean-pool, L2-normalized).
 */

import {
  type Embedder,
  l2Normalize,
  MINILM_L6_V2_DIMS,
  MINILM_L6_V2_ID,
} from "./embedder.ts";

type FeaturePipeline = (
  text: string,
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

export class FastEmbedEmbedder implements Embedder {
  readonly id = MINILM_L6_V2_ID;
  readonly dimensions = MINILM_L6_V2_DIMS;
  private pipe: FeaturePipeline | null = null;
  private initError: string | null = null;

  get lastInitError(): string | null {
    return this.initError;
  }

  get usingNeural(): boolean {
    return this.pipe !== null;
  }

  async init(): Promise<void> {
    if (this.pipe) return;
    if (this.initError && !this.pipe) {
      // allow retry after install fix
    }
    try {
      // Dynamic import: package is a declared dependency; sharp native must be
      // present (npm install postinstall) or this throws.
      const mod = await import("@xenova/transformers");
      const pipeline = mod.pipeline as (
        task: string,
        model: string,
      ) => Promise<FeaturePipeline>;
      this.pipe = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
      );
      this.initError = null;
    } catch (e) {
      this.initError = e instanceof Error ? e.message : String(e);
      this.pipe = null;
      throw new Error(
        `Search neural embedder failed to load (all-MiniLM-L6-v2 via @xenova/transformers): ${this.initError}\n` +
          `Fix: from the Search install root run \`npm install\` (not bun-only) so sharp's native binary installs, ` +
          `then retry.`,
      );
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.init();
    if (!this.pipe) {
      throw new Error(
        `Search neural embedder not initialized: ${this.initError ?? "unknown"}`,
      );
    }
    const out: number[][] = [];
    for (const t of texts) {
      const res = await this.pipe(t, { pooling: "mean", normalize: true });
      const data = Array.from(res.data as ArrayLike<number>);
      if (data.length !== this.dimensions) {
        const padded = new Array(this.dimensions).fill(0);
        for (let i = 0; i < Math.min(data.length, this.dimensions); i++) {
          padded[i] = data[i];
        }
        out.push(l2Normalize(padded));
      } else {
        out.push(data);
      }
    }
    return out;
  }
}

export async function createDefaultEmbedder(): Promise<{
  embedder: Embedder;
  healthDetail: string;
}> {
  const fe = new FastEmbedEmbedder();
  await fe.init();
  return {
    embedder: fe,
    healthDetail: "FastEmbed/Xenova all-MiniLM-L6-v2 (neural, 384-d)",
  };
}
