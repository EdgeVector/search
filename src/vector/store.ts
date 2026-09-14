/**
 * Durable vector store: binary snapshot + append-only op log.
 *
 * Replaces the v1 format, which serialized the *entire* index to JSON text on
 * every flush. That made a flush cost O(total index) regardless of how few
 * records changed — quadratic across a backfill, and it pushed a snapshot-sized
 * transient string through the heap each time. Draining a 99k-batch inbox on
 * 2026-08-07 wrote 549.80 GB in 20 minutes and grew one process to 26.1 GB RSS,
 * which took the machine down. See brain
 * `papercut-search-vector-index-persist-rewrites-entire-file-per-flush`.
 *
 * Here a flush appends only what changed. The snapshot is rewritten only when
 * the log has grown past a fraction of it, so total bytes written stay linear
 * in records touched, with a small bounded amplification factor.
 *
 * Layout (both files share a header and frame encoding):
 *
 *   header: "LSV2" | u32 headerJsonLen | headerJson
 *   frame:  u8 op | u32 metaJsonLen | u32 dims | metaJson | f32[dims] LE
 *
 * Vectors are float32 — the embedder emits float32, so widening to JSON text
 * cost ~3x the bytes and bought no precision.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const STORE_MAGIC = "LSV2";
export const STORE_VERSION = 2;

const OP_UPSERT = 1;
const OP_DELETE = 2;

export type StoreRecord = {
  id: string;
  schema_name: string;
  key_hash: string | null;
  key_range: string | null;
  fragment_key: string;
  text: string;
  embedder_id: string;
  vector: number[];
  mutation_id?: string;
};

export type StoreOp =
  | { op: "upsert"; rec: StoreRecord }
  | { op: "delete"; id: string };

export type StoreHeader = {
  version: number;
  embedder_id: string;
  dimensions: number;
};

/** Snapshot and log paths derived from the caller's store path. */
export type StorePaths = {
  /** Legacy whole-file JSON snapshot, read once for migration. */
  legacyJson: string;
  snapshot: string;
  log: string;
};

export function storePaths(storePath: string): StorePaths {
  const base = storePath.replace(/\.v1\.json$/, "").replace(/\.json$/, "");
  return {
    legacyJson: storePath,
    snapshot: `${base}.v2.bin`,
    log: `${base}.v2.log`,
  };
}

function encodeHeader(header: StoreHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const out = Buffer.allocUnsafe(4 + 4 + json.length);
  out.write(STORE_MAGIC, 0, "ascii");
  out.writeUInt32LE(json.length, 4);
  json.copy(out, 8);
  return out;
}

/** Returns the header and the offset where frames begin, or null if unreadable. */
function decodeHeader(
  buf: Buffer,
): { header: StoreHeader; offset: number } | null {
  if (buf.length < 8) return null;
  if (buf.toString("ascii", 0, 4) !== STORE_MAGIC) return null;
  const jsonLen = buf.readUInt32LE(4);
  if (buf.length < 8 + jsonLen) return null;
  try {
    const header = JSON.parse(
      buf.toString("utf8", 8, 8 + jsonLen),
    ) as StoreHeader;
    if (header.version !== STORE_VERSION) return null;
    return { header, offset: 8 + jsonLen };
  } catch {
    return null;
  }
}

function encodeOp(op: StoreOp): Buffer {
  if (op.op === "delete") {
    const meta = Buffer.from(JSON.stringify({ id: op.id }), "utf8");
    const out = Buffer.allocUnsafe(9 + meta.length);
    out.writeUInt8(OP_DELETE, 0);
    out.writeUInt32LE(meta.length, 1);
    out.writeUInt32LE(0, 5);
    meta.copy(out, 9);
    return out;
  }
  const r = op.rec;
  const meta = Buffer.from(
    JSON.stringify({
      id: r.id,
      schema_name: r.schema_name,
      key_hash: r.key_hash,
      key_range: r.key_range,
      fragment_key: r.fragment_key,
      text: r.text,
      embedder_id: r.embedder_id,
      mutation_id: r.mutation_id,
    }),
    "utf8",
  );
  const dims = r.vector.length;
  const out = Buffer.allocUnsafe(9 + meta.length + dims * 4);
  out.writeUInt8(OP_UPSERT, 0);
  out.writeUInt32LE(meta.length, 1);
  out.writeUInt32LE(dims, 5);
  meta.copy(out, 9);
  let at = 9 + meta.length;
  for (let i = 0; i < dims; i++) {
    out.writeFloatLE(r.vector[i]!, at);
    at += 4;
  }
  return out;
}

/**
 * Decode frames from `offset`. Stops cleanly at the first truncated frame so a
 * torn tail from an interrupted append costs one record, not the whole log.
 */
function decodeFrames(buf: Buffer, offset: number): StoreOp[] {
  const ops: StoreOp[] = [];
  let at = offset;
  while (at + 9 <= buf.length) {
    const op = buf.readUInt8(at);
    const metaLen = buf.readUInt32LE(at + 1);
    const dims = buf.readUInt32LE(at + 5);
    const end = at + 9 + metaLen + dims * 4;
    if (end > buf.length) break;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(buf.toString("utf8", at + 9, at + 9 + metaLen)) as Record<
        string,
        unknown
      >;
    } catch {
      break;
    }
    if (op === OP_DELETE) {
      ops.push({ op: "delete", id: String(meta.id) });
    } else if (op === OP_UPSERT) {
      const vector = new Array<number>(dims);
      let vat = at + 9 + metaLen;
      for (let i = 0; i < dims; i++) {
        vector[i] = buf.readFloatLE(vat);
        vat += 4;
      }
      ops.push({
        op: "upsert",
        rec: {
          id: String(meta.id),
          schema_name: String(meta.schema_name),
          key_hash: (meta.key_hash ?? null) as string | null,
          key_range: (meta.key_range ?? null) as string | null,
          fragment_key: String(meta.fragment_key ?? "body"),
          text: String(meta.text ?? ""),
          embedder_id: String(meta.embedder_id ?? ""),
          vector,
          mutation_id: meta.mutation_id as string | undefined,
        },
      });
    } else {
      break;
    }
    at = end;
  }
  return ops;
}

/**
 * Bytes this process has written to the store, ever.
 *
 * This is the metric that matters: the v1 format grew its file slowly while
 * rewriting it constantly, so file size hides the cost entirely. The freeze was
 * 549.80 GB written against a 162 MB file. Tests assert on this counter.
 */
let bytesWritten = 0;

export function storeBytesWritten(): number {
  return bytesWritten;
}

export function resetStoreBytesWritten(): void {
  bytesWritten = 0;
}

export function writeSnapshot(
  path: string,
  header: StoreHeader,
  records: Iterable<StoreRecord>,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  // Stream frame-by-frame: never materialize the whole snapshot in memory.
  const fd = openSync(tmp, "w", 0o600);
  try {
    const head = encodeHeader(header);
    writeFileSync(fd, head);
    bytesWritten += head.length;
    for (const rec of records) {
      const frame = encodeOp({ op: "upsert", rec });
      writeFileSync(fd, frame);
      bytesWritten += frame.length;
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function appendOps(
  path: string,
  header: StoreHeader,
  ops: StoreOp[],
): void {
  if (ops.length === 0) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parts: Buffer[] = [];
  if (!existsSync(path)) parts.push(encodeHeader(header));
  for (const op of ops) parts.push(encodeOp(op));
  const buf = Buffer.concat(parts);
  appendFileSync(path, buf, { mode: 0o600 });
  bytesWritten += buf.length;
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function removeIfPresent(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best effort */
  }
}

export type LoadedStore = {
  header: StoreHeader | null;
  ops: StoreOp[];
  /** True when records came from the legacy v1 JSON and want a v2 snapshot. */
  migratedFromLegacy: boolean;
};

/** Read a v2 file (snapshot or log) into ops. Missing/corrupt reads as empty. */
function readV2(path: string): { header: StoreHeader | null; ops: StoreOp[] } {
  if (!existsSync(path)) return { header: null, ops: [] };
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return { header: null, ops: [] };
  }
  const head = decodeHeader(buf);
  if (!head) return { header: null, ops: [] };
  return { header: head.header, ops: decodeFrames(buf, head.offset) };
}

type LegacySnapshot = {
  version: number;
  embedder_id: string;
  dimensions: number;
  records: StoreRecord[];
};

/**
 * Load the durable store: v2 snapshot then log replay, falling back to the
 * legacy v1 JSON so an existing index migrates instead of forcing a re-embed.
 */
export function loadStore(paths: StorePaths): LoadedStore {
  const snap = readV2(paths.snapshot);
  const log = readV2(paths.log);
  // A young index has a log and no snapshot yet — compaction has not run. The
  // log alone is then the whole durable state, so it must be read on its own.
  if (snap.header || log.header) {
    return {
      header: snap.header ?? log.header,
      ops: [...snap.ops, ...log.ops],
      migratedFromLegacy: false,
    };
  }

  if (!existsSync(paths.legacyJson)) {
    return { header: null, ops: [], migratedFromLegacy: false };
  }
  try {
    const legacy = JSON.parse(
      readFileSync(paths.legacyJson, "utf8"),
    ) as LegacySnapshot;
    if (!Array.isArray(legacy.records)) {
      return { header: null, ops: [], migratedFromLegacy: false };
    }
    return {
      header: {
        version: STORE_VERSION,
        embedder_id: legacy.embedder_id ?? "",
        dimensions: legacy.dimensions ?? 0,
      },
      ops: legacy.records.map((rec) => ({ op: "upsert" as const, rec })),
      migratedFromLegacy: true,
    };
  } catch {
    return { header: null, ops: [], migratedFromLegacy: false };
  }
}
