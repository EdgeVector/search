use laststore::{LastStore, LastStoreOptions, LayoutMode};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

#[test]
fn hash_group_place_is_stable_and_uses_layout_path() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions::hash_group();
    let s = LastStore::open_with(dir.path(), opts).unwrap();

    let first = s.place("atoms", "550e8400-e29b-41d4-a716-446655440000");
    let second = s.place("atoms", "550e8400-e29b-41d4-a716-446655440000");

    assert_eq!(first, second);
    assert_eq!(first.shard, 0);
    assert!(first.group_id < 1024);
    assert_eq!(
        first.relative_dir,
        std::path::PathBuf::from(format!("data/atoms/0/g/{:03x}", first.group_id))
    );
}

#[test]
fn hash_group_put_get_roundtrip_and_reopen() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions::hash_group();
    let id = "550e8400-e29b-41d4-a716-446655440000";
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        let placement = s.place("atoms", id);
        s.put("atoms", id, br#"{"v":1}"#).unwrap();
        s.flush().unwrap();

        assert_eq!(
            s.get("atoms", id).unwrap().as_deref(),
            Some(br#"{"v":1}"#.as_slice())
        );
        assert!(dir.path().join(placement.relative_dir).exists());
    }

    let reopened = LastStore::open_with(dir.path(), opts).unwrap();
    assert_eq!(
        reopened.get("atoms", id).unwrap().as_deref(),
        Some(br#"{"v":1}"#.as_slice())
    );
}

#[test]
fn hash_group_writes_buffer_until_group_commit_threshold() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        layout_mode: LayoutMode::HashGroup,
        max_dirty_ops: 2,
        ..LastStoreOptions::default()
    };
    let s = LastStore::open_with(dir.path(), opts).unwrap();
    let first = "550e8400-e29b-41d4-a716-446655440001";
    let first_dir = dir.path().join(s.place("atoms", first).relative_dir);

    s.put("atoms", first, br#"{"v":1}"#).unwrap();
    assert!(
        seg_files(&first_dir).is_empty(),
        "first hash-group write should stay in the in-memory group buffer"
    );

    s.put("atoms", first, br#"{"v":2}"#).unwrap();

    let first_files = seg_files(&first_dir);
    assert_eq!(
        first_files.len(),
        1,
        "dirty-op threshold should spill the hash-group buffer"
    );
    assert_eq!(
        s.get("atoms", first).unwrap().as_deref(),
        Some(br#"{"v":2}"#.as_slice())
    );
}

#[test]
fn hash_group_rolls_segment_before_exceeding_max_segment_bytes() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        layout_mode: LayoutMode::HashGroup,
        max_segment_bytes: 64 * 1024,
        ..LastStoreOptions::default()
    };
    let id = "550e8400-e29b-41d4-a716-446655440003";
    let first_body = vec![b'a'; 40 * 1024];
    let second_body = vec![b'b'; 40 * 1024];
    let group_dir;
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        group_dir = dir.path().join(s.place("atoms", id).relative_dir);
        s.put("atoms", id, &first_body).unwrap();
        s.put("atoms", id, &second_body).unwrap();
        s.flush().unwrap();

        assert_eq!(seg_files(&group_dir).len(), 2);
        assert_eq!(
            s.get("atoms", id).unwrap().as_deref(),
            Some(second_body.as_slice())
        );
    }

    let reopened = LastStore::open_with(dir.path(), opts).unwrap();
    assert_eq!(
        reopened.get("atoms", id).unwrap().as_deref(),
        Some(second_body.as_slice())
    );
    assert_eq!(seg_files(&group_dir).len(), 2);
}

#[test]
fn hash_group_default_enables_256_mib_warm_budget() {
    let opts = LastStoreOptions::hash_group();

    assert_eq!(opts.hash_group_warm_bytes, 256 * 1024 * 1024);
}

#[test]
fn open_existing_or_with_default_restores_product_warm_budget_on_hash_group_home() {
    let dir = TempDir::new().unwrap();
    {
        let s = LastStore::open_with(dir.path(), LastStoreOptions::hash_group()).unwrap();
        s.put("atoms", "00000000-0000-4000-8000-000000000001", b"v1")
            .unwrap();
        s.flush().unwrap();
        assert_eq!(s.options().layout_mode, LayoutMode::HashGroup);
    }

    // Mini-style reopen: callers historically passed Default (warm_bytes=0).
    // Product path must re-enable the 256 MiB warm budget so eviction stays on.
    let reopened =
        LastStore::open_existing_or_with(dir.path(), LastStoreOptions::default()).unwrap();
    assert_eq!(reopened.options().layout_mode, LayoutMode::HashGroup);
    assert_eq!(
        reopened.options().hash_group_warm_bytes,
        LastStoreOptions::hash_group().hash_group_warm_bytes
    );
    assert_eq!(
        reopened
            .get("atoms", "00000000-0000-4000-8000-000000000001")
            .unwrap()
            .as_deref(),
        Some(b"v1".as_slice())
    );
    let stats = reopened.hash_group_warm_stats();
    assert!(stats.budget_bytes > 0);
    assert!(stats.resident_bytes <= stats.budget_bytes);
}

#[test]
fn segment_log_does_not_charge_hash_group_warm_residency() {
    let dir = TempDir::new().unwrap();
    let s = LastStore::open(dir.path()).unwrap();
    for i in 0..100 {
        let id = format!("legacy-{i:03}");
        s.put("atoms", &id, &[b'x'; 1_024]).unwrap();
        assert_eq!(s.get("atoms", &id).unwrap().unwrap().len(), 1_024);
    }

    let stats = s.hash_group_warm_stats();
    assert_eq!(stats.resident_groups, 0);
    assert_eq!(stats.resident_bytes, 0);
}

#[test]
fn hash_group_different_hashes_can_choose_different_groups() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        layout_mode: LayoutMode::HashGroup,
        hash_group_bits: 4,
        ..LastStoreOptions::default()
    };
    let s = LastStore::open_with(dir.path(), opts).unwrap();

    let a = s.place("atoms", "00000000-0000-0000-0000-000000000001");
    let b = s.place("atoms", "00000000-0000-0000-0000-000000000002");

    assert_ne!(a.group_id, b.group_id);
    s.put("atoms", "00000000-0000-0000-0000-000000000001", b"a")
        .unwrap();
    s.put("atoms", "00000000-0000-0000-0000-000000000002", b"b")
        .unwrap();
    assert_eq!(
        s.get("atoms", "00000000-0000-0000-0000-000000000001")
            .unwrap()
            .as_deref(),
        Some(b"a".as_slice())
    );
    assert_eq!(
        s.get("atoms", "00000000-0000-0000-0000-000000000002")
            .unwrap()
            .as_deref(),
        Some(b"b".as_slice())
    );
}

#[test]
fn hash_group_warm_set_evicts_cold_groups_without_losing_point_gets() {
    let dir = TempDir::new().unwrap();
    let opts = LastStoreOptions {
        layout_mode: LayoutMode::HashGroup,
        hash_group_bits: 4,
        ..LastStoreOptions::default()
    }
    .with_hash_group_warm_bytes(5 * 1024 * 1024);
    let s = LastStore::open_with(dir.path(), opts).unwrap();
    let first = "00000000-0000-0000-0000-000000000001";
    let second = (2..)
        .map(|i| format!("00000000-0000-0000-0000-{i:012}"))
        .find(|id| s.place("atoms", id).group_id != s.place("atoms", first).group_id)
        .unwrap();

    s.put("atoms", first, b"first").unwrap();
    assert_eq!(s.hash_group_warm_stats().resident_groups, 1);

    s.put("atoms", &second, b"second").unwrap();
    let stats = s.hash_group_warm_stats();
    assert_eq!(stats.resident_groups, 1);
    assert!(stats.resident_bytes <= stats.budget_bytes);

    assert_eq!(
        s.get("atoms", first).unwrap().as_deref(),
        Some(b"first".as_slice())
    );
    assert_eq!(
        s.get("atoms", &second).unwrap().as_deref(),
        Some(b"second".as_slice())
    );
    assert!(s.hash_group_warm_stats().resident_groups <= 2);
}

#[test]
fn hash_group_cold_open_opens_zero_groups_and_nav_keys_do_not_require_all_bodies() {
    let dir = TempDir::new().unwrap();
    // Fat atom bodies so the warm budget cannot retain every group at once.
    let warm_cap = 3 * 1024 * 1024u64;
    let opts = LastStoreOptions {
        layout_mode: LayoutMode::HashGroup,
        hash_group_bits: 6, // 64 groups
        ..LastStoreOptions::default()
    }
    .with_hash_group_warm_bytes(warm_cap);
    let n = 64usize; // one fat doc per group ideally
    let fat = vec![b'B'; 256 * 1024]; // 256 KiB bodies
    let mut ids = Vec::with_capacity(n);
    {
        let s = LastStore::open_with(dir.path(), opts.clone()).unwrap();
        for i in 0..n {
            let id = format!("00000000-0000-4000-8000-{i:012x}");
            let mut body = format!("body-{i}|").into_bytes();
            body.extend_from_slice(&fat);
            s.put("atoms", &id, &body).unwrap();
            // schemas = thin navigational plane (tiny docs, separate collection)
            s.put(
                "schemas",
                &format!("schema-{i}"),
                format!("name-{i}").as_bytes(),
            )
            .unwrap();
            ids.push(id);
        }
        s.flush().unwrap();
        assert!(s.hash_group_disk_group_count("atoms").unwrap() > 1);
    }

    // Cold reopen: no permanent placement map, no groups resident until touch.
    let s = LastStore::open_with(dir.path(), opts).unwrap();
    let warm0 = s.hash_group_warm_stats();
    assert_eq!(warm0.resident_groups, 0);
    assert_eq!(warm0.resident_bytes, 0);
    let disk_groups = s.hash_group_disk_group_count("atoms").unwrap();
    assert!(
        disk_groups > 1,
        "expected multi-group layout, got {disk_groups}"
    );

    // Navigational plane: keys-only list (no atom body hydrate).
    let schema_ids = s.list_prefix_keys("schemas", "schema-").unwrap();
    assert_eq!(schema_ids.len(), n);
    // Schema nav must not open the atom plane.
    let atoms_after_nav = s.hash_group_warm_stats_for("atoms");
    assert_eq!(
        atoms_after_nav.resident_groups, 0,
        "schema keys-only nav must leave atoms cold: {:?}",
        atoms_after_nav
    );
    let after_nav = s.hash_group_warm_stats();
    assert!(
        after_nav.resident_bytes <= after_nav.budget_bytes || after_nav.budget_bytes == 0,
        "nav must stay within warm budget: {:?}",
        after_nav
    );

    // Sparse hydrate: only touch a handful of atom ids.
    for id in ids.iter().step_by(8).take(4) {
        let body = s.get("atoms", id).unwrap().expect("atom present");
        assert!(body.starts_with(b"body-"));
        assert!(body.len() > 200_000);
    }
    let after_gets = s.hash_group_warm_stats();
    assert!(
        after_gets.resident_bytes <= after_gets.budget_bytes,
        "sparse gets must stay within warm budget: {:?}",
        after_gets
    );
    let atoms_after = s.hash_group_warm_stats_for("atoms");
    // With fat groups + tight budget, open atom groups stay a minority of disk.
    assert!(
        atoms_after.resident_groups < disk_groups,
        "cold majority required for atoms: resident={} disk={} global={:?}",
        atoms_after.resident_groups,
        disk_groups,
        after_gets
    );
    assert!(atoms_after.resident_groups <= 16);
    // Untouched majority remains correct on later get.
    let last = ids.last().unwrap();
    let got = s.get("atoms", last).unwrap().expect("last present");
    assert!(got.starts_with(format!("body-{}", n - 1).as_bytes()));
}

#[test]
fn hash_group_warm_set_stays_bounded_after_touching_many_distinct_groups() {
    let dir = TempDir::new().unwrap();
    let warm_cap = 4 * 1024 * 1024u64;
    let opts = LastStoreOptions {
        layout_mode: LayoutMode::HashGroup,
        hash_group_bits: 8, // 256 groups
        ..LastStoreOptions::default()
    }
    .with_hash_group_warm_bytes(warm_cap);
    let s = LastStore::open_with(dir.path(), opts).unwrap();

    // Write one fat doc per many ids so groups fill and eviction fires.
    let body = vec![b'z'; 64 * 1024];
    let mut written = Vec::new();
    for i in 0..400 {
        let id = format!("00000000-0000-4000-8000-{i:012x}");
        s.put("atoms", &id, &body).unwrap();
        written.push(id);
        let stats = s.hash_group_warm_stats();
        assert!(
            stats.resident_bytes
                <= stats
                    .budget_bytes
                    .saturating_mul(2)
                    .max(warm_cap + body.len() as u64),
            "warm set unbounded after put {i}: {:?}",
            stats
        );
    }
    s.flush().unwrap();

    // Touch every written id once more (simulates scanning long tail then forgetting).
    for id in &written {
        let got = s.get("atoms", id).unwrap().expect("present");
        assert_eq!(got.len(), body.len());
    }
    let final_stats = s.hash_group_warm_stats();
    assert!(final_stats.resident_bytes <= final_stats.budget_bytes.max(warm_cap));
    assert!(final_stats.resident_groups < 400);
    // Correctness after eviction churn.
    assert_eq!(
        s.get("atoms", &written[0]).unwrap().unwrap().len(),
        body.len()
    );
    assert_eq!(
        s.get("atoms", written.last().unwrap())
            .unwrap()
            .unwrap()
            .len(),
        body.len()
    );
}

fn seg_files(dir: &Path) -> Vec<PathBuf> {
    if !dir.exists() {
        return Vec::new();
    }
    let mut files = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|s| s.to_str()) == Some("seg"))
        .collect::<Vec<_>>();
    files.sort();
    files
}
