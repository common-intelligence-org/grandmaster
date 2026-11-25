import { describe, expect, it } from 'vitest';
import {
  ChessBoard,
  ChessTrainingSession,
  START_FEN,
  createUciHandler,
  perft,
  searchBestMove,
} from './index.ts';

describe('@common-intelligence/grandmaster-engine', () => {
  it('matches exact standard Perft node counts on startpos (depth 1..4)', () => {
    const board = new ChessBoard(START_FEN);
    expect(perft(board, 1)).toBe(20);
    expect(perft(board, 2)).toBe(400);
    expect(perft(board, 3)).toBe(8902);
    expect(perft(board, 4)).toBe(197281);
    expect(board.toFen()).toBe(START_FEN);
  });

  it('matches exact Perft node counts on Kiwipete (castling, promotions, en passant)', () => {
    const kiwipete = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
    const board = new ChessBoard(kiwipete);
    expect(perft(board, 1)).toBe(48);
    expect(perft(board, 2)).toBe(2039);
    expect(perft(board, 3)).toBe(97862);
    expect(board.toFen()).toBe(kiwipete);
  });

  it('handles en-passant pin legality and promotion edge cases accurately', () => {
    // Position 3 from Chess Programming Wiki Perft results
    const pos3 = '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1';
    const board = new ChessBoard(pos3);
    expect(perft(board, 1)).toBe(14);
    expect(perft(board, 2)).toBe(191);
    expect(perft(board, 3)).toBe(2812);
  });

  it('finds forced mate-in-1 and winning tactical captures in search', () => {
    // White Queen on h5, Bishop on c4: Qxf7#
    const mateIn1 = new ChessBoard('r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
    const res = searchBestMove(mateIn1, { maxDepth: 2, maxTimeMs: 500 });
    expect(res.bestMoveUci).toBe('h5f7');
    expect(res.isMate).toBe(true);

    // Hanging Black queen on d5 capturable by White pawn on e4 (leaves White up a passed pawn, winning endgame)
    const hangingQueen = new ChessBoard('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1');
    const capRes = searchBestMove(hangingQueen, { maxDepth: 2, maxTimeMs: 500 });
    expect(capRes.bestMoveUci).toBe('e4d5');
    expect(capRes.scoreWhiteCp).toBeGreaterThan(100);
  });

  it('runs a real self-play training session with move telemetry and game completion', () => {
    const session = new ChessTrainingSession({ seed: 42, depth: 2 });
    session.maxPliesPerGame = 12; // Fast completion test
    let snap = session.getSnapshot();
    expect(snap.gameNumber).toBe(1);

    for (let i = 0; i < 14; i++) {
      snap = session.stepMove();
    }

    expect(snap.gameNumber).toBeGreaterThanOrEqual(2);
    expect(snap.totalNodes).toBeGreaterThan(100);
    expect(snap.eloHistory.length).toBeGreaterThanOrEqual(2);
    expect(snap.recentGames.length).toBeGreaterThanOrEqual(1);
  });

  it('handles standard UCI protocol commands end-to-end', () => {
    const uci = createUciHandler();
    expect(uci.handleLine('uci')).toContain('uciok');
    expect(uci.handleLine('isready')).toEqual(['readyok']);
    uci.handleLine('position startpos moves e2e4 e7e5');
    const goOut = uci.handleLine('go depth 2');
    expect(goOut.some((l) => l.startsWith('info depth 2'))).toBe(true);
    expect(goOut.some((l) => /^bestmove [a-h][1-8][a-h][1-8]/.test(l))).toBe(true);
    const perftOut = uci.handleLine('perft 2');
    expect(perftOut[0]).toBe('perft 2: 835');
  });
});
