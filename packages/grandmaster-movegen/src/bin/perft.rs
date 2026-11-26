//! Perft command-line tool.
//!
//! ```text
//! perft <depth> [FEN]            total leaf count + timing
//! perft --divide <depth> [FEN]   per-root-move counts
//! perft --suite [--max-nodes N]  run the built-in regression suite, print JSON
//! ```

use grandmaster_movegen::{divide, perft, Position, PERFT_SUITE, START_FEN};
use std::process::ExitCode;
use std::time::Instant;

fn usage() -> ExitCode {
    eprintln!("usage: perft [--divide] <depth> [FEN]\n       perft --suite [--max-nodes N]");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--suite") {
        let max_nodes = match args.iter().position(|a| a == "--max-nodes") {
            Some(i) => match args.get(i + 1).and_then(|s| s.parse::<u64>().ok()) {
                Some(n) => n,
                None => return usage(),
            },
            None => u64::MAX,
        };
        return run_suite(max_nodes);
    }

    let (do_divide, rest) = match args.first().map(String::as_str) {
        Some("--divide") => (true, &args[1..]),
        _ => (false, &args[..]),
    };
    let Some(depth) = rest.first().and_then(|s| s.parse::<u32>().ok()) else {
        return usage();
    };
    let fen = if rest.len() > 1 {
        rest[1..].join(" ")
    } else {
        START_FEN.to_string()
    };
    let pos = match Position::from_fen(&fen) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };

    let start = Instant::now();
    let nodes = if do_divide && depth >= 1 {
        let mut rows = divide(&pos, depth);
        rows.sort_by_key(|(m, _)| m.to_uci());
        for (m, n) in &rows {
            println!("{m}: {n}");
        }
        rows.iter().map(|(_, n)| n).sum()
    } else {
        perft(&pos, depth)
    };
    let secs = start.elapsed().as_secs_f64();
    println!("nodes {nodes}");
    println!("time {secs:.3}s nps {:.0}", nodes as f64 / secs.max(1e-9));
    ExitCode::SUCCESS
}

fn run_suite(max_nodes: u64) -> ExitCode {
    let start = Instant::now();
    let (mut passed, mut failed, mut total_nodes) = (0u32, 0u32, 0u64);
    let mut rows = Vec::new();
    for (name, fen, cases) in PERFT_SUITE {
        let pos = Position::from_fen(fen).expect("suite FEN is valid");
        for &(depth, expected) in cases.iter() {
            if expected > max_nodes {
                continue;
            }
            let got = perft(&pos, depth);
            total_nodes += got;
            let ok = got == expected;
            if ok {
                passed += 1;
            } else {
                failed += 1;
            }
            rows.push(format!(
                "    {{\"name\":\"{name}\",\"depth\":{depth},\"expected\":{expected},\"got\":{got},\"ok\":{ok}}}"
            ));
        }
    }
    let secs = start.elapsed().as_secs_f64();
    println!("{{");
    println!("  \"accepted\": {},", failed == 0);
    println!("  \"passed\": {passed},");
    println!("  \"failed\": {failed},");
    println!("  \"nodes\": {total_nodes},");
    println!("  \"seconds\": {secs:.3},");
    println!("  \"nps\": {:.0},", total_nodes as f64 / secs.max(1e-9));
    println!("  \"cases\": [\n{}\n  ]", rows.join(",\n"));
    println!("}}");
    if failed == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
