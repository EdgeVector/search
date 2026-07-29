/**
 * Field policy for Search indexing — mirrors fold native_index classifications.
 * A field is searchable when classified `word` and not `secret` / `no_index`.
 */

export type FieldClassifications = Record<string, string[] | undefined>;

const BLOCK = new Set(["secret", "no_index", "no-index"]);

export function fieldIsIndexable(classifications: string[] | undefined): boolean {
  if (!classifications || classifications.length === 0) {
    // No classifications: allow (batch searchable_fields still applies).
    return true;
  }
  const lower = classifications.map((c) => c.toLowerCase());
  if (lower.some((c) => BLOCK.has(c))) return false;
  return lower.some((c) => c === "word");
}

/**
 * Filter field map by optional batch searchable_fields and optional
 * per-field classification map (when provided by the host).
 */
export function selectIndexableFields(
  fields: Record<string, unknown> | undefined,
  searchableFields: string[] | null | undefined,
  classifications?: FieldClassifications | null,
): Record<string, unknown> {
  if (!fields) return {};
  const allow =
    searchableFields && searchableFields.length > 0
      ? new Set(searchableFields)
      : null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (allow && !allow.has(k)) continue;
    if (classifications && !fieldIsIndexable(classifications[k])) continue;
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function fieldsToIndexText(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const v of Object.values(fields)) {
    if (typeof v === "string") parts.push(v);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(String(v));
    else if (typeof v === "object") {
      try {
        parts.push(JSON.stringify(v));
      } catch {
        /* skip */
      }
    }
  }
  return parts.join("\n");
}
