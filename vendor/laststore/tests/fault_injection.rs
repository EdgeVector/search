use laststore::{LastStore, LastStoreOptions};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const KEY: [u8; 32] = [0xA5; 32];
const CHILD_ENV: &str = "LASTSTORE_FAULT_CHILD";

#[test]
fn kill_harness_preserves_acked_flushes_and_opens_fresh_nonce_domain_for_200_schedules() {
    for seed in 0..200 {
        run_kill_schedule(seed);
    }
}

#[test]
fn fault_child_entrypoint() {
    if env::var_os(CHILD_ENV).is_none() {
        return;
    }

    let root = PathBuf::from(env::var("LASTSTORE_FAULT_ROOT").expect("root"));
    let ack_target: usize = env::var("LASTSTORE_FAULT_ACK_TARGET")
        .expect("ack target")
        .parse()
        .expect("ack target number");
    run_child_writer(&root, ack_target).expect("child writer");
    std::process::exit(0);
}

#[test]
fn truncated_tail_is_retired_and_never_resumed() {
    let dir = TempDir::new().unwrap();
    let opts = opts_with_one_frame_per_flush();
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        for i in 0..5 {
            put_flush(&s, i);
        }
    }

    let tail_path = only_seg_file(&dir.path().join("data/c/0/tail"));
    let old_tail_uuid = uuid_from_seg_path(&tail_path);
    let spans = frame_spans(&tail_path);
    assert!(spans.len() >= 5, "expected several flushed tail frames");
    let truncate_at = spans[3].0 + spans[3].1 / 2;
    fs::OpenOptions::new()
        .write(true)
        .open(&tail_path)
        .unwrap()
        .set_len(truncate_at as u64)
        .unwrap();

    let reopened = LastStore::open_with(dir.path(), opts.clone()).unwrap();
    for i in 0..3 {
        assert_eq!(
            reopened.get("c", &doc_id(i)).unwrap().as_deref(),
            Some(body(i).as_slice())
        );
    }
    assert!(reopened.get("c", &doc_id(3)).unwrap().is_none());
    assert!(dir
        .path()
        .join(format!("data/c/0/chunks/{old_tail_uuid}.seg"))
        .exists());
    assert!(seg_files(&dir.path().join("data/c/0/tail")).is_empty());

    put_flush(&reopened, 99);
    let new_tail = only_seg_file(&dir.path().join("data/c/0/tail"));
    assert_ne!(uuid_from_seg_path(&new_tail), old_tail_uuid);
    assert_nonce_pairs_unique(dir.path());
}

#[test]
fn fabricated_csn_gap_hard_stops_chunk_verification() {
    let dir = TempDir::new().unwrap();
    let opts = opts_with_one_frame_per_flush();
    let s = LastStore::open_with(dir.path(), opts).unwrap();
    for i in 0..3 {
        put_flush(&s, i);
    }
    let snapshot = s.snapshot().unwrap();
    let chunk = snapshot.sealed_chunks.first().expect("sealed chunk");
    let spans = frame_spans(&chunk.path);
    assert!(
        spans.len() >= 3,
        "expected multiple data frames in sealed chunk"
    );

    let mut disk = fs::read(&chunk.path).unwrap();
    disk[spans[1].0 + 8] = disk[spans[1].0 + 8].wrapping_add(1);
    fs::write(&chunk.path, disk).unwrap();

    let err = s.verify_chunk(chunk.chunk_uuid).unwrap_err();
    assert!(
        matches!(err, laststore::Error::AeadAuthFail),
        "expected hard auth stop, got {err:?}"
    );
}

#[test]
fn per_role_recovery_matrix_handles_tail_sealed_and_combined_corruption() {
    for role in [CorruptRole::Tail, CorruptRole::Sealed, CorruptRole::Both] {
        exercise_recovery_role(role);
    }
}

fn run_kill_schedule(seed: u64) {
    let dir = TempDir::new().unwrap();
    let ack_target = 1 + (seed as usize % 8);
    let mut child = Command::new(env::current_exe().unwrap())
        .arg("--exact")
        .arg("fault_child_entrypoint")
        .arg("--nocapture")
        .env(CHILD_ENV, "1")
        .env("LASTSTORE_FAULT_ROOT", dir.path())
        .env("LASTSTORE_FAULT_ACK_TARGET", ack_target.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let marker = dir.path().join("kill-ready");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !marker.exists() {
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("child did not reach kill marker");
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    child.kill().unwrap();
    let _ = child.wait().unwrap();

    let store = LastStore::open_with(dir.path(), opts_with_one_frame_per_flush()).unwrap();
    for i in 0..ack_target {
        assert_eq!(
            store.get("c", &doc_id(i)).unwrap().as_deref(),
            Some(body(i).as_slice())
        );
    }
    let old_tail = only_seg_file(&dir.path().join("data/c/0/chunks"));
    let old_tail_uuid = uuid_from_seg_path(&old_tail);
    put_flush(&store, 1000 + ack_target);
    let new_tail = only_seg_file(&dir.path().join("data/c/0/tail"));
    assert_ne!(uuid_from_seg_path(&new_tail), old_tail_uuid);
    assert_nonce_pairs_unique(dir.path());
}

fn run_child_writer(root: &Path, ack_target: usize) -> Result<(), Box<dyn std::error::Error>> {
    let store = LastStore::open_with(root, opts_with_one_frame_per_flush())?;
    for i in 0..ack_target {
        put_flush(&store, i);
    }
    fs::write(root.join("kill-ready"), ack_target.to_string())?;
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[derive(Clone, Copy, Debug)]
enum CorruptRole {
    Tail,
    Sealed,
    Both,
}

fn exercise_recovery_role(role: CorruptRole) {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        max_dirty_ops: 1,
        data_key: Some(KEY),
        ..LastStoreOptions::default()
    };
    let pristine_chunk;
    let chunk_uuid;
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        for i in 0..4 {
            s.put("c", &format!("sealed-{i}"), &vec![b's'; 20 * 1024])
                .unwrap();
            s.flush().unwrap();
        }
        let snapshot = s.snapshot().unwrap();
        let chunk = snapshot.sealed_chunks.first().expect("sealed chunk");
        pristine_chunk = fs::read(&chunk.path).unwrap();
        chunk_uuid = chunk.chunk_uuid;
        for i in 0..3 {
            s.put("c", &format!("tail-{i}"), &body(i)).unwrap();
            s.flush().unwrap();
        }
    }

    if matches!(role, CorruptRole::Tail | CorruptRole::Both) {
        truncate_tail_mid_frame(dir.path());
    }
    if matches!(role, CorruptRole::Sealed | CorruptRole::Both) {
        corrupt_first_chunk_byte(dir.path(), chunk_uuid);
    }

    let reopened = LastStore::open_with(dir.path(), opts).unwrap();
    if matches!(role, CorruptRole::Sealed | CorruptRole::Both) {
        assert!(reopened.get("c", "sealed-0").unwrap().is_none());
        assert!(dir
            .path()
            .join(format!("data/c/0/quarantine/{chunk_uuid}.seg"))
            .exists());
        reopened.install_chunk(chunk_uuid, &pristine_chunk).unwrap();
        assert!(reopened.get("c", "sealed-0").unwrap().is_some());
    } else {
        assert!(reopened.get("c", "sealed-0").unwrap().is_some());
    }

    assert_eq!(
        reopened.get("c", "tail-0").unwrap().as_deref(),
        Some(body(0).as_slice())
    );
    if matches!(role, CorruptRole::Tail | CorruptRole::Both) {
        assert!(reopened.get("c", "tail-2").unwrap().is_none());
    } else {
        assert_eq!(
            reopened.get("c", "tail-2").unwrap().as_deref(),
            Some(body(2).as_slice())
        );
    }
    put_flush(&reopened, 250);
    assert_nonce_pairs_unique(dir.path());
}

fn opts_with_one_frame_per_flush() -> LastStoreOptions {
    LastStoreOptions {
        max_dirty_ops: 1,
        data_key: Some(KEY),
        ..LastStoreOptions::default()
    }
}

fn put_flush(store: &LastStore, i: usize) {
    store.put("c", &doc_id(i), &body(i)).unwrap();
    store.flush().unwrap();
}

fn doc_id(i: usize) -> String {
    format!("doc-{i:03}")
}

fn body(i: usize) -> Vec<u8> {
    format!("value-{i:03}").into_bytes()
}

fn truncate_tail_mid_frame(root: &Path) {
    let tail_path = only_seg_file(&root.join("data/c/0/tail"));
    let spans = frame_spans(&tail_path);
    assert!(spans.len() >= 2, "expected multiple tail frames");
    fs::OpenOptions::new()
        .write(true)
        .open(&tail_path)
        .unwrap()
        .set_len((spans[1].0 + spans[1].1 / 2) as u64)
        .unwrap();
}

fn corrupt_first_chunk_byte(root: &Path, chunk_uuid: uuid::Uuid) {
    let path = root.join(format!("data/c/0/chunks/{chunk_uuid}.seg"));
    let mut disk = fs::read(&path).unwrap();
    disk[laststore::frame::header_size()] ^= 0x01;
    fs::write(path, disk).unwrap();
}

fn assert_nonce_pairs_unique(root: &Path) {
    let mut seen = HashSet::new();
    for path in all_seg_files(root) {
        for header in frame_headers(&path) {
            assert!(
                seen.insert((header.chunk_uuid, header.counter)),
                "reused frame nonce pair ({}, {}) in {}",
                header.chunk_uuid,
                header.counter,
                path.display()
            );
        }
    }
}

fn all_seg_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_seg_files(root, &mut out);
    out.sort();
    out
}

fn collect_seg_files(dir: &Path, out: &mut Vec<PathBuf>) {
    if !dir.exists() {
        return;
    }
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect_seg_files(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("seg") {
            out.push(path);
        }
    }
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
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|s| s.to_str()) == Some("seg"))
        .collect::<Vec<_>>();
    out.sort();
    out
}

fn frame_headers(path: &Path) -> Vec<laststore::frame::FrameHeader> {
    let disk = fs::read(path).unwrap();
    let mut headers = Vec::new();
    let mut off = 0usize;
    while off < disk.len() {
        if disk.len() - off == 24 && disk[off..].starts_with(b"LSFTRL1\0") {
            break;
        }
        if off + laststore::frame::header_size() > disk.len() {
            break;
        }
        let header_end = off + laststore::frame::header_size();
        let frame_len = laststore::frame::encoded_len(&disk[off..header_end]).unwrap();
        if off + frame_len > disk.len() {
            break;
        }
        let decoded = laststore::frame::decode_frame(&KEY, &disk[off..off + frame_len]).unwrap();
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
        if disk.len() - off == 24 && disk[off..].starts_with(b"LSFTRL1\0") {
            break;
        }
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

#[test]
fn hash_group_kill_harness_preserves_acked_flushes_for_50_schedules() {
    for seed in 0..50 {
        run_kill_schedule_hg(seed);
    }
}

fn opts_hash_group_one_frame_per_flush() -> LastStoreOptions {
    LastStoreOptions {
        max_dirty_ops: 1,
        data_key: Some(KEY),
        ..LastStoreOptions::hash_group()
    }
}

fn run_kill_schedule_hg(seed: u64) {
    let dir = TempDir::new().unwrap();
    let ack_target = 1 + (seed as usize % 8);
    let mut child = Command::new(env::current_exe().unwrap())
        .arg("--exact")
        .arg("fault_child_entrypoint_hg")
        .arg("--nocapture")
        .env(CHILD_ENV, "1")
        .env("LASTSTORE_FAULT_ROOT", dir.path())
        .env("LASTSTORE_FAULT_ACK_TARGET", ack_target.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let marker = dir.path().join("kill-ready");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !marker.exists() {
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("child did not reach kill marker");
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    child.kill().unwrap();
    let _ = child.wait().unwrap();

    let store = LastStore::open_with(dir.path(), opts_hash_group_one_frame_per_flush()).unwrap();
    for i in 0..ack_target {
        assert_eq!(
            store.get("c", &doc_id(i)).unwrap().as_deref(),
            Some(body(i).as_slice()),
            "seed={seed} ack_target={ack_target} i={i}"
        );
    }
    put_flush(&store, 1000 + ack_target);
    assert_nonce_pairs_unique(dir.path());
}

#[test]
fn fault_child_entrypoint_hg() {
    if env::var_os(CHILD_ENV).is_none() {
        return;
    }
    let root = PathBuf::from(env::var("LASTSTORE_FAULT_ROOT").expect("root"));
    let ack_target: usize = env::var("LASTSTORE_FAULT_ACK_TARGET")
        .expect("ack target")
        .parse()
        .expect("ack target number");
    run_child_writer_hg(&root, ack_target).expect("child writer");
    std::process::exit(0);
}

fn run_child_writer_hg(root: &Path, ack_target: usize) -> Result<(), Box<dyn std::error::Error>> {
    let store = LastStore::open_with(root, opts_hash_group_one_frame_per_flush())?;
    for i in 0..ack_target {
        put_flush(&store, i);
    }
    fs::write(root.join("kill-ready"), ack_target.to_string())?;
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[test]
fn hash_group_sealed_chunk_corruption_quarantines_and_install_chunk_restores() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        max_dirty_ops: 1,
        data_key: Some(KEY),
        hash_group_bits: 1,
        ..LastStoreOptions::hash_group()
    };
    let pristine_chunk;
    let chunk_uuid;
    let target_id;
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        for i in 0..8 {
            s.put("c", &format!("sealed-{i}"), &vec![b's'; 20 * 1024])
                .unwrap();
            s.flush().unwrap();
        }
        let snapshot = s.snapshot().unwrap();
        let chunk = snapshot.sealed_chunks.first().expect("sealed chunk");
        pristine_chunk = fs::read(&chunk.path).unwrap();
        chunk_uuid = chunk.chunk_uuid;
        let chunk_group = chunk
            .path
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .and_then(|s| u32::from_str_radix(s, 16).ok())
            .expect("chunk path has a hash-group component");
        target_id = (0..8)
            .map(|i| format!("sealed-{i}"))
            .find(|id| s.place("c", id).group_id == chunk_group)
            .expect("an id placed in the corrupted chunk's group");
        s.verify_chunk(chunk_uuid).unwrap();
    }

    corrupt_first_chunk_byte_hg(dir.path(), chunk_uuid);

    let reopened = LastStore::open_with(dir.path(), opts).unwrap();
    assert!(reopened.get("c", &target_id).unwrap().is_none());
    reopened.install_chunk(chunk_uuid, &pristine_chunk).unwrap();
    assert!(reopened.get("c", &target_id).unwrap().is_some());
}

fn corrupt_first_chunk_byte_hg(root: &Path, chunk_uuid: uuid::Uuid) {
    for entry in walkdir_seg(root) {
        if entry.file_name().and_then(|s| s.to_str()) == Some(&format!("{chunk_uuid}.seg")) {
            let mut disk = fs::read(&entry).unwrap();
            disk[laststore::frame::header_size()] ^= 0x01;
            fs::write(&entry, disk).unwrap();
            return;
        }
    }
    panic!("chunk file for {chunk_uuid} not found on disk");
}

fn walkdir_seg(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn rec(dir: &Path, out: &mut Vec<PathBuf>) {
        if !dir.exists() {
            return;
        }
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rec(&path, out);
            } else {
                out.push(path);
            }
        }
    }
    rec(root, &mut out);
    out
}

/// Two hash groups interleave puts against the store-wide CSN counter, so
/// each group's own frame chain sees "gaps" in its CSNs: legitimate, not
/// corruption. Regression test for the false-positive this used to trigger in
/// `decode_encrypted_file` on a completely clean reopen.
#[test]
fn hash_group_encrypted_reopen_survives_interleaved_group_csn_allocation() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        max_dirty_ops: 1,
        data_key: Some(KEY),
        hash_group_bits: 1,
        ..LastStoreOptions::hash_group()
    };
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        for i in 0..4 {
            s.put("c", &format!("sealed-{i}"), &vec![b's'; 20 * 1024])
                .unwrap();
            s.flush().unwrap();
        }
        s.snapshot().unwrap();
    }
    let reopened = LastStore::open_with(dir.path(), opts).unwrap();
    for i in 0..4 {
        let id = format!("sealed-{i}");
        assert!(
            reopened.get("c", &id).unwrap().is_some(),
            "{id} should survive a plain reopen"
        );
    }
}
