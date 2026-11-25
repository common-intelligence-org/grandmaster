// ============================================================================
// Common Intelligence — Project Grandmaster Clean-Room Evaluation
// Tapered Middlegame / Endgame evaluation with tunable SPSA weight vector.
// ============================================================================

import {
  BISHOP,
  KING,
  KNIGHT,
  PAWN,
  QUEEN,
  ROOK,
  WHITE,
  type ChessBoard,
} from './board.ts';

export interface EvalWeights {
  pawnMg: number;
  knightMg: number;
  bishopMg: number;
  rookMg: number;
  queenMg: number;
  pawnEg: number;
  knightEg: number;
  bishopEg: number;
  rookEg: number;
  queenEg: number;
  bishopPairBonus: number;
  passedPawnScale: number;
  kingShieldBonus: number;
  centerControlBonus: number;
  rookOpenFileBonus: number;
  tempoBonus: number;
}

export const DEFAULT_WEIGHTS: EvalWeights = {
  pawnMg: 82,
  knightMg: 337,
  bishopMg: 365,
  rookMg: 477,
  queenMg: 1025,
  pawnEg: 94,
  knightEg: 281,
  bishopEg: 297,
  rookEg: 512,
  queenEg: 936,
  bishopPairBonus: 34,
  passedPawnScale: 18,
  kingShieldBonus: 14,
  centerControlBonus: 10,
  rookOpenFileBonus: 16,
  tempoBonus: 11,
};

export function cloneWeights(w: EvalWeights): EvalWeights {
  return { ...w };
}

export interface WeightPerturbation {
  weights: EvalWeights;
  changedKeys: Array<{ key: keyof EvalWeights; delta: number }>;
}

const TUNABLE_KEYS: Array<{ key: keyof EvalWeights; step: number; min: number; max: number }> = [
  { key: 'pawnMg', step: 6, min: 65, max: 115 },
  { key: 'knightMg', step: 14, min: 280, max: 390 },
  { key: 'bishopMg', step: 14, min: 300, max: 420 },
  { key: 'rookMg', step: 16, min: 430, max: 560 },
  { key: 'queenMg', step: 24, min: 900, max: 1120 },
  { key: 'bishopPairBonus', step: 8, min: 10, max: 70 },
  { key: 'passedPawnScale', step: 6, min: 6, max: 42 },
  { key: 'kingShieldBonus', step: 5, min: 2, max: 35 },
  { key: 'centerControlBonus', step: 4, min: 2, max: 28 },
  { key: 'rookOpenFileBonus', step: 5, min: 4, max: 36 },
  { key: 'tempoBonus', step: 3, min: 4, max: 24 },
];

export function perturbWeights(
  base: EvalWeights,
  rng: () => number = Math.random
): WeightPerturbation {
  const next = cloneWeights(base);
  const changedKeys: Array<{ key: keyof EvalWeights; delta: number }> = [];
  // SPSA-style simultaneous perturbation on 3 randomly chosen evaluation terms
  const picked = new Set<number>();
  while (picked.size < 3) {
    picked.add(Math.floor(rng() * TUNABLE_KEYS.length));
  }
  for (const idx of picked) {
    const spec = TUNABLE_KEYS[idx]!;
    const sign = rng() < 0.5 ? -1 : 1;
    const raw = next[spec.key] + sign * spec.step;
    const clamped = Math.max(spec.min, Math.min(spec.max, raw));
    const delta = clamped - next[spec.key];
    next[spec.key] = clamped;
    if (delta !== 0) {
      changedKeys.push({ key: spec.key, delta });
    }
  }
  return { weights: next, changedKeys };
}

export function blendWeights(champion: EvalWeights, candidate: EvalWeights, alpha = 0.5): EvalWeights {
  const result = cloneWeights(champion);
  for (const k of Object.keys(result) as Array<keyof EvalWeights>) {
    result[k] = Math.round(champion[k] * (1 - alpha) + candidate[k] * alpha);
  }
  return result;
}

// Piece-Square Tables indexed from White's perspective with rank 0 = rank 1 (a1=0..h8=63).
// Helper flips a visual rank-8-top 64-entry table into rank-1-bottom index order.
function flipVisualTable(visual: readonly number[]): Int16Array {
  const out = new Int16Array(64);
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      out[(7 - r) * 8 + f] = visual[r * 8 + f]!;
    }
  }
  return out;
}

const PAWN_MG = flipVisualTable([
  0, 0, 0, 0, 0, 0, 0, 0,
  55, 60, 62, 68, 68, 62, 60, 55,
  18, 22, 26, 36, 36, 26, 22, 18,
  8, 12, 18, 28, 28, 18, 12, 8,
  2, 4, 10, 22, 22, 10, 4, 2,
  4, -2, -4, 4, 4, -4, -2, 4,
  4, 10, 10, -18, -18, 10, 10, 4,
  0, 0, 0, 0, 0, 0, 0, 0,
]);

const PAWN_EG = flipVisualTable([
  0, 0, 0, 0, 0, 0, 0, 0,
  90, 92, 94, 96, 96, 94, 92, 90,
  52, 54, 56, 58, 58, 56, 54, 52,
  28, 28, 30, 32, 32, 30, 28, 28,
  12, 12, 14, 16, 16, 14, 12, 12,
  4, 4, 4, 6, 6, 4, 4, 4,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
]);

const KNIGHT_MG = flipVisualTable([
  -48, -32, -22, -20, -20, -22, -32, -48,
  -32, -16, 2, 8, 8, 2, -16, -32,
  -18, 6, 18, 22, 22, 18, 6, -18,
  -16, 8, 20, 26, 26, 20, 8, -16,
  -18, 4, 16, 22, 22, 16, 4, -18,
  -22, 2, 12, 14, 14, 12, 2, -22,
  -34, -18, 0, 4, 4, 0, -18, -34,
  -48, -34, -24, -20, -20, -24, -34, -48,
]);

const KNIGHT_EG = flipVisualTable([
  -40, -28, -18, -14, -14, -18, -28, -40,
  -26, -12, 0, 4, 4, 0, -12, -26,
  -16, 2, 12, 16, 16, 12, 2, -16,
  -14, 4, 16, 20, 20, 16, 4, -14,
  -14, 4, 16, 20, 20, 16, 4, -14,
  -18, 0, 10, 14, 14, 10, 0, -18,
  -28, -14, -2, 2, 2, -2, -14, -28,
  -42, -30, -20, -16, -16, -20, -30, -42,
]);

const BISHOP_MG = flipVisualTable([
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10, 4, 0, 4, 4, 0, 4, -10,
  -10, 8, 12, 14, 14, 12, 8, -10,
  -10, 6, 14, 18, 18, 14, 6, -10,
  -10, 10, 12, 16, 16, 12, 10, -10,
  -10, 8, 10, 12, 12, 10, 8, -10,
  -10, 10, 2, 4, 4, 2, 10, -10,
  -20, -10, -12, -10, -10, -12, -10, -20,
]);

const BISHOP_EG = flipVisualTable([
  -14, -8, -6, -6, -6, -6, -8, -14,
  -8, 0, 4, 4, 4, 4, 0, -8,
  -6, 4, 10, 12, 12, 10, 4, -6,
  -6, 4, 12, 14, 14, 12, 4, -6,
  -6, 4, 12, 14, 14, 12, 4, -6,
  -6, 4, 10, 12, 12, 10, 4, -6,
  -8, 0, 4, 4, 4, 4, 0, -8,
  -14, -8, -6, -6, -6, -6, -8, -14,
]);

const ROOK_MG = flipVisualTable([
  4, 6, 8, 10, 10, 8, 6, 4,
  12, 16, 18, 20, 20, 18, 16, 12,
  -4, 0, 2, 4, 4, 2, 0, -4,
  -4, 0, 2, 4, 4, 2, 0, -4,
  -4, 0, 2, 4, 4, 2, 0, -4,
  -4, 0, 2, 4, 4, 2, 0, -4,
  -4, 0, 2, 4, 4, 2, 0, -4,
  0, 2, 6, 10, 10, 6, 2, 0,
]);

const ROOK_EG = flipVisualTable([
  10, 12, 12, 14, 14, 12, 12, 10,
  14, 16, 16, 18, 18, 16, 16, 14,
  4, 6, 6, 8, 8, 6, 6, 4,
  2, 4, 4, 6, 6, 4, 4, 2,
  0, 2, 2, 4, 4, 2, 2, 0,
  0, 0, 0, 2, 2, 0, 0, 0,
  0, 0, 0, 2, 2, 0, 0, 0,
  -2, 0, 2, 2, 2, 2, 0, -2,
]);

const QUEEN_MG = flipVisualTable([
  -20, -10, -8, -4, -4, -8, -10, -20,
  -10, 0, 4, 4, 4, 4, 0, -10,
  -8, 4, 6, 8, 8, 6, 4, -8,
  -4, 4, 8, 10, 10, 8, 4, -4,
  -4, 4, 8, 10, 10, 8, 4, -4,
  -8, 4, 6, 8, 8, 6, 4, -8,
  -10, 0, 4, 4, 4, 4, 0, -10,
  -20, -10, -8, -4, -4, -8, -10, -20,
]);

const QUEEN_EG = flipVisualTable([
  -16, -8, -6, -4, -4, -6, -8, -16,
  -8, 0, 4, 6, 6, 4, 0, -8,
  -6, 4, 10, 12, 12, 10, 4, -6,
  -4, 6, 12, 16, 16, 12, 6, -4,
  -4, 6, 12, 16, 16, 12, 6, -4,
  -6, 4, 10, 12, 12, 10, 4, -6,
  -8, 0, 4, 6, 6, 4, 0, -8,
  -16, -8, -6, -4, -4, -6, -8, -16,
]);

const KING_MG = flipVisualTable([
  -40, -45, -45, -55, -55, -45, -45, -40,
  -35, -40, -40, -50, -50, -40, -40, -35,
  -30, -35, -35, -42, -42, -35, -35, -30,
  -25, -30, -30, -36, -36, -30, -30, -25,
  -18, -22, -22, -26, -26, -22, -22, -18,
  -10, -12, -14, -16, -16, -14, -12, -10,
  14, 18, 4, -4, -4, 4, 18, 14,
  20, 30, 12, 0, 0, 10, 30, 20,
]);

const KING_EG = flipVisualTable([
  -32, -20, -14, -10, -10, -14, -20, -32,
  -18, -4, 4, 10, 10, 4, -4, -18,
  -12, 4, 18, 24, 24, 18, 4, -12,
  -10, 8, 22, 30, 30, 22, 8, -10,
  -10, 8, 22, 30, 30, 22, 8, -10,
  -14, 2, 14, 20, 20, 14, 2, -14,
  -20, -8, 2, 6, 6, 2, -8, -20,
  -36, -24, -16, -12, -12, -16, -24, -36,
]);

const PST_MG: Record<number, Int16Array> = {
  [PAWN]: PAWN_MG,
  [KNIGHT]: KNIGHT_MG,
  [BISHOP]: BISHOP_MG,
  [ROOK]: ROOK_MG,
  [QUEEN]: QUEEN_MG,
  [KING]: KING_MG,
};

const PST_EG: Record<number, Int16Array> = {
  [PAWN]: PAWN_EG,
  [KNIGHT]: KNIGHT_EG,
  [BISHOP]: BISHOP_EG,
  [ROOK]: ROOK_EG,
  [QUEEN]: QUEEN_EG,
  [KING]: KING_EG,
};

const PHASE_INC = [0, 0, 1, 1, 2, 4, 0];
const CENTER_SQUARES = new Set([27, 28, 35, 36]); // d4, e4, d5, e5

/**
 * Evaluates the board from the perspective of `board.sideToMove` in centipawns.
 */
export function evaluateBoard(board: ChessBoard, weights: EvalWeights = DEFAULT_WEIGHTS): number {
  let mgScore = 0;
  let egScore = 0;
  let phase = 0;
  let whiteBishops = 0;
  let blackBishops = 0;

  const whitePawnsPerFile = new Uint8Array(8);
  const blackPawnsPerFile = new Uint8Array(8);
  const whitePawnMaxRank = new Int8Array(8).fill(-1);
  const blackPawnMinRank = new Int8Array(8).fill(8);

  const mgVals = [0, weights.pawnMg, weights.knightMg, weights.bishopMg, weights.rookMg, weights.queenMg, 0];
  const egVals = [0, weights.pawnEg, weights.knightEg, weights.bishopEg, weights.rookEg, weights.queenEg, 0];

  for (let sq = 0; sq < 64; sq++) {
    const p = board.squares[sq]!;
    if (p === 0) continue;
    const abs = Math.abs(p);
    const rank = sq >> 3;
    const file = sq & 7;
    phase += PHASE_INC[abs]!;

    if (p > 0) {
      mgScore += mgVals[abs]! + PST_MG[abs]![sq]!;
      egScore += egVals[abs]! + PST_EG[abs]![sq]!;
      if (abs === BISHOP) whiteBishops++;
      if (abs === PAWN) {
        whitePawnsPerFile[file]!++;
        if (rank > whitePawnMaxRank[file]!) whitePawnMaxRank[file] = rank;
      }
      if (CENTER_SQUARES.has(sq)) {
        mgScore += weights.centerControlBonus;
      }
    } else {
      const mirrored = sq ^ 56;
      mgScore -= mgVals[abs]! + PST_MG[abs]![mirrored]!;
      egScore -= egVals[abs]! + PST_EG[abs]![mirrored]!;
      if (abs === BISHOP) blackBishops++;
      if (abs === PAWN) {
        blackPawnsPerFile[file]!++;
        if (rank < blackPawnMinRank[file]!) blackPawnMinRank[file] = rank;
      }
      if (CENTER_SQUARES.has(sq)) {
        mgScore -= weights.centerControlBonus;
      }
    }
  }

  // Bishop pair bonus
  if (whiteBishops >= 2) {
    mgScore += weights.bishopPairBonus;
    egScore += weights.bishopPairBonus + 8;
  }
  if (blackBishops >= 2) {
    mgScore -= weights.bishopPairBonus;
    egScore -= weights.bishopPairBonus + 8;
  }

  // Passed pawns & doubled pawn penalty
  for (let file = 0; file < 8; file++) {
    if (whitePawnsPerFile[file]! > 1) {
      mgScore -= 12 * (whitePawnsPerFile[file]! - 1);
      egScore -= 16 * (whitePawnsPerFile[file]! - 1);
    }
    if (blackPawnsPerFile[file]! > 1) {
      mgScore += 12 * (blackPawnsPerFile[file]! - 1);
      egScore += 16 * (blackPawnsPerFile[file]! - 1);
    }

    const wpRank = whitePawnMaxRank[file]!;
    if (wpRank >= 1) {
      let blocked = false;
      for (let df = -1; df <= 1; df++) {
        const f = file + df;
        if (f >= 0 && f <= 7 && blackPawnMinRank[f]! < 8 && blackPawnMinRank[f]! > wpRank) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        const bonus = (wpRank - 1) * weights.passedPawnScale;
        mgScore += Math.round(bonus * 0.5);
        egScore += bonus;
      }
    }

    const bpRank = blackPawnMinRank[file]!;
    if (bpRank <= 6) {
      let blocked = false;
      for (let df = -1; df <= 1; df++) {
        const f = file + df;
        if (f >= 0 && f <= 7 && whitePawnMaxRank[f]! >= 0 && whitePawnMaxRank[f]! < bpRank) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        const bonus = (6 - bpRank) * weights.passedPawnScale;
        mgScore -= Math.round(bonus * 0.5);
        egScore -= bonus;
      }
    }
  }

  // Rook open/semi-open file bonus
  for (let sq = 0; sq < 64; sq++) {
    const p = board.squares[sq]!;
    if (p === ROOK) {
      const file = sq & 7;
      if (whitePawnsPerFile[file] === 0) {
        mgScore += blackPawnsPerFile[file] === 0 ? weights.rookOpenFileBonus : Math.round(weights.rookOpenFileBonus * 0.5);
      }
    } else if (p === -ROOK) {
      const file = sq & 7;
      if (blackPawnsPerFile[file] === 0) {
        mgScore -= whitePawnsPerFile[file] === 0 ? weights.rookOpenFileBonus : Math.round(weights.rookOpenFileBonus * 0.5);
      }
    }
  }

  // Simple king pawn-shield in middlegame
  if (board.whiteKingSq >= 0 && (board.whiteKingSq >> 3) === 0) {
    const kf = board.whiteKingSq & 7;
    if (kf >= 5 || kf <= 2) {
      for (let df = -1; df <= 1; df++) {
        const f = kf + df;
        if (f >= 0 && f <= 7 && board.squares[8 + f] === PAWN) {
          mgScore += weights.kingShieldBonus;
        }
      }
    }
  }
  if (board.blackKingSq >= 0 && (board.blackKingSq >> 3) === 7) {
    const kf = board.blackKingSq & 7;
    if (kf >= 5 || kf <= 2) {
      for (let df = -1; df <= 1; df++) {
        const f = kf + df;
        if (f >= 0 && f <= 7 && board.squares[48 + f] === -PAWN) {
          mgScore -= weights.kingShieldBonus;
        }
      }
    }
  }

  const mgPhase = Math.min(24, phase);
  const egPhase = 24 - mgPhase;
  const whiteScore = Math.round((mgScore * mgPhase + egScore * egPhase) / 24);
  return (board.sideToMove === WHITE ? whiteScore : -whiteScore) + weights.tempoBonus;
}
