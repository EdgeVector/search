/**
 * Source-of-truth record counts per schema, read from the LastDB kernel's
 * own schema catalog (`/api/schemas?include_counts=true`). These counts are
 * maintained counters, not a full-table scan, so this stays within the
 * kernel's no-scan contract.
 *
 * `schema_name` on a vector record is the schema's `identity_hash` (the same
 * value the catalog reports as `identity_hash`/`name`), so counts join
 * directly against `VectorIndex.countsBySchema()` without any translation
 * table.
 */
import * as http from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";

export type SchemaCorpusEntry = {
  descriptive_name: string;
  owner_app_id: string | null;
  record_count: number;
};

/** identity_hash -> catalog entry, restricted to schemas with a known count. */
export type SchemaCorpusCounts = Record<string, SchemaCorpusEntry>;

export type CorpusCountSource = {
  fetchCounts(): Promise<SchemaCorpusCounts>;
};

type RawSchema = {
  identity_hash?: string;
  descriptive_name?: string;
  owner_app_id?: string | null;
  record_count?: number | null;
};

type RawSchemasResponse = {
  ok?: boolean;
  schemas?: RawSchema[];
};

function toCounts(raw: RawSchemasResponse): SchemaCorpusCounts {
  const out: SchemaCorpusCounts = {};
  for (const s of raw.schemas ?? []) {
    if (!s.identity_hash || typeof s.record_count !== "number") continue;
    out[s.identity_hash] = {
      descriptive_name: s.descriptive_name ?? s.identity_hash,
      owner_app_id: s.owner_app_id ?? null,
      record_count: s.record_count,
    };
  }
  return out;
}

/**
 * Internal bookkeeping schemas (rollup indexes, dual-written
 * `_hashrange_v#` secondaries, attachment blobs, admin snapshots) never
 * carry embeddable product text. Without this filter they sit at a
 * permanent 0% and drown the real per-type coverage table in noise that
 * Search was never going to index anyway — see `_hashrange_` roll-up
 * naming in concepts-lastdb-canonical-model (dual-written secondaries).
 */
const NON_CONTENT_SCHEMA_PATTERN =
  /index|listentry|adminsnapshot|attachmentblob|attachmentfile|hashrange/i;

export function isContentSchema(descriptiveName: string): boolean {
  return !NON_CONTENT_SCHEMA_PATTERN.test(descriptiveName);
}

/** Fetch the schema catalog with counts over an HTTP endpoint (unix socket or TCP). */
function createHttpCorpusCountSource(opts: {
  socketPath?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): CorpusCountSource {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return {
    fetchCounts(): Promise<SchemaCorpusCounts> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            socketPath: opts.socketPath,
            host: opts.socketPath ? undefined : (opts.baseUrl ? new URL(opts.baseUrl).hostname : "localhost"),
            port: opts.socketPath ? undefined : (opts.baseUrl ? new URL(opts.baseUrl).port : undefined),
            path: "/api/schemas?include_counts=true",
            method: "GET",
            timeout: timeoutMs,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              if ((res.statusCode ?? 0) >= 400) {
                reject(new Error(`schema catalog request failed: HTTP ${res.statusCode}`));
                return;
              }
              try {
                resolve(toCounts(JSON.parse(body) as RawSchemasResponse));
              } catch (e) {
                reject(e instanceof Error ? e : new Error(String(e)));
              }
            });
          },
        );
        req.on("timeout", () => req.destroy(new Error("schema catalog request timed out")));
        req.on("error", reject);
        req.end();
      });
    },
  };
}

export function defaultCorpusCountSource(env: Record<string, string | undefined> = process.env): CorpusCountSource {
  const baseUrl = env.SEARCH_LASTDB_API_URL?.trim();
  const socketPath =
    !baseUrl ? (env.SEARCH_LASTDB_SOCKET?.trim() || env.LASTDB_SOCKET?.trim() || defaultSocketPath()) : undefined;
  return createHttpCorpusCountSource({ socketPath, baseUrl });
}

function defaultSocketPath(): string {
  return join(homedir(), ".lastdb", "data", "folddb.sock");
}
