/**
 * Embedder contract for the Search semantic plane.
 * Production default model identity matches fold FastEmbed: all-MiniLM-L6-v2 (384-d).
 */

export const MINILM_L6_V2_ID = "all-MiniLM-L6-v2";
export const MINILM_L6_V2_DIMS = 384;

export type VectorHealthState =
  | "disabled"
  | "starting"
  | "healthy"
  | "degraded";

export type Embedder = {
  /** Stable model id stored with each vector. */
  readonly id: string;
  readonly dimensions: number;
  /** L2-normalized embedding rows, one per input string. */
  embed(texts: string[]): Promise<number[][]>;
};

export type VectorHealth = {
  state: VectorHealthState;
  embedder_id: string | null;
  dimensions: number | null;
  vectors: number;
  detail?: string;
};

export function l2Normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}
