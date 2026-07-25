//! AEAD frame primitives for Last Store encrypted chunk files.
//!
//! The default keyless store continues to write raw segment bytes. When a store
//! is opened with a data key, group-commit batches are persisted as these
//! authenticated frames.

use crate::{Error, Result};
use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use hkdf::Hkdf;
use sha2::Sha256;
use uuid::Uuid;

/// Magic prefix for encrypted Last Store frames.
pub const MAGIC: [u8; 4] = *b"LSF1";
/// Frame format version.
pub const VERSION: u8 = 1;
/// Reserved key epoch for the initial frame format.
pub const KEY_EPOCH_RESERVED: u8 = 0;

const HEADER_SIZE: usize = 4 + 1 + 1 + 2 + 8 + 8 + 8 + 16;
const TAG_SIZE: usize = 16;
const HKDF_INFO: &[u8] = b"laststore/frame/aes-256-gcm/v1";

/// Immutable metadata authenticated with every frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    /// Unique chunk identifier; paired with the counter for nonce uniqueness.
    pub chunk_uuid: Uuid,
    /// Shard number for the chunk.
    pub shard: u16,
    /// Starting commit sequence number for this frame.
    pub start_csn: u64,
    /// Monotonic frame counter within the chunk.
    pub counter: u64,
}

/// A decrypted frame and the authenticated metadata it carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedFrame {
    /// Authenticated immutable frame metadata.
    pub header: FrameHeader,
    /// Decrypted frame payload.
    pub payload: Vec<u8>,
}

/// Total encoded length of one frame, read from its clear authenticated header.
pub fn encoded_len(frame: &[u8]) -> Result<usize> {
    if frame.len() < HEADER_SIZE {
        return Err(Error::Corrupt("bad frame header length".into()));
    }
    let (_, payload_len) = decode_header_prefix(&frame[..HEADER_SIZE])?;
    HEADER_SIZE
        .checked_add(payload_len)
        .and_then(|n| n.checked_add(TAG_SIZE))
        .ok_or_else(|| Error::Corrupt("frame length overflow".into()))
}

/// Cleartext header size for frame scanners.
pub fn header_size() -> usize {
    HEADER_SIZE
}

/// Minimum valid encoded frame length.
pub fn min_encoded_len() -> usize {
    HEADER_SIZE + TAG_SIZE
}

/// Encode one AES-256-GCM frame.
///
/// The header is used as associated data and is included verbatim before the
/// ciphertext. The GCM tag is appended to the ciphertext.
pub fn encode_frame(data_key: &[u8; 32], header: FrameHeader, payload: &[u8]) -> Result<Vec<u8>> {
    let payload_len = payload.len() as u64;
    let header_bytes = encode_header(header, payload_len);
    let cipher = Aes256Gcm::new_from_slice(&chunk_key(data_key, header.chunk_uuid)?)
        .map_err(|_| Error::Config("invalid aead key length".into()))?;
    let nonce_bytes = counter_nonce(header.counter);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let mut ciphertext = payload.to_vec();
    let tag = cipher
        .encrypt_in_place_detached(nonce, &header_bytes, &mut ciphertext)
        .map_err(|_| Error::AeadAuthFail)?;

    let mut out = Vec::with_capacity(HEADER_SIZE + ciphertext.len() + TAG_SIZE);
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(&ciphertext);
    out.extend_from_slice(&tag);
    Ok(out)
}

/// Decode and authenticate one AES-256-GCM frame.
///
/// Any authentication failure returns [`Error::AeadAuthFail`]; plaintext is
/// returned only after the tag verifies.
pub fn decode_frame(data_key: &[u8; 32], frame: &[u8]) -> Result<DecodedFrame> {
    if frame.len() < HEADER_SIZE + TAG_SIZE {
        return Err(Error::Corrupt("frame too short".into()));
    }
    let header_bytes = &frame[..HEADER_SIZE];
    let (header, payload_len) = decode_header(header_bytes)?;
    let expected_len = HEADER_SIZE
        .checked_add(payload_len)
        .and_then(|n| n.checked_add(TAG_SIZE))
        .ok_or_else(|| Error::Corrupt("frame length overflow".into()))?;
    if frame.len() != expected_len {
        return Err(Error::Corrupt("frame length mismatch".into()));
    }
    let tag_offset = HEADER_SIZE + payload_len;
    let mut payload = frame[HEADER_SIZE..tag_offset].to_vec();
    let tag = Tag::from_slice(&frame[tag_offset..]);
    let cipher = Aes256Gcm::new_from_slice(&chunk_key(data_key, header.chunk_uuid)?)
        .map_err(|_| Error::Config("invalid aead key length".into()))?;
    let nonce_bytes = counter_nonce(header.counter);
    let nonce = Nonce::from_slice(&nonce_bytes);
    cipher
        .decrypt_in_place_detached(nonce, header_bytes, &mut payload, tag)
        .map_err(|_| Error::AeadAuthFail)?;
    Ok(DecodedFrame { header, payload })
}

fn chunk_key(data_key: &[u8; 32], chunk_uuid: Uuid) -> Result<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(Some(chunk_uuid.as_bytes()), data_key);
    let mut out = [0u8; 32];
    hk.expand(HKDF_INFO, &mut out)
        .map_err(|_| Error::Config("hkdf expand failed".into()))?;
    Ok(out)
}

fn encode_header(header: FrameHeader, payload_len: u64) -> [u8; HEADER_SIZE] {
    let mut out = [0u8; HEADER_SIZE];
    out[..4].copy_from_slice(&MAGIC);
    out[4] = VERSION;
    out[5] = KEY_EPOCH_RESERVED;
    out[6..8].copy_from_slice(&header.shard.to_le_bytes());
    out[8..16].copy_from_slice(&header.start_csn.to_le_bytes());
    out[16..24].copy_from_slice(&header.counter.to_le_bytes());
    out[24..32].copy_from_slice(&payload_len.to_le_bytes());
    out[32..48].copy_from_slice(header.chunk_uuid.as_bytes());
    out
}

fn decode_header(bytes: &[u8]) -> Result<(FrameHeader, usize)> {
    let (header, payload_len) = decode_header_prefix(bytes)?;
    Ok((header, payload_len))
}

fn decode_header_prefix(bytes: &[u8]) -> Result<(FrameHeader, usize)> {
    if bytes.len() != HEADER_SIZE {
        return Err(Error::Corrupt("bad frame header length".into()));
    }
    if bytes[..4] != MAGIC {
        return Err(Error::AeadAuthFail);
    }
    if bytes[4] != VERSION {
        return Err(Error::AeadAuthFail);
    }
    if bytes[5] != KEY_EPOCH_RESERVED {
        return Err(Error::AeadAuthFail);
    }
    let shard = u16::from_le_bytes(bytes[6..8].try_into().unwrap());
    let start_csn = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
    let counter = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
    let payload_len_u64 = u64::from_le_bytes(bytes[24..32].try_into().unwrap());
    let payload_len = usize::try_from(payload_len_u64)
        .map_err(|_| Error::Corrupt("frame payload length too large".into()))?;
    let chunk_uuid =
        Uuid::from_slice(&bytes[32..48]).map_err(|e| Error::Corrupt(format!("chunk uuid: {e}")))?;
    Ok((
        FrameHeader {
            chunk_uuid,
            shard,
            start_csn,
            counter,
        },
        payload_len,
    ))
}

fn counter_nonce(counter: u64) -> [u8; 12] {
    let mut bytes = [0u8; 12];
    bytes[4..].copy_from_slice(&counter.to_be_bytes());
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] {
        [7u8; 32]
    }

    fn header() -> FrameHeader {
        FrameHeader {
            chunk_uuid: Uuid::from_u128(0x123456789abcdef00123456789abcdef),
            shard: 3,
            start_csn: 42,
            counter: 9,
        }
    }

    fn assert_auth_fail(bytes: &[u8]) {
        match decode_frame(&key(), bytes) {
            Err(Error::AeadAuthFail) => {}
            other => panic!("expected AeadAuthFail, got {other:?}"),
        }
    }

    #[test]
    fn frame_roundtrip_authenticates_header_and_payload() {
        let payload = b"two segfmt records would live here".to_vec();
        let encoded = encode_frame(&key(), header(), &payload).unwrap();
        let decoded = decode_frame(&key(), &encoded).unwrap();
        assert_eq!(decoded.header, header());
        assert_eq!(decoded.payload, payload);
    }

    #[test]
    fn bit_flip_in_immutable_header_is_auth_failure() {
        let mut encoded = encode_frame(&key(), header(), b"payload").unwrap();
        encoded[8] ^= 0x01;
        assert_auth_fail(&encoded);
    }

    #[test]
    fn bit_flip_in_payload_is_auth_failure() {
        let mut encoded = encode_frame(&key(), header(), b"payload").unwrap();
        encoded[HEADER_SIZE] ^= 0x01;
        assert_auth_fail(&encoded);
    }

    #[test]
    fn bit_flip_in_tag_is_auth_failure() {
        let mut encoded = encode_frame(&key(), header(), b"payload").unwrap();
        let last = encoded.len() - 1;
        encoded[last] ^= 0x01;
        assert_auth_fail(&encoded);
    }

    #[test]
    fn wrong_chunk_uuid_authenticates_nothing() {
        let mut encoded = encode_frame(&key(), header(), b"payload").unwrap();
        encoded[32] ^= 0x01;
        assert_auth_fail(&encoded);
    }
}
