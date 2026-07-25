use laststore::{LastStore, LastStoreOptions, LayoutMode};
use std::fs;

#[test]
fn hash_group_home_reopens_from_durable_layout() {
    let dir = tempfile::tempdir().unwrap();
    {
        let store = LastStore::open_with(dir.path(), LastStoreOptions::hash_group()).unwrap();
        store.put("atoms", "atom-1", b"one").unwrap();
        store.flush().unwrap();
    }

    let reopened = LastStore::open(dir.path()).unwrap();
    assert_eq!(reopened.options().layout_mode, LayoutMode::HashGroup);
    assert_eq!(
        reopened.get("atoms", "atom-1").unwrap().as_deref(),
        Some(b"one".as_slice())
    );
}

#[test]
fn explicit_layout_mismatch_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    LastStore::open_with(dir.path(), LastStoreOptions::hash_group()).unwrap();
    let error = LastStore::open_with(dir.path(), LastStoreOptions::default())
        .err()
        .expect("mismatched layout must fail");
    assert!(error.to_string().contains("durable descriptor"));
}

#[test]
fn existing_open_uses_recorded_layout_with_runtime_options() {
    let dir = tempfile::tempdir().unwrap();
    let key = [7u8; 32];
    {
        let mut options = LastStoreOptions::hash_group();
        options.data_key = Some(key);
        let store = LastStore::open_with(dir.path(), options).unwrap();
        store.put("atoms", "atom-1", b"encrypted").unwrap();
        store.flush().unwrap();
    }

    let runtime_options = LastStoreOptions {
        data_key: Some(key),
        ..LastStoreOptions::default()
    };
    let reopened = LastStore::open_existing_or_with(dir.path(), runtime_options).unwrap();
    assert_eq!(reopened.options().layout_mode, LayoutMode::HashGroup);
    assert_eq!(
        reopened.get("atoms", "atom-1").unwrap().as_deref(),
        Some(b"encrypted".as_slice())
    );
}

#[test]
fn descriptorless_legacy_home_is_detected_without_mutation() {
    let dir = tempfile::tempdir().unwrap();
    {
        let store = LastStore::open(dir.path()).unwrap();
        store.put("tips", "tip-1", b"legacy").unwrap();
        store.flush().unwrap();
    }
    fs::remove_file(dir.path().join("laststore-layout-v1")).unwrap();
    let reopened = LastStore::open(dir.path()).unwrap();
    assert_eq!(reopened.options().layout_mode, LayoutMode::SegmentLog);
    assert_eq!(
        reopened.get("tips", "tip-1").unwrap().as_deref(),
        Some(b"legacy".as_slice())
    );
    assert!(!dir.path().join("laststore-layout-v1").exists());
}

#[test]
fn descriptorless_mixed_home_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let shard = dir.path().join("data/atoms/0");
    fs::create_dir_all(shard.join("g/001")).unwrap();
    fs::write(shard.join("0000000000000000.seg"), []).unwrap();
    let error = LastStore::open(dir.path())
        .err()
        .expect("mixed layout must fail");
    assert!(error
        .to_string()
        .contains("mixed segment-log and hash-group"));
}

#[test]
fn migration_copies_only_live_values_and_verifies_reopen() {
    let source_dir = tempfile::tempdir().unwrap();
    let destination_dir = tempfile::tempdir().unwrap();
    let source = LastStore::open(source_dir.path()).unwrap();
    source.put("atoms", "a1", b"old").unwrap();
    source.put("atoms", "a1", b"new").unwrap();
    source.put("atoms", "deleted", b"gone").unwrap();
    source.delete("atoms", "deleted").unwrap();
    source.put("tips", "t1", b"a1").unwrap();
    source.flush().unwrap();
    let report = source
        .migrate_to_hash_group(destination_dir.path(), LastStoreOptions::hash_group())
        .unwrap();
    assert_eq!(report.total_documents, 2);
    assert_eq!(report.collections.get("atoms"), Some(&1));
    assert_eq!(report.collections.get("tips"), Some(&1));
    drop(source);
    let migrated = LastStore::open(destination_dir.path()).unwrap();
    assert_eq!(migrated.options().layout_mode, LayoutMode::HashGroup);
    assert_eq!(migrated.options().layout_epoch, 1);
    assert_eq!(
        migrated.get("atoms", "a1").unwrap().as_deref(),
        Some(b"new".as_slice())
    );
    assert_eq!(migrated.get("atoms", "deleted").unwrap(), None);
}

#[test]
fn migration_batches_writes_by_destination_hash_group() {
    let source_dir = tempfile::tempdir().unwrap();
    let destination_dir = tempfile::tempdir().unwrap();
    let source = LastStore::open(source_dir.path()).unwrap();
    for i in 0..400 {
        let id = format!("atom-{i:04}");
        source.put("atoms", &id, &[b'x'; 1_024]).unwrap();
    }
    source.flush().unwrap();

    let mut options = LastStoreOptions::hash_group().with_hash_group_warm_bytes(192 * 1_024);
    options.hash_group_bits = 4;
    options.data_key = Some([9; 32]);
    source
        .migrate_to_hash_group(destination_dir.path(), options)
        .unwrap();

    let segment_count = walk_files(destination_dir.path())
        .into_iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "seg"))
        .count();
    assert!(
        segment_count <= 40,
        "group-ordered migration should not amplify 400 documents into {segment_count} segments"
    );
}

#[test]
fn migration_refuses_nonempty_destination() {
    let source_dir = tempfile::tempdir().unwrap();
    let destination_dir = tempfile::tempdir().unwrap();
    let source = LastStore::open(source_dir.path()).unwrap();
    source.put("atoms", "a1", b"one").unwrap();
    fs::write(destination_dir.path().join("unrelated"), b"keep").unwrap();
    let error = source
        .migrate_to_hash_group(destination_dir.path(), LastStoreOptions::hash_group())
        .unwrap_err();
    assert!(error.to_string().contains("destination must be empty"));
    assert_eq!(
        fs::read(destination_dir.path().join("unrelated")).unwrap(),
        b"keep"
    );
}

fn walk_files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.push(path);
            }
        }
    }
    files
}
