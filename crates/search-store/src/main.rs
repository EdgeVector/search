//! CLI for LastStore-backed Search index (apply / query / rebuild / status).

use search_store::{
    laststore_path_for_home, IndexChangeBatch, SearchLastStoreIndex, SliceRebuildSource,
};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

fn usage() -> ExitCode {
    eprintln!(
        "usage:
  search-store apply --store DIR --file batch.json
  search-store query --store DIR <text> [--k N] [--schema S]... [--json]
  search-store rebuild --store DIR --batches-dir DIR [--page-size N]
  search-store status --store DIR [--json]
  search-store apply --last-db-home HOME --file batch.json
  (store defaults to HOME/apps/search/laststore when --last-db-home is set)
"
    );
    ExitCode::from(2)
}

fn resolve_store(args: &Args) -> Result<PathBuf, String> {
    if let Some(s) = &args.store {
        return Ok(PathBuf::from(s));
    }
    if let Some(h) = &args.last_db_home {
        return Ok(laststore_path_for_home(h));
    }
    Err("need --store or --last-db-home".into())
}

#[derive(Default)]
struct Args {
    cmd: String,
    store: Option<String>,
    last_db_home: Option<String>,
    file: Option<String>,
    batches_dir: Option<String>,
    query: String,
    k: usize,
    schemas: Vec<String>,
    json: bool,
    page_size: usize,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        k: 20,
        page_size: 32,
        ..Args::default()
    };
    let mut it = env::args().skip(1);
    a.cmd = it.next().ok_or_else(|| "missing command".to_string())?;
    let mut positionals = Vec::new();
    while let Some(x) = it.next() {
        match x.as_str() {
            "--store" => a.store = Some(it.next().ok_or("--store needs value")?),
            "--last-db-home" | "--data-dir" => {
                a.last_db_home = Some(it.next().ok_or("--last-db-home needs value")?)
            }
            "--file" => a.file = Some(it.next().ok_or("--file needs value")?),
            "--batches-dir" => a.batches_dir = Some(it.next().ok_or("--batches-dir needs value")?),
            "--k" => {
                a.k = it
                    .next()
                    .ok_or("--k needs value")?
                    .parse()
                    .map_err(|_| "bad --k")?
            }
            "--page-size" => {
                a.page_size = it
                    .next()
                    .ok_or("--page-size needs value")?
                    .parse()
                    .map_err(|_| "bad --page-size")?
            }
            "--schema" => a.schemas.push(it.next().ok_or("--schema needs value")?),
            "--json" => a.json = true,
            _ if x.starts_with('-') => return Err(format!("unknown flag {x}")),
            _ => positionals.push(x),
        }
    }
    if a.cmd == "query" {
        a.query = positionals.join(" ");
    }
    Ok(a)
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return usage();
        }
    };
    let store_path = match resolve_store(&args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            return usage();
        }
    };

    let run = || -> Result<(), String> {
        match args.cmd.as_str() {
            "apply" => {
                let file = args.file.as_ref().ok_or("apply needs --file")?;
                let raw = fs::read_to_string(file).map_err(|e| e.to_string())?;
                let batch: IndexChangeBatch =
                    serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                let idx = SearchLastStoreIndex::open(&store_path).map_err(|e| e.to_string())?;
                let n = idx.apply_change_batch(&batch).map_err(|e| e.to_string())?;
                println!(
                    "{}",
                    serde_json::json!({ "ok": true, "applied": n, "docs": idx.doc_count().unwrap_or(0), "store": store_path })
                );
            }
            "query" => {
                if args.query.trim().is_empty() {
                    return Err("query needs text".into());
                }
                let idx = SearchLastStoreIndex::open(&store_path).map_err(|e| e.to_string())?;
                let schemas = if args.schemas.is_empty() {
                    None
                } else {
                    Some(args.schemas.as_slice())
                };
                let hits = idx
                    .search(&args.query, args.k, schemas)
                    .map_err(|e| e.to_string())?;
                if args.json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "query": args.query,
                            "hits": hits,
                            "docs": idx.doc_count().unwrap_or(0),
                            "store": store_path,
                            "backend": "laststore",
                        })
                    );
                } else {
                    println!("# {} hit(s)", hits.len());
                    for h in hits {
                        println!(
                            "{:.3}\t{}\t{}\t{}",
                            h.score,
                            h.schema_name,
                            h.key_hash.unwrap_or_default(),
                            h.text.replace('\n', " ")
                        );
                    }
                }
            }
            "rebuild" => {
                let dir = args
                    .batches_dir
                    .as_ref()
                    .ok_or("rebuild needs --batches-dir")?;
                let mut files: Vec<_> = fs::read_dir(dir)
                    .map_err(|e| e.to_string())?
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
                    .collect();
                files.sort();
                let mut batches = Vec::new();
                for f in files {
                    let raw = fs::read_to_string(&f).map_err(|e| e.to_string())?;
                    let b: IndexChangeBatch =
                        serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                    batches.push(b);
                }
                let idx = SearchLastStoreIndex::open(&store_path).map_err(|e| e.to_string())?;
                let mut src = SliceRebuildSource::new(batches);
                let report = idx
                    .rebuild_paged(&mut src, args.page_size.max(1), true)
                    .map_err(|e| e.to_string())?;
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "backend": "laststore",
                        "store": store_path,
                        "batches": report.batches,
                        "changes": report.changes,
                        "docs": report.docs,
                    })
                );
            }
            "status" => {
                let idx = SearchLastStoreIndex::open(&store_path).map_err(|e| e.to_string())?;
                let body = serde_json::json!({
                    "backend": "laststore",
                    "store": store_path,
                    "docs": idx.doc_count().unwrap_or(0),
                });
                println!("{body}");
            }
            _ => return Err(format!("unknown command {}", args.cmd)),
        }
        Ok(())
    };

    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("search-store: {e}");
            ExitCode::from(1)
        }
    }
}
