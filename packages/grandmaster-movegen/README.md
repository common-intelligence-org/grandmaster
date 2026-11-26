# grandmaster-movegen

Clean-room Rust chess rules core for Project Grandmaster (`TASK-GM-P1-01`).

- **Board representation:** 12 piece bitboards (`u64`, a1 = bit 0) + colour occupancy + mailbox; `Position` is `Copy` for copy-make.
- **Move generation:** pseudo-legal generation (precomputed knight/king/pawn tables, ray-based sliding attacks), legality filtered by make-and-test. Covers castling (no castling out of, through, or into check), en passant (including discovered-check / pinned cases), all four promotions, check evasion and pins.
- **FEN:** strict parser (validates rank layout, kings, pawns on back ranks, en-passant rank, side-not-to-move-in-check; drops inconsistent castling rights) and serializer.
- **Hashing:** incremental Zobrist keys (fixed-seed SplitMix64). `Position::key()` adds castling rights and the en-passant file only when an en-passant capture is pseudo-legally available.
- **Game termination:** `Game::status()` reports checkmate, stalemate, insufficient material, the 50-move rule (halfmove clock ≥ 100) and threefold repetition (window limited to positions since the last irreversible move).
- **Perft:** `perft`, `divide`, and a built-in regression suite `PERFT_SUITE` (21 positions, 44 depth/count pairs).

No code, tables or data were copied from Stockfish or any other engine. The only external data is the publicly documented Perft reference node counts.

## Usage

```sh
cd packages/grandmaster-movegen
cargo test                                  # 22 perft tests + 10 rules tests (optimized test profile)
cargo run --release --bin perft -- --suite  # JSON report: {"accepted":true,...}
cargo run --release --bin perft -- 6        # startpos perft(6) = 119060324
cargo run --release --bin perft -- --divide 3 "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"
```

## Limitations

- Legality is checked by making each pseudo-legal move and testing for check. This is simple and robust, but slower than generating legal moves directly with pin and check masks (~13–20 M nodes/s single-threaded perft on a desktop CPU).
- Sliding attacks use ray scans, not magic bitboards. Faster attack lookup is a possible follow-up task.
- Repetition keys count the en-passant file when a capture is *pseudo*-legal. FIDE requires the capture to be legal, so this can differ in rare pinned-pawn positions.
- Not wired into the TypeScript Phase 0 engine. Integration or porting is a separate task.
