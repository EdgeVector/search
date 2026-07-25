//! Id-walk primitives (keys-only, paged, range) for Mini-style navigation.

use laststore::LastStore;
use tempfile::TempDir;

fn seed(s: &LastStore) {
    for id in [
        "a", "ab", "b", "ba", "c", "note:1:t", "note:1:b", "note:2:t",
    ] {
        s.put("c", id, id.as_bytes()).unwrap();
    }
    s.flush().unwrap();
}

#[test]
fn list_prefix_keys_no_body_and_sorted() {
    let dir = TempDir::new().unwrap();
    let s = LastStore::open(dir.path()).unwrap();
    seed(&s);
    let keys = s.list_prefix_keys("c", "note:").unwrap();
    assert_eq!(keys, vec!["note:1:b", "note:1:t", "note:2:t"]);
}

#[test]
fn list_prefix_paged_and_cursor() {
    let dir = TempDir::new().unwrap();
    let s = LastStore::open(dir.path()).unwrap();
    seed(&s);
    let page1 = s.list_prefix_keys_paged("c", "", None, 3).unwrap();
    assert_eq!(page1, vec!["a", "ab", "b"]);
    let page2 = s
        .list_prefix_keys_paged("c", "", Some(page1.last().unwrap()), 3)
        .unwrap();
    assert_eq!(page2, vec!["ba", "c", "note:1:b"]);
    let page3 = s
        .list_prefix_keys_paged("c", "", Some(page2.last().unwrap()), 10)
        .unwrap();
    assert_eq!(page3, vec!["note:1:t", "note:2:t"]);
}

#[test]
fn list_range_half_open() {
    let dir = TempDir::new().unwrap();
    let s = LastStore::open(dir.path()).unwrap();
    seed(&s);
    let rows = s.list_range("c", "ab", "c").unwrap();
    let ids: Vec<_> = rows.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(ids, vec!["ab", "b", "ba"]);
    assert!(s.list_range("c", "c", "ab").unwrap().is_empty());
}

#[test]
fn list_range_paged() {
    let dir = TempDir::new().unwrap();
    let s = LastStore::open(dir.path()).unwrap();
    seed(&s);
    let keys = s.list_range_keys_paged("c", "a", "note:2:t", 2).unwrap();
    assert_eq!(keys, vec!["a", "ab"]);
}

#[test]
fn exists() {
    let dir = TempDir::new().unwrap();
    let s = LastStore::open(dir.path()).unwrap();
    s.put("c", "x", b"1").unwrap();
    assert!(s.exists("c", "x").unwrap());
    assert!(!s.exists("c", "y").unwrap());
}

#[test]
fn multi_shard_prefix_merge() {
    use laststore::LastStoreOptions;
    let dir = TempDir::new().unwrap();
    let s = LastStore::open_with(
        dir.path(),
        LastStoreOptions {
            shard_bits: 2,
            ..Default::default()
        },
    )
    .unwrap();
    for i in 0..20 {
        let id = format!("k{i:02}");
        s.put("c", &id, id.as_bytes()).unwrap();
    }
    s.flush().unwrap();
    let keys = s.list_prefix_keys("c", "k").unwrap();
    assert_eq!(keys.len(), 20);
    assert!(keys.windows(2).all(|w| w[0] < w[1]));
}
