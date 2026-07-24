/** Simple whitespace + punctuation tokenizer for regenerable keyword index. */

const TOKEN_RE = /[a-z0-9_]+/g;

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(TOKEN_RE);
  while ((m = re.exec(lower)) !== null) {
    if (m[0].length >= 2) out.push(m[0]);
  }
  return out;
}

export function fieldsToText(
  fields: Record<string, unknown> | undefined,
  searchable: Set<string> | null,
): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (searchable && !searchable.has(k)) continue;
    if (v === null || v === undefined) continue;
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
