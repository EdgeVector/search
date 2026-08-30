/**
 * Coverage health for `search status` / `vector-status`.
 *
 * "Healthy" from the vector plane alone only means internally consistent
 * (model loaded, index file readable) — it says nothing about how much of
 * the source corpus actually made it into the index. This module turns
 * vectors-held-vs-source-records-available into the health signal.
 */
import { isContentSchema, type SchemaCorpusCounts } from "./vector/corpus_counts.ts";

export const DEFAULT_COVERAGE_FLOOR = 0.95;

/**
 * Only these apps currently push IndexChangeBatch traffic into Search's
 * inbox (see BRAIN_SEARCH_URL / FKANBAN_SEARCH_URL in doctor.ts). Every
 * other app in the LastDB schema catalog — lastgit, dogfood-graph, remote,
 * starter-seed fixtures, etc. — was never wired to feed Search at all, so a
 * schema sitting at 0 vectors there is "not integrated," not "starved."
 * Scoring those as degraded would drown the real signal in noise from apps
 * this tool has no way to affect. Override with SEARCH_COVERAGE_APPS.
 */
const DEFAULT_TRACKED_APP_IDS = ["brain", "fbrain", "fkanban", "kanban"];

type SchemaCoverage = {
  schema_name: string;
  descriptive_name: string;
  owner_app_id: string | null;
  vectors: number;
  source_records: number;
  ratio: number | null;
  degraded: boolean;
};

export type CoverageReport = {
  available: boolean;
  note?: string;
  floor: number;
  total: {
    vectors: number;
    source_records: number;
    ratio: number | null;
  };
  by_schema: SchemaCoverage[];
  degraded_schemas: string[];
};

export type EmbedderBreakdown = {
  by_embedder_id: Record<string, number>;
  deterministic_vectors: number;
  total_vectors: number;
  deterministic_share: number | null;
};

/** Coverage over the corpus the kernel reports counts for. `null` counts
 * means the catalog was unreachable — coverage is unknown, not zero. */
export function computeCoverage(
  vectorCountsBySchema: Record<string, number>,
  corpusCounts: SchemaCorpusCounts | null,
  opts?: { floor?: number; trackedAppIds?: string[] | null },
): CoverageReport {
  const floor = opts?.floor ?? DEFAULT_COVERAGE_FLOOR;
  if (!corpusCounts) {
    return {
      available: false,
      note: "schema catalog unreachable; coverage unknown (not zero)",
      floor,
      total: { vectors: 0, source_records: 0, ratio: null },
      by_schema: [],
      degraded_schemas: [],
    };
  }
  const trackedApps =
    opts?.trackedAppIds === null ? null : new Set(opts?.trackedAppIds ?? DEFAULT_TRACKED_APP_IDS);

  const rows: SchemaCoverage[] = [];
  for (const [hash, entry] of Object.entries(corpusCounts)) {
    if (trackedApps && !(entry.owner_app_id && trackedApps.has(entry.owner_app_id))) continue;
    if (!isContentSchema(entry.descriptive_name)) continue;
    if (entry.record_count <= 0) continue;
    const vectors = vectorCountsBySchema[hash] ?? 0;
    const ratio = entry.record_count > 0 ? vectors / entry.record_count : null;
    // A schema with any source records but zero vectors is degraded
    // regardless of the floor — it is not "slightly under", it is invisible.
    const degraded = ratio === null ? false : ratio < floor;
    rows.push({
      schema_name: hash,
      descriptive_name: entry.descriptive_name,
      owner_app_id: entry.owner_app_id,
      vectors,
      source_records: entry.record_count,
      ratio,
      degraded,
    });
  }
  rows.sort((a, b) => (a.ratio ?? 1) - (b.ratio ?? 1));

  const totalVectors = rows.reduce((s, r) => s + r.vectors, 0);
  const totalSource = rows.reduce((s, r) => s + r.source_records, 0);

  return {
    available: true,
    floor,
    total: {
      vectors: totalVectors,
      source_records: totalSource,
      ratio: totalSource > 0 ? totalVectors / totalSource : null,
    },
    by_schema: rows,
    degraded_schemas: rows.filter((r) => r.degraded).map((r) => r.schema_name),
  };
}

export function computeEmbedderBreakdown(
  byEmbedderId: Record<string, number>,
): EmbedderBreakdown {
  let deterministic = 0;
  let total = 0;
  for (const [id, n] of Object.entries(byEmbedderId)) {
    total += n;
    if (id.includes("+deterministic")) deterministic += n;
  }
  return {
    by_embedder_id: byEmbedderId,
    deterministic_vectors: deterministic,
    total_vectors: total,
    deterministic_share: total > 0 ? deterministic / total : null,
  };
}

/**
 * Overall status is machine-readable and stable: exactly "healthy" or
 * "degraded". Callers (routines, `brain doctor`) must be able to switch on
 * it without parsing prose.
 */
export function overallState(opts: {
  vectorPlaneHealthy: boolean;
  coverage: CoverageReport;
  embedder: EmbedderBreakdown;
}): "healthy" | "degraded" {
  if (!opts.vectorPlaneHealthy) return "degraded";
  if (opts.coverage.available) {
    if (opts.coverage.total.ratio !== null && opts.coverage.total.ratio < opts.coverage.floor) {
      return "degraded";
    }
    if (opts.coverage.degraded_schemas.length > 0) return "degraded";
  }
  // A nonzero deterministic share means the neural embedder is silently
  // unavailable in a live run — the vectors that exist are not the ones
  // production search expects.
  if ((opts.embedder.deterministic_share ?? 0) > 0) return "degraded";
  return "healthy";
}
