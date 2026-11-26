//! Rules, FEN, hashing and game-termination tests.

use grandmaster_movegen::*;

#[test]
fn fen_round_trip() {
    for (_, fen, _) in PERFT_SUITE {
        let pos = Position::from_fen(fen).unwrap();
        let again = Position::from_fen(&pos.to_fen()).unwrap();
        assert_eq!(pos, again, "{fen}");
    }
    assert_eq!(Position::startpos().to_fen(), START_FEN);
}

#[test]
fn fen_rejects_garbage() {
    for bad in [
        "",
        "8/8/8/8/8/8/8/8 w - - 0 1", // no kings
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1", // short rank
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1", // bad side
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e4 0 1", // bad ep rank
        "4k3/8/8/8/8/8/8/4K2r b - - 0 1", // side not to move in check
        "P3k3/8/8/8/8/8/8/4K3 w - - 0 1", // pawn on back rank
    ] {
        assert!(Position::from_fen(bad).is_err(), "accepted: {bad:?}");
    }
}

/// Incremental Zobrist keys must equal keys of freshly parsed positions, and
/// every generated move must survive a FEN round trip.
fn walk(pos: &Position, depth: u32) {
    let fresh = Position::from_fen(&pos.to_fen()).unwrap();
    assert_eq!(pos.key(), fresh.key(), "key mismatch at {}", pos.to_fen());
    assert_eq!(*pos, fresh);
    if depth == 0 {
        return;
    }
    for &m in pos.legal_moves().iter() {
        walk(&pos.make_move(m), depth - 1);
    }
}

#[test]
fn incremental_hash_matches_fresh_parse() {
    walk(&Position::startpos(), 3);
    walk(
        &Position::from_fen("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1")
            .unwrap(),
        3,
    );
    walk(
        &Position::from_fen("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1")
            .unwrap(),
        3,
    );
}

#[test]
fn uci_moves_and_special_moves() {
    let mut g = Game::new(Position::startpos());
    for m in ["e2e4", "d7d5", "e4e5", "f7f5"] {
        g.play_uci(m).unwrap();
    }
    assert_eq!(g.position().en_passant(), parse_square("f6"));
    let ep = g.play_uci("e5f6").unwrap();
    assert_eq!(ep.kind, MoveKind::EnPassant);
    assert_eq!(g.position().piece_at(parse_square("f5").unwrap()), None);
    assert!(g.play_uci("e1g1").is_err(), "not a legal move for Black");

    let pos = Position::from_fen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1").unwrap();
    let after = pos.make_move(pos.parse_uci_move("e1g1").unwrap());
    assert_eq!(after.to_fen(), "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1");
    let after = after.make_move(after.parse_uci_move("e8c8").unwrap());
    assert_eq!(after.to_fen(), "2kr3r/8/8/8/8/8/8/R4RK1 w - - 2 2");

    let pos = Position::from_fen("8/4P3/8/8/8/8/8/k3K3 w - - 0 1").unwrap();
    let promos: Vec<String> = pos
        .legal_moves()
        .iter()
        .filter(|m| m.promotion.is_some())
        .map(|m| m.to_uci())
        .collect();
    assert_eq!(promos.len(), 4);
    assert!(promos.contains(&"e7e8n".to_string()));
}

#[test]
fn checkmate_fools_mate() {
    let mut g = Game::new(Position::startpos());
    for m in ["f2f3", "e7e5", "g2g4", "d8h4"] {
        g.play_uci(m).unwrap();
    }
    assert!(g.position().in_check());
    assert_eq!(
        g.status(),
        GameStatus::Checkmate {
            winner: Color::Black
        }
    );
}

#[test]
fn stalemate() {
    let g = Game::from_fen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1").unwrap();
    assert!(!g.position().in_check());
    assert_eq!(g.status(), GameStatus::Stalemate);
}

#[test]
fn fifty_move_rule() {
    assert_eq!(
        Game::from_fen("8/8/8/8/8/8/R7/K6k w - - 99 80")
            .unwrap()
            .status(),
        GameStatus::Ongoing
    );
    assert_eq!(
        Game::from_fen("8/8/8/8/8/8/R7/K6k w - - 100 80")
            .unwrap()
            .status(),
        GameStatus::FiftyMoveRule
    );
    // Checkmate on the 100th half-move takes precedence.
    assert_eq!(
        Game::from_fen("R6k/8/6K1/8/8/8/8/8 b - - 100 80")
            .unwrap()
            .status(),
        GameStatus::Checkmate {
            winner: Color::White
        }
    );
    // Pawn moves and captures reset the clock.
    let mut g = Game::from_fen("4k3/8/8/8/8/8/4P3/4K3 w - - 57 40").unwrap();
    g.play_uci("e2e4").unwrap();
    assert_eq!(g.position().halfmove_clock(), 0);
}

#[test]
fn threefold_repetition() {
    let mut g = Game::new(Position::startpos());
    let shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
    for m in shuffle {
        g.play_uci(m).unwrap();
    }
    assert_eq!(g.repetition_count(), 2);
    assert_eq!(g.status(), GameStatus::Ongoing);
    for m in shuffle {
        g.play_uci(m).unwrap();
    }
    assert_eq!(g.repetition_count(), 3);
    assert_eq!(g.status(), GameStatus::ThreefoldRepetition);
}

#[test]
fn repetition_respects_castling_rights() {
    // Same placement, but the king walk forfeits castling rights: not a repetition.
    let mut g = Game::from_fen("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1").unwrap();
    for m in [
        "e1f1", "e8d8", "f1e1", "d8e8", "e1f1", "e8d8", "f1e1", "d8e8",
    ] {
        g.play_uci(m).unwrap();
    }
    // Initial position (with rights) seen once; rights-less version seen twice.
    assert_eq!(g.repetition_count(), 2);
}

#[test]
fn insufficient_material() {
    for (fen, expected) in [
        ("8/8/8/4k3/8/8/8/4K3 w - - 0 1", true),      // K v K
        ("8/8/8/4k3/8/8/8/4K1N1 w - - 0 1", true),    // K+N v K
        ("8/8/8/4k3/8/8/8/2B1K3 w - - 0 1", true),    // K+B v K
        ("5b2/8/8/4k3/8/8/8/2B1K3 w - - 0 1", true),  // same-coloured bishops (c1, f8: both dark)
        ("2b5/8/8/4k3/8/8/8/2B1K3 w - - 0 1", false), // c1 dark, c8 light
        ("8/8/8/4k3/8/8/8/1NN1K3 w - - 0 1", false),  // K+NN v K (mate possible with help)
        ("8/8/8/4k3/8/8/4P3/4K3 w - - 0 1", false),
    ] {
        let pos = Position::from_fen(fen).unwrap();
        assert_eq!(pos.is_insufficient_material(), expected, "{fen}");
    }
    assert_eq!(
        Game::from_fen("8/8/8/4k3/8/8/8/4K1N1 w - - 0 1")
            .unwrap()
            .status(),
        GameStatus::InsufficientMaterial
    );
}
