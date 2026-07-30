import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SearchPaths } from "./paths.ts";
import type { SemanticSearchPlane } from "./vector/plane.ts";
import {
  fieldsToIndexText,
  selectIndexableFields,
  type FieldClassifications,
} from "./vector/field_policy.ts";
import type { ProgressReporter } from "./progress.ts";

export type LiveBackfillRecord = {
  schema_name: string;
  key_hash: string | null;
  key_range?: string | null;
  mutation_id?: string;
  searchable_fields?: string[] | null;
  classifications?: FieldClassifications | null;
  fields_and_values?: Record<string, unknown>;
};

export type LiveBackfillPage = {
  records: LiveBackfillRecord[];
  next_cursor?: string | null;
  total?: number;
};

export type LiveBackfillSource = {
  id?: string;
  listPage(opts: {
    cursor: string | null;
    limit: number;
  }): Promise<LiveBackfillPage>;
};

export type LiveBackfillCheckpoint = {
  version: 1;
  source_id: string;
  cursor: string | null;
  completed: boolean;
  updated_at: string;
};

export type LiveBackfillResult = {
  live_pages: number;
  live_records: number;
  live_embedded: number;
  live_skipped: number;
  live_removed: number;
  live_flushes: number;
  live_completed: boolean;
  live_checkpoint: string;
  live_source: string;
};

export function defaultLiveBackfillCheckpointPath(paths: SearchPaths): string {
  return join(paths.home, "online-backfill.checkpoint.json");
}

export function readLiveBackfillCheckpoint(
  path: string,
): LiveBackfillCheckpoint | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LiveBackfillCheckpoint>;
    if (parsed.version !== 1 || typeof parsed.source_id !== "string") return null;
    return {
      version: 1,
      source_id: parsed.source_id,
      cursor: typeof parsed.cursor === "string" ? parsed.cursor : null,
      completed: parsed.completed === true,
      updated_at:
        typeof parsed.updated_at === "string"
          ? parsed.updated_at
          : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function writeLiveBackfillCheckpoint(
  path: string,
  checkpoint: LiveBackfillCheckpoint,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(checkpoint, null, 2));
  renameSync(tmp, path);
}

function normalizeRecord(record: LiveBackfillRecord): {
  schema_name: string;
  key_hash: string | null;
  key_range: string | null;
  text: string;
  mutation_id?: string;
} {
  const fields = selectIndexableFields(
    record.fields_and_values,
    record.searchable_fields,
    record.classifications,
  );
  return {
    schema_name: record.schema_name,
    key_hash: record.key_hash,
    key_range: record.key_range ?? null,
    text: fieldsToIndexText(fields),
    mutation_id: record.mutation_id,
  };
}

async function retry<T>(
  op: () => Promise<T>,
  maxAttempts: number,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (e) {
      last = e;
      if (attempt === maxAttempts) break;
    }
  }
  throw last;
}

export async function runLiveBackfill(
  plane: SemanticSearchPlane,
  paths: SearchPaths,
  source: LiveBackfillSource,
  opts?: {
    checkpointFile?: string;
    force?: boolean;
    pageLimit?: number;
    maxPages?: number;
    maxRetries?: number;
    flushEvery?: number;
    progress?: ProgressReporter;
  },
): Promise<LiveBackfillResult> {
  const sourceId = source.id ?? "live";
  const checkpointFile =
    opts?.checkpointFile ?? defaultLiveBackfillCheckpointPath(paths);
  const previous = opts?.force
    ? null
    : readLiveBackfillCheckpoint(checkpointFile);
  if (previous?.source_id === sourceId && previous.completed) {
    return {
      live_pages: 0,
      live_records: 0,
      live_embedded: 0,
      live_skipped: 0,
      live_removed: 0,
      live_flushes: 0,
      live_completed: true,
      live_checkpoint: checkpointFile,
      live_source: sourceId,
    };
  }

  let cursor =
    previous?.source_id === sourceId && !previous.completed
      ? previous.cursor
      : null;
  const limit = Math.max(1, opts?.pageLimit ?? 100);
  const maxRetries = Math.max(1, opts?.maxRetries ?? 3);
  const maxPages = opts?.maxPages ?? Number.POSITIVE_INFINITY;
  let pages = 0;
  let records = 0;
  let embedded = 0;
  let skipped = 0;
  let removed = 0;
  let flushes = 0;
  let completed = false;

  opts?.progress?.startPhase("live-backfill");
  while (pages < maxPages) {
    const page = await retry(
      () => source.listPage({ cursor, limit }),
      maxRetries,
    );
    const docs = page.records.map(normalizeRecord);
    const indexed = await plane.indexPlainDocs(docs, {
      skipIfFresh: !opts?.force,
      flushEvery: opts?.flushEvery,
      onProgress: (p) => {
        opts?.progress?.tick({
          phase: "live-backfill",
          done: records + p.done,
          total: page.total ?? 0,
          embedded: embedded + p.embedded,
          skipped: skipped + p.skipped,
          flushes: flushes + p.flushes,
        });
      },
    });
    pages++;
    records += page.records.length;
    embedded += indexed.embedded;
    skipped += indexed.skipped;
    removed += indexed.removed;
    flushes += indexed.flushes;
    cursor = page.next_cursor ?? null;
    completed = cursor === null;
    writeLiveBackfillCheckpoint(checkpointFile, {
      version: 1,
      source_id: sourceId,
      cursor,
      completed,
      updated_at: new Date().toISOString(),
    });
    if (completed) break;
  }

  return {
    live_pages: pages,
    live_records: records,
    live_embedded: embedded,
    live_skipped: skipped,
    live_removed: removed,
    live_flushes: flushes,
    live_completed: completed,
    live_checkpoint: checkpointFile,
    live_source: sourceId,
  };
}

export function createHttpLiveBackfillSource(opts: {
  url: string;
  fetchImpl?: typeof fetch;
}): LiveBackfillSource {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    id: opts.url,
    async listPage({ cursor, limit }) {
      const url = new URL(opts.url);
      url.searchParams.set("limit", String(limit));
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetchImpl(url);
      if (!res.ok) {
        throw new Error(`live backfill request failed: HTTP ${res.status}`);
      }
      const json = (await res.json()) as Partial<LiveBackfillPage> & {
        ok?: boolean;
        error?: string;
      };
      if (json.ok === false) {
        throw new Error(json.error ?? "live backfill request failed");
      }
      if (!Array.isArray(json.records)) {
        throw new Error("live backfill response missing records array");
      }
      return {
        records: json.records,
        next_cursor:
          typeof json.next_cursor === "string" ? json.next_cursor : null,
        total: typeof json.total === "number" ? json.total : undefined,
      };
    },
  };
}
