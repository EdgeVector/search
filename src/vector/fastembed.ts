/**
 * Local all-MiniLM-L6-v2 embedder (real neural model).
 *
 * Production default: `@xenova/transformers` ONNX pipeline
 * `Xenova/all-MiniLM-L6-v2` (384-d, mean-pool, L2-normalized) — same family as
 * fold FastEmbed. Deterministic embedder is **tests/CI only**
 * (`SEARCH_EMBEDDER=deterministic`).
 */

import {
  type Embedder,
  l2Normalize,
  MINILM_L6_V2_DIMS,
  MINILM_L6_V2_ID,
} from "./embedder.ts";
import { DeterministicMiniLmCompatEmbedder } from "./deterministic.ts";

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
          `then retry. For offline unit tests only: SEARCH_EMBEDDER=deterministic.`,
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
  neural: boolean;
}> {
  // Production default is real MiniLM. Deterministic is explicit opt-in for CI/tests.
  const mode = (process.env.SEARCH_EMBEDDER ?? "fastembed").trim().toLowerCase();
  if (mode === "deterministic" || mode === "mock") {
    return {
      embedder: new DeterministicMiniLmCompatEmbedder(),
      healthDetail: "deterministic MiniLM-compatible embedder (tests/CI only)",
      neural: false,
    };
  }

  // fastembed | auto | neural | real → neural path
  if (
    mode === "fastembed" ||
    mode === "auto" ||
    mode === "neural" ||
    mode === "real" ||
    mode === "minilm"
  ) {
    const fe = new FastEmbedEmbedder();
    try {
      await fe.init();
    } catch (e) {
      // auto may fall back only when explicitly allowed (legacy / constrained envs).
      if (
        mode === "auto" &&
        process.env.SEARCH_ALLOW_DETERMINISTIC === "1"
      ) {
        return {
          embedder: new DeterministicMiniLmCompatEmbedder(),
          healthDetail: `auto: neural unavailable (${e instanceof Error ? e.message : e}); deterministic`,
          neural: false,
        };
      }
      throw e;
    }
    return {
      embedder: fe,
      healthDetail: "FastEmbed/Xenova all-MiniLM-L6-v2 (neural, 384-d)",
      neural: true,
    };
  }

  throw new Error(
    `Unknown SEARCH_EMBEDDER=${mode} (use fastembed|auto|deterministic)`,
  );
}
