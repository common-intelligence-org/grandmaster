// ============================================================================
// Common Intelligence — Project Grandmaster Standard UCI Protocol Handler
// ============================================================================

import { ChessBoard, START_FEN, perft } from './board.ts';
import { DEFAULT_WEIGHTS, type EvalWeights } from './eval.ts';
import { ChessSearcher } from './search.ts';

export interface UciHandler {
  handleLine(line: string): string[];
}

const BENCH_FENS = [
  START_FEN,
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  'r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1',
];

export function createUciHandler(weights: EvalWeights = DEFAULT_WEIGHTS): UciHandler {
  const board = new ChessBoard(START_FEN);
  const searcher = new ChessSearcher();

  return {
    handleLine(rawLine: string): string[] {
      const line = rawLine.trim();
      if (!line) return [];
      const tokens = line.split(/\s+/);
      const cmd = tokens[0]!;

      if (cmd === 'uci') {
        return [
          'id name Grandmaster-CI 0.1.0',
          'id author Common Intelligence Collective',
          'uciok',
        ];
      }

      if (cmd === 'isready') {
        return ['readyok'];
      }

      if (cmd === 'ucinewgame') {
        board.loadFen(START_FEN);
        searcher.clear();
        return [];
      }

      if (cmd === 'position') {
        let idx = 1;
        if (tokens[idx] === 'startpos') {
          board.loadFen(START_FEN);
          idx++;
        } else if (tokens[idx] === 'fen') {
          idx++;
          const fenParts: string[] = [];
          while (idx < tokens.length && tokens[idx] !== 'moves') {
            fenParts.push(tokens[idx]!);
            idx++;
          }
          board.loadFen(fenParts.join(' '));
        }

        if (tokens[idx] === 'moves') {
          idx++;
          while (idx < tokens.length) {
            const m = board.findMoveByUci(tokens[idx]!);
            if (!m) break;
            board.makeMove(m, true);
            idx++;
          }
        }
        return [];
      }

      if (cmd === 'go') {
        let maxDepth = 4;
        let maxTimeMs = 400;
        for (let i = 1; i < tokens.length; i++) {
          if (tokens[i] === 'depth' && tokens[i + 1]) {
            maxDepth = Number.parseInt(tokens[i + 1]!, 10) || 4;
            maxTimeMs = 15_000;
          } else if (tokens[i] === 'movetime' && tokens[i + 1]) {
            maxTimeMs = Number.parseInt(tokens[i + 1]!, 10) || 400;
            maxDepth = 6;
          }
        }
        const res = searcher.search(board, { maxDepth, maxTimeMs, weights });
        const scorePart = res.isMate && res.mateInPlies !== null
          ? `mate ${res.scoreSideCp > 0 ? Math.ceil(res.mateInPlies / 2) : -Math.ceil(res.mateInPlies / 2)}`
          : `cp ${res.scoreSideCp}`;
        return [
          `info depth ${res.depth} score ${scorePart} nodes ${res.nodes} nps ${res.nps} time ${res.timeMs} pv ${res.pv.join(' ')}`,
          `bestmove ${res.bestMoveUci ?? '0000'}`,
        ];
      }

      if (cmd === 'perft') {
        const depth = Number.parseInt(tokens[1] ?? '3', 10) || 3;
        const nodes = perft(board, depth);
        return [`perft ${depth}: ${nodes}`];
      }

      if (cmd === 'bench') {
        const depth = Number.parseInt(tokens[1] ?? '3', 10) || 3;
        const start = performance.now();
        let totalNodes = 0;
        for (const fen of BENCH_FENS) {
          const b = new ChessBoard(fen);
          searcher.clear();
          totalNodes += searcher.search(b, { maxDepth: depth, maxTimeMs: 10_000, weights }).nodes;
        }
        const ms = Math.max(1, Math.round(performance.now() - start));
        return [`bench depth ${depth}: ${totalNodes} nodes in ${ms}ms (${Math.round((totalNodes / ms) * 1000)} nps)`];
      }

      return [];
    },
  };
}
