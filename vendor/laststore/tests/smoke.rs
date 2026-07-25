use laststore::{collections, LastStore, LastStoreOptions, TxnOp};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

#[test]
fn put_get_flush_reopen() {
    let dir = TempDir::new().unwrap();
    {
        let s = LastStore::open(dir.path()).unwrap();
        s.put(collections::ATOMS, "k1", b"v1").unwrap();
        s.put(collections::TIPS, "t1", b"k1").unwrap();
        s.flush().unwrap();
    }
    let s = LastStore::open(dir.path()).unwrap();
    assert_eq!(
        s.get(collections::ATOMS, "k1").unwrap().as_deref(),
        Some(b"v1".as_slice())
    );
    assert_eq!(
        s.get(collections::TIPS, "t1").unwrap().as_deref(),
        Some(b"k1".as_slice())
    );
}

#[test]
fn transaction_and_compact() {
    let dir = TempDir::new().unwrap();
    let s = LastStore::open(dir.path()).unwrap();
    s.transaction(vec![
        TxnOp::put("notes", "1", b"a"),
        TxnOp::put("notes", "2", b"b"),
    ])
    .unwrap();
    s.delete("notes", "1").unwrap();
    s.flush().unwrap();
    s.compact().unwrap();
    assert!(s.get("notes", "1").unwrap().is_none());
    assert_eq!(
        s.get("notes", "2").unwrap().as_deref(),
        Some(b"b".as_slice())
    );
    let listed = s.list_prefix("notes", "").unwrap();
    assert_eq!(listed.len(), 1);
}

#[test]
fn atoms_are_never_compacted_by_default() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        max_segment_bytes: 64 * 1024,
        data_key: Some([61u8; 32]),
        ..LastStoreOptions::default()
    };
    let body = vec![b'a'; 20 * 1024];
    let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
    for i in 0..8 {
        s.put(collections::ATOMS, &format!("atom-{i}"), &body)
            .unwrap();
    }
    s.delete(collections::ATOMS, "atom-0").unwrap();
    s.flush().unwrap();

    let before = seg_file_bytes_under(&dir.path().join("data/atoms/0"));
    s.compact_collection(collections::ATOMS).unwrap();
    let after = seg_file_bytes_under(&dir.path().join("data/atoms/0"));

    assert_eq!(before, after);
    assert!(s.get(collections::ATOMS, "atom-0").unwrap().is_none());
    assert_eq!(
        s.get(collections::ATOMS, "atom-7").unwrap().as_deref(),
        Some(body.as_slice())
    );

    let reopened = LastStore::open_with(dir.path(), opts).unwrap();
    assert_eq!(
        reopened
            .get(collections::ATOMS, "atom-7")
            .unwrap()
            .as_deref(),
        Some(body.as_slice())
    );
}

#[test]
fn encrypted_mutable_compaction_reclaims_to_fresh_sealed_chunk() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        max_segment_bytes: 64 * 1024,
        data_key: Some([62u8; 32]),
        ..LastStoreOptions::default()
    };
    let body = vec![b'm'; 20 * 1024];
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        for i in 0..8 {
            s.put("mutable", &format!("doc-{i}"), &body).unwrap();
        }
        for i in 0..4 {
            s.delete("mutable", &format!("doc-{i}")).unwrap();
        }
        s.flush().unwrap();

        let before = seg_file_bytes_under(&dir.path().join("data/mutable/0"));
        assert!(before.len() > 1, "expected pre-compact chunk fanout");
        s.compact_collection("mutable").unwrap();
        let after = seg_file_bytes_under(&dir.path().join("data/mutable/0"));
        assert_eq!(after.len(), 1, "compact should write one sealed chunk");
        assert_ne!(
            before.iter().map(|(p, _)| p).collect::<Vec<_>>(),
            after.iter().map(|(p, _)| p).collect::<Vec<_>>()
        );
        assert!(s.get("mutable", "doc-0").unwrap().is_none());
        assert_eq!(
            s.get("mutable", "doc-7").unwrap().as_deref(),
            Some(body.as_slice())
        );
    }

    let reopened = LastStore::open_with(dir.path(), opts).unwrap();
    assert!(reopened.get("mutable", "doc-0").unwrap().is_none());
    assert_eq!(
        reopened.get("mutable", "doc-7").unwrap().as_deref(),
        Some(body.as_slice())
    );
}

#[test]
fn backup_excluded_collections_seal_locally_without_backup_chunks() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        max_segment_bytes: 64 * 1024,
        data_key: Some([63u8; 32]),
        ..LastStoreOptions::default()
    }
    .with_backup_excluded_collection("native_index");
    let s = LastStore::open_with(dir.path(), opts).unwrap();
    let body = vec![b'i'; 20 * 1024];
    for i in 0..8 {
        s.put("native_index", &format!("idx-{i}"), &body).unwrap();
    }
    s.flush().unwrap();

    let local_chunks = seg_files(&dir.path().join("data/native_index/0/chunks"));
    assert!(!local_chunks.is_empty(), "excluded collection still seals");
    assert!(s.backup_chunk_paths("native_index").unwrap().is_empty());
    assert!(dir
        .path()
        .join("data/native_index/.laststore-backup-excluded")
        .exists());
}

#[test]
fn multi_shard_roundtrip() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        shard_bits: 2,
        ..LastStoreOptions::default()
    };
    let s = LastStore::open_with(dir.path(), opts).unwrap();
    for i in 0..50 {
        let id = format!("k{i}");
        s.put("c", &id, id.as_bytes()).unwrap();
    }
    s.flush().unwrap();
    for i in 0..50 {
        let id = format!("k{i}");
        assert_eq!(s.get("c", &id).unwrap().as_deref(), Some(id.as_bytes()));
    }
}

#[test]
fn rejects_bad_shard_bits() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        shard_bits: 20,
        ..LastStoreOptions::default()
    };
    assert!(LastStore::open_with(dir.path(), opts).is_err());
}

#[test]
fn encrypted_store_writes_one_frame_per_group_commit_batch_and_reopens() {
    let dir = TempDir::new().unwrap();
    let key = [11u8; 32];
    let opts = LastStoreOptions {
        max_dirty_ops: 2,
        data_key: Some(key),
        ..LastStoreOptions::default()
    };
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        s.put("c", "a", b"alpha").unwrap();
        s.put("c", "b", b"bravo").unwrap();
        s.put("c", "c", b"charlie").unwrap();
        s.flush().unwrap();
    }

    let seg_path = only_seg_file(&dir.path().join("data/c/0/tail"));
    let disk = fs::read(seg_path).unwrap();
    assert!(disk.starts_with(&laststore::frame::MAGIC));
    assert!(!disk.windows(b"alpha".len()).any(|w| w == b"alpha"));

    let mut off = 0usize;
    let mut frames = Vec::new();
    while off < disk.len() {
        let header_end = off + laststore::frame::header_size();
        let frame_len = laststore::frame::encoded_len(&disk[off..header_end]).unwrap();
        let decoded = laststore::frame::decode_frame(&key, &disk[off..off + frame_len]).unwrap();
        frames.push(decoded);
        off += frame_len;
    }
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0].header.start_csn, 1);
    assert_eq!(frames[1].header.start_csn, 3);

    let reopened = LastStore::open_with(dir.path(), opts).unwrap();
    assert_eq!(
        reopened.get("c", "a").unwrap().as_deref(),
        Some(&b"alpha"[..])
    );
    assert_eq!(
        reopened.get("c", "b").unwrap().as_deref(),
        Some(&b"bravo"[..])
    );
    assert_eq!(
        reopened.get("c", "c").unwrap().as_deref(),
        Some(&b"charlie"[..])
    );
}

#[test]
fn encrypted_capture_log_csn_is_contiguous_across_concurrent_collections() {
    let dir = TempDir::new().unwrap();
    let store = Arc::new(
        LastStore::open_with(
            dir.path(),
            LastStoreOptions {
                data_key: Some([61u8; 32]),
                ..LastStoreOptions::default()
            },
        )
        .unwrap(),
    );

    let mut threads = Vec::new();
    for collection in ["a", "b", "c", "d"] {
        let store = store.clone();
        threads.push(std::thread::spawn(move || {
            for i in 0..25 {
                let id = format!("{collection}-{i:02}");
                store.put(collection, &id, id.as_bytes()).unwrap();
            }
        }));
    }
    for thread in threads {
        thread.join().unwrap();
    }
    store.flush().unwrap();

    let log = store.capture_log();
    assert_eq!(log.len(), 100);
    for (idx, event) in log.iter().enumerate() {
        assert_eq!(event.csn, idx as u64 + 1);
    }
    assert_eq!(store.csn_high_water(), 100);
}

#[test]
fn snapshot_force_seals_dirty_tails_and_reports_max_csn() {
    let dir = TempDir::new().unwrap();
    let sealed = Arc::new(Mutex::new(Vec::new()));
    let sealed_for_hook = sealed.clone();
    let s = LastStore::open_with(
        dir.path(),
        LastStoreOptions {
            data_key: Some([71u8; 32]),
            on_seal: Some(Arc::new(move |meta| {
                sealed_for_hook.lock().unwrap().push(meta.clone());
                Ok(())
            })),
            ..LastStoreOptions::default()
        },
    )
    .unwrap();
    for collection in ["a", "b", "c", "d", "e"] {
        s.put(collection, "id", collection.as_bytes()).unwrap();
    }

    let snapshot = s.snapshot().unwrap();
    assert_eq!(snapshot.max_csn, 5);
    assert_eq!(snapshot.sealed_chunks.len(), 5);
    assert_eq!(sealed.lock().unwrap().len(), 5);
    for collection in ["a", "b", "c", "d", "e"] {
        assert!(seg_files(&dir.path().join(format!("data/{collection}/0/tail"))).is_empty());
    }
}

#[test]
fn capture_hook_failure_suspends_capture_without_blocking_local_writes() {
    let dir = TempDir::new().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_hook = calls.clone();
    let s = LastStore::open_with(
        dir.path(),
        LastStoreOptions {
            data_key: Some([81u8; 32]),
            capture_hook: Some(Arc::new(move |_| {
                if calls_for_hook.fetch_add(1, Ordering::SeqCst) == 0 {
                    Ok(())
                } else {
                    Err("capture sink unavailable".into())
                }
            })),
            ..LastStoreOptions::default()
        },
    )
    .unwrap();

    s.put("c", "a", b"alpha").unwrap();
    s.put("c", "b", b"bravo").unwrap();
    s.put("c", "c", b"charlie").unwrap();
    s.flush().unwrap();

    assert!(s.capture_suspended());
    assert_eq!(s.capture_log().len(), 1);
    assert_eq!(s.get("c", "b").unwrap().as_deref(), Some(&b"bravo"[..]));
    assert_eq!(s.get("c", "c").unwrap().as_deref(), Some(&b"charlie"[..]));
}

#[test]
fn csn_floor_advances_first_new_commit() {
    let dir = TempDir::new().unwrap();
    let s = LastStore::open_with(
        dir.path(),
        LastStoreOptions {
            data_key: Some([91u8; 32]),
            csn_floor: 41,
            ..LastStoreOptions::default()
        },
    )
    .unwrap();

    s.put("c", "id", b"value").unwrap();

    let log = s.capture_log();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].csn, 42);
    assert_eq!(s.csn_high_water(), 42);
}

#[test]
fn encrypted_store_seals_uuid_chunks_and_reopens_by_chunk_identity() {
    let dir = TempDir::new().unwrap();
    let key = [31u8; 32];
    let opts = LastStoreOptions {
        max_segment_bytes: 8 * 1024 * 1024,
        data_key: Some(key),
        ..LastStoreOptions::default()
    };
    let body = vec![b'x'; 1024 * 1024];
    let mut expected = Vec::new();
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        for i in 0..24 {
            let id = format!("doc-{i:02}");
            let mut value = body.clone();
            value[..id.len()].copy_from_slice(id.as_bytes());
            expected.push((id.clone(), value.clone()));
            s.put("c", &id, &value).unwrap();
        }
        s.flush().unwrap();
    }

    let shard_dir = dir.path().join("data/c/0");
    let chunks_dir = shard_dir.join("chunks");
    let tail_dir = shard_dir.join("tail");
    let chunks = seg_files(&chunks_dir);
    let tails = seg_files(&tail_dir);
    assert!(
        chunks.len() >= 2,
        "expected at least two sealed chunks, got {chunks:?}"
    );
    assert_eq!(tails.len(), 1, "expected one open tail");
    let tail_name = tails[0].file_name().unwrap().to_owned();
    assert!(
        chunks.iter().all(|p| p.file_name().unwrap() != tail_name),
        "tail uuid must be distinct from sealed chunks"
    );

    let moved = dir.path().join("moved-sealed-chunk.seg");
    let restored_name = chunks[0].file_name().unwrap().to_owned();
    fs::rename(&chunks[0], &moved).unwrap();
    fs::rename(&moved, chunks_dir.join(restored_name)).unwrap();

    let reopened = LastStore::open_with(dir.path(), opts).unwrap();
    for (id, value) in expected {
        assert_eq!(
            reopened.get("c", &id).unwrap().as_deref(),
            Some(value.as_slice())
        );
    }

    let mut seen = HashSet::new();
    for path in seg_files(&chunks_dir)
        .into_iter()
        .chain(seg_files(&tail_dir))
    {
        for header in frame_headers(&path, &key) {
            assert!(
                seen.insert((header.chunk_uuid, header.counter)),
                "reused frame nonce pair ({}, {})",
                header.chunk_uuid,
                header.counter
            );
        }
    }
}

#[test]
fn encrypted_store_quarantines_corrupt_sealed_chunk_and_install_restores_it() {
    let dir = TempDir::new().unwrap();
    let key = [41u8; 32];
    let opts = LastStoreOptions {
        max_segment_bytes: 8 * 1024 * 1024,
        data_key: Some(key),
        ..LastStoreOptions::default()
    };
    let body = vec![b'x'; 1024 * 1024];
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        for i in 0..12 {
            let id = format!("doc-{i:02}");
            s.put("c", &id, &body).unwrap();
        }
        s.flush().unwrap();
    }

    let chunk_path = seg_files(&dir.path().join("data/c/0/chunks"))
        .into_iter()
        .next()
        .expect("sealed chunk");
    let pristine = fs::read(&chunk_path).unwrap();
    let chunk_uuid = uuid_from_seg_path(&chunk_path);
    let mut disk = fs::read(&chunk_path).unwrap();
    disk[laststore::frame::header_size()] ^= 0x01;
    fs::write(&chunk_path, disk).unwrap();

    let reopened = LastStore::open_with(dir.path(), opts).unwrap();
    assert!(reopened.get("c", "doc-00").unwrap().is_none());
    assert!(dir
        .path()
        .join(format!("data/c/0/quarantine/{chunk_uuid}.seg"))
        .exists());

    reopened.install_chunk(chunk_uuid, &pristine).unwrap();
    reopened.verify_chunk(chunk_uuid).unwrap();
    assert_eq!(
        reopened.get("c", "doc-00").unwrap().as_deref(),
        Some(body.as_slice())
    );
}

#[test]
fn encrypted_reopen_retires_truncated_tail_and_writes_fresh_uuid() {
    let dir = TempDir::new().unwrap();
    let key = [42u8; 32];
    let opts = LastStoreOptions {
        max_dirty_ops: 1,
        data_key: Some(key),
        ..LastStoreOptions::default()
    };
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        s.put("c", "a", b"alpha").unwrap();
        s.put("c", "b", b"bravo").unwrap();
        s.flush().unwrap();
    }

    let tail_path = only_seg_file(&dir.path().join("data/c/0/tail"));
    let old_tail_uuid = uuid_from_seg_path(&tail_path);
    let spans = frame_spans(&tail_path);
    assert!(spans.len() >= 2, "expected at least two tail frames");
    fs::OpenOptions::new()
        .write(true)
        .open(&tail_path)
        .unwrap()
        .set_len((spans[1].0 + spans[1].1 / 2) as u64)
        .unwrap();

    let reopened = LastStore::open_with(dir.path(), opts).unwrap();
    assert_eq!(
        reopened.get("c", "a").unwrap().as_deref(),
        Some(&b"alpha"[..])
    );
    assert!(reopened.get("c", "b").unwrap().is_none());
    assert!(dir
        .path()
        .join(format!("data/c/0/chunks/{old_tail_uuid}.seg"))
        .exists());
    assert!(
        seg_files(&dir.path().join("data/c/0/tail")).is_empty(),
        "reopen must not resume appending to the recovered tail"
    );

    reopened.put("c", "c", b"charlie").unwrap();
    reopened.flush().unwrap();
    let new_tail = only_seg_file(&dir.path().join("data/c/0/tail"));
    assert_ne!(uuid_from_seg_path(&new_tail), old_tail_uuid);
    assert_eq!(
        reopened.get("c", "c").unwrap().as_deref(),
        Some(&b"charlie"[..])
    );
}

#[test]
fn encrypted_footer_tombstone_removes_id_from_older_sealed_chunk_on_reopen() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        max_segment_bytes: 64 * 1024,
        data_key: Some([51u8; 32]),
        ..LastStoreOptions::default()
    };
    let body = vec![b'x'; 20 * 1024];
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        s.put("c", "victim", &body).unwrap();
        for i in 0..8 {
            s.put("c", &format!("before-{i}"), &body).unwrap();
        }
        s.delete("c", "victim").unwrap();
        for i in 0..8 {
            s.put("c", &format!("after-{i}"), &body).unwrap();
        }
        s.flush().unwrap();
    }

    let chunks = seg_files(&dir.path().join("data/c/0/chunks"));
    assert!(
        chunks.len() >= 2,
        "expected multiple sealed chunks: {chunks:?}"
    );

    let reopened = LastStore::open_with(dir.path(), opts).unwrap();
    assert!(reopened.get("c", "victim").unwrap().is_none());
}

#[test]
fn encrypted_store_rejects_wrong_key_on_reopen() {
    let dir = TempDir::new().unwrap();
    {
        let s = LastStore::open_with(
            dir.path(),
            LastStoreOptions {
                data_key: Some([1u8; 32]),
                ..LastStoreOptions::default()
            },
        )
        .unwrap();
        s.put("c", "k", b"secret").unwrap();
        s.flush().unwrap();
    }

    let reopened = LastStore::open_with(
        dir.path(),
        LastStoreOptions {
            data_key: Some([2u8; 32]),
            ..LastStoreOptions::default()
        },
    )
    .unwrap();
    let err = reopened.get("c", "k").unwrap_err();
    assert!(matches!(err, laststore::Error::AeadAuthFail));
}

fn only_seg_file(dir: &Path) -> PathBuf {
    let files = seg_files(dir);
    assert_eq!(
        files.len(),
        1,
        "expected one .seg file in {dir:?}: {files:?}"
    );
    files.into_iter().next().unwrap()
}

fn seg_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("seg"))
        .collect::<Vec<_>>();
    out.sort();
    out
}

fn seg_file_bytes_under(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    collect_seg_file_bytes(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn collect_seg_file_bytes(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
    if !dir.exists() {
        return;
    }
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect_seg_file_bytes(root, &path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("seg") {
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            out.push((rel, fs::read(path).unwrap()));
        }
    }
}

fn frame_headers(path: &Path, key: &[u8; 32]) -> Vec<laststore::frame::FrameHeader> {
    let disk = fs::read(path).unwrap();
    let mut headers = Vec::new();
    let mut off = 0usize;
    while off < disk.len() {
        if off + laststore::frame::header_size() > disk.len() {
            break;
        }
        let header_end = off + laststore::frame::header_size();
        let frame_len = laststore::frame::encoded_len(&disk[off..header_end]).unwrap();
        if off + frame_len > disk.len() {
            break;
        }
        let decoded = laststore::frame::decode_frame(key, &disk[off..off + frame_len]).unwrap();
        headers.push(decoded.header);
        off += frame_len;
    }
    headers
}

fn frame_spans(path: &Path) -> Vec<(usize, usize)> {
    let disk = fs::read(path).unwrap();
    let mut spans = Vec::new();
    let mut off = 0usize;
    while off < disk.len() {
        if off + laststore::frame::header_size() > disk.len() {
            break;
        }
        let header_end = off + laststore::frame::header_size();
        let frame_len = laststore::frame::encoded_len(&disk[off..header_end]).unwrap();
        if off + frame_len > disk.len() {
            break;
        }
        spans.push((off, frame_len));
        off += frame_len;
    }
    spans
}

fn uuid_from_seg_path(path: &Path) -> uuid::Uuid {
    path.file_stem()
        .and_then(|s| s.to_str())
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .expect("uuid segment filename")
}
