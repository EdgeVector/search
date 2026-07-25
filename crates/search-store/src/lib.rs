//! LastStore-backed keyword Search index.
//!
//! Primary durable state lives in a dedicated LastStore home (segment files),
//! not a single full-corpus JSON snapshot. Collections:
//! - `docs` — document id → DocRecord JSON
//! - `post` — `{token}\x1f{doc_id}` → empty body (posting membership)
//!
//! Local-only / regenerable: path is under `{LASTDB_HOME}/apps/search/laststore`.

use laststore::LastStore;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const COL_DOCS: &str = "docs";
const COL_POST: &str = "post";
const POST_SEP: char = '\u{001f}';

/// Wire types aligned with fold IndexChangeBatch / Search TS types.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyValue {
    pub hash: Option<String>,
    pub range: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexChangeKind {
    Upsert,
    Tombstone,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexChange {
    pub mutation_id: String,
    pub kind: IndexChangeKind,
    pub key_value: KeyValue,
    #[serde(default)]
    pub fields_and_values: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexChangeBatch {
    pub schema_name: String,
    #[serde(default)]
    pub searchable_fields: Option<Vec<String>>,
    pub changes: Vec<IndexChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub schema_name: String,
    pub key_hash: Option<String>,
    pub key_range: Option<String>,
    pub score: f64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mutation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DocRecord {
    id: String,
    schema_name: String,
    key_hash: Option<String>,
    key_range: Option<String>,
    text: String,
    tokens: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mutation_id: Option<String>,
}

/// Errors from Search LastStore index operations.
#[derive(Debug, thiserror::Error)]
pub enum SearchStoreError {
    #[error("laststore: {0}")]
    LastStore(#[from] laststore::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Msg(String),
}

/// Result alias.
pub type Result<T> = std::result::Result<T, SearchStoreError>;

/// LastStore-backed keyword index.
pub struct SearchLastStoreIndex {
    store: LastStore,
    path: PathBuf,
}

impl SearchLastStoreIndex {
    /// Open or create the Search LastStore home at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        std::fs::create_dir_all(&path).map_err(|e| SearchStoreError::Msg(e.to_string()))?;
        let store = LastStore::open(&path)?;
        Ok(Self { store, path })
    }

    /// Store root path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Flush group-commit buffers.
    pub fn flush(&self) -> Result<()> {
        self.store.flush()?;
        Ok(())
    }

    /// Number of documents currently indexed.
    pub fn doc_count(&self) -> Result<usize> {
        Ok(self.store.list_prefix_keys(COL_DOCS, "")?.len())
    }

    /// Apply one IndexChangeBatch. Returns number of changes applied.
    pub fn apply_change_batch(&self, batch: &IndexChangeBatch) -> Result<usize> {
        let searchable: Option<HashSet<&str>> = batch
            .searchable_fields
            .as_ref()
            .map(|v| v.iter().map(|s| s.as_str()).collect());
        let mut n = 0usize;
        for ch in &batch.changes {
            let id = doc_id(
                &batch.schema_name,
                ch.key_value.hash.as_deref(),
                ch.key_value.range.as_deref(),
            );
            match ch.kind {
                IndexChangeKind::Tombstone => {
                    self.remove_doc(&id)?;
                    n += 1;
                }
                IndexChangeKind::Upsert => {
                    let text = fields_to_text(&ch.fields_and_values, searchable.as_ref());
                    let tokens = tokenize(&text);
                    self.remove_doc(&id)?;
                    let doc = DocRecord {
                        id: id.clone(),
                        schema_name: batch.schema_name.clone(),
                        key_hash: ch.key_value.hash.clone(),
                        key_range: ch.key_value.range.clone(),
                        text,
                        tokens: tokens.clone(),
                        mutation_id: Some(ch.mutation_id.clone()),
                    };
                    let body = serde_json::to_vec(&doc)?;
                    self.store.put(COL_DOCS, &id, &body)?;
                    for t in tokens {
                        let pk = posting_key(&t, &id);
                        self.store.put(COL_POST, &pk, b"")?;
                    }
                    n += 1;
                }
            }
        }
        self.store.flush()?;
        Ok(n)
    }

    /// Keyword search over LastStore postings.
    pub fn search(&self, query: &str, k: usize, schemas: Option<&[String]>) -> Result<Vec<SearchHit>> {
        let q_tokens = tokenize(query);
        if q_tokens.is_empty() {
            return Ok(vec![]);
        }
        let schema_filter: Option<HashSet<&str>> =
            schemas.map(|s| s.iter().map(|x| x.as_str()).collect());

        let mut scores: HashMap<String, f64> = HashMap::new();
        let mut matched_terms: HashMap<String, usize> = HashMap::new();

        for t in &q_tokens {
            let prefix = format!("{t}{POST_SEP}");
            let keys = self.store.list_prefix_keys(COL_POST, &prefix)?;
            let mut seen_docs: HashSet<String> = HashSet::new();
            for pk in keys {
                let Some(doc_id) = pk.split(POST_SEP).nth(1).map(|s| s.to_string()) else {
                    continue;
                };
                if !seen_docs.insert(doc_id.clone()) {
                    continue;
                }
                let Some(raw) = self.store.get(COL_DOCS, &doc_id)? else {
                    continue;
                };
                let doc: DocRecord = serde_json::from_slice(&raw)?;
                if let Some(ref filt) = schema_filter {
                    if !filt.contains(doc.schema_name.as_str()) {
                        continue;
                    }
                }
                let tf = doc.tokens.iter().filter(|x| *x == t).count() as f64;
                *scores.entry(doc_id.clone()).or_insert(0.0) += tf;
                *matched_terms.entry(doc_id).or_insert(0) += 1;
            }
        }

        let qn = q_tokens.len() as f64;
        let mut ranked: Vec<(String, f64)> = scores
            .into_iter()
            .map(|(id, tf)| {
                let terms = *matched_terms.get(&id).unwrap_or(&0) as f64;
                let score = tf * (1.0 + terms / qn);
                (id, score)
            })
            .collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ranked.truncate(k);

        let mut hits = Vec::with_capacity(ranked.len());
        for (id, score) in ranked {
            let Some(raw) = self.store.get(COL_DOCS, &id)? else {
                continue;
            };
            let doc: DocRecord = serde_json::from_slice(&raw)?;
            let text: String = doc.text.chars().take(500).collect();
            hits.push(SearchHit {
                schema_name: doc.schema_name,
                key_hash: doc.key_hash,
                key_range: doc.key_range,
                score,
                text,
                mutation_id: doc.mutation_id,
            });
        }
        Ok(hits)
    }

    /// Rebuild from an ordered list of batches (cold plane). Clears existing
    /// index documents/postings first when `clear` is true.
    pub fn rebuild_from_batches(
        &self,
        batches: &[IndexChangeBatch],
        clear: bool,
    ) -> Result<RebuildReport> {
        if clear {
            self.clear_all()?;
        }
        let mut changes = 0usize;
        let mut batch_count = 0usize;
        for b in batches {
            changes += self.apply_change_batch(b)?;
            batch_count += 1;
        }
        self.flush()?;
        Ok(RebuildReport {
            batches: batch_count,
            changes,
            docs: self.doc_count()?,
        })
    }

    /// Iterative rebuild: consume pages from `source` until exhausted.
    /// Off-hot-path by construction — caller must not invoke this from a
    /// mutation critical section.
    pub fn rebuild_paged<S: SearchRebuildSource>(
        &self,
        source: &mut S,
        page_size: usize,
        clear: bool,
    ) -> Result<RebuildReport> {
        if clear {
            self.clear_all()?;
        }
        let mut batches_total = 0usize;
        let mut changes = 0usize;
        let mut pages = 0usize;
        loop {
            let page = source.next_page(page_size)?;
            if page.is_empty() {
                break;
            }
            pages += 1;
            for b in &page {
                changes += self.apply_change_batch(b)?;
                batches_total += 1;
            }
        }
        let _ = pages;
        self.flush()?;
        Ok(RebuildReport {
            batches: batches_total,
            changes,
            docs: self.doc_count()?,
        })
    }

    fn clear_all(&self) -> Result<()> {
        for id in self.store.list_prefix_keys(COL_DOCS, "")? {
            self.store.delete(COL_DOCS, &id)?;
        }
        for id in self.store.list_prefix_keys(COL_POST, "")? {
            self.store.delete(COL_POST, &id)?;
        }
        self.store.flush()?;
        Ok(())
    }

    fn remove_doc(&self, id: &str) -> Result<()> {
        if let Some(raw) = self.store.get(COL_DOCS, id)? {
            if let Ok(doc) = serde_json::from_slice::<DocRecord>(&raw) {
                for t in doc.tokens {
                    let pk = posting_key(&t, id);
                    let _ = self.store.delete(COL_POST, &pk);
                }
            }
            self.store.delete(COL_DOCS, id)?;
        }
        Ok(())
    }
}

/// Report from a rebuild run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RebuildReport {
    /// Number of batches applied.
    pub batches: usize,
    /// Number of individual changes applied.
    pub changes: usize,
    /// Document count after rebuild.
    pub docs: usize,
}

/// Page source for off-hot-path rebuild. Fold implements this over product
/// records; tests use fixture batches.
pub trait SearchRebuildSource {
    /// Return the next page of batches (length ≤ limit). Empty = done.
    fn next_page(&mut self, limit: usize) -> Result<Vec<IndexChangeBatch>>;
}

/// In-memory page source for tests / pre-built batch lists.
pub struct SliceRebuildSource {
    batches: Vec<IndexChangeBatch>,
    offset: usize,
}

impl SliceRebuildSource {
    /// Wrap an owned batch list.
    pub fn new(batches: Vec<IndexChangeBatch>) -> Self {
        Self {
            batches,
            offset: 0,
        }
    }
}

impl SearchRebuildSource for SliceRebuildSource {
    fn next_page(&mut self, limit: usize) -> Result<Vec<IndexChangeBatch>> {
        if self.offset >= self.batches.len() || limit == 0 {
            return Ok(vec![]);
        }
        let end = (self.offset + limit).min(self.batches.len());
        let page = self.batches[self.offset..end].to_vec();
        self.offset = end;
        Ok(page)
    }
}

/// Resolve default LastStore path under a LastDB home.
pub fn laststore_path_for_home(last_db_home: impl AsRef<Path>) -> PathBuf {
    last_db_home
        .as_ref()
        .join("apps")
        .join("search")
        .join("laststore")
}

fn doc_id(schema: &str, hash: Option<&str>, range: Option<&str>) -> String {
    format!(
        "{schema}\0{}\0{}",
        hash.unwrap_or(""),
        range.unwrap_or("")
    )
}

fn posting_key(token: &str, doc_id: &str) -> String {
    format!("{token}{POST_SEP}{doc_id}")
}

fn tokenize(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            cur.push(ch);
        } else if !cur.is_empty() {
            if cur.len() >= 2 {
                out.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        }
    }
    if cur.len() >= 2 {
        out.push(cur);
    }
    out
}

fn fields_to_text(
    fields: &HashMap<String, serde_json::Value>,
    searchable: Option<&HashSet<&str>>,
) -> String {
    let mut parts = Vec::new();
    for (k, v) in fields {
        if let Some(s) = searchable {
            if !s.contains(k.as_str()) {
                continue;
            }
        }
        match v {
            serde_json::Value::Null => {}
            serde_json::Value::String(s) => parts.push(s.clone()),
            serde_json::Value::Number(n) => parts.push(n.to_string()),
            serde_json::Value::Bool(b) => parts.push(b.to_string()),
            other => parts.push(other.to_string()),
        }
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn batch(unique: &str, schema: &str, hash: &str) -> IndexChangeBatch {
        IndexChangeBatch {
            schema_name: schema.into(),
            searchable_fields: Some(vec!["title".into(), "body".into()]),
            changes: vec![IndexChange {
                mutation_id: "m1".into(),
                kind: IndexChangeKind::Upsert,
                key_value: KeyValue {
                    hash: Some(hash.into()),
                    range: None,
                },
                fields_and_values: HashMap::from([
                    ("title".into(), serde_json::json!("t")),
                    ("body".into(), serde_json::json!(unique)),
                ]),
            }],
        }
    }

    #[test]
    fn apply_reopen_query_via_laststore() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("ls");
        let unique = format!("laststore-uniq-{}", std::process::id());
        {
            let idx = SearchLastStoreIndex::open(&path).unwrap();
            assert_eq!(idx.apply_change_batch(&batch(&unique, "fbrain/Preference", "h1")).unwrap(), 1);
            idx.flush().unwrap();
        }
        let idx = SearchLastStoreIndex::open(&path).unwrap();
        let hits = idx.search(&unique, 10, None).unwrap();
        assert!(!hits.is_empty(), "expected hit after reopen");
        assert!(hits[0].text.contains(&unique));
        assert_eq!(hits[0].key_hash.as_deref(), Some("h1"));
    }

    #[test]
    fn rebuild_paged_from_cold_empty_index() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("ls");
        let unique = format!("rebuild-cold-{}", std::process::id());
        let batches = vec![
            batch(&unique, "fbrain/Preference", "r1"),
            batch("other-text-zzz", "fbrain/Preference", "r2"),
        ];
        let idx = SearchLastStoreIndex::open(&path).unwrap();
        assert_eq!(idx.doc_count().unwrap(), 0);
        let mut src = SliceRebuildSource::new(batches);
        let report = idx.rebuild_paged(&mut src, 1, true).unwrap();
        assert_eq!(report.batches, 2);
        assert!(report.docs >= 2);
        let hits = idx.search(&unique, 5, None).unwrap();
        assert!(hits.iter().any(|h| h.text.contains(&unique)));
    }

    #[test]
    fn tombstone_removes_from_laststore() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("ls");
        let unique = "tombstone-me-please";
        let idx = SearchLastStoreIndex::open(&path).unwrap();
        idx.apply_change_batch(&batch(unique, "s", "t1")).unwrap();
        idx.apply_change_batch(&IndexChangeBatch {
            schema_name: "s".into(),
            searchable_fields: None,
            changes: vec![IndexChange {
                mutation_id: "del".into(),
                kind: IndexChangeKind::Tombstone,
                key_value: KeyValue {
                    hash: Some("t1".into()),
                    range: None,
                },
                fields_and_values: HashMap::new(),
            }],
        })
        .unwrap();
        assert!(idx.search(unique, 10, None).unwrap().is_empty());
    }
}
