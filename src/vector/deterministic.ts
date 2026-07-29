/**
 * Deterministic 384-d embedder for tests and offline CI.
 * Same dimensions as all-MiniLM-L6-v2 so storage layout matches FastEmbed.
 * Not a neural model — production prefers FastEmbedEmbedder when available.
 */

import {
  type Embedder,
  l2Normalize,
  MINILM_L6_V2_DIMS,
  MINILM_L6_V2_ID,
} from "./embedder.ts";

export class DeterministicMiniLmCompatEmbedder implements Embedder {
  readonly id = `${MINILM_L6_V2_ID}+deterministic`;
  readonly dimensions = MINILM_L6_V2_DIMS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    const lower = text.toLowerCase();
    // Character 3-grams + token hashes into fixed bins (semantic-ish for tests).
    for (let i = 0; i < lower.length; i++) {
      const c = lower.charCodeAt(i);
      v[c % this.dimensions]! += 1;
      if (i + 2 < lower.length) {
        const g =
          (lower.charCodeAt(i) * 131 +
            lower.charCodeAt(i + 1) * 17 +
            lower.charCodeAt(i + 2)) %
          this.dimensions;
        v[g]! += 1.5;
      }
    }
    for (const tok of lower.match(/[a-z0-9_]+/g) ?? []) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % this.dimensions;
      v[idx]! += 3;
    }
    return l2Normalize(v);
  }
}
