import { existsSync } from "node:fs";
import { MINILM_L6_V2_DIMS, MINILM_L6_V2_ID } from "./vector/embedder.ts";
import {
  createHttpLiveBackfillSource,
  defaultLiveBackfillCheckpointPath,
  readLiveBackfillCheckpoint,
  type LiveBackfillSource,
} from "./live_backfill.ts";
import { openSearchSession, type SearchSession } from "./semantic.ts";

type DoctorLevel = "ok" | "warn" | "error" | "skipped";

type DoctorCheck = {
  name: string;
  level: DoctorLevel;
  summary: string;
  next_action?: string;
  detail?: Record<string, unknown>;
};

export type SearchDoctorReport = {
  ok: boolean;
  status: "healthy" | "degraded";
  generated_at: string;
  home: string;
  vectorIndexPath: string;
  inbox: string;
  checks: DoctorCheck[];
  next_actions: string[];
};

function worst(checks: DoctorCheck[]): "healthy" | "degraded" {
  return checks.some((c) => c.level === "error") ? "degraded" : "healthy";
}

function addNextActions(checks: DoctorCheck[]): string[] {
  return [
    ...new Set(
      checks
        .map((c) => c.next_action)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
}

function configured(env: Record<string, string | undefined>, names: string[]) {
  return names.filter((name) => (env[name] ?? "").trim().length > 0);
}

export async function runSearchDoctor(opts?: {
  session?: SearchSession;
  lastDbHome?: string;
  liveUrl?: string;
  liveSource?: LiveBackfillSource;
  checkpointFile?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}): Promise<SearchDoctorReport> {
  const env = opts?.env ?? process.env;
  const session =
    opts?.session ?? openSearchSession({ lastDbHome: opts?.lastDbHome });
  const checks: DoctorCheck[] = [];

  let ensureError: string | null = null;
  try {
    await session.semantic.ensureReady();
  } catch (e) {
    ensureError = e instanceof Error ? e.message : String(e);
  }
  const vector = session.semantic.health();
  const modelOk =
    vector.state === "healthy" &&
    typeof vector.embedder_id === "string" &&
    vector.embedder_id.startsWith(MINILM_L6_V2_ID) &&
    vector.dimensions === MINILM_L6_V2_DIMS;
  checks.push({
    name: "fastembed_model",
    level: modelOk ? "ok" : "error",
    summary: modelOk
      ? "FastEmbed-compatible all-MiniLM-L6-v2 model is ready"
      : "FastEmbed-compatible model is not ready",
    next_action: modelOk
      ? undefined
      : "Run npm install in the Search install root, then retry search doctor. Use SEARCH_EMBEDDER=deterministic only for tests.",
    detail: {
      expected_embedder_id: MINILM_L6_V2_ID,
      expected_dimensions: MINILM_L6_V2_DIMS,
      state: vector.state,
      embedder_id: vector.embedder_id,
      dimensions: vector.dimensions,
      detail: vector.detail,
      ensure_error: ensureError,
    },
  });

  checks.push({
    name: "vector_index",
    level: vector.vectors > 0 ? "ok" : "warn",
    summary:
      vector.vectors > 0
        ? `Vector index has ${vector.vectors} vector(s)`
        : "Vector index is empty",
    next_action:
      vector.vectors > 0
        ? undefined
        : "Run search bootstrap --live-url <lastdb search backfill endpoint> to seed vectors online.",
    detail: {
      path: session.paths.vectorIndexPath,
      exists: existsSync(session.paths.vectorIndexPath),
      vectors: vector.vectors,
      embedder_id: vector.embedder_id,
      dimensions: vector.dimensions,
    },
  });

  const checkpointFile =
    opts?.checkpointFile ?? defaultLiveBackfillCheckpointPath(session.paths);
  const checkpoint = readLiveBackfillCheckpoint(checkpointFile);
  checks.push({
    name: "online_backfill",
    level: checkpoint
      ? checkpoint.completed
        ? "ok"
        : "warn"
      : "warn",
    summary: checkpoint
      ? checkpoint.completed
        ? "Online backfill checkpoint is complete"
        : "Online backfill checkpoint is in progress"
      : "Online backfill has not checkpointed yet",
    next_action:
      checkpoint?.completed === true
        ? undefined
        : "Run search bootstrap to start or resume online backfill; offline rebuild is disaster-only.",
    detail: {
      checkpoint_file: checkpointFile,
      checkpoint,
    },
  });

  const liveSource =
    opts?.liveSource ??
    ((opts?.liveUrl ?? env.SEARCH_LIVE_BACKFILL_URL)?.trim()
      ? createHttpLiveBackfillSource({
          url: (opts?.liveUrl ?? env.SEARCH_LIVE_BACKFILL_URL)!.trim(),
        })
      : undefined);
  if (liveSource) {
    try {
      const page = await liveSource.listPage({ cursor: null, limit: 1 });
      checks.push({
        name: "lastdb_live_backfill",
        level: "ok",
        summary: "Live LastDB backfill endpoint is reachable",
        detail: {
          source: liveSource.id ?? opts?.liveUrl ?? "live",
          sample_records: page.records.length,
          next_cursor: page.next_cursor ?? null,
          total: page.total ?? null,
        },
      });
    } catch (e) {
      checks.push({
        name: "lastdb_live_backfill",
        level: "error",
        summary: "Live LastDB backfill endpoint is unavailable",
        next_action:
          "Verify lastdbd is running and pass the correct --live-url or SEARCH_LIVE_BACKFILL_URL.",
        detail: {
          source: liveSource.id ?? opts?.liveUrl ?? "live",
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  } else {
    checks.push({
      name: "lastdb_live_backfill",
      level: "skipped",
      summary: "No live backfill endpoint configured",
      next_action:
        "Set SEARCH_LIVE_BACKFILL_URL or pass --live-url to validate and run online bootstrap.",
    });
  }

  const brainVars = configured(env, [
    "BRAIN_SEARCH_URL",
    "BRAIN_SEARCH_ENDPOINT",
    "SEARCH_HTTP_URL",
  ]);
  const fkanbanVars = configured(env, [
    "FKANBAN_SEARCH_URL",
    "FKANBAN_SEARCH_ENDPOINT",
    "SEARCH_HTTP_URL",
  ]);
  checks.push({
    name: "client_config",
    level: brainVars.length > 0 && fkanbanVars.length > 0 ? "ok" : "warn",
    summary:
      brainVars.length > 0 && fkanbanVars.length > 0
        ? "Brain and fkanban Search endpoints are configured"
        : "One or more Search client endpoint variables are unset",
    next_action:
      brainVars.length > 0 && fkanbanVars.length > 0
        ? undefined
        : "Configure BRAIN_SEARCH_URL and FKANBAN_SEARCH_URL, or SEARCH_HTTP_URL for both clients.",
    detail: {
      brain_configured: brainVars,
      fkanban_configured: fkanbanVars,
    },
  });

  const status = worst(checks);
  return {
    ok: status === "healthy",
    status,
    generated_at: (opts?.now ?? (() => new Date()))().toISOString(),
    home: session.paths.home,
    vectorIndexPath: session.paths.vectorIndexPath,
    inbox: session.paths.inbox,
    checks,
    next_actions: addNextActions(checks),
  };
}
