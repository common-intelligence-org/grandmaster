//! Perft regression suite: exact node counts for standard test positions.

use grandmaster_movegen::{perft, Position, PERFT_SUITE};

fn run(name: &str) {
    let (_, fen, cases) = PERFT_SUITE
        .iter()
        .find(|(n, _, _)| *n == name)
        .expect("case exists");
    let pos = Position::from_fen(fen).unwrap();
    for &(depth, expected) in cases.iter() {
        assert_eq!(
            perft(&pos, depth),
            expected,
            "{name} perft({depth}) [{fen}]"
        );
    }
}

macro_rules! perft_tests {
    ($($test:ident => $name:literal),* $(,)?) => {
        $( #[test] fn $test() { run($name); } )*
    };
}

perft_tests! {
    startpos => "startpos",
    kiwipete => "kiwipete",
    position3_ep_pins => "position3-ep-pins",
    position4_promotions => "position4-promotions",
    position4_mirrored => "position4-mirrored",
    position5 => "position5",
    position6 => "position6",
    illegal_ep_1 => "illegal-ep-1",
    illegal_ep_2 => "illegal-ep-2",
    ep_gives_check => "ep-gives-check",
    short_castle_check => "short-castle-check",
    long_castle_check => "long-castle-check",
    castle_rights => "castle-rights",
    castle_prevented => "castle-prevented",
    promote_out_of_check => "promote-out-of-check",
    discovered_check => "discovered-check",
    promote_gives_check => "promote-gives-check",
    underpromote_check => "underpromote-check",
    self_stalemate => "self-stalemate",
    stalemate_checkmate_1 => "stalemate-checkmate-1",
    stalemate_checkmate_2 => "stalemate-checkmate-2",
}

#[test]
fn every_suite_case_is_covered() {
    // Guard against adding a suite entry without a test above.
    assert_eq!(PERFT_SUITE.len(), 21);
}
