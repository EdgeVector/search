//! [`LastStore`] — multi-collection sharded segment engine.

use crate::durability;
use crate::frame::{self, FrameHeader};
use crate::options::{CollectionPolicy, HashAlgo, LastStoreOptions, LayoutMode, PackagingMode};
use crate::segfmt::{self, encode_del, encode_put};
use crate::{Error, Result};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const SEAL_RECORD_MAGIC: &[u8; 8] = b"LSSEAL1\0";
const FOOTER_RECORD_MAGIC: &[u8; 8] = b"LSFOOT1\0";
const FOOTER_TRAILER_MAGIC: &[u8; 8] = b"LSFTRL1\0";
const FOOTER_TRAILER_LEN: usize = 24;
const FRAME_CACHE_LIMIT: usize = 64;
const LAYOUT_FILE: &str = "laststore-layout-v1";

#[derive(Clone, Copy)]
enum Loc {
    Legacy {
        seg: u64,
        offset: u64,
        len: u64,
    },
    Chunk {
        chunk_uuid: Uuid,
        frame_idx: u64,
        offset_in_frame: u64,
        len: u64,
    },
}

type ShardKey = (String, u16, Option<u32>);
type ShardHandle = Arc<Mutex<Shard>>;
type FrameKey = (Uuid, u64);

#[derive(Clone)]
struct FrameDiskLoc {
    path: PathBuf,
    disk_offset: u64,
    disk_len: u64,
}

#[derive(Default)]
struct Shard {
    dir: PathBuf,
    collection: String,
    shard: u16,
    data_key: Option<[u8; 32]>,
    policy: CollectionPolicy,
    index: BTreeMap<String, Loc>,
    values: HashMap<String, Vec<u8>>,
    seg_bytes: HashMap<u64, Vec<u8>>,
    frame_cache: HashMap<FrameKey, Vec<u8>>,
    frame_cache_order: VecDeque<FrameKey>,
    frame_locs: HashMap<FrameKey, FrameDiskLoc>,
    open_buf: Vec<u8>,
    segments: Vec<u64>,
    open_len: u64,
    /// Plaintext bytes of `open_buf` already written to `open_file`.
    file_len: u64,
    open_file: Option<File>,
    open_chunk_uuid: Option<Uuid>,
    next_frame_counter: u64,
    open_frame_start_csn: Option<u64>,
    max_csn: u64,
    dirty_ops: u32,
    dirty_bytes: u64,
}

#[derive(Default)]
struct StoreMeta {
    next_csn: u64,
    capture_suspended: bool,
    capture_log: Vec<CaptureEvent>,
    sealed_chunks: Vec<SealedChunkMeta>,
}

#[derive(Default)]
struct ShardWarmSet {
    handles: HashMap<ShardKey, ShardHandle>,
    order: VecDeque<ShardKey>,
    resident_by_key: HashMap<ShardKey, u64>,
    resident_bytes: u64,
}

/// Mutation kind captured in the local CDC log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureOp {
    /// A document was inserted or replaced.
    Put,
    /// A document was deleted.
    Delete,
}

/// One CSN-ordered capture event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureEvent {
    /// Monotonic commit sequence number.
    pub csn: u64,
    /// Collection affected by the mutation.
    pub collection: String,
    /// Document id affected by the mutation.
    pub id: String,
    /// Mutation kind.
    pub op: CaptureOp,
}

/// Metadata for one immutable encrypted chunk sealed by [`LastStore::snapshot`]
/// or segment rollover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedChunkMeta {
    /// Collection the chunk belongs to.
    pub collection: String,
    /// Shard number within the collection.
    pub shard: u16,
    /// Hash group within the shard for hash-group layout chunks.
    ///
    /// `None` identifies the legacy segment-log shard directory.
    pub group_id: Option<u32>,
    /// Stable chunk UUID used in the local filename and AEAD subkey derivation.
    pub chunk_uuid: Uuid,
    /// Local sealed chunk path.
    pub path: PathBuf,
    /// Highest CSN covered by this chunk's seal record.
    pub end_csn: u64,
}

/// Result of force-sealing a store snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// Chunks sealed by this snapshot call.
    pub sealed_chunks: Vec<SealedChunkMeta>,
    /// Highest CSN assigned when the snapshot was cut.
    pub max_csn: u64,
}

/// Deterministic placement for one id in hash-group layout mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HashGroupPlacement {
    /// Collection name.
    pub collection: String,
    /// Shard number selected by `shard_bits`.
    pub shard: u16,
    /// Hash group selected by `hash_group_bits`.
    pub group_id: u32,
    /// Relative directory under the store root.
    pub relative_dir: PathBuf,
}

/// Verified counts from an offline layout migration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutMigrationReport {
    /// Number of live documents copied and verified, grouped by collection.
    pub collections: BTreeMap<String, u64>,
    /// Total number of live documents copied and verified.
    pub total_documents: u64,
}

/// Approximate in-process residency of hash-group handles.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HashGroupWarmStats {
    /// Number of hash-group shard handles currently retained in memory.
    pub resident_groups: usize,
    /// Approximate resident bytes across retained hash-group handles.
    pub resident_bytes: u64,
    /// Configured resident byte budget. `0` means eviction is disabled.
    pub budget_bytes: u64,
}

/// One op in a multi-document transaction (apply all, then flush).
#[derive(Debug, Clone)]
pub enum TxnOp {
    /// Insert or replace a document.
    Put {
        /// Collection name.
        collection: String,
        /// Document id.
        id: String,
        /// Opaque body bytes.
        body: Vec<u8>,
    },
    /// Remove a document if present.
    Delete {
        /// Collection name.
        collection: String,
        /// Document id.
        id: String,
    },
}

impl TxnOp {
    /// Build a put op.
    pub fn put(collection: &str, id: &str, body: impl Into<Vec<u8>>) -> Self {
        Self::Put {
            collection: collection.to_string(),
            id: id.to_string(),
            body: body.into(),
        }
    }

    /// Build a delete op.
    pub fn delete(collection: &str, id: &str) -> Self {
        Self::Delete {
            collection: collection.to_string(),
            id: id.to_string(),
        }
    }
}

/// **Last Store** — multi-collection local document store.
///
/// Layout under the home path:
/// ```text
/// <home>/data/<collection>/<shard>/*.seg                 # keyless legacy mode
/// <home>/data/<collection>/<shard>/tail/<uuid>.seg       # encrypted open tail
/// <home>/data/<collection>/<shard>/chunks/<uuid>.seg     # encrypted sealed chunks
/// ```
///
/// Durability: appends are memory-first and group-committed; call [`Self::flush`]
/// (or [`Self::transaction`], which flushes at the end) for a durability barrier.
/// Drop also flushes.
pub struct LastStore {
    root: PathBuf,
    opts: LastStoreOptions,
    shards: Mutex<ShardWarmSet>,
    meta: Mutex<StoreMeta>,
}

impl LastStore {
    /// Open or create a store at `path` with default options.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let root = path.as_ref().to_path_buf();
        let opts = resolve_layout_options(&root, LastStoreOptions::default(), false)?;
        Self::open_resolved(root, opts)
    }

    /// Open or create a store with explicit options.
    pub fn open_with(path: impl AsRef<Path>, opts: LastStoreOptions) -> Result<Self> {
        let root = path.as_ref().to_path_buf();
        let opts = resolve_layout_options(&root, opts, true)?;
        Self::open_resolved(root, opts)
    }

    /// Open an existing store using its durable layout while retaining
    /// runtime-only options such as data keys, hooks, and CSN floors.
    /// For a fresh home, `opts` also selects the initial layout.
    pub fn open_existing_or_with(path: impl AsRef<Path>, opts: LastStoreOptions) -> Result<Self> {
        let root = path.as_ref().to_path_buf();
        let opts = resolve_layout_options(&root, opts, false)?;
        Self::open_resolved(root, opts)
    }

    fn open_resolved(root: PathBuf, mut opts: LastStoreOptions) -> Result<Self> {
        // Backward compatible: a present data_key implies frame-AEAD packaging
        // even when callers only set the key (pre-packaging-mode tests/APIs).
        if opts.data_key.is_some() {
            opts.packaging = PackagingMode::FrameAead;
        }
        opts.validate().map_err(Error::Config)?;
        fs::create_dir_all(root.join("data"))?;
        write_layout_descriptor(&root, &opts)?;
        let next_csn = opts.csn_floor.saturating_add(1);
        Ok(Self {
            root,
            opts,
            shards: Mutex::new(ShardWarmSet::default()),
            meta: Mutex::new(StoreMeta {
                next_csn,
                ..StoreMeta::default()
            }),
        })
    }

    /// Copy the live document set into a separate fresh hash-group home and
    /// verify full key/value parity before returning success.
    ///
    /// The source is read-only. The destination must not exist or must be an
    /// empty directory; an interrupted destination is intentionally not
    /// resumed or promoted automatically.
    pub fn migrate_to_hash_group(
        &self,
        destination: impl AsRef<Path>,
        destination_options: LastStoreOptions,
    ) -> Result<LayoutMigrationReport> {
        self.migrate_to_hash_group_with(destination, destination_options, |_, _, body| {
            Ok(body.to_vec())
        })
    }

    /// Copy the live document set while transforming each value before it is
    /// written. This is used by upper layers that must remove a legacy value
    /// envelope while moving protection into hash-group frame AEAD.
    pub fn migrate_to_hash_group_with<F>(
        &self,
        destination: impl AsRef<Path>,
        mut destination_options: LastStoreOptions,
        mut transform: F,
    ) -> Result<LayoutMigrationReport>
    where
        F: FnMut(&str, &str, &[u8]) -> Result<Vec<u8>>,
    {
        let destination = destination.as_ref();
        ensure_empty_migration_destination(destination)?;
        destination_options.layout_mode = LayoutMode::HashGroup;
        // New migrations always emit plain packaging (restart-safe open tails).
        // Atom body secrecy is an upper-layer concern (content field seal).
        destination_options.packaging = PackagingMode::Plain;
        destination_options.data_key = None;
        destination_options.layout_epoch = self.opts.layout_epoch.saturating_add(1);
        let target = Self::open_with(destination, destination_options)?;

        let mut collections = BTreeMap::new();
        for collection in self.collections_on_disk()? {
            // Source ids are lexicographically ordered, while destination
            // placement is hash ordered. Writing in source order repeatedly
            // evicts and reopens the same bounded hash-group handles, creating
            // one tiny encrypted tail per revisit on large collections.
            // Decorate and sort keys only; values remain streamed one at a
            // time so migration memory is proportional to id metadata rather
            // than the live data set.
            let mut ids = self
                .list_prefix_keys(&collection, "")?
                .into_iter()
                .map(|id| (target.shard_of(&id), target.group_of(&id), id))
                .collect::<Vec<_>>();
            ids.sort_unstable();
            let count = ids.len() as u64;
            for (_, _, id) in ids {
                let body = self
                    .get(&collection, &id)?
                    .ok_or_else(|| Error::Corrupt(format!("id vanished during migration: {id}")))?;
                let transformed = transform(&collection, &id, &body)?;
                target.put(&collection, &id, &transformed)?;
            }
            if count > 0 {
                collections.insert(collection, count);
            }
        }
        target.flush()?;

        verify_migration_parity(self, &target, &collections, &mut transform)?;
        let total_documents = collections.values().copied().sum();
        Ok(LayoutMigrationReport {
            collections,
            total_documents,
        })
    }

    /// Root directory of this store.
    pub fn path(&self) -> &Path {
        &self.root
    }

    /// Options used when this store was opened.
    pub fn options(&self) -> &LastStoreOptions {
        &self.opts
    }

    /// Highest commit sequence number assigned or accepted from the open floor.
    pub fn csn_high_water(&self) -> u64 {
        let meta = self.meta.lock().expect("poison");
        meta.next_csn.saturating_sub(1)
    }

    /// Whether capture has been suspended after a capture hook failure.
    pub fn capture_suspended(&self) -> bool {
        self.meta.lock().expect("poison").capture_suspended
    }

    /// In-memory CDC tail captured since this store handle opened.
    pub fn capture_log(&self) -> Vec<CaptureEvent> {
        self.meta.lock().expect("poison").capture_log.clone()
    }

    /// Immutable chunks sealed since this store handle opened.
    pub fn sealed_chunks(&self) -> Vec<SealedChunkMeta> {
        self.meta.lock().expect("poison").sealed_chunks.clone()
    }

    /// Insert or replace a document. Not durable until [`Self::flush`] /
    /// group-commit threshold / drop.
    pub fn put(&self, collection: &str, id: &str, body: &[u8]) -> Result<()> {
        let line = encode_put(id, body)?;
        let key = self.point_key(collection, id);
        let h = self.shard_handle_by_key(&key)?;
        {
            let mut sh = h.lock().expect("poison");
            let loc = self.append(&mut sh, &line, id, CaptureOp::Put)?;
            sh.index.insert(id.to_string(), loc);
            if sh.data_key.is_none() {
                sh.values.insert(id.to_string(), body.to_vec());
            }
        }
        self.refresh_warm_resident_bytes(&key, &h)?;
        Ok(())
    }

    /// Get a document by id.
    pub fn get(&self, collection: &str, id: &str) -> Result<Option<Vec<u8>>> {
        let key = self.point_key(collection, id);
        let h = self.shard_handle_by_key(&key)?;
        let out = {
            let mut sh = h.lock().expect("poison");
            if sh.data_key.is_none() && sh.values.contains_key(id) {
                let v = sh.values.get(id).expect("checked");
                return Ok(Some(v.clone()));
            }
            let Some(&loc) = sh.index.get(id) else {
                return Ok(None);
            };
            let body = Self::read_at(&mut sh, loc)?;
            if sh.data_key.is_none() {
                sh.values.insert(id.to_string(), body.clone());
            }
            Some(body)
        };
        self.refresh_warm_resident_bytes(&key, &h)?;
        Ok(out)
    }

    /// Delete a document if present.
    pub fn delete(&self, collection: &str, id: &str) -> Result<()> {
        let key = self.point_key(collection, id);
        let h = self.shard_handle_by_key(&key)?;
        {
            let mut sh = h.lock().expect("poison");
            if !sh.index.contains_key(id) {
                return Ok(());
            }
            let line = encode_del(id)?;
            self.append(&mut sh, &line, id, CaptureOp::Delete)?;
            sh.index.remove(id);
            sh.values.remove(id);
        }
        self.refresh_warm_resident_bytes(&key, &h)?;
        Ok(())
    }

    /// Whether a document id exists (no body load).
    pub fn exists(&self, collection: &str, id: &str) -> Result<bool> {
        let h = self.point_handle(collection, id)?;
        let sh = h.lock().expect("poison");
        Ok(sh.index.contains_key(id))
    }

    /// List documents whose ids start with `prefix` (sorted by id).
    ///
    /// Loads bodies. Prefer [`Self::list_prefix_keys`] when only ids are needed.
    pub fn list_prefix(&self, collection: &str, prefix: &str) -> Result<Vec<(String, Vec<u8>)>> {
        self.list_prefix_paged(collection, prefix, None, usize::MAX)
    }

    /// Ids only under `prefix` (sorted). Does **not** read or decode bodies —
    /// cheap discovery for GC, key lists, and outbox counters.
    pub fn list_prefix_keys(&self, collection: &str, prefix: &str) -> Result<Vec<String>> {
        self.list_prefix_keys_paged(collection, prefix, None, usize::MAX)
    }

    /// At most `limit` documents under `prefix`, ascending by id.
    ///
    /// `after`: exclusive cursor — only ids **strictly greater** than `after`
    /// (and still under `prefix`). Use the last id of the previous page.
    /// `limit == 0` → empty without scanning.
    pub fn list_prefix_paged(
        &self,
        collection: &str,
        prefix: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let ids = self.list_prefix_keys_paged(collection, prefix, after, limit)?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let body = self
                .get(collection, &id)?
                .ok_or_else(|| Error::Corrupt(format!("id vanished during walk: {id}")))?;
            out.push((id, body));
        }
        Ok(out)
    }

    /// Keys-only counterpart of [`Self::list_prefix_paged`].
    pub fn list_prefix_keys_paged(
        &self,
        collection: &str,
        prefix: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<String>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        // Range start: after exclusive if after is under prefix; else prefix.
        let start = match after {
            Some(a) if a.starts_with(prefix) => {
                // Exclusive: start at the next possible string after `a`.
                // BTreeMap range is inclusive on start, so we skip `a` in the loop.
                a.to_string()
            }
            _ => prefix.to_string(),
        };
        let skip_exact = after.filter(|a| a.starts_with(prefix));
        let mut merged: BTreeMap<String, ()> = BTreeMap::new();
        for (shard, group) in self.handles_on_disk(collection)? {
            let h = self.shard_handle_at(collection, shard, group)?;
            let sh = h.lock().expect("poison");
            for (id, _) in sh.index.range(start.clone()..) {
                if !id.starts_with(prefix) {
                    break;
                }
                if skip_exact == Some(id.as_str()) {
                    continue;
                }
                merged.insert(id.clone(), ());
            }
        }
        Ok(merged.into_iter().take(limit).map(|(id, _)| id).collect())
    }

    /// Documents with ids in the half-open range `[start, end)` (sorted).
    ///
    /// Empty if `start >= end`. Does not require a shared prefix, but for
    /// multi-shard stores this still visits every shard (correct, not always
    /// optimal).
    pub fn list_range(
        &self,
        collection: &str,
        start: &str,
        end: &str,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        self.list_range_paged(collection, start, end, usize::MAX)
    }

    /// At most `limit` docs in half-open `[start, end)`.
    pub fn list_range_paged(
        &self,
        collection: &str,
        start: &str,
        end: &str,
        limit: usize,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        if limit == 0 || start >= end {
            return Ok(Vec::new());
        }
        let ids = self.list_range_keys_paged(collection, start, end, limit)?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let body = self
                .get(collection, &id)?
                .ok_or_else(|| Error::Corrupt(format!("id vanished during walk: {id}")))?;
            out.push((id, body));
        }
        Ok(out)
    }

    /// Keys only in half-open `[start, end)`, ascending, at most `limit`.
    pub fn list_range_keys_paged(
        &self,
        collection: &str,
        start: &str,
        end: &str,
        limit: usize,
    ) -> Result<Vec<String>> {
        if limit == 0 || start >= end {
            return Ok(Vec::new());
        }
        let mut merged: BTreeMap<String, ()> = BTreeMap::new();
        for (shard, group) in self.handles_on_disk(collection)? {
            let h = self.shard_handle_at(collection, shard, group)?;
            let sh = h.lock().expect("poison");
            for (id, _) in sh.index.range(start.to_string()..end.to_string()) {
                merged.insert(id.clone(), ());
            }
        }
        Ok(merged.into_iter().take(limit).map(|(id, _)| id).collect())
    }

    /// Apply all ops then [`Self::flush`] (group-commit durability barrier).
    pub fn transaction(&self, ops: Vec<TxnOp>) -> Result<()> {
        for op in ops {
            match op {
                TxnOp::Put {
                    collection,
                    id,
                    body,
                } => self.put(&collection, &id, &body)?,
                TxnOp::Delete { collection, id } => self.delete(&collection, &id)?,
            }
        }
        self.flush()
    }

    /// Spill pending buffers and `sync_data` all open shards.
    pub fn flush(&self) -> Result<()> {
        let keys: Vec<ShardKey> = self
            .shards
            .lock()
            .expect("poison")
            .handles
            .keys()
            .cloned()
            .collect();
        for (c, s, g) in keys {
            let h = self.shard_handle_at(&c, s, g)?;
            let mut sh = h.lock().expect("poison");
            Self::sync_open(&mut sh)?;
        }
        Ok(())
    }

    /// Force-seal all dirty encrypted tails and return the chunks sealed by
    /// this call.
    pub fn snapshot(&self) -> Result<Snapshot> {
        let before = self.meta.lock().expect("poison").sealed_chunks.len();
        let keys: Vec<ShardKey> = self
            .shards
            .lock()
            .expect("poison")
            .handles
            .keys()
            .cloned()
            .collect();
        for (c, s, g) in keys {
            let h = self.shard_handle_at(&c, s, g)?;
            let mut sh = h.lock().expect("poison");
            if sh.data_key.is_some() && sh.open_len > 0 {
                Self::seal_open(&self.opts, &self.meta, &mut sh)?;
                Self::open_fresh_encrypted_tail(&mut sh);
            } else {
                Self::sync_open(&mut sh)?;
            }
        }
        let meta = self.meta.lock().expect("poison");
        Ok(Snapshot {
            sealed_chunks: meta.sealed_chunks[before..].to_vec(),
            max_csn: meta.next_csn.saturating_sub(1),
        })
    }

    /// Alias for [`Self::snapshot`] when callers need only the force-seal
    /// behavior.
    pub fn seal_all(&self) -> Result<Snapshot> {
        self.snapshot()
    }

    /// Compact every collection found under `data/`.
    pub fn compact(&self) -> Result<()> {
        for collection in self.collections_on_disk()? {
            self.compact_collection(&collection)?;
        }
        Ok(())
    }

    /// Compact one collection (rewrite live docs, delete old segments).
    pub fn compact_collection(&self, collection: &str) -> Result<()> {
        if self.opts.collection_policy(collection).never_compact {
            return Ok(());
        }
        for (shard, group) in self.handles_on_disk(collection)? {
            let h = self.shard_handle_at(collection, shard, group)?;
            let mut sh = h.lock().expect("poison");
            Self::compact_shard(&mut sh)?;
        }
        Ok(())
    }

    /// Verify all on-disk shards can be authenticated and indexed.
    ///
    /// For encrypted stores this walks every handle loader, which
    /// authenticates encrypted tail frames, sealed chunks, seal records, and
    /// footer records before returning. It does not hydrate document bodies
    /// beyond the frame payloads required to rebuild the local index.
    pub fn verify_integrity(&self) -> Result<()> {
        for collection in self.collections_on_disk()? {
            for (shard, group) in self.handles_on_disk(&collection)? {
                let verify_shard = Shard {
                    dir: self.handle_dir(&collection, shard, group),
                    collection: collection.clone(),
                    shard,
                    data_key: self.opts.data_key,
                    policy: self.opts.collection_policy(&collection),
                    ..Default::default()
                };

                for (chunk_uuid, path) in encrypted_files(&encrypted_chunks_dir(&verify_shard))? {
                    let disk = fs::read(&path)?;
                    let decoded =
                        decode_encrypted_file(&verify_shard, chunk_uuid, &path, &disk, false)?;
                    if !decoded.sealed {
                        return Err(Error::Corrupt(format!(
                            "sealed chunk {chunk_uuid} has no seal record"
                        )));
                    }
                }

                for (chunk_uuid, path) in encrypted_files(&encrypted_tail_dir(&verify_shard))? {
                    let disk = fs::read(&path)?;
                    if disk.is_empty() {
                        continue;
                    }
                    let decoded =
                        decode_encrypted_file(&verify_shard, chunk_uuid, &path, &disk, true)?;
                    if decoded.frames.is_empty() {
                        return Err(Error::Corrupt(format!(
                            "encrypted tail {chunk_uuid} has no authenticated frames"
                        )));
                    }
                }

                let _ = self.shard_handle_at(&collection, shard, group)?;
            }
        }
        Ok(())
    }

    /// Sealed encrypted chunks that are eligible for backup upload.
    ///
    /// Collections marked `backup_excluded` return an empty list even though
    /// they still seal and compact locally. Includes plain SegmentLog numbered
    /// segs as well as frame-AEAD `chunks/` units.
    pub fn backup_chunk_paths(&self, collection: &str) -> Result<Vec<PathBuf>> {
        if self.opts.collection_policy(collection).backup_excluded {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for (shard, group) in self.handles_on_disk(collection)? {
            let shard_dir = self.handle_dir(collection, shard, group);
            let chunks_dir = encrypted_chunks_dir_for(&shard_dir);
            let has_chunks_dir = chunks_dir.exists();
            if has_chunks_dir {
                for e in fs::read_dir(&chunks_dir)? {
                    let path = e?.path();
                    if path.extension().and_then(|s| s.to_str()) == Some("seg") {
                        out.push(path);
                    }
                }
            }
            if self.opts.packaging == PackagingMode::Plain || !has_chunks_dir {
                for (_uuid, path) in plain_segment_log_files(&shard_dir, collection, shard)? {
                    if !out.iter().any(|p| p == &path) {
                        out.push(path);
                    }
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// Sealed encrypted chunks for `collection`, including backup-excluded
    /// collections for local restore and verification callers.
    ///
    /// Covers both frame-AEAD `chunks/{uuid}.seg` homes and plain SegmentLog
    /// numbered `{seq:010}.seg` files (Tom's primary Mini layout).
    pub fn enumerate_chunks(&self, collection: &str) -> Result<Vec<SealedChunkMeta>> {
        let mut out = Vec::new();
        for (shard, group) in self.handles_on_disk(collection)? {
            let shard_dir = self.handle_dir(collection, shard, group);
            let chunks_dir = encrypted_chunks_dir_for(&shard_dir);
            for (chunk_uuid, path) in encrypted_files(&chunks_dir)? {
                out.push(SealedChunkMeta {
                    collection: collection.to_string(),
                    shard,
                    group_id: group,
                    chunk_uuid,
                    path,
                    end_csn: 0,
                });
            }
            // Plain SegmentLog: sealed units live as numbered segs in the shard
            // dir (no `chunks/` subdirectory). Include them so cloud backup can
            // drain real Mini homes that predate frame-AEAD layout.
            if self.opts.packaging == PackagingMode::Plain || !chunks_dir.exists() {
                for (chunk_uuid, path) in plain_segment_log_files(&shard_dir, collection, shard)? {
                    // Skip if we already listed the same path via chunks/.
                    if out.iter().any(|m| m.path == path) {
                        continue;
                    }
                    out.push(SealedChunkMeta {
                        collection: collection.to_string(),
                        shard,
                        group_id: group,
                        chunk_uuid,
                        path,
                        end_csn: 0,
                    });
                }
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// Verify one sealed encrypted chunk by UUID.
    pub fn verify_chunk(&self, chunk_uuid: Uuid) -> Result<SealedChunkMeta> {
        if let Some((collection, shard, group, path)) =
            find_chunk_file(&self.root, chunk_uuid, "chunks")?
        {
            let sh = Shard {
                dir: self.handle_dir(&collection, shard, group),
                collection: collection.clone(),
                shard,
                data_key: self.opts.data_key,
                policy: self.opts.collection_policy(&collection),
                ..Default::default()
            };
            let disk = fs::read(&path)?;
            let decoded = decode_encrypted_file(&sh, chunk_uuid, &path, &disk, false)?;
            if !decoded.sealed {
                return Err(Error::Corrupt(format!(
                    "sealed chunk {chunk_uuid} has no seal record"
                )));
            }
            return Ok(SealedChunkMeta {
                collection,
                shard,
                group_id: group,
                chunk_uuid,
                path,
                end_csn: decoded.max_csn,
            });
        }

        // Plain SegmentLog: uuid is deterministic from collection/shard/seq.
        if let Some(meta) = find_plain_segment_log_chunk(&self.root, chunk_uuid)? {
            // Presence + readable bytes is enough for opaque plain-seg backup;
            // frame AEAD seal records do not exist in this packaging.
            let _ = fs::metadata(&meta.path)?;
            return Ok(meta);
        }

        Err(Error::Corrupt(format!("missing chunk {chunk_uuid}")))
    }

    /// Install pristine bytes for a previously known or quarantined chunk UUID.
    pub fn install_chunk(&self, chunk_uuid: Uuid, bytes: &[u8]) -> Result<SealedChunkMeta> {
        let target = find_chunk_file(&self.root, chunk_uuid, "quarantine")?
            .or(find_chunk_file(&self.root, chunk_uuid, "chunks")?)
            .ok_or_else(|| Error::Corrupt(format!("unknown chunk {chunk_uuid}")))?;
        let (collection, shard, group, old_path) = target;
        let shard_dir = self.handle_dir(&collection, shard, group);
        let mut verify_shard = Shard {
            dir: shard_dir.clone(),
            collection: collection.clone(),
            shard,
            data_key: self.opts.data_key,
            policy: self.opts.collection_policy(&collection),
            ..Default::default()
        };
        let tmp = shard_dir
            .join("chunks")
            .join(format!("{chunk_uuid}.seg.installing"));
        fs::create_dir_all(encrypted_chunks_dir(&verify_shard))?;
        fs::write(&tmp, bytes)?;
        let decoded = decode_encrypted_file(&verify_shard, chunk_uuid, &tmp, bytes, false)?;
        if !decoded.sealed {
            let _ = fs::remove_file(&tmp);
            return Err(Error::Corrupt(format!(
                "installed chunk {chunk_uuid} has no seal record"
            )));
        }
        apply_encrypted_frames(&mut verify_shard, chunk_uuid, &decoded.frames, false)?;

        let dst = encrypted_chunk_path(&verify_shard, chunk_uuid);
        fs::rename(&tmp, &dst)?;
        if old_path != dst {
            let _ = fs::remove_file(old_path);
        }
        sync_dir(&encrypted_chunks_dir(&verify_shard))?;

        let maybe_handle = {
            let map = self.shards.lock().expect("poison");
            map.handles
                .iter()
                .find(|((c, s, _), _)| c == &collection && *s == shard)
                .map(|(_, handle)| handle.clone())
        };
        if let Some(handle) = maybe_handle {
            let mut sh = handle.lock().expect("poison");
            load_verified_sealed_chunk(&mut sh, chunk_uuid, &dst)?;
        }

        Ok(SealedChunkMeta {
            collection,
            shard,
            group_id: group,
            chunk_uuid,
            path: dst,
            end_csn: decoded.max_csn,
        })
    }

    /// Install pristine sealed-chunk bytes described by an external manifest.
    ///
    /// Restore starts from an empty store, so the chunk UUID is not yet known
    /// locally. The caller supplies the manifest's collection and shard.
    ///
    /// - **Frame-AEAD** packaging: decode + authenticate frame AAD, then place
    ///   under `chunks/{uuid}.seg`.
    /// - **Plain SegmentLog** packaging (Tom's primary Mini layout): write the
    ///   numbered `{seq:010}.seg` opaque sealed unit; content-addressed
    ///   integrity is the caller's sha256 check (no frame AEAD seal records).
    pub fn install_manifest_chunk(
        &self,
        collection: &str,
        shard: u16,
        group_id: Option<u32>,
        chunk_uuid: Uuid,
        bytes: &[u8],
    ) -> Result<SealedChunkMeta> {
        // Plain SegmentLog homes backup numbered segs, not frame-AEAD LSF1 files.
        if self.opts.packaging == PackagingMode::Plain {
            return self
                .install_plain_segment_log_chunk(collection, shard, group_id, chunk_uuid, bytes);
        }

        let shard_dir = self.handle_dir(collection, shard, group_id);
        let mut verify_shard = Shard {
            dir: shard_dir.clone(),
            collection: collection.to_string(),
            shard,
            data_key: self.opts.data_key,
            policy: self.opts.collection_policy(collection),
            ..Default::default()
        };
        fs::create_dir_all(encrypted_chunks_dir(&verify_shard))?;
        let tmp = shard_dir
            .join("chunks")
            .join(format!("{chunk_uuid}.seg.installing"));
        let _ = fs::remove_file(&tmp);
        fs::write(&tmp, bytes)?;
        let decoded = match decode_encrypted_file(&verify_shard, chunk_uuid, &tmp, bytes, false) {
            Ok(decoded) => decoded,
            Err(err) => {
                let _ = fs::remove_file(&tmp);
                return Err(err);
            }
        };
        if !decoded.sealed {
            let _ = fs::remove_file(&tmp);
            return Err(Error::Corrupt(format!(
                "installed chunk {chunk_uuid} has no seal record"
            )));
        }
        if let Err(err) =
            apply_encrypted_frames(&mut verify_shard, chunk_uuid, &decoded.frames, false)
        {
            let _ = fs::remove_file(&tmp);
            return Err(err);
        }

        let dst = encrypted_chunk_path(&verify_shard, chunk_uuid);
        fs::rename(&tmp, &dst)?;
        sync_dir(&encrypted_chunks_dir(&verify_shard))?;

        let maybe_handle = {
            let map = self.shards.lock().expect("poison");
            map.handles
                .iter()
                .find(|((c, s, g), _)| c == collection && *s == shard && *g == group_id)
                .map(|(_, handle)| handle.clone())
        };
        if let Some(handle) = maybe_handle {
            let mut sh = handle.lock().expect("poison");
            load_verified_sealed_chunk(&mut sh, chunk_uuid, &dst)?;
        }

        Ok(SealedChunkMeta {
            collection: collection.to_string(),
            shard,
            group_id,
            chunk_uuid,
            path: dst,
            end_csn: decoded.max_csn,
        })
    }

    /// Install a plain SegmentLog numbered seg from a cloud backup.
    fn install_plain_segment_log_chunk(
        &self,
        collection: &str,
        shard: u16,
        group_id: Option<u32>,
        chunk_uuid: Uuid,
        bytes: &[u8],
    ) -> Result<SealedChunkMeta> {
        // Recover seq from deterministic uuid (collection, shard, seq).
        // Prefer end_csn when the backup cutter packed seq there (0 is valid
        // for seq 0 — try direct match first, then scan a bounded range).
        let seq = plain_segment_log_seq_for_uuid(collection, shard, chunk_uuid).ok_or_else(|| {
            Error::Corrupt(format!(
                "plain segment log uuid {chunk_uuid} does not match any seq for {collection}/{shard}"
            ))
        })?;
        let shard_dir = self.handle_dir(collection, shard, group_id);
        fs::create_dir_all(&shard_dir)?;
        let dst = shard_dir.join(format!("{seq:010}.seg"));
        let tmp = shard_dir.join(format!("{seq:010}.seg.installing"));
        let _ = fs::remove_file(&tmp);
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &dst)?;
        sync_dir(&shard_dir)?;
        Ok(SealedChunkMeta {
            collection: collection.to_string(),
            shard,
            group_id,
            chunk_uuid,
            path: dst,
            end_csn: 0,
        })
    }

    /// Names of collection directories that exist on disk.
    pub fn collections_on_disk(&self) -> Result<Vec<String>> {
        let dir = self.root.join("data");
        let mut out = Vec::new();
        if !dir.exists() {
            return Ok(out);
        }
        for e in fs::read_dir(dir)? {
            let e = e?;
            if e.file_type()?.is_dir() {
                out.push(e.file_name().to_string_lossy().into_owned());
            }
        }
        out.sort();
        Ok(out)
    }

    /// Return the deterministic hash-group placement for `id`.
    pub fn place(&self, collection: &str, id: &str) -> HashGroupPlacement {
        let shard = self.shard_of(id);
        let group_id = self.group_of(id);
        let relative_dir = PathBuf::from("data")
            .join(collection)
            .join(self.shard_name(shard))
            .join("g")
            .join(self.group_name(group_id));
        HashGroupPlacement {
            collection: collection.to_string(),
            shard,
            group_id,
            relative_dir,
        }
    }

    /// Return approximate warm-set residency for hash-group handles.
    pub fn hash_group_warm_stats(&self) -> HashGroupWarmStats {
        let warm = self.shards.lock().expect("poison");
        HashGroupWarmStats {
            resident_groups: warm
                .handles
                .keys()
                .filter(|(_, _, group)| group.is_some())
                .count(),
            resident_bytes: warm.resident_bytes,
            budget_bytes: self.opts.hash_group_warm_bytes,
        }
    }

    /// Warm-set stats restricted to one collection's resident hash groups.
    ///
    /// `resident_bytes` is the sum of per-handle estimates for that collection
    /// only. `budget_bytes` is still the global warm budget.
    pub fn hash_group_warm_stats_for(&self, collection: &str) -> HashGroupWarmStats {
        let warm = self.shards.lock().expect("poison");
        let mut resident_groups = 0usize;
        let mut resident_bytes = 0u64;
        for (key, _) in warm.handles.iter() {
            if key.0 == collection && key.2.is_some() {
                resident_groups = resident_groups.saturating_add(1);
                resident_bytes =
                    resident_bytes.saturating_add(*warm.resident_by_key.get(key).unwrap_or(&0));
            }
        }
        HashGroupWarmStats {
            resident_groups,
            resident_bytes,
            budget_bytes: self.opts.hash_group_warm_bytes,
        }
    }

    /// Number of durable hash-group directories on disk for `collection`.
    ///
    /// This is independent of the in-memory warm set: cold groups that have
    /// never been touched still count here and do **not** require a resident
    /// handle.
    pub fn hash_group_disk_group_count(&self, collection: &str) -> Result<usize> {
        match self.opts.layout_mode {
            LayoutMode::SegmentLog => Ok(0),
            LayoutMode::HashGroup => Ok(self.hash_groups_on_disk(collection)?.len()),
        }
    }

    fn shard_of(&self, id: &str) -> u16 {
        let bits = self.opts.shard_bits;
        if bits == 0 {
            return 0;
        }
        let h = self.hash_id(id);
        (h as u16) >> (16 - bits)
    }

    fn group_of(&self, id: &str) -> u32 {
        let mask = (1u64 << self.opts.hash_group_bits) - 1;
        (self.hash_id(id) & mask) as u32
    }

    fn hash_id(&self, id: &str) -> u64 {
        match self.opts.hash_algo {
            HashAlgo::Fnv1a64 => fnv1a64(id.as_bytes()),
        }
    }

    fn shard_dir(&self, collection: &str, shard: u16) -> PathBuf {
        self.root
            .join("data")
            .join(collection)
            .join(self.shard_name(shard))
    }

    fn shard_name(&self, shard: u16) -> String {
        let bits = self.opts.shard_bits;
        if bits == 0 {
            return "0".to_string();
        }
        let w = usize::from(bits.div_ceil(4));
        format!("{shard:0w$x}")
    }

    fn group_name(&self, group: u32) -> String {
        let w = usize::from(self.opts.hash_group_bits.div_ceil(4));
        format!("{group:0w$x}")
    }

    fn hash_group_dir(&self, collection: &str, shard: u16, group: u32) -> PathBuf {
        self.shard_dir(collection, shard)
            .join("g")
            .join(self.group_name(group))
    }

    fn handle_dir(&self, collection: &str, shard: u16, group: Option<u32>) -> PathBuf {
        match group {
            Some(group) => self.hash_group_dir(collection, shard, group),
            None => self.shard_dir(collection, shard),
        }
    }

    fn shards_on_disk(&self, collection: &str) -> Result<Vec<u16>> {
        let dir = self.root.join("data").join(collection);
        let mut out = Vec::new();
        if !dir.exists() {
            return Ok(out);
        }
        for e in fs::read_dir(dir)? {
            let e = e?;
            if let Ok(n) = u16::from_str_radix(&e.file_name().to_string_lossy(), 16) {
                out.push(n);
            }
        }
        out.sort_unstable();
        Ok(out)
    }

    fn point_handle(&self, collection: &str, id: &str) -> Result<ShardHandle> {
        let key = self.point_key(collection, id);
        self.shard_handle_by_key(&key)
    }

    fn point_key(&self, collection: &str, id: &str) -> ShardKey {
        let shard = self.shard_of(id);
        let group = match self.opts.layout_mode {
            LayoutMode::SegmentLog => None,
            LayoutMode::HashGroup => Some(self.group_of(id)),
        };
        (collection.to_string(), shard, group)
    }

    fn shard_handle_by_key(&self, key: &ShardKey) -> Result<ShardHandle> {
        self.shard_handle_at(&key.0, key.1, key.2)
    }

    fn shard_handle_at(
        &self,
        collection: &str,
        shard: u16,
        group: Option<u32>,
    ) -> Result<ShardHandle> {
        let key = (collection.to_string(), shard, group);
        {
            let mut warm = self.shards.lock().expect("poison");
            if let Some(h) = warm.handles.get(&key).cloned() {
                touch_warm_key(&mut warm.order, &key);
                return Ok(h.clone());
            }
        }
        let loaded = load_shard(
            self.handle_dir(collection, shard, group),
            collection.to_string(),
            shard,
            self.opts.data_key,
            self.opts.collection_policy(collection),
        )?;
        {
            let mut meta = self.meta.lock().expect("poison");
            meta.next_csn = meta.next_csn.max(loaded.max_csn.saturating_add(1));
        }
        let handle = Arc::new(Mutex::new(loaded));
        {
            let mut warm = self.shards.lock().expect("poison");
            if let Some(existing) = warm.handles.get(&key).cloned() {
                touch_warm_key(&mut warm.order, &key);
                return Ok(existing);
            }
            warm.order.push_back(key.clone());
            if key.2.is_some() {
                let resident_bytes = estimate_shard_resident_bytes(&handle);
                warm.resident_bytes = warm.resident_bytes.saturating_add(resident_bytes);
                warm.resident_by_key.insert(key.clone(), resident_bytes);
            }
            warm.handles.insert(key, Arc::clone(&handle));
        }
        self.evict_hash_group_warm_set()?;
        Ok(handle)
    }

    fn refresh_warm_resident_bytes(&self, key: &ShardKey, handle: &ShardHandle) -> Result<()> {
        // Segment-log handles are the legacy correctness index, not members of
        // the bounded hash-group warm set. Re-estimating their full index on
        // every point operation turns a sequential scan into O(n^2) work and
        // also pollutes hash-group-only residency metrics.
        if key.2.is_none() {
            return Ok(());
        }
        let new_bytes = estimate_shard_resident_bytes(handle);
        {
            let mut warm = self.shards.lock().expect("poison");
            if !warm.handles.contains_key(key) {
                return Ok(());
            }
            let old_bytes = warm
                .resident_by_key
                .insert(key.clone(), new_bytes)
                .unwrap_or_default();
            warm.resident_bytes = warm
                .resident_bytes
                .saturating_sub(old_bytes)
                .saturating_add(new_bytes);
        }
        self.evict_hash_group_warm_set()
    }

    fn evict_hash_group_warm_set(&self) -> Result<()> {
        if self.opts.layout_mode != LayoutMode::HashGroup || self.opts.hash_group_warm_bytes == 0 {
            return Ok(());
        }
        loop {
            let candidate = {
                let mut warm = self.shards.lock().expect("poison");
                if warm.resident_bytes <= self.opts.hash_group_warm_bytes {
                    return Ok(());
                }
                let Some(key) = warm.order.pop_front() else {
                    return Ok(());
                };
                let Some(handle) = warm.handles.get(&key).cloned() else {
                    continue;
                };
                if key.2.is_none() || Arc::strong_count(&handle) > 2 {
                    warm.order.push_back(key);
                    return Ok(());
                }
                (key, handle)
            };

            let (key, handle) = candidate;
            {
                let mut sh = handle.lock().expect("poison");
                Self::sync_open(&mut sh)?;
            }
            let mut warm = self.shards.lock().expect("poison");
            if Arc::strong_count(&handle) > 2 {
                warm.order.push_back(key);
                return Ok(());
            }
            if warm.handles.remove(&key).is_some() {
                let old_bytes = warm.resident_by_key.remove(&key).unwrap_or_default();
                warm.resident_bytes = warm.resident_bytes.saturating_sub(old_bytes);
            }
        }
    }

    fn handles_on_disk(&self, collection: &str) -> Result<Vec<(u16, Option<u32>)>> {
        match self.opts.layout_mode {
            LayoutMode::SegmentLog => Ok(self
                .shards_on_disk(collection)?
                .into_iter()
                .map(|shard| (shard, None))
                .collect()),
            LayoutMode::HashGroup => self.hash_groups_on_disk(collection),
        }
    }

    fn hash_groups_on_disk(&self, collection: &str) -> Result<Vec<(u16, Option<u32>)>> {
        let mut out = Vec::new();
        let collection_dir = self.root.join("data").join(collection);
        if !collection_dir.exists() {
            return Ok(out);
        }
        for shard_entry in fs::read_dir(collection_dir)? {
            let shard_entry = shard_entry?;
            if !shard_entry.file_type()?.is_dir() {
                continue;
            }
            let shard_name = shard_entry.file_name().to_string_lossy().into_owned();
            let Ok(shard) = u16::from_str_radix(&shard_name, 16) else {
                continue;
            };
            let groups_dir = shard_entry.path().join("g");
            if !groups_dir.exists() {
                continue;
            }
            for group_entry in fs::read_dir(groups_dir)? {
                let group_entry = group_entry?;
                if !group_entry.file_type()?.is_dir() {
                    continue;
                }
                let group_name = group_entry.file_name().to_string_lossy().into_owned();
                if let Ok(group) = u32::from_str_radix(&group_name, 16) {
                    out.push((shard, Some(group)));
                }
            }
        }
        out.sort_unstable();
        Ok(out)
    }

    fn allocate_csn(&self, collection: &str, id: &str, op: CaptureOp) -> u64 {
        let mut meta = self.meta.lock().expect("poison");
        let csn = meta.next_csn;
        meta.next_csn = meta.next_csn.saturating_add(1);
        if meta.capture_suspended {
            return csn;
        }
        let event = CaptureEvent {
            csn,
            collection: collection.to_string(),
            id: id.to_string(),
            op,
        };
        if let Some(hook) = self.opts.capture_hook.as_ref() {
            if hook(&event).is_err() {
                meta.capture_suspended = true;
                return csn;
            }
        }
        meta.capture_log.push(event);
        csn
    }

    fn sync_open(sh: &mut Shard) -> Result<()> {
        if sh.dirty_ops == 0 && sh.dirty_bytes == 0 {
            return Ok(());
        }
        Self::spill_open(sh)?;
        if let Some(f) = sh.open_file.as_mut() {
            durability::sync_dirty_file(f)?;
        }
        sh.dirty_ops = 0;
        sh.dirty_bytes = 0;
        Ok(())
    }

    fn spill_open(sh: &mut Shard) -> Result<()> {
        if sh.data_key.is_some() {
            return Self::spill_encrypted_open(sh);
        }
        if sh.file_len as usize >= sh.open_buf.len() {
            return Ok(());
        }
        if sh.open_file.is_none() {
            let seg = *sh.segments.last().expect("seg");
            let path = sh.dir.join(format!("{seg:010}.seg"));
            sh.open_file = Some(OpenOptions::new().create(true).append(true).open(path)?);
        }
        let f = sh.open_file.as_mut().unwrap();
        let payload = &sh.open_buf[sh.file_len as usize..];
        if let Some(data_key) = sh.data_key.as_ref() {
            let chunk_uuid = *sh.open_chunk_uuid.get_or_insert_with(Uuid::new_v4);
            let header = FrameHeader {
                chunk_uuid,
                shard: sh.shard,
                start_csn: sh.file_len,
                counter: sh.next_frame_counter,
            };
            let encoded = frame::encode_frame(data_key, header, payload)?;
            f.write_all(&encoded)?;
            sh.next_frame_counter = sh.next_frame_counter.saturating_add(1);
        } else {
            f.write_all(payload)?;
        }
        sh.file_len = sh.open_buf.len() as u64;
        Ok(())
    }

    fn spill_encrypted_open(sh: &mut Shard) -> Result<()> {
        if sh.file_len as usize >= sh.open_buf.len() {
            return Ok(());
        }
        let data_key = sh
            .data_key
            .as_ref()
            .ok_or_else(|| Error::Config("encrypted spill without data key".into()))?;
        let chunk_uuid = *sh.open_chunk_uuid.get_or_insert_with(Uuid::new_v4);
        fs::create_dir_all(encrypted_tail_dir(sh))?;
        if sh.open_file.is_none() {
            let path = encrypted_tail_path(sh, chunk_uuid);
            sh.open_file = Some(OpenOptions::new().create(true).append(true).open(path)?);
        }
        let payload = sh.open_buf[sh.file_len as usize..].to_vec();
        let header = FrameHeader {
            chunk_uuid,
            shard: sh.shard,
            start_csn: sh.open_frame_start_csn.unwrap_or(sh.max_csn),
            counter: sh.next_frame_counter,
        };
        let encoded = frame::encode_frame(data_key, header, &payload)?;
        let path = encrypted_tail_path(sh, chunk_uuid);
        let disk_offset;
        {
            let f = sh.open_file.as_mut().unwrap();
            disk_offset = f.metadata()?.len();
            f.write_all(&encoded)?;
        }
        record_frame(
            sh,
            (chunk_uuid, header.counter),
            path,
            disk_offset,
            encoded.len() as u64,
            &payload,
        );
        sh.next_frame_counter = sh.next_frame_counter.saturating_add(1);
        sh.file_len = sh.open_buf.len() as u64;
        sh.open_frame_start_csn = None;
        Ok(())
    }

    fn append(&self, sh: &mut Shard, line: &[u8], id: &str, op: CaptureOp) -> Result<Loc> {
        if sh.data_key.is_some() {
            return self.append_encrypted(sh, line, id, op);
        }
        fs::create_dir_all(&sh.dir)?;
        tag_backup_excluded_collection(sh)?;
        let max_seg = self.opts.max_segment_bytes;
        let roll = sh.segments.is_empty()
            || (sh.open_len > 0 && sh.open_len + line.len() as u64 > max_seg);
        if roll {
            Self::sync_open(sh)?;
            if let Some(&prev) = sh.segments.last() {
                if !sh.open_buf.is_empty() {
                    sh.seg_bytes.insert(prev, std::mem::take(&mut sh.open_buf));
                }
            }
            let next = sh.segments.last().copied().unwrap_or(0) + 1;
            sh.segments.push(next);
            sh.open_len = 0;
            sh.file_len = 0;
            sh.open_file = None;
            sh.open_chunk_uuid = sh.data_key.map(|_| Uuid::new_v4());
            sh.next_frame_counter = 0;
            sh.open_buf.clear();
        }
        let seg = *sh.segments.last().expect("seg");
        let offset = sh.open_len;
        if sh.open_buf.capacity() < 1024 * 1024 {
            sh.open_buf.reserve(4 * 1024 * 1024);
        }
        sh.open_buf.extend_from_slice(line);
        sh.open_len += line.len() as u64;
        sh.dirty_ops = sh.dirty_ops.saturating_add(1);
        sh.dirty_bytes = sh.dirty_bytes.saturating_add(line.len() as u64);
        if sh.dirty_ops >= self.opts.max_dirty_ops || sh.dirty_bytes >= self.opts.max_dirty_bytes {
            Self::sync_open(sh)?;
        }
        Ok(Loc::Legacy {
            seg,
            offset,
            len: line.len() as u64,
        })
    }

    fn append_encrypted(
        &self,
        sh: &mut Shard,
        line: &[u8],
        id: &str,
        op: CaptureOp,
    ) -> Result<Loc> {
        fs::create_dir_all(encrypted_tail_dir(sh))?;
        fs::create_dir_all(encrypted_chunks_dir(sh))?;
        tag_backup_excluded_collection(sh)?;
        if sh.open_chunk_uuid.is_none() {
            Self::open_fresh_encrypted_tail(sh);
        }
        let max_seg = self.opts.max_segment_bytes;
        if sh.open_len > 0 && sh.open_len + line.len() as u64 > max_seg {
            Self::seal_open(&self.opts, &self.meta, sh)?;
            Self::open_fresh_encrypted_tail(sh);
        }
        let csn = self.allocate_csn(&sh.collection, id, op);
        let chunk_uuid = sh.open_chunk_uuid.expect("open chunk uuid");
        let frame_idx = sh.next_frame_counter;
        let offset_in_frame = sh.open_len.saturating_sub(sh.file_len);
        if sh.open_len == sh.file_len {
            sh.open_frame_start_csn = Some(csn);
        }
        if sh.open_buf.capacity() < 1024 * 1024 {
            sh.open_buf.reserve(4 * 1024 * 1024);
        }
        sh.open_buf.extend_from_slice(line);
        sh.open_len += line.len() as u64;
        sh.max_csn = sh.max_csn.max(csn);
        sh.dirty_ops = sh.dirty_ops.saturating_add(1);
        sh.dirty_bytes = sh.dirty_bytes.saturating_add(line.len() as u64);
        if sh.dirty_ops >= self.opts.max_dirty_ops || sh.dirty_bytes >= self.opts.max_dirty_bytes {
            Self::sync_open(sh)?;
        }
        Ok(Loc::Chunk {
            chunk_uuid,
            frame_idx,
            offset_in_frame,
            len: line.len() as u64,
        })
    }

    fn open_fresh_encrypted_tail(sh: &mut Shard) {
        sh.open_buf.clear();
        sh.open_len = 0;
        sh.file_len = 0;
        sh.open_file = None;
        sh.open_chunk_uuid = Some(Uuid::new_v4());
        sh.next_frame_counter = 0;
        sh.open_frame_start_csn = None;
    }

    fn seal_open(opts: &LastStoreOptions, meta: &Mutex<StoreMeta>, sh: &mut Shard) -> Result<()> {
        if sh.data_key.is_none() {
            return Ok(());
        }
        let Some(chunk_uuid) = sh.open_chunk_uuid else {
            return Ok(());
        };
        if sh.open_len == 0 {
            return Ok(());
        }
        Self::spill_encrypted_open(sh)?;
        fs::create_dir_all(encrypted_tail_dir(sh))?;
        fs::create_dir_all(encrypted_chunks_dir(sh))?;
        if sh.open_file.is_none() {
            sh.open_file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(encrypted_tail_path(sh, chunk_uuid))?,
            );
        }
        let end_csn = sh.max_csn;
        let seal_payload = encode_seal_record(end_csn);
        let header = FrameHeader {
            chunk_uuid,
            shard: sh.shard,
            start_csn: end_csn.saturating_add(1),
            counter: sh.next_frame_counter,
        };
        let data_key = *sh
            .data_key
            .as_ref()
            .ok_or_else(|| Error::Config("encrypted seal without data key".into()))?;
        let encoded = frame::encode_frame(&data_key, header, &seal_payload)?;
        {
            let f = sh.open_file.as_mut().unwrap();
            f.write_all(&encoded)?;
            durability::sync_dirty_file(f)?;
        }
        sh.next_frame_counter = sh.next_frame_counter.saturating_add(1);

        let footer_payload = encode_footer_record(sh, chunk_uuid)?;
        let footer_header = FrameHeader {
            chunk_uuid,
            shard: sh.shard,
            start_csn: end_csn.saturating_add(1),
            counter: sh.next_frame_counter,
        };
        let footer_encoded = frame::encode_frame(&data_key, footer_header, &footer_payload)?;
        {
            let f = sh.open_file.as_mut().unwrap();
            let footer_offset = f.metadata()?.len();
            f.write_all(&footer_encoded)?;
            write_footer_trailer(f, footer_offset, footer_encoded.len() as u64)?;
            durability::sync_dirty_file(f)?;
        }
        sh.next_frame_counter = sh.next_frame_counter.saturating_add(1);
        sh.open_file = None;

        let src = encrypted_tail_path(sh, chunk_uuid);
        let dst = encrypted_chunk_path(sh, chunk_uuid);
        fs::rename(&src, &dst)?;
        for loc in sh.frame_locs.values_mut() {
            if loc.path == src {
                loc.path = dst.clone();
            }
        }
        sync_dir(&encrypted_chunks_dir(sh))?;
        sync_dir(&encrypted_tail_dir(sh))?;
        sync_dir(&sh.dir)?;

        let sealed = SealedChunkMeta {
            collection: sh.collection.clone(),
            shard: sh.shard,
            group_id: shard_group_from_dir(sh),
            chunk_uuid,
            path: dst,
            end_csn,
        };
        if !sh.policy.backup_excluded {
            if let Some(on_seal) = opts.on_seal.as_ref() {
                let _ = on_seal(&sealed);
            }
        }
        meta.lock().expect("poison").sealed_chunks.push(sealed);

        sh.open_buf.clear();
        sh.open_len = 0;
        sh.file_len = 0;
        sh.open_chunk_uuid = None;
        sh.next_frame_counter = 0;
        sh.open_frame_start_csn = None;
        sh.dirty_ops = 0;
        sh.dirty_bytes = 0;
        Ok(())
    }

    fn read_at(sh: &mut Shard, loc: Loc) -> Result<Vec<u8>> {
        let rec = match loc {
            Loc::Legacy { seg, offset, len } => {
                let bytes = if Some(seg) == sh.segments.last().copied() {
                    &sh.open_buf
                } else {
                    sh.seg_bytes
                        .get(&seg)
                        .ok_or_else(|| Error::Corrupt(format!("missing seg {seg}")))?
                };
                parse_loc_record(bytes, offset, len)?
            }
            Loc::Chunk {
                chunk_uuid,
                frame_idx,
                offset_in_frame,
                len,
            } => {
                let key = (chunk_uuid, frame_idx);
                if let Some(frame_payload) = sh.frame_cache.get(&key) {
                    parse_loc_record(frame_payload, offset_in_frame, len)?
                } else if Some(chunk_uuid) == sh.open_chunk_uuid
                    && frame_idx == sh.next_frame_counter
                {
                    let s = sh.file_len + offset_in_frame;
                    parse_loc_record(&sh.open_buf, s, len)?
                } else if let Some(disk_loc) = sh.frame_locs.get(&key).cloned() {
                    let frame_payload = read_encrypted_frame(sh, key, &disk_loc)?;
                    parse_loc_record(&frame_payload, offset_in_frame, len)?
                } else {
                    return Err(Error::Corrupt(format!(
                        "missing frame {frame_idx} in chunk {chunk_uuid}"
                    )));
                }
            }
        };
        rec.body
            .ok_or_else(|| Error::Corrupt(format!("no body {}", rec.id)))
    }

    fn compact_shard(sh: &mut Shard) -> Result<()> {
        if sh.data_key.is_some() {
            return compact_encrypted_shard(sh);
        }
        if sh.segments.is_empty() {
            return Ok(());
        }
        Self::sync_open(sh)?;
        sh.open_file = None;
        let old = sh.segments.clone();
        let new_seq = old.last().copied().unwrap_or(0) + 1;
        let mut new_index = BTreeMap::new();
        let mut new_buf = Vec::new();
        let entries: Vec<_> = sh.index.iter().map(|(k, &l)| (k.clone(), l)).collect();
        for (id, loc) in entries {
            let body = Self::read_at(sh, loc)?;
            let line = encode_put(&id, &body)?;
            let offset = new_buf.len() as u64;
            new_buf.extend_from_slice(&line);
            new_index.insert(
                id,
                Loc::Legacy {
                    seg: new_seq,
                    offset,
                    len: line.len() as u64,
                },
            );
        }
        let (chunk_uuid, next_frame_counter) = if !new_buf.is_empty() {
            let path = sh.dir.join(format!("{new_seq:010}.seg"));
            let tmp = sh.dir.join(format!("{new_seq:010}.seg.tmp"));
            let (disk_bytes, chunk_uuid, next_frame_counter) =
                encode_segment_payload(sh, 0, &new_buf)?;
            fs::write(&tmp, &disk_bytes)?;
            let f = OpenOptions::new().write(true).open(&tmp)?;
            durability::sync_dirty_file(&f)?;
            drop(f);
            fs::rename(&tmp, &path)?;
            (chunk_uuid, next_frame_counter)
        } else {
            (None, 0)
        };
        for s in &old {
            let _ = fs::remove_file(sh.dir.join(format!("{s:010}.seg")));
        }
        File::open(&sh.dir)?.sync_all()?;
        sh.segments = if new_index.is_empty() {
            vec![]
        } else {
            vec![new_seq]
        };
        sh.index = new_index;
        sh.open_len = new_buf.len() as u64;
        sh.file_len = new_buf.len() as u64;
        sh.open_buf = new_buf;
        sh.open_chunk_uuid = chunk_uuid;
        sh.next_frame_counter = next_frame_counter;
        sh.seg_bytes.clear();
        sh.dirty_ops = 0;
        sh.dirty_bytes = 0;
        Ok(())
    }
}

impl Drop for LastStore {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

fn load_shard(
    dir: PathBuf,
    collection: String,
    shard: u16,
    data_key: Option<[u8; 32]>,
    policy: CollectionPolicy,
) -> Result<Shard> {
    let mut sh = Shard {
        dir,
        collection,
        shard,
        data_key,
        policy,
        ..Default::default()
    };
    if sh.data_key.is_some() {
        return load_encrypted_shard(sh);
    }
    if !sh.dir.exists() {
        return Ok(sh);
    }
    let mut seqs = Vec::new();
    for e in fs::read_dir(&sh.dir)? {
        let p = e?.path();
        if p.extension().and_then(|x| x.to_str()) != Some("seg") {
            continue;
        }
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            if let Ok(n) = stem.parse::<u64>() {
                seqs.push(n);
            }
        }
    }
    seqs.sort_unstable();
    for (i, &seq) in seqs.iter().enumerate() {
        let last = i + 1 == seqs.len();
        let path = sh.dir.join(format!("{seq:010}.seg"));
        let disk_data = fs::read(&path)?;
        let (data, clean_disk_len, chunk_uuid, next_frame_counter) =
            decode_segment_payload(&sh, seq, &disk_data, last)?;
        let mut off = 0usize;
        let mut clean = 0usize;
        while off < data.len() {
            match segfmt::parse_at(&data, off)? {
                None => {
                    if last {
                        break;
                    }
                    return Err(Error::Corrupt(format!("bad sealed seg {seq}")));
                }
                Some(rec) => {
                    let len = rec.raw_len;
                    if rec.is_put {
                        sh.index.insert(
                            rec.id,
                            Loc::Legacy {
                                seg: seq,
                                offset: off as u64,
                                len: len as u64,
                            },
                        );
                    } else {
                        sh.index.remove(&rec.id);
                    }
                    off += len;
                    clean = off;
                }
            }
        }
        if last {
            if clean < data.len() || clean_disk_len < disk_data.len() as u64 {
                let f = OpenOptions::new().write(true).open(&path)?;
                let truncate_to = if sh.data_key.is_some() {
                    clean_disk_len
                } else {
                    clean as u64
                };
                f.set_len(truncate_to)?;
                durability::sync_dirty_file(&f)?;
            }
            sh.open_len = clean as u64;
            sh.file_len = clean as u64;
            sh.open_buf = data[..clean].to_vec();
            sh.open_chunk_uuid = chunk_uuid;
            sh.next_frame_counter = next_frame_counter;
            sh.open_frame_start_csn = None;
        } else {
            sh.seg_bytes.insert(seq, data);
        }
    }
    sh.segments = seqs;
    Ok(sh)
}

fn load_encrypted_shard(mut sh: Shard) -> Result<Shard> {
    if !sh.dir.exists() {
        return Ok(sh);
    }

    let mut chunks = encrypted_files(&encrypted_chunks_dir(&sh))?;
    let mut tails = encrypted_files(&encrypted_tail_dir(&sh))?;
    sort_encrypted_files_by_mtime(&mut chunks);
    sort_encrypted_files_by_mtime(&mut tails);

    for (chunk_uuid, path) in chunks {
        if let Err(err) = load_verified_sealed_chunk(&mut sh, chunk_uuid, &path) {
            if matches!(err, Error::Io(_)) {
                return Err(err);
            }
            quarantine_encrypted_chunk(&sh, chunk_uuid, &path)?;
        }
    }

    for (chunk_uuid, path) in tails {
        let disk_data = fs::read(&path)?;
        let decoded = decode_encrypted_file(&sh, chunk_uuid, &path, &disk_data, true)?;
        sh.max_csn = sh.max_csn.max(decoded.max_csn);
        if decoded.clean_disk_len < disk_data.len() as u64 {
            let f = OpenOptions::new().write(true).open(&path)?;
            f.set_len(decoded.clean_disk_len)?;
            durability::sync_dirty_file(&f)?;
        }
        if decoded.frames.is_empty() {
            let _ = fs::remove_file(path);
            continue;
        }
        apply_encrypted_frames(&mut sh, chunk_uuid, &decoded.frames, false)?;
        let plaintext: Vec<u8> = decoded
            .frames
            .iter()
            .flat_map(|(_, payload)| payload.iter().copied())
            .collect();
        for (frame_idx, payload) in decoded.frames {
            insert_frame_cache(&mut sh, (chunk_uuid, frame_idx), payload);
        }
        for (frame_idx, loc) in decoded.frame_locs {
            sh.frame_locs.insert((chunk_uuid, frame_idx), loc);
        }
        sh.open_chunk_uuid = Some(chunk_uuid);
        sh.open_len = plaintext.len() as u64;
        sh.file_len = plaintext.len() as u64;
        sh.open_buf = plaintext;
        sh.next_frame_counter = decoded.next_frame_counter;
        sh.open_frame_start_csn = None;
        seal_recovered_tail(&mut sh, chunk_uuid)?;
    }
    if sh.data_key.is_some() && sh.open_chunk_uuid.is_none() {
        LastStore::open_fresh_encrypted_tail(&mut sh);
    }
    Ok(sh)
}

fn apply_encrypted_frames(
    sh: &mut Shard,
    chunk_uuid: Uuid,
    frames: &[(u64, Vec<u8>)],
    allow_partial_last_frame: bool,
) -> Result<()> {
    for (frame_idx, payload) in frames {
        let mut off = 0usize;
        while off < payload.len() {
            match segfmt::parse_at(payload, off)? {
                None => {
                    if allow_partial_last_frame {
                        break;
                    }
                    return Err(Error::Corrupt(format!("bad encrypted chunk {chunk_uuid}")));
                }
                Some(rec) => {
                    let len = rec.raw_len;
                    if rec.is_put {
                        sh.index.insert(
                            rec.id,
                            Loc::Chunk {
                                chunk_uuid,
                                frame_idx: *frame_idx,
                                offset_in_frame: off as u64,
                                len: len as u64,
                            },
                        );
                    } else {
                        sh.index.remove(&rec.id);
                    }
                    off += len;
                }
            }
        }
    }
    Ok(())
}

struct DecodedEncryptedFile {
    frames: Vec<(u64, Vec<u8>)>,
    frame_locs: Vec<(u64, FrameDiskLoc)>,
    clean_disk_len: u64,
    next_frame_counter: u64,
    sealed: bool,
    max_csn: u64,
}

fn decode_encrypted_file(
    sh: &Shard,
    expected_uuid: Uuid,
    path: &Path,
    disk_data: &[u8],
    allow_truncated_tail: bool,
) -> Result<DecodedEncryptedFile> {
    let data_key = sh
        .data_key
        .as_ref()
        .ok_or_else(|| Error::Config("encrypted decode without data key".into()))?;
    let mut frames = Vec::new();
    let mut frame_locs = Vec::new();
    let mut off = 0usize;
    let mut plaintext_len = 0u64;
    let mut next_frame_counter = 0u64;
    let mut max_csn = 0u64;
    let mut sealed = false;
    while off < disk_data.len() {
        if is_footer_trailer_at(disk_data, off) {
            break;
        }
        if disk_data.len() - off < frame::min_encoded_len() {
            if allow_truncated_tail {
                break;
            }
            return Err(Error::Corrupt(format!(
                "bad sealed encrypted chunk {expected_uuid}"
            )));
        }
        let frame_len = match frame::encoded_len(&disk_data[off..off + frame::header_size()]) {
            Ok(len) if off + len <= disk_data.len() => len,
            Ok(_) if allow_truncated_tail => break,
            Ok(_) => {
                return Err(Error::Corrupt(format!(
                    "bad sealed encrypted chunk {expected_uuid}"
                )))
            }
            Err(e) => return Err(e),
        };
        let decoded = frame::decode_frame(data_key, &disk_data[off..off + frame_len])?;
        if decoded.header.shard != sh.shard || decoded.header.chunk_uuid != expected_uuid {
            return Err(Error::AeadAuthFail);
        }
        if decoded.header.counter != next_frame_counter {
            return Err(Error::AeadAuthFail);
        }
        if is_seal_record(&decoded.payload) {
            let end_csn = decode_seal_record(&decoded.payload)?;
            if decoded.header.start_csn != end_csn.saturating_add(1) {
                return Err(Error::AeadAuthFail);
            }
            max_csn = max_csn.max(end_csn);
            sealed = true;
            off += frame_len;
            next_frame_counter = next_frame_counter.saturating_add(1);
            if off == disk_data.len() || is_footer_trailer_at(disk_data, off) {
                break;
            }
            continue;
        }
        if is_footer_record(&decoded.payload) {
            if !sealed {
                return Err(Error::Corrupt(format!(
                    "chunk {expected_uuid} has footer before seal"
                )));
            }
            if decoded.header.start_csn != max_csn.saturating_add(1) {
                return Err(Error::AeadAuthFail);
            }
            off += frame_len;
            next_frame_counter = next_frame_counter.saturating_add(1);
            if off == disk_data.len() || is_footer_trailer_at(disk_data, off) {
                break;
            }
            continue;
        }
        if sealed {
            return Err(Error::Corrupt(format!(
                "sealed chunk {expected_uuid} has data after seal"
            )));
        }
        let records = count_complete_records(&decoded.payload, false)?;
        if records > 0 {
            let frame_end = decoded.header.start_csn.saturating_add(records - 1);
            max_csn = max_csn.max(frame_end);
        }
        plaintext_len = plaintext_len.saturating_add(decoded.payload.len() as u64);
        frame_locs.push((
            decoded.header.counter,
            FrameDiskLoc {
                path: path.to_path_buf(),
                disk_offset: off as u64,
                disk_len: frame_len as u64,
            },
        ));
        frames.push((decoded.header.counter, decoded.payload));
        off += frame_len;
        next_frame_counter = next_frame_counter.saturating_add(1);
    }
    Ok(DecodedEncryptedFile {
        frames,
        frame_locs,
        clean_disk_len: off as u64,
        next_frame_counter,
        sealed,
        max_csn,
    })
}

fn load_verified_sealed_chunk(sh: &mut Shard, chunk_uuid: Uuid, path: &Path) -> Result<()> {
    let disk_data = fs::read(path)?;
    let decoded = decode_encrypted_file(sh, chunk_uuid, path, &disk_data, false)?;
    if !decoded.sealed {
        return Err(Error::Corrupt(format!(
            "sealed chunk {chunk_uuid} has no seal record"
        )));
    }
    sh.max_csn = sh.max_csn.max(decoded.max_csn);
    apply_encrypted_frames(sh, chunk_uuid, &decoded.frames, false)?;
    for (frame_idx, payload) in decoded.frames {
        insert_frame_cache(sh, (chunk_uuid, frame_idx), payload);
    }
    for (frame_idx, loc) in decoded.frame_locs {
        sh.frame_locs.insert((chunk_uuid, frame_idx), loc);
    }
    Ok(())
}

fn seal_recovered_tail(sh: &mut Shard, chunk_uuid: Uuid) -> Result<()> {
    if sh.open_len == 0 {
        sh.open_chunk_uuid = None;
        sh.next_frame_counter = 0;
        return Ok(());
    }
    fs::create_dir_all(encrypted_tail_dir(sh))?;
    fs::create_dir_all(encrypted_chunks_dir(sh))?;
    let path = encrypted_tail_path(sh, chunk_uuid);
    let mut f = OpenOptions::new().append(true).open(&path)?;
    let data_key = *sh
        .data_key
        .as_ref()
        .ok_or_else(|| Error::Config("encrypted recovered seal without data key".into()))?;
    let end_csn = sh.max_csn;
    let seal_payload = encode_seal_record(end_csn);
    let seal_header = FrameHeader {
        chunk_uuid,
        shard: sh.shard,
        start_csn: end_csn.saturating_add(1),
        counter: sh.next_frame_counter,
    };
    let seal_encoded = frame::encode_frame(&data_key, seal_header, &seal_payload)?;
    f.write_all(&seal_encoded)?;
    sh.next_frame_counter = sh.next_frame_counter.saturating_add(1);

    let footer_payload = encode_footer_record(sh, chunk_uuid)?;
    let footer_header = FrameHeader {
        chunk_uuid,
        shard: sh.shard,
        start_csn: end_csn.saturating_add(1),
        counter: sh.next_frame_counter,
    };
    let footer_encoded = frame::encode_frame(&data_key, footer_header, &footer_payload)?;
    let footer_offset = f.metadata()?.len();
    f.write_all(&footer_encoded)?;
    write_footer_trailer(&mut f, footer_offset, footer_encoded.len() as u64)?;
    durability::sync_dirty_file(&f)?;
    drop(f);

    let dst = encrypted_chunk_path(sh, chunk_uuid);
    fs::rename(&path, &dst)?;
    for loc in sh.frame_locs.values_mut() {
        if loc.path == path {
            loc.path = dst.clone();
        }
    }
    sync_dir(&encrypted_chunks_dir(sh))?;
    sync_dir(&encrypted_tail_dir(sh))?;

    sh.open_buf.clear();
    sh.open_len = 0;
    sh.file_len = 0;
    sh.open_file = None;
    sh.open_chunk_uuid = None;
    sh.next_frame_counter = 0;
    sh.open_frame_start_csn = None;
    sh.dirty_ops = 0;
    sh.dirty_bytes = 0;
    Ok(())
}

fn encode_footer_record(sh: &Shard, chunk_uuid: Uuid) -> Result<Vec<u8>> {
    let mut frame_entries = sh
        .frame_locs
        .iter()
        .filter_map(|(&(uuid, frame_idx), loc)| {
            (uuid == chunk_uuid).then_some((frame_idx, loc.disk_offset, loc.disk_len))
        })
        .collect::<Vec<_>>();
    frame_entries.sort_by_key(|(frame_idx, _, _)| *frame_idx);

    let mut index_entries = sh
        .index
        .iter()
        .filter_map(|(id, loc)| match *loc {
            Loc::Chunk {
                chunk_uuid: uuid,
                frame_idx,
                offset_in_frame,
                len,
            } if uuid == chunk_uuid => Some((id.clone(), frame_idx, offset_in_frame, len)),
            _ => None,
        })
        .collect::<Vec<_>>();
    index_entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut chunk_mutations = BTreeMap::new();
    let mut off = 0usize;
    while off < sh.open_buf.len() {
        let rec = segfmt::parse_at(&sh.open_buf, off)?
            .ok_or_else(|| Error::Corrupt("bad footer source records".into()))?;
        off += rec.raw_len;
        chunk_mutations.insert(rec.id, rec.is_put);
    }
    let tombstones = chunk_mutations
        .into_iter()
        .filter_map(|(id, is_put)| (!is_put).then_some(id))
        .collect::<Vec<_>>();

    let mut out = Vec::new();
    out.extend_from_slice(FOOTER_RECORD_MAGIC);
    out.extend_from_slice(&(frame_entries.len() as u64).to_le_bytes());
    for (frame_idx, disk_offset, disk_len) in frame_entries {
        out.extend_from_slice(&frame_idx.to_le_bytes());
        out.extend_from_slice(&disk_offset.to_le_bytes());
        out.extend_from_slice(&disk_len.to_le_bytes());
    }
    out.extend_from_slice(&(index_entries.len() as u64).to_le_bytes());
    for (id, frame_idx, offset_in_frame, len) in index_entries {
        let id_bytes = id.as_bytes();
        let id_len = u32::try_from(id_bytes.len())
            .map_err(|_| Error::Corrupt("footer id too long".into()))?;
        out.extend_from_slice(&id_len.to_le_bytes());
        out.extend_from_slice(id_bytes);
        out.extend_from_slice(&frame_idx.to_le_bytes());
        out.extend_from_slice(&offset_in_frame.to_le_bytes());
        out.extend_from_slice(&len.to_le_bytes());
    }
    out.extend_from_slice(&(tombstones.len() as u64).to_le_bytes());
    for id in tombstones {
        let id_bytes = id.as_bytes();
        let id_len = u32::try_from(id_bytes.len())
            .map_err(|_| Error::Corrupt("footer id too long".into()))?;
        out.extend_from_slice(&id_len.to_le_bytes());
        out.extend_from_slice(id_bytes);
    }
    Ok(out)
}

fn write_footer_trailer(f: &mut File, footer_offset: u64, footer_len: u64) -> Result<()> {
    let mut trailer = [0u8; FOOTER_TRAILER_LEN];
    trailer[..FOOTER_TRAILER_MAGIC.len()].copy_from_slice(FOOTER_TRAILER_MAGIC);
    trailer[8..16].copy_from_slice(&footer_offset.to_le_bytes());
    trailer[16..24].copy_from_slice(&footer_len.to_le_bytes());
    f.write_all(&trailer)?;
    Ok(())
}

fn is_footer_trailer_at(bytes: &[u8], off: usize) -> bool {
    bytes.len().saturating_sub(off) == FOOTER_TRAILER_LEN
        && bytes[off..].starts_with(FOOTER_TRAILER_MAGIC)
}

fn record_frame(
    sh: &mut Shard,
    key: FrameKey,
    path: PathBuf,
    disk_offset: u64,
    disk_len: u64,
    payload: &[u8],
) {
    sh.frame_locs.insert(
        key,
        FrameDiskLoc {
            path,
            disk_offset,
            disk_len,
        },
    );
    insert_frame_cache(sh, key, payload.to_vec());
}

fn insert_frame_cache(sh: &mut Shard, key: FrameKey, payload: Vec<u8>) {
    if !sh.frame_cache.contains_key(&key) {
        sh.frame_cache_order.push_back(key);
    }
    sh.frame_cache.insert(key, payload);
    while sh.frame_cache_order.len() > FRAME_CACHE_LIMIT {
        if let Some(old) = sh.frame_cache_order.pop_front() {
            sh.frame_cache.remove(&old);
        }
    }
}

fn touch_warm_key(order: &mut VecDeque<ShardKey>, key: &ShardKey) {
    if let Some(pos) = order.iter().position(|existing| existing == key) {
        order.remove(pos);
    }
    order.push_back(key.clone());
}

fn estimate_shard_resident_bytes(handle: &ShardHandle) -> u64 {
    let sh = handle.lock().expect("poison");
    let mut bytes = sh.open_buf.capacity() as u64;
    bytes = bytes.saturating_add(sh.values.values().map(|v| v.capacity() as u64).sum::<u64>());
    bytes = bytes.saturating_add(
        sh.seg_bytes
            .values()
            .map(|v| v.capacity() as u64)
            .sum::<u64>(),
    );
    bytes = bytes.saturating_add(
        sh.frame_cache
            .values()
            .map(|v| v.capacity() as u64)
            .sum::<u64>(),
    );
    bytes.saturating_add((sh.index.len() as u64).saturating_mul(128))
}

fn read_encrypted_frame(sh: &mut Shard, key: FrameKey, loc: &FrameDiskLoc) -> Result<Vec<u8>> {
    let data_key = *sh
        .data_key
        .as_ref()
        .ok_or_else(|| Error::Config("encrypted frame read without data key".into()))?;
    let mut f = File::open(&loc.path)?;
    f.seek(SeekFrom::Start(loc.disk_offset))?;
    let mut encoded = vec![0u8; loc.disk_len as usize];
    f.read_exact(&mut encoded)?;
    let decoded = frame::decode_frame(&data_key, &encoded)?;
    if decoded.header.chunk_uuid != key.0
        || decoded.header.counter != key.1
        || decoded.header.shard != sh.shard
        || is_seal_record(&decoded.payload)
        || is_footer_record(&decoded.payload)
    {
        return Err(Error::AeadAuthFail);
    }
    let payload = decoded.payload;
    insert_frame_cache(sh, key, payload.clone());
    Ok(payload)
}

fn compact_encrypted_shard(sh: &mut Shard) -> Result<()> {
    if sh.index.is_empty() && sh.open_chunk_uuid.is_none() && sh.frame_locs.is_empty() {
        return Ok(());
    }
    LastStore::sync_open(sh)?;
    sh.open_file = None;

    let old_paths = encrypted_shard_paths(sh)?;
    let mut new_index = BTreeMap::new();
    let mut new_buf = Vec::new();
    let entries: Vec<_> = sh.index.iter().map(|(k, &l)| (k.clone(), l)).collect();
    for (id, loc) in entries {
        let body = LastStore::read_at(sh, loc)?;
        let line = encode_put(&id, &body)?;
        let offset = new_buf.len() as u64;
        new_buf.extend_from_slice(&line);
        new_index.insert(
            id,
            Loc::Chunk {
                chunk_uuid: Uuid::nil(),
                frame_idx: 0,
                offset_in_frame: offset,
                len: line.len() as u64,
            },
        );
    }

    sh.index.clear();
    sh.frame_cache.clear();
    sh.frame_cache_order.clear();
    sh.frame_locs.clear();
    sh.open_buf.clear();
    sh.open_len = 0;
    sh.file_len = 0;
    sh.open_file = None;
    sh.open_chunk_uuid = None;
    sh.next_frame_counter = 0;

    if !new_buf.is_empty() {
        fs::create_dir_all(encrypted_chunks_dir(sh))?;
        let chunk_uuid = Uuid::new_v4();
        let header = FrameHeader {
            chunk_uuid,
            shard: sh.shard,
            start_csn: 0,
            counter: 0,
        };
        let data_key = sh
            .data_key
            .as_ref()
            .ok_or_else(|| Error::Config("encrypted compact without data key".into()))?;
        let encoded = frame::encode_frame(data_key, header, &new_buf)?;
        let path = encrypted_chunk_path(sh, chunk_uuid);
        let tmp = path.with_extension("seg.tmp");
        fs::write(&tmp, &encoded)?;
        for loc in new_index.values_mut() {
            if let Loc::Chunk { chunk_uuid: id, .. } = loc {
                *id = chunk_uuid;
            }
        }
        sh.index = new_index;
        sh.frame_locs.insert(
            (chunk_uuid, 0),
            FrameDiskLoc {
                path: path.clone(),
                disk_offset: 0,
                disk_len: encoded.len() as u64,
            },
        );
        sh.open_buf = new_buf.clone();

        let mut f = OpenOptions::new().append(true).open(&tmp)?;
        let records = count_complete_records(&new_buf, false)?;
        let end_csn = records.saturating_sub(1);
        let seal_payload = encode_seal_record(end_csn);
        let seal_header = FrameHeader {
            chunk_uuid,
            shard: sh.shard,
            start_csn: end_csn.saturating_add(1),
            counter: 1,
        };
        let seal_encoded = frame::encode_frame(data_key, seal_header, &seal_payload)?;
        f.write_all(&seal_encoded)?;
        let footer_payload = encode_footer_record(sh, chunk_uuid)?;
        let footer_header = FrameHeader {
            chunk_uuid,
            shard: sh.shard,
            start_csn: end_csn.saturating_add(1),
            counter: 2,
        };
        let footer_encoded = frame::encode_frame(data_key, footer_header, &footer_payload)?;
        let footer_offset = f.metadata()?.len();
        f.write_all(&footer_encoded)?;
        write_footer_trailer(&mut f, footer_offset, footer_encoded.len() as u64)?;
        durability::sync_dirty_file(&f)?;
        drop(f);
        fs::rename(&tmp, &path)?;
        sync_dir(&encrypted_chunks_dir(sh))?;
        insert_frame_cache(sh, (chunk_uuid, 0), new_buf.clone());
        sh.open_buf.clear();
        sh.open_len = 0;
        sh.file_len = 0;
        sh.open_chunk_uuid = None;
        sh.next_frame_counter = 0;
    }

    for path in old_paths {
        if Some(path.as_path())
            != sh
                .open_chunk_uuid
                .map(|u| encrypted_tail_path(sh, u))
                .as_deref()
        {
            let _ = fs::remove_file(path);
        }
    }
    sync_dir(&encrypted_chunks_dir(sh))?;
    sync_dir(&encrypted_tail_dir(sh))?;
    sync_dir(&sh.dir)?;
    sh.dirty_ops = 0;
    sh.dirty_bytes = 0;
    Ok(())
}

fn parse_loc_record(bytes: &[u8], offset: u64, len: u64) -> Result<segfmt::Rec> {
    let s = offset as usize;
    let e = s + len as usize;
    if e > bytes.len() {
        return Err(Error::Corrupt("loc oob".into()));
    }
    segfmt::parse_at(&bytes[s..e], 0)?.ok_or_else(|| Error::Corrupt("empty rec".into()))
}

fn encrypted_tail_dir(sh: &Shard) -> PathBuf {
    encrypted_tail_dir_for(&sh.dir)
}

fn encrypted_chunks_dir(sh: &Shard) -> PathBuf {
    encrypted_chunks_dir_for(&sh.dir)
}

fn encrypted_tail_dir_for(shard_dir: &Path) -> PathBuf {
    shard_dir.join("tail")
}

fn encrypted_chunks_dir_for(shard_dir: &Path) -> PathBuf {
    shard_dir.join("chunks")
}

fn encrypted_quarantine_dir(sh: &Shard) -> PathBuf {
    sh.dir.join("quarantine")
}

fn encrypted_tail_path(sh: &Shard, chunk_uuid: Uuid) -> PathBuf {
    encrypted_tail_dir(sh).join(format!("{chunk_uuid}.seg"))
}

fn encrypted_chunk_path(sh: &Shard, chunk_uuid: Uuid) -> PathBuf {
    encrypted_chunks_dir(sh).join(format!("{chunk_uuid}.seg"))
}

fn quarantine_encrypted_chunk(sh: &Shard, chunk_uuid: Uuid, path: &Path) -> Result<PathBuf> {
    fs::create_dir_all(encrypted_quarantine_dir(sh))?;
    let dst = encrypted_quarantine_dir(sh).join(format!("{chunk_uuid}.seg"));
    if dst.exists() {
        let _ = fs::remove_file(&dst);
    }
    fs::rename(path, &dst)?;
    sync_dir(&encrypted_quarantine_dir(sh))?;
    sync_dir(&encrypted_chunks_dir(sh))?;
    Ok(dst)
}

type LocatedChunkFile = (String, u16, Option<u32>, PathBuf);

fn find_chunk_file(
    root: &Path,
    chunk_uuid: Uuid,
    role_dir: &str,
) -> Result<Option<LocatedChunkFile>> {
    let data_dir = root.join("data");
    if !data_dir.exists() {
        return Ok(None);
    }
    for collection_entry in fs::read_dir(data_dir)? {
        let collection_entry = collection_entry?;
        if !collection_entry.file_type()?.is_dir() {
            continue;
        }
        let collection = collection_entry.file_name().to_string_lossy().into_owned();
        for shard_entry in fs::read_dir(collection_entry.path())? {
            let shard_entry = shard_entry?;
            if !shard_entry.file_type()?.is_dir() {
                continue;
            }
            let shard_name = shard_entry.file_name().to_string_lossy().into_owned();
            let Ok(shard) = u16::from_str_radix(&shard_name, 16) else {
                continue;
            };
            let path = shard_entry
                .path()
                .join(role_dir)
                .join(format!("{chunk_uuid}.seg"));
            if path.exists() {
                return Ok(Some((collection, shard, None, path)));
            }

            let groups_dir = shard_entry.path().join("g");
            if !groups_dir.exists() {
                continue;
            }
            for group_entry in fs::read_dir(groups_dir)? {
                let group_entry = group_entry?;
                if !group_entry.file_type()?.is_dir() {
                    continue;
                }
                let group_name = group_entry.file_name().to_string_lossy().into_owned();
                let Ok(group) = u32::from_str_radix(&group_name, 16) else {
                    continue;
                };
                let path = group_entry
                    .path()
                    .join(role_dir)
                    .join(format!("{chunk_uuid}.seg"));
                if path.exists() {
                    return Ok(Some((collection, shard, Some(group), path)));
                }
            }
        }
    }
    Ok(None)
}

fn shard_group_from_dir(sh: &Shard) -> Option<u32> {
    let group_name = sh.dir.file_name()?.to_string_lossy();
    if sh
        .dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        != Some("g")
    {
        return None;
    }
    u32::from_str_radix(&group_name, 16).ok()
}

fn encrypted_files(dir: &Path) -> Result<Vec<(Uuid, PathBuf)>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for e in fs::read_dir(dir)? {
        let path = e?.path();
        if path.extension().and_then(|x| x.to_str()) != Some("seg") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(uuid) = Uuid::parse_str(stem) else {
            continue;
        };
        out.push((uuid, path));
    }
    Ok(out)
}

fn plain_segment_log_uuid(collection: &str, shard: u16, seq: u64) -> Uuid {
    // Stable per (collection, shard, seq) so re-uploads hit the same content key.
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"laststore-plain-seg-v1\0");
    h.update(collection.as_bytes());
    h.update(b"\0");
    h.update(shard.to_le_bytes());
    h.update(seq.to_le_bytes());
    let dig = h.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&dig[..16]);
    // Set RFC 4122 variant/version bits so parsers accept it as a UUID.
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5-ish
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    Uuid::from_bytes(bytes)
}

/// Invert [`plain_segment_log_uuid`] for restore install.
///
/// Builds a reverse map once per (collection, shard) covering a bounded seq
/// range so restoring thousands of segs is O(range) total, not per chunk.
fn plain_segment_log_seq_for_uuid(collection: &str, shard: u16, chunk_uuid: Uuid) -> Option<u64> {
    use std::cell::RefCell;
    use std::collections::HashMap;
    thread_local! {
        static CACHE: RefCell<HashMap<(String, u16), HashMap<Uuid, u64>>> =
            RefCell::new(HashMap::new());
    }
    const MAX_SEQ: u64 = 50_000;
    CACHE.with(|cell| {
        let mut cache = cell.borrow_mut();
        let key = (collection.to_string(), shard);
        let map = cache.entry(key).or_insert_with(|| {
            let mut m = HashMap::with_capacity((MAX_SEQ as usize) + 1);
            for seq in 0..=MAX_SEQ {
                m.insert(plain_segment_log_uuid(collection, shard, seq), seq);
            }
            m
        });
        map.get(&chunk_uuid).copied()
    })
}

/// Numbered sealed segs under a SegmentLog shard dir (`{seq:010}.seg`).
fn plain_segment_log_files(
    shard_dir: &Path,
    collection: &str,
    shard: u16,
) -> Result<Vec<(Uuid, PathBuf)>> {
    let mut out = Vec::new();
    if !shard_dir.exists() {
        return Ok(out);
    }
    let mut seqs = Vec::new();
    for e in fs::read_dir(shard_dir)? {
        let path = e?.path();
        if path.extension().and_then(|x| x.to_str()) != Some("seg") {
            continue;
        }
        // Skip uuid-named segs (those belong under chunks/ if frame-AEAD).
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if Uuid::parse_str(stem).is_ok() {
            continue;
        }
        if let Ok(seq) = stem.parse::<u64>() {
            seqs.push((seq, path));
        }
    }
    seqs.sort_by_key(|(seq, _)| *seq);
    for (seq, path) in seqs {
        let chunk_uuid = plain_segment_log_uuid(collection, shard, seq);
        out.push((chunk_uuid, path));
    }
    Ok(out)
}

fn find_plain_segment_log_chunk(root: &Path, chunk_uuid: Uuid) -> Result<Option<SealedChunkMeta>> {
    let data_dir = root.join("data");
    if !data_dir.exists() {
        return Ok(None);
    }
    for collection_entry in fs::read_dir(data_dir)? {
        let collection_entry = collection_entry?;
        if !collection_entry.file_type()?.is_dir() {
            continue;
        }
        let collection = collection_entry.file_name().to_string_lossy().into_owned();
        for shard_entry in fs::read_dir(collection_entry.path())? {
            let shard_entry = shard_entry?;
            if !shard_entry.file_type()?.is_dir() {
                continue;
            }
            let shard_name = shard_entry.file_name().to_string_lossy().into_owned();
            let Ok(shard) = u16::from_str_radix(&shard_name, 16) else {
                continue;
            };
            for (uuid, path) in plain_segment_log_files(&shard_entry.path(), &collection, shard)? {
                if uuid == chunk_uuid {
                    return Ok(Some(SealedChunkMeta {
                        collection,
                        shard,
                        group_id: None,
                        chunk_uuid,
                        path,
                        end_csn: 0,
                    }));
                }
            }
        }
    }
    Ok(None)
}

fn sort_encrypted_files_by_mtime(files: &mut [(Uuid, PathBuf)]) {
    files.sort_by(|a, b| {
        let a_key =
            a.1.metadata()
                .and_then(|m| m.modified())
                .ok()
                .map(|t| (t, a.1.clone()));
        let b_key =
            b.1.metadata()
                .and_then(|m| m.modified())
                .ok()
                .map(|t| (t, b.1.clone()));
        a_key.cmp(&b_key)
    });
}

fn encrypted_shard_paths(sh: &Shard) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for (_, path) in encrypted_files(&encrypted_chunks_dir(sh))? {
        out.push(path);
    }
    for (_, path) in encrypted_files(&encrypted_tail_dir(sh))? {
        out.push(path);
    }
    Ok(out)
}

fn encode_seal_record(end_csn: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(SEAL_RECORD_MAGIC.len() + 8);
    out.extend_from_slice(SEAL_RECORD_MAGIC);
    out.extend_from_slice(&end_csn.to_le_bytes());
    out
}

fn decode_seal_record(payload: &[u8]) -> Result<u64> {
    if !is_seal_record(payload) {
        return Err(Error::Corrupt("missing seal record".into()));
    }
    Ok(u64::from_le_bytes(
        payload[SEAL_RECORD_MAGIC.len()..]
            .try_into()
            .expect("seal record length checked"),
    ))
}

fn is_seal_record(payload: &[u8]) -> bool {
    payload.len() == SEAL_RECORD_MAGIC.len() + 8 && payload.starts_with(SEAL_RECORD_MAGIC)
}

fn is_footer_record(payload: &[u8]) -> bool {
    payload.starts_with(FOOTER_RECORD_MAGIC)
}

fn count_complete_records(payload: &[u8], allow_partial_last_frame: bool) -> Result<u64> {
    let mut off = 0usize;
    let mut records = 0u64;
    while off < payload.len() {
        match segfmt::parse_at(payload, off)? {
            Some(rec) => {
                off += rec.raw_len;
                records = records.saturating_add(1);
            }
            None if allow_partial_last_frame => break,
            None => return Err(Error::Corrupt("bad encrypted frame payload".into())),
        }
    }
    Ok(records)
}

#[derive(Clone, Copy)]
struct LayoutDescriptor {
    layout_mode: LayoutMode,
    shard_bits: u8,
    hash_group_bits: u8,
    hash_algo: HashAlgo,
    layout_epoch: u32,
    packaging: PackagingMode,
}

impl LayoutDescriptor {
    fn apply_to(self, opts: &mut LastStoreOptions) {
        opts.layout_mode = self.layout_mode;
        opts.shard_bits = self.shard_bits;
        opts.hash_group_bits = self.hash_group_bits;
        opts.hash_algo = self.hash_algo;
        opts.layout_epoch = self.layout_epoch;
        opts.packaging = self.packaging;
        // Frame AEAD homes keep a caller-supplied data_key; plain packaging
        // must never retain a leftover key from the request options.
        if self.packaging == PackagingMode::Plain {
            opts.data_key = None;
        }
    }

    fn matches(self, opts: &LastStoreOptions) -> bool {
        self.layout_mode == opts.layout_mode
            && self.shard_bits == opts.shard_bits
            && self.hash_group_bits == opts.hash_group_bits
            && self.hash_algo == opts.hash_algo
            && self.layout_epoch == opts.layout_epoch
            && self.packaging == opts.packaging
    }
}

fn resolve_layout_options(
    root: &Path,
    mut requested: LastStoreOptions,
    explicit: bool,
) -> Result<LastStoreOptions> {
    apply_legacy_data_key_packaging(&mut requested);
    if let Some(recorded) = read_layout_descriptor(root)? {
        if explicit && !recorded.matches(&requested) {
            return Err(Error::Config(format!(
                "requested layout does not match durable descriptor at {}",
                root.join(LAYOUT_FILE).display()
            )));
        }
        recorded.apply_to(&mut requested);
        apply_hash_group_product_warm_default(&mut requested);
        return Ok(requested);
    }

    if let Some(detected) = detect_existing_layout(root)? {
        if explicit && requested.layout_mode != detected {
            return Err(Error::Config(format!(
                "requested {:?} layout conflicts with existing {:?} files at {}",
                requested.layout_mode,
                detected,
                root.display()
            )));
        }
        requested.layout_mode = detected;
    }
    if let Some(packaging) = detect_packaging_mode(root) {
        if explicit && requested.packaging != packaging {
            return Err(Error::Config(format!(
                "requested packaging {:?} conflicts with existing {:?} at {}",
                requested.packaging,
                packaging,
                root.display()
            )));
        }
        requested.packaging = packaging;
        if packaging == PackagingMode::Plain {
            requested.data_key = None;
        }
    }
    // Existing hash-group homes reopened with `LastStoreOptions::default()`
    // (warm_bytes=0) would otherwise disable eviction permanently. Product
    // default warm budget is a runtime policy, not stored in the descriptor.
    apply_hash_group_product_warm_default(&mut requested);
    Ok(requested)
}

/// When layout is hash-group and the caller left warm budget at 0 (Default),
/// install the product 256 MiB cap so Mini reopen never disables eviction.
///
/// Fresh `open_with(hash_group().with_hash_group_warm_bytes(0))` on an empty
/// home still gets 0 (no existing layout detected) for intentional bulk-write
/// paths that disable eviction during fixture builds.
fn apply_hash_group_product_warm_default(opts: &mut LastStoreOptions) {
    if opts.layout_mode == LayoutMode::HashGroup && opts.hash_group_warm_bytes == 0 {
        opts.hash_group_warm_bytes = LastStoreOptions::hash_group().hash_group_warm_bytes;
    }
}

fn apply_legacy_data_key_packaging(opts: &mut LastStoreOptions) {
    // Backward compatible: older callers selected encrypted frame packaging by
    // providing only a data key. Normalize before durable layout comparison so
    // explicit reopen sees the same effective options that fresh open wrote.
    if opts.data_key.is_some() {
        opts.packaging = PackagingMode::FrameAead;
    }
}

fn detect_existing_layout(root: &Path) -> Result<Option<LayoutMode>> {
    let data = root.join("data");
    if !data.exists() {
        return Ok(None);
    }
    let mut saw_segment_log = false;
    let mut saw_hash_group = false;
    for collection in fs::read_dir(data)? {
        let collection = collection?;
        if !collection.file_type()?.is_dir() {
            continue;
        }
        for shard in fs::read_dir(collection.path())? {
            let shard = shard?;
            if !shard.file_type()?.is_dir() {
                continue;
            }
            let shard_path = shard.path();
            if shard_path.join("g").is_dir() {
                saw_hash_group = true;
            }
            if shard_path.join("tail").is_dir() || shard_path.join("chunks").is_dir() {
                saw_segment_log = true;
            }
            for entry in fs::read_dir(&shard_path)? {
                let entry = entry?;
                if entry.file_type()?.is_file()
                    && entry.path().extension().and_then(|value| value.to_str()) == Some("seg")
                {
                    saw_segment_log = true;
                }
            }
        }
    }
    match (saw_segment_log, saw_hash_group) {
        (false, false) => Ok(None),
        (true, false) => Ok(Some(LayoutMode::SegmentLog)),
        (false, true) => Ok(Some(LayoutMode::HashGroup)),
        (true, true) => Err(Error::Corrupt(format!(
            "mixed segment-log and hash-group layouts under {}",
            root.display()
        ))),
    }
}

fn read_layout_descriptor(root: &Path) -> Result<Option<LayoutDescriptor>> {
    let path = root.join(LAYOUT_FILE);
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let fields: BTreeMap<_, _> = contents
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect();
    if fields.get("version") != Some(&"1") {
        return Err(Error::Corrupt(format!(
            "unsupported layout descriptor at {}",
            path.display()
        )));
    }
    let layout_mode = match fields.get("layout_mode") {
        Some(&"segment_log") => LayoutMode::SegmentLog,
        Some(&"hash_group") => LayoutMode::HashGroup,
        _ => return Err(Error::Corrupt("invalid layout_mode in descriptor".into())),
    };
    let hash_algo = match fields.get("hash_algo") {
        Some(&"fnv1a64") => HashAlgo::Fnv1a64,
        _ => return Err(Error::Corrupt("invalid hash_algo in descriptor".into())),
    };
    let parse = |key: &str| {
        fields
            .get(key)
            .ok_or_else(|| Error::Corrupt(format!("missing {key} in layout descriptor")))
    };
    let shard_bits = parse("shard_bits")?
        .parse()
        .map_err(|_| Error::Corrupt("invalid shard_bits in layout descriptor".into()))?;
    let hash_group_bits = parse("hash_group_bits")?
        .parse()
        .map_err(|_| Error::Corrupt("invalid hash_group_bits in layout descriptor".into()))?;
    let layout_epoch = parse("layout_epoch")?
        .parse()
        .map_err(|_| Error::Corrupt("invalid layout_epoch in layout descriptor".into()))?;
    // Optional field: older descriptors omit packaging; default by sampling.
    let packaging = match fields.get("packaging").copied() {
        Some("plain") => PackagingMode::Plain,
        Some("frame_aead") => PackagingMode::FrameAead,
        Some(_) => {
            return Err(Error::Corrupt(
                "invalid packaging in layout descriptor".into(),
            ))
        }
        None => detect_packaging_mode(root).unwrap_or(PackagingMode::Plain),
    };
    Ok(Some(LayoutDescriptor {
        layout_mode,
        shard_bits,
        hash_group_bits,
        hash_algo,
        layout_epoch,
        packaging,
    }))
}

fn write_layout_descriptor(root: &Path, opts: &LastStoreOptions) -> Result<()> {
    let path = root.join(LAYOUT_FILE);
    if path.exists() {
        return Ok(());
    }
    if detect_existing_layout(root)?.is_some() {
        return Ok(());
    }
    fs::create_dir_all(root)?;
    let tmp = root.join(format!(".{LAYOUT_FILE}.{}.tmp", Uuid::new_v4()));
    let mode = match opts.layout_mode {
        LayoutMode::SegmentLog => "segment_log",
        LayoutMode::HashGroup => "hash_group",
    };
    let algo = match opts.hash_algo {
        HashAlgo::Fnv1a64 => "fnv1a64",
    };
    let packaging = match opts.packaging {
        PackagingMode::Plain => "plain",
        PackagingMode::FrameAead => "frame_aead",
    };
    let mut file = OpenOptions::new().create_new(true).write(true).open(&tmp)?;
    write!(
        file,
        "version=1\nlayout_mode={mode}\nshard_bits={}\nhash_group_bits={}\nhash_algo={algo}\nlayout_epoch={}\npackaging={packaging}\n",
        opts.shard_bits, opts.hash_group_bits, opts.layout_epoch
    )?;
    durability::sync_dirty_file(&file)?;
    drop(file);
    fs::rename(&tmp, &path)?;
    sync_dir(root)
}

/// True when any sealed/open segment under `root` begins with the frame magic.
pub fn home_has_frame_aead_segments(root: impl AsRef<Path>) -> bool {
    detect_packaging_mode(root.as_ref()) == Some(PackagingMode::FrameAead)
}

fn detect_packaging_mode(root: &Path) -> Option<PackagingMode> {
    let data = root.join("data");
    if !data.is_dir() {
        return None;
    }
    let mut saw_seg = false;
    let mut stack = vec![data];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|s| s.to_str()) != Some("seg") {
                continue;
            }
            saw_seg = true;
            let mut magic = [0u8; 4];
            if let Ok(mut f) = File::open(&path) {
                if f.read_exact(&mut magic).is_ok() && magic == frame::MAGIC {
                    return Some(PackagingMode::FrameAead);
                }
            }
        }
    }
    if saw_seg {
        Some(PackagingMode::Plain)
    } else {
        None
    }
}

fn ensure_empty_migration_destination(destination: &Path) -> Result<()> {
    if !destination.exists() {
        return Ok(());
    }
    if fs::read_dir(destination)?.next().is_none() {
        return Ok(());
    }
    Err(Error::Config(format!(
        "migration destination must be empty: {}",
        destination.display()
    )))
}

fn verify_migration_parity<F>(
    source: &LastStore,
    target: &LastStore,
    expected: &BTreeMap<String, u64>,
    transform: &mut F,
) -> Result<()>
where
    F: FnMut(&str, &str, &[u8]) -> Result<Vec<u8>>,
{
    let target_collections: Vec<_> = target
        .collections_on_disk()?
        .into_iter()
        .filter(|collection| expected.contains_key(collection))
        .collect();
    if target_collections != expected.keys().cloned().collect::<Vec<_>>() {
        return Err(Error::Corrupt(
            "migration destination collection set does not match source".into(),
        ));
    }
    for (collection, expected_count) in expected {
        let source_keys = source.list_prefix_keys(collection, "")?;
        let target_keys = target.list_prefix_keys(collection, "")?;
        if source_keys != target_keys {
            return Err(Error::Corrupt(format!(
                "migration key mismatch in collection {collection}"
            )));
        }
        let verified = source_keys.len() as u64;
        if verified != *expected_count {
            return Err(Error::Corrupt(format!(
                "migration count mismatch in {collection}: copied {expected_count}, verified {verified}"
            )));
        }

        // Keep parity reads in the same destination order as writes. A
        // lexicographic walk would thrash the bounded target warm set again
        // and create fresh encrypted tails merely while verifying the copy.
        let mut source_keys = source_keys
            .into_iter()
            .map(|id| (target.shard_of(&id), target.group_of(&id), id))
            .collect::<Vec<_>>();
        source_keys.sort_unstable();
        for (_, _, id) in source_keys {
            let source_body = source.get(collection, &id)?.ok_or_else(|| {
                Error::Corrupt(format!(
                    "migration source key disappeared: {collection}/{id}"
                ))
            })?;
            let expected_body = transform(collection, &id, &source_body)?;
            if target.get(collection, &id)?.as_deref() != Some(expected_body.as_slice()) {
                return Err(Error::Corrupt(format!(
                    "migration value mismatch for {collection}/{id}"
                )));
            }
        }
    }
    Ok(())
}

fn sync_dir(path: &Path) -> Result<()> {
    if path.exists() {
        File::open(path)?.sync_all()?;
    }
    Ok(())
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn tag_backup_excluded_collection(sh: &Shard) -> Result<()> {
    if !sh.policy.backup_excluded {
        return Ok(());
    }
    if let Some(collection_dir) = collection_dir_for(sh) {
        fs::create_dir_all(collection_dir)?;
        let marker = collection_dir.join(".laststore-backup-excluded");
        if !marker.exists() {
            fs::write(&marker, format!("collection={}\n", sh.collection))?;
            let f = OpenOptions::new().read(true).open(&marker)?;
            durability::sync_dirty_file(&f)?;
            sync_dir(collection_dir)?;
        }
    }
    Ok(())
}

fn collection_dir_for(sh: &Shard) -> Option<&Path> {
    sh.dir
        .ancestors()
        .find(|p| p.file_name().and_then(|s| s.to_str()) == Some(sh.collection.as_str()))
}

fn encode_segment_payload(
    sh: &Shard,
    start_csn: u64,
    payload: &[u8],
) -> Result<(Vec<u8>, Option<Uuid>, u64)> {
    let Some(data_key) = sh.data_key.as_ref() else {
        return Ok((payload.to_vec(), None, 0));
    };
    if payload.is_empty() {
        return Ok((Vec::new(), None, 0));
    }
    let chunk_uuid = Uuid::new_v4();
    let header = FrameHeader {
        chunk_uuid,
        shard: sh.shard,
        start_csn,
        counter: 0,
    };
    let encoded = frame::encode_frame(data_key, header, payload)?;
    Ok((encoded, Some(chunk_uuid), 1))
}

fn decode_segment_payload(
    sh: &Shard,
    seq: u64,
    disk_data: &[u8],
    last: bool,
) -> Result<(Vec<u8>, u64, Option<Uuid>, u64)> {
    let Some(data_key) = sh.data_key.as_ref() else {
        return Ok((disk_data.to_vec(), disk_data.len() as u64, None, 0));
    };

    let mut plaintext = Vec::new();
    let mut off = 0usize;
    let mut chunk_uuid = None;
    let mut next_frame_counter = 0u64;
    while off < disk_data.len() {
        if disk_data.len() - off < frame::min_encoded_len() {
            if last {
                break;
            }
            return Err(Error::Corrupt(format!("bad sealed encrypted seg {seq}")));
        }
        let frame_len = match frame::encoded_len(&disk_data[off..off + frame::header_size()]) {
            Ok(len) if off + len <= disk_data.len() => len,
            Ok(_) if last => break,
            Ok(_) => return Err(Error::Corrupt(format!("bad sealed encrypted seg {seq}"))),
            Err(e) => return Err(e),
        };
        let decoded = frame::decode_frame(data_key, &disk_data[off..off + frame_len])?;
        if decoded.header.shard != sh.shard {
            return Err(Error::AeadAuthFail);
        }
        if let Some(existing) = chunk_uuid {
            if existing != decoded.header.chunk_uuid {
                return Err(Error::AeadAuthFail);
            }
        } else {
            chunk_uuid = Some(decoded.header.chunk_uuid);
        }
        if decoded.header.start_csn != plaintext.len() as u64 {
            return Err(Error::AeadAuthFail);
        }
        plaintext.extend_from_slice(&decoded.payload);
        next_frame_counter = decoded.header.counter.saturating_add(1);
        off += frame_len;
    }
    Ok((plaintext, off as u64, chunk_uuid, next_frame_counter))
}
