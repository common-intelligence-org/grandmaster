// ============================================================================
// Common Intelligence — Project Grandmaster Clean-Room Search Engine
// Iterative Deepening + Principal Variation Search (PVS) + Quiescence Search
// + Transposition Table + MVV-LVA & Killer Move Ordering.
// ============================================================================

import {
  WHITE,
  moveToUci,
  type ChessBoard,
  type ChessMove,
} from './board.ts';
import { DEFAULT_WEIGHTS, evaluateBoard, type EvalWeights } from './eval.ts';

export const MATE_SCORE = 30_000;
const INF = 100_000;
const TT_SIZE = 1 << 15; // 32,768 entries (lightweight for browser & worker)
const TT_MASK = TT_SIZE - 1;

const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

interface TTEntry {
  hashLo: number;
  hashHi: number;
  depth: number;
  flag: number;
  score: number;
  bestUci: string;
}

export interface SearchOptions {
  maxDepth?: number;
  maxTimeMs?: number;
  weights?: EvalWeights;
  /** Optional slight root noise in centipawns to diversify self-play games. */
  rootNoiseCp?: number;
  rng?: () => number;
}

export interface SearchResult {
  bestMove: ChessMove | null;
  bestMoveUci: string | null;
  /** Score in centipawns from White's perspective (+ = White better, - = Black better). */
  scoreWhiteCp: number;
  /** Score in centipawns from side-to-move's perspective. */
  scoreSideCp: number;
  depth: number;
  nodes: number;
  timeMs: number;
  nps: number;
  pv: string[];
  isMate: boolean;
  mateInPlies: number | null;
}

const MVV_VICTIM = [0, 100, 320, 330, 500, 900, 10_000];

export class ChessSearcher {
  private tt: Array<TTEntry | undefined> = new Array(TT_SIZE);
  private killers: Array<[string, string]> = Array.from({ length: 64 }, () => ['', '']);
  private nodes = 0;
  private startTime = 0;
  private deadline = Number.POSITIVE_INFINITY;
  private aborted = false;
  private weights: EvalWeights = DEFAULT_WEIGHTS;

  clear(): void {
    this.tt.fill(undefined);
    for (let i = 0; i < this.killers.length; i++) {
      this.killers[i] = ['', ''];
    }
  }

  private isTimeUp(): boolean {
    if ((this.nodes & 2047) === 0 && performance.now() >= this.deadline) {
      this.aborted = true;
    }
    return this.aborted;
  }

  private scoreMove(move: ChessMove, ttBest: string, ply: number): number {
    const uci = moveToUci(move);
    if (ttBest && uci === ttBest) return 1_000_000;
    if (move.captured !== 0) {
      return 100_000 + MVV_VICTIM[move.captured]! * 10 - MVV_VICTIM[move.piece]!;
    }
    if (move.promotion !== 0) {
      return 90_000 + MVV_VICTIM[move.promotion]!;
    }
    const killerSlot = this.killers[ply];
    if (killerSlot) {
      if (uci === killerSlot[0]) return 50_000;
      if (uci === killerSlot[1]) return 40_000;
    }
    return 0;
  }

  private orderMoves(moves: ChessMove[], ttBest: string, ply: number): void {
    if (moves.length <= 1) return;
    const scored = moves.map((m) => ({ m, s: this.scoreMove(m, ttBest, ply) }));
    scored.sort((a, b) => b.s - a.s);
    for (let i = 0; i < scored.length; i++) {
      moves[i] = scored[i]!.m;
    }
  }

  private quiescence(board: ChessBoard, alpha: number, beta: number, ply: number): number {
    this.nodes++;
    if (this.isTimeUp()) return 0;

    const standPat = evaluateBoard(board, this.weights);
    if (standPat >= beta) return standPat;
    let bestScore = standPat;
    if (standPat > alpha) alpha = standPat;
    if (ply >= 24) return standPat;

    const captures = board.generateLegalMoves(true);
    this.orderMoves(captures, '', ply);

    for (let i = 0; i < captures.length; i++) {
      const m = captures[i]!;
      // Delta pruning for hopeless non-promotion captures
      if (
        m.promotion === 0 &&
        standPat + MVV_VICTIM[m.captured]! + 180 < alpha
      ) {
        continue;
      }
      const undo = board.makeMove(m, false);
      const score = -this.quiescence(board, -beta, -alpha, ply + 1);
      board.unmakeMove(undo, false);

      if (this.aborted) return 0;
      if (score > bestScore) {
        bestScore = score;
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) return bestScore;
        }
      }
    }

    return bestScore;
  }

  private negamax(
    board: ChessBoard,
    depth: number,
    alpha: number,
    beta: number,
    ply: number,
    pvLine: string[]
  ): number {
    pvLine.length = 0;
    this.nodes++;
    if (this.isTimeUp()) return 0;

    // Draw checks inside search
    if (ply > 0) {
      if (board.halfmoveClock >= 100 || board.isInsufficientMaterial()) return 0;
      if (board.repetitionCount() >= 2) return 0;
    }

    const inCheck = board.isInCheck(board.sideToMove);
    const effectiveDepth = inCheck && ply < 24 ? depth + 1 : depth;

    if (effectiveDepth <= 0) {
      return this.quiescence(board, alpha, beta, ply);
    }

    const origAlpha = alpha;
    const ttIdx = board.hashLo & TT_MASK;
    const entry = this.tt[ttIdx];
    let ttBest = '';
    if (entry && entry.hashLo === board.hashLo && entry.hashHi === board.hashHi) {
      ttBest = entry.bestUci;
      if (ply > 0 && entry.depth >= effectiveDepth) {
        let ttScore = entry.score;
        if (ttScore > MATE_SCORE - 100) ttScore -= ply;
        else if (ttScore < -MATE_SCORE + 100) ttScore += ply;

        if (entry.flag === TT_EXACT) return ttScore;
        if (entry.flag === TT_LOWER && ttScore >= beta) return ttScore;
        if (entry.flag === TT_UPPER && ttScore <= alpha) return ttScore;
      }
    }

    const moves = board.generateLegalMoves(false);
    if (moves.length === 0) {
      return inCheck ? -MATE_SCORE + ply : 0;
    }

    this.orderMoves(moves, ttBest, ply);

    let bestScore = -INF;
    let bestMoveUci = moveToUci(moves[0]!);
    const childPv: string[] = [];

    for (let i = 0; i < moves.length; i++) {
      const m = moves[i]!;
      const undo = board.makeMove(m, true);
      let score: number;

      if (i === 0) {
        score = -this.negamax(board, effectiveDepth - 1, -beta, -alpha, ply + 1, childPv);
      } else {
        // Late Move Reduction for quiet late moves
        const canReduce =
          effectiveDepth >= 3 &&
          i >= 3 &&
          !inCheck &&
          m.captured === 0 &&
          m.promotion === 0;
        const reduction = canReduce ? 1 : 0;

        score = -this.negamax(
          board,
          effectiveDepth - 1 - reduction,
          -alpha - 1,
          -alpha,
          ply + 1,
          childPv
        );
        if (score > alpha && reduction > 0 && !this.aborted) {
          score = -this.negamax(board, effectiveDepth - 1, -alpha - 1, -alpha, ply + 1, childPv);
        }
        if (score > alpha && score < beta && !this.aborted) {
          score = -this.negamax(board, effectiveDepth - 1, -beta, -alpha, ply + 1, childPv);
        }
      }

      board.unmakeMove(undo, true);
      if (this.aborted) return 0;

      if (score > bestScore) {
        bestScore = score;
        bestMoveUci = moveToUci(m);
        if (score > alpha) {
          alpha = score;
          pvLine.length = 0;
          pvLine.push(bestMoveUci, ...childPv);
        }
        if (alpha >= beta) {
          if (m.captured === 0 && m.promotion === 0 && ply < 64) {
            const slot = this.killers[ply]!;
            if (slot[0] !== bestMoveUci) {
              slot[1] = slot[0];
              slot[0] = bestMoveUci;
            }
          }
          break;
        }
      }
    }

    if (!this.aborted) {
      let storedScore = bestScore;
      if (storedScore > MATE_SCORE - 100) storedScore += ply;
      else if (storedScore < -MATE_SCORE + 100) storedScore -= ply;

      const flag =
        bestScore <= origAlpha ? TT_UPPER : bestScore >= beta ? TT_LOWER : TT_EXACT;
      this.tt[ttIdx] = {
        hashLo: board.hashLo,
        hashHi: board.hashHi,
        depth: effectiveDepth,
        flag,
        score: storedScore,
        bestUci: bestMoveUci,
      };
    }

    return bestScore;
  }

  search(board: ChessBoard, options: SearchOptions = {}): SearchResult {
    const maxDepth = Math.max(1, Math.min(8, options.maxDepth ?? 3));
    const maxTimeMs = options.maxTimeMs ?? 350;
    this.weights = options.weights ?? DEFAULT_WEIGHTS;
    this.nodes = 0;
    this.aborted = false;
    this.startTime = performance.now();
    this.deadline = this.startTime + maxTimeMs;

    const legalMoves = board.generateLegalMoves(false);
    if (legalMoves.length === 0) {
      return {
        bestMove: null,
        bestMoveUci: null,
        scoreWhiteCp: 0,
        scoreSideCp: 0,
        depth: 0,
        nodes: 0,
        timeMs: 0,
        nps: 0,
        pv: [],
        isMate: false,
        mateInPlies: null,
      };
    }

    let bestMove = legalMoves[0]!;
    let bestScore = 0;
    let completedDepth = 1;
    let bestPv: string[] = [moveToUci(bestMove)];
    const workBoard = board.clone();

    for (let depth = 1; depth <= maxDepth; depth++) {
      const pv: string[] = [];
      let iterBestMove = bestMove;
      let iterBestScore = -INF;
      let alpha = -INF;
      const beta = INF;

      this.orderMoves(legalMoves, moveToUci(bestMove), 0);

      for (let i = 0; i < legalMoves.length; i++) {
        const m = legalMoves[i]!;
        const childPv: string[] = [];
        const undo = workBoard.makeMove(m, true);
        let score: number;
        if (i === 0 || options.rootNoiseCp) {
          // Use full window for PV move (and when rootNoiseCp is enabled so scores are exact, never fail-low bounds).
          score = -this.negamax(workBoard, depth - 1, -beta, -alpha, 1, childPv);
        } else {
          score = -this.negamax(workBoard, depth - 1, -alpha - 1, -alpha, 1, childPv);
          if (score > alpha && score < beta && !this.aborted) {
            score = -this.negamax(workBoard, depth - 1, -beta, -alpha, 1, childPv);
          }
        }
        workBoard.unmakeMove(undo, true);

        if (this.aborted && depth > 1) break;

        const noise =
          options.rootNoiseCp && Math.abs(score) < MATE_SCORE - 500
            ? ((options.rng ?? Math.random)() - 0.5) * 2 * options.rootNoiseCp
            : 0;
        const rankedScore = score + noise;
        if (i === 0 || rankedScore > iterBestScore) {
          iterBestScore = rankedScore;
          iterBestMove = m;
          pv.length = 0;
          pv.push(moveToUci(m), ...childPv);
        }
        if (!options.rootNoiseCp && score > alpha) alpha = score;
      }

      if (this.aborted && depth > 1) break;

      bestMove = iterBestMove;
      bestScore = Math.round(iterBestScore);
      completedDepth = depth;
      if (pv.length > 0) bestPv = pv;
      if (Math.abs(bestScore) >= MATE_SCORE - 50) break;
    }

    const elapsed = Math.max(1, performance.now() - this.startTime);
    const scoreWhiteCp = board.sideToMove === WHITE ? bestScore : -bestScore;
    const isMate = Math.abs(bestScore) >= MATE_SCORE - 100;
    const mateInPlies = isMate ? MATE_SCORE - Math.abs(bestScore) : null;

    return {
      bestMove,
      bestMoveUci: moveToUci(bestMove),
      scoreWhiteCp,
      scoreSideCp: bestScore,
      depth: completedDepth,
      nodes: this.nodes,
      timeMs: Math.round(elapsed),
      nps: Math.round((this.nodes / elapsed) * 1000),
      pv: bestPv,
      isMate,
      mateInPlies,
    };
  }
}

export function searchBestMove(board: ChessBoard, options?: SearchOptions): SearchResult {
  const searcher = new ChessSearcher();
  return searcher.search(board, options);
}
