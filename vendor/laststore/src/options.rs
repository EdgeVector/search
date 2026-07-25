//! Tunables for [`crate::LastStore`].

use crate::store::{CaptureEvent, SealedChunkMeta};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

const ATOMS_COLLECTION: &str = "atoms";
const DEFAULT_HASH_GROUP_WARM_BYTES: u64 = 256 * 1024 * 1024;

/// Per-collection storage policy.
#[derive(Debug, Clone, Copy, Default, Eq, PartialEq)]
pub struct CollectionPolicy {
    /// Never rewrite this collection during compaction.
    pub never_compact: bool,
    /// Keep this collection out of cloud-backup chunk enumeration.
    pub backup_excluded: bool,
}

/// On-disk document placement strategy.
#[derive(Debug, Clone, Copy, Default, Eq, PartialEq)]
pub enum LayoutMode {
    /// Existing per-shard append segments with an in-memory id -> location map.
    #[default]
    SegmentLog,
    /// Place each id in a deterministic UUID/string hash group under
    /// `data/<collection>/<shard>/g/<group>/`.
    HashGroup,
}

/// Hash algorithm used for shard and hash-group placement.
#[derive(Debug, Clone, Copy, Default, Eq, PartialEq)]
pub enum HashAlgo {
    /// 64-bit FNV-1a over the document id bytes.
    #[default]
    Fnv1a64,
}

/// How logical values are protected inside on-disk group/segment files.
///
/// Plain packaging keeps group files structurally readable (ids, indexes, atom
/// metadata) and leaves body secrecy to upper layers (e.g. atom `content`
/// field seal). Frame AEAD wraps every spilled batch in AES-GCM frames under
/// [`LastStoreOptions::data_key`].
#[derive(Debug, Clone, Copy, Default, Eq, PartialEq)]
pub enum PackagingMode {
    /// Raw segment records / open tails (no frame AEAD). Default for new
    /// hash-group homes — restart-safe without sealing open encrypted tails.
    #[default]
    Plain,
    /// AES-256-GCM frame cabinet (`LSF1` frames). Requires `data_key`.
    FrameAead,
}

/// Hook invoked after a commit is assigned a CSN and before it is exposed in the
/// capture log.
pub type CaptureHook =
    Arc<dyn Fn(&CaptureEvent) -> std::result::Result<(), String> + Send + Sync + 'static>;

/// Hook invoked after an encrypted tail is sealed into an immutable chunk.
pub type SealHook =
    Arc<dyn Fn(&SealedChunkMeta) -> std::result::Result<(), String> + Send + Sync + 'static>;

/// Configuration for opening a Last Store home directory.
///
/// Defaults match the dual-score / sled head-to-head tip (2026-07): single
/// shard, memory-first append, group-commit every 16 384 ops or 16 MiB.
#[derive(Clone)]
pub struct LastStoreOptions {
    /// Point-document layout mode.
    pub layout_mode: LayoutMode,
    /// Number of high bits of a 16-bit hash used for sharding (0..=12).
    /// `0` = one shard per collection (best sequential / batch-flush throughput).
    /// Higher values spread writers and shrink per-shard locks.
    pub shard_bits: u8,
    /// Number of low hash bits used for hash-group placement (1..=16).
    ///
    /// Default is `10`, so hash-group mode creates up to 1024 groups per
    /// shard. Ignored by [`LayoutMode::SegmentLog`].
    pub hash_group_bits: u8,
    /// Hash algorithm for shard and group placement.
    pub hash_algo: HashAlgo,
    /// Layout epoch recorded in options for callers coordinating migrations.
    pub layout_epoch: u32,
    /// On-disk packaging / encryption of segment and tail files.
    pub packaging: PackagingMode,
    /// Roll the open segment file after this many bytes.
    pub max_segment_bytes: u64,
    /// Spill + fsync after this many unflushed ops (group-commit).
    pub max_dirty_ops: u32,
    /// Spill + fsync after this many unflushed bytes (group-commit).
    pub max_dirty_bytes: u64,
    /// Optional 256-bit content data key for frame encryption.
    ///
    /// `None` keeps the keyless segment format. `Some` writes group-commit
    /// batches as AES-256-GCM frames and authenticates them on reopen.
    pub data_key: Option<[u8; 32]>,
    /// Per-collection policy overrides.
    ///
    /// Defaults include `atoms.never_compact = true`: atom collections are
    /// write-once backup material and compaction must not rewrite their chunks.
    pub collection_policies: BTreeMap<String, CollectionPolicy>,
    /// Minimum already-restored CSN. New commits start after this floor.
    pub csn_floor: u64,
    /// Optional best-effort capture hook. Failure suspends capture, never the
    /// local write path.
    pub capture_hook: Option<CaptureHook>,
    /// Optional best-effort seal hook for daemon upload notification.
    pub on_seal: Option<SealHook>,
    /// Approximate resident warm-set budget for hash-group shard handles.
    ///
    /// `0` disables hash-group handle eviction. Segment-log layout ignores this
    /// field because the single shard-level index is the legacy correctness map.
    pub hash_group_warm_bytes: u64,
}

impl Default for LastStoreOptions {
    fn default() -> Self {
        let mut collection_policies = BTreeMap::new();
        collection_policies.insert(
            ATOMS_COLLECTION.to_string(),
            CollectionPolicy {
                never_compact: true,
                backup_excluded: false,
            },
        );
        Self {
            layout_mode: LayoutMode::SegmentLog,
            shard_bits: 0,
            hash_group_bits: 10,
            hash_algo: HashAlgo::Fnv1a64,
            layout_epoch: 0,
            packaging: PackagingMode::Plain,
            max_segment_bytes: 8 * 1024 * 1024,
            max_dirty_ops: 16_384,
            max_dirty_bytes: 16 * 1024 * 1024,
            data_key: None,
            collection_policies,
            csn_floor: 0,
            capture_hook: None,
            on_seal: None,
            hash_group_warm_bytes: 0,
        }
    }
}

impl fmt::Debug for LastStoreOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LastStoreOptions")
            .field("layout_mode", &self.layout_mode)
            .field("shard_bits", &self.shard_bits)
            .field("hash_group_bits", &self.hash_group_bits)
            .field("hash_algo", &self.hash_algo)
            .field("layout_epoch", &self.layout_epoch)
            .field("packaging", &self.packaging)
            .field("max_segment_bytes", &self.max_segment_bytes)
            .field("max_dirty_ops", &self.max_dirty_ops)
            .field("max_dirty_bytes", &self.max_dirty_bytes)
            .field("data_key", &self.data_key.as_ref().map(|_| "<redacted>"))
            .field("collection_policies", &self.collection_policies)
            .field("csn_floor", &self.csn_floor)
            .field("capture_hook", &self.capture_hook.is_some())
            .field("on_seal", &self.on_seal.is_some())
            .field("hash_group_warm_bytes", &self.hash_group_warm_bytes)
            .finish()
    }
}

impl LastStoreOptions {
    /// Defaults tuned for sequential / batch-flush workloads (H2H vs sled tip).
    pub fn sequential() -> Self {
        Self::default()
    }

    /// More shards for concurrent writers (trades some single-thread flush cost).
    pub fn concurrent(shard_bits: u8) -> Self {
        Self {
            shard_bits,
            ..Self::default()
        }
    }

    /// Use deterministic hash-group point placement with default S=0, G=1024.
    ///
    /// Default packaging is [`PackagingMode::Plain`] (no frame AEAD). Callers
    /// that need the legacy encrypted frame cabinet must set
    /// `packaging = FrameAead` and `data_key = Some(...)`.
    pub fn hash_group() -> Self {
        Self {
            layout_mode: LayoutMode::HashGroup,
            hash_group_warm_bytes: DEFAULT_HASH_GROUP_WARM_BYTES,
            packaging: PackagingMode::Plain,
            ..Self::default()
        }
    }

    /// Hash-group layout with frame-AEAD packaging (legacy cabinet).
    pub fn hash_group_frame_aead(data_key: [u8; 32]) -> Self {
        Self {
            packaging: PackagingMode::FrameAead,
            data_key: Some(data_key),
            ..Self::hash_group()
        }
    }

    /// Set the approximate resident warm-set budget for hash-group handles.
    pub fn with_hash_group_warm_bytes(mut self, bytes: u64) -> Self {
        self.hash_group_warm_bytes = bytes;
        self
    }

    /// Mark a collection as non-compacting.
    pub fn with_never_compact_collection(mut self, collection: impl Into<String>) -> Self {
        self.collection_policies
            .entry(collection.into())
            .or_default()
            .never_compact = true;
        self
    }

    /// Mark a collection as excluded from backup chunk enumeration.
    pub fn with_backup_excluded_collection(mut self, collection: impl Into<String>) -> Self {
        self.collection_policies
            .entry(collection.into())
            .or_default()
            .backup_excluded = true;
        self
    }

    /// Return the effective policy for `collection`.
    pub fn collection_policy(&self, collection: &str) -> CollectionPolicy {
        self.collection_policies
            .get(collection)
            .copied()
            .unwrap_or_default()
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.shard_bits > 12 {
            return Err(format!(
                "shard_bits must be 0..=12, got {}",
                self.shard_bits
            ));
        }
        if self.hash_group_bits == 0 || self.hash_group_bits > 16 {
            return Err(format!(
                "hash_group_bits must be 1..=16, got {}",
                self.hash_group_bits
            ));
        }
        if self.max_segment_bytes < 64 * 1024 {
            return Err("max_segment_bytes must be >= 64 KiB".into());
        }
        if self.max_dirty_ops == 0 {
            return Err("max_dirty_ops must be >= 1".into());
        }
        if self.max_dirty_bytes == 0 {
            return Err("max_dirty_bytes must be >= 1".into());
        }
        if let Some(collection) = self.collection_policies.keys().find(|k| k.is_empty()) {
            return Err(format!(
                "collection policy name must not be empty: {collection:?}"
            ));
        }
        match self.packaging {
            PackagingMode::Plain if self.data_key.is_some() => {
                return Err(
                    "packaging=plain forbids data_key (frame AEAD); use PackagingMode::FrameAead"
                        .into(),
                );
            }
            PackagingMode::FrameAead if self.data_key.is_none() => {
                return Err("packaging=frame_aead requires data_key".into());
            }
            _ => {}
        }
        Ok(())
    }
}
