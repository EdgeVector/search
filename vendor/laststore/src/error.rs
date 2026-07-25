//! Error types for Last Store.

use std::fmt;
use std::path::PathBuf;

/// Result alias for Last Store operations.
pub type Result<T> = std::result::Result<T, Error>;

/// Errors returned by [`crate::LastStore`].
#[derive(Debug)]
pub enum Error {
    /// Underlying filesystem or IO failure.
    Io(std::io::Error),
    /// On-disk format is truncated, truncated mid-record, or inconsistent.
    Corrupt(String),
    /// AEAD authentication failed while decrypting a frame.
    AeadAuthFail,
    /// A sealed encrypted chunk failed verification and was moved aside.
    ChunkQuarantined {
        /// Chunk UUID that failed verification.
        chunk_uuid: uuid::Uuid,
        /// Quarantine path holding the suspect bytes.
        path: PathBuf,
    },
    /// Invalid configuration (e.g. `shard_bits` out of range).
    Config(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "io: {e}"),
            Self::Corrupt(s) => write!(f, "corrupt: {s}"),
            Self::AeadAuthFail => write!(f, "aead authentication failed"),
            Self::ChunkQuarantined { chunk_uuid, path } => {
                write!(f, "chunk {chunk_uuid} quarantined at {}", path.display())
            }
            Self::Config(s) => write!(f, "config: {s}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
