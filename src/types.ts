/**
 * Wire types for Search ingest — aligned with fold_db IndexChangeBatch
 * (native_index/sink.rs). Keyword/semantic index is regenerable local state.
 */

export type IndexChangeKind = "upsert" | "tombstone";

export type KeyValue = {
  hash: string | null;
  range: string | null;
};

export type IndexChange = {
  mutation_id: string;
  kind: IndexChangeKind;
  key_value: KeyValue;
  fields_and_values?: Record<string, unknown>;
};

export type IndexChangeBatch = {
  schema_name: string;
  searchable_fields?: string[] | null;
  changes: IndexChange[];
};

export type SearchHit = {
  schema_name: string;
  key_hash: string | null;
  key_range: string | null;
  score: number;
  text: string;
  mutation_id?: string;
};

export type SearchQueryOptions = {
  k?: number;
  /** Restrict to these schema names / identity hashes. */
  schemas?: string[];
};
