/**
 * Local all-MiniLM-L6-v2 embedder.
 *
 * Prefer `@xenova/transformers` (ONNX, same model family as fold FastEmbed).
 * Falls back to DeterministicMiniLmCompatEmbedder only when the package is
 * unavailable — callers should surface degraded health in that case.
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
  private fallback: DeterministicMiniLmCompatEmbedder | null = null;

  get lastInitError(): string | null {
    return this.initError;
  }

  get usingNeural(): boolean {
    return this.pipe !== null;
  }

  async init(): Promise<void> {
    if (this.pipe || this.initError) return;
    try {
      // Dynamic import keeps CI/bootstrap working when the package is absent.
      const mod = await import("@xenova/transformers");
      const pipeline = mod.pipeline as (
        task: string,
        model: string,
      ) => Promise<FeaturePipeline>;
      this.pipe = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
      );
    } catch (e) {
      this.initError = e instanceof Error ? e.message : String(e);
      this.fallback = new DeterministicMiniLmCompatEmbedder();
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.init();
    if (this.pipe) {
      const out: number[][] = [];
      for (const t of texts) {
        const res = await this.pipe(t, { pooling: "mean", normalize: true });
        const data = Array.from(res.data as ArrayLike<number>);
        // Ensure 384-d
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
    return this.fallback!.embed(texts);
  }
}

export async function createDefaultEmbedder(): Promise<{
  embedder: Embedder;
  healthDetail: string;
  neural: boolean;
}> {
  const mode = (process.env.SEARCH_EMBEDDER ?? "auto").trim().toLowerCase();
  if (mode === "deterministic" || mode === "mock") {
    return {
      embedder: new DeterministicMiniLmCompatEmbedder(),
      healthDetail: "deterministic MiniLM-compatible embedder",
      neural: false,
    };
  }
  if (mode === "fastembed" || mode === "auto") {
    const fe = new FastEmbedEmbedder();
    await fe.init();
    if (fe.usingNeural) {
      return {
        embedder: fe,
        healthDetail: "FastEmbed/Xenova all-MiniLM-L6-v2",
        neural: true,
      };
    }
    if (mode === "fastembed") {
      // Explicit request: still return FastEmbed wrapper (may use fallback).
      return {
        embedder: fe,
        healthDetail: `FastEmbed requested; neural init failed (${fe.lastInitError}); using deterministic fallback`,
        neural: false,
      };
    }
    // auto: prefer deterministic without download surprise in constrained envs
    // unless SEARCH_EMBEDDER=fastembed forced neural.
    if (process.env.SEARCH_ALLOW_DETERMINISTIC !== "0") {
      return {
        embedder: new DeterministicMiniLmCompatEmbedder(),
        healthDetail: `auto: neural unavailable (${fe.lastInitError ?? "no package"}); deterministic`,
        neural: false,
      };
    }
  }
  return {
    embedder: new DeterministicMiniLmCompatEmbedder(),
    healthDetail: "default deterministic",
    neural: false,
  };
}
