/**
 * Wire types for Search ingest — aligned with fold_db IndexChangeBatch
 * (native_index/sink.rs). Semantic vector index is regenerable local state.
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
