// ============================================================================
// Common Intelligence — Project Grandmaster Clean-Room Chess Engine
// Module: Board representation, FEN parser/serializer, Zobrist hashing,
//         strictly legal move generator, SAN/UCI formatting, and Perft.
// Clean-room implementation written from first principles.
// ============================================================================

export const WHITE = 1 as const;
export const BLACK = -1 as const;
export type Color = typeof WHITE | typeof BLACK;

export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const CASTLE_WK = 1;
export const CASTLE_WQ = 2;
export const CASTLE_BK = 4;
export const CASTLE_BQ = 8;

export const FLAG_NONE = 0;
export const FLAG_EN_PASSANT = 1;
export const FLAG_CASTLE = 2;
export const FLAG_DOUBLE_PAWN = 4;

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface ChessMove {
  from: number;
  to: number;
  piece: number; // positive piece type 1..6
  captured: number; // positive piece type 0..6
  promotion: number; // 0 or 2..5 (N, B, R, Q)
  flags: number;
}

export interface UndoState {
  move: ChessMove;
  castling: number;
  enPassant: number;
  halfmoveClock: number;
  fullmoveNumber: number;
  hashLo: number;
  hashHi: number;
  capturedSquare: number;
}

export type GameOutcome =
  | { status: 'playing' }
  | { status: 'checkmate'; winner: Color }
  | { status: 'stalemate' }
  | { status: 'draw_50move' }
  | { status: 'draw_repetition' }
  | { status: 'draw_insufficient' };

// Deterministic PRNG (xorshift32) for Zobrist keys
function makeZobristTables() {
  let seed = 0x2f6e2b1;
  const nextU32 = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  // 12 piece indices (0..5 white P..K, 6..11 black P..K) x 64 squares
  const pieceLo = new Uint32Array(12 * 64);
  const pieceHi = new Uint32Array(12 * 64);
  for (let i = 0; i < 12 * 64; i++) {
    pieceLo[i] = nextU32();
    pieceHi[i] = nextU32();
  }
  const sideLo = nextU32();
  const sideHi = nextU32();
  const castleLo = new Uint32Array(16);
  const castleHi = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    castleLo[i] = nextU32();
    castleHi[i] = nextU32();
  }
  const epLo = new Uint32Array(8);
  const epHi = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    epLo[i] = nextU32();
    epHi[i] = nextU32();
  }
  return { pieceLo, pieceHi, sideLo, sideHi, castleLo, castleHi, epLo, epHi };
}

export const ZOBRIST = makeZobristTables();

function pieceZobristIndex(signedPiece: number): number {
  return signedPiece > 0 ? signedPiece - 1 : 6 + (-signedPiece - 1);
}

const CASTLING_MASK = new Uint8Array(64).fill(15);
CASTLING_MASK[0] = 15 & ~CASTLE_WQ; // a1
CASTLING_MASK[4] = 15 & ~(CASTLE_WK | CASTLE_WQ); // e1
CASTLING_MASK[7] = 15 & ~CASTLE_WK; // h1
CASTLING_MASK[56] = 15 & ~CASTLE_BQ; // a8
CASTLING_MASK[60] = 15 & ~(CASTLE_BK | CASTLE_BQ); // e8
CASTLING_MASK[63] = 15 & ~CASTLE_BK; // h8

const KNIGHT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2],
  [1, -2], [1, 2], [2, -1], [2, 1],
];

const KING_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

const BISHOP_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 1], [1, -1], [1, 1],
];

const ROOK_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
];

const PIECE_CHARS: Record<number, string> = {
  [PAWN]: 'P',
  [KNIGHT]: 'N',
  [BISHOP]: 'B',
  [ROOK]: 'R',
  [QUEEN]: 'Q',
  [KING]: 'K',
  [-PAWN]: 'p',
  [-KNIGHT]: 'n',
  [-BISHOP]: 'b',
  [-ROOK]: 'r',
  [-QUEEN]: 'q',
  [-KING]: 'k',
};

const CHAR_TO_PIECE: Record<string, number> = {
  P: PAWN, N: KNIGHT, B: BISHOP, R: ROOK, Q: QUEEN, K: KING,
  p: -PAWN, n: -KNIGHT, b: -BISHOP, r: -ROOK, q: -QUEEN, k: -KING,
};

export function squareToAlgebraic(sq: number): string {
  const file = sq & 7;
  const rank = sq >> 3;
  return String.fromCharCode(97 + file) + String(rank + 1);
}

export function algebraicToSquare(name: string): number {
  if (name.length !== 2) return -1;
  const file = name.charCodeAt(0) - 97;
  const rank = name.charCodeAt(1) - 49;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
  return rank * 8 + file;
}

export function moveToUci(move: ChessMove): string {
  const promo =
    move.promotion === QUEEN
      ? 'q'
      : move.promotion === ROOK
        ? 'r'
        : move.promotion === BISHOP
          ? 'b'
          : move.promotion === KNIGHT
            ? 'n'
            : '';
  return squareToAlgebraic(move.from) + squareToAlgebraic(move.to) + promo;
}

export class ChessBoard {
  /** 0 = empty, +1..+6 = White P..K, -1..-6 = Black p..k. Index = rank*8 + file (a1=0, h8=63). */
  readonly squares = new Int8Array(64);
  sideToMove: Color = WHITE;
  castling = CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ;
  enPassant = -1;
  halfmoveClock = 0;
  fullmoveNumber = 1;
  whiteKingSq = 4;
  blackKingSq = 60;
  hashLo = 0;
  hashHi = 0;
  readonly hashHistory: string[] = [];

  constructor(fen: string = START_FEN) {
    this.loadFen(fen);
  }

  clone(): ChessBoard {
    const copy = new ChessBoard(START_FEN);
    copy.squares.set(this.squares);
    copy.sideToMove = this.sideToMove;
    copy.castling = this.castling;
    copy.enPassant = this.enPassant;
    copy.halfmoveClock = this.halfmoveClock;
    copy.fullmoveNumber = this.fullmoveNumber;
    copy.whiteKingSq = this.whiteKingSq;
    copy.blackKingSq = this.blackKingSq;
    copy.hashLo = this.hashLo;
    copy.hashHi = this.hashHi;
    copy.hashHistory.length = 0;
    for (const h of this.hashHistory) copy.hashHistory.push(h);
    return copy;
  }

  hashKey(): string {
    return `${this.hashLo >>> 0}:${this.hashHi >>> 0}`;
  }

  loadFen(fen: string): void {
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 4) throw new Error(`Invalid FEN: ${fen}`);
    const placement = parts[0]!;
    const sideStr = parts[1]!;
    const castleStr = parts[2]!;
    const epStr = parts[3]!;
    const halfStr = parts[4] ?? '0';
    const fullStr = parts[5] ?? '1';

    this.squares.fill(0);
    this.whiteKingSq = -1;
    this.blackKingSq = -1;

    const ranks = placement.split('/');
    if (ranks.length !== 8) throw new Error(`Invalid FEN board: ${fen}`);
    for (let r = 0; r < 8; r++) {
      const rank = 7 - r;
      let file = 0;
      for (const ch of ranks[r]!) {
        if (ch >= '1' && ch <= '8') {
          file += Number(ch);
        } else {
          const piece = CHAR_TO_PIECE[ch];
          if (piece === undefined) throw new Error(`Unknown FEN piece '${ch}'`);
          const sq = rank * 8 + file;
          this.squares[sq] = piece;
          if (piece === KING) this.whiteKingSq = sq;
          if (piece === -KING) this.blackKingSq = sq;
          file++;
        }
      }
      if (file !== 8) throw new Error(`Invalid FEN rank length in ${fen}`);
    }

    this.sideToMove = sideStr === 'b' ? BLACK : WHITE;
    this.castling = 0;
    if (castleStr !== '-') {
      if (castleStr.includes('K')) this.castling |= CASTLE_WK;
      if (castleStr.includes('Q')) this.castling |= CASTLE_WQ;
      if (castleStr.includes('k')) this.castling |= CASTLE_BK;
      if (castleStr.includes('q')) this.castling |= CASTLE_BQ;
    }
    this.enPassant = epStr === '-' ? -1 : algebraicToSquare(epStr);
    this.halfmoveClock = Number.parseInt(halfStr, 10) || 0;
    this.fullmoveNumber = Number.parseInt(fullStr, 10) || 1;
    this.recomputeHash();
    this.hashHistory.length = 0;
    this.hashHistory.push(this.hashKey());
  }

  toFen(): string {
    const rankStrs: string[] = [];
    for (let rank = 7; rank >= 0; rank--) {
      let row = '';
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.squares[rank * 8 + file]!;
        if (p === 0) {
          empty++;
        } else {
          if (empty > 0) {
            row += String(empty);
            empty = 0;
          }
          row += PIECE_CHARS[p]!;
        }
      }
      if (empty > 0) row += String(empty);
      rankStrs.push(row);
    }
    let castleStr = '';
    if (this.castling & CASTLE_WK) castleStr += 'K';
    if (this.castling & CASTLE_WQ) castleStr += 'Q';
    if (this.castling & CASTLE_BK) castleStr += 'k';
    if (this.castling & CASTLE_BQ) castleStr += 'q';
    if (!castleStr) castleStr = '-';

    const epStr = this.enPassant === -1 ? '-' : squareToAlgebraic(this.enPassant);
    const sideStr = this.sideToMove === WHITE ? 'w' : 'b';
    return `${rankStrs.join('/')} ${sideStr} ${castleStr} ${epStr} ${this.halfmoveClock} ${this.fullmoveNumber}`;
  }

  private recomputeHash(): void {
    let lo = 0;
    let hi = 0;
    for (let sq = 0; sq < 64; sq++) {
      const p = this.squares[sq]!;
      if (p !== 0) {
        const idx = pieceZobristIndex(p) * 64 + sq;
        lo ^= ZOBRIST.pieceLo[idx]!;
        hi ^= ZOBRIST.pieceHi[idx]!;
      }
    }
    if (this.sideToMove === BLACK) {
      lo ^= ZOBRIST.sideLo;
      hi ^= ZOBRIST.sideHi;
    }
    lo ^= ZOBRIST.castleLo[this.castling]!;
    hi ^= ZOBRIST.castleHi[this.castling]!;
    if (this.enPassant !== -1) {
      const file = this.enPassant & 7;
      lo ^= ZOBRIST.epLo[file]!;
      hi ^= ZOBRIST.epHi[file]!;
    }
    this.hashLo = lo >>> 0;
    this.hashHi = hi >>> 0;
  }

  isSquareAttacked(sq: number, bySide: Color): boolean {
    const rank = sq >> 3;
    const file = sq & 7;

    // 1. Pawn attacks
    const pawnRank = rank - bySide;
    if (pawnRank >= 0 && pawnRank <= 7) {
      const targetPawn = bySide * PAWN;
      if (file > 0 && this.squares[pawnRank * 8 + file - 1] === targetPawn) return true;
      if (file < 7 && this.squares[pawnRank * 8 + file + 1] === targetPawn) return true;
    }

    // 2. Knight attacks
    const targetKnight = bySide * KNIGHT;
    for (let i = 0; i < 8; i++) {
      const [dr, df] = KNIGHT_OFFSETS[i]!;
      const nr = rank + dr;
      const nf = file + df;
      if (nr >= 0 && nr <= 7 && nf >= 0 && nf <= 7) {
        if (this.squares[nr * 8 + nf] === targetKnight) return true;
      }
    }

    // 3. King attacks
    const targetKing = bySide * KING;
    for (let i = 0; i < 8; i++) {
      const [dr, df] = KING_OFFSETS[i]!;
      const nr = rank + dr;
      const nf = file + df;
      if (nr >= 0 && nr <= 7 && nf >= 0 && nf <= 7) {
        if (this.squares[nr * 8 + nf] === targetKing) return true;
      }
    }

    // 4. Diagonal sliders (Bishop / Queen)
    const targetBishop = bySide * BISHOP;
    const targetQueen = bySide * QUEEN;
    for (let d = 0; d < 4; d++) {
      const [dr, df] = BISHOP_DIRS[d]!;
      let nr = rank + dr;
      let nf = file + df;
      while (nr >= 0 && nr <= 7 && nf >= 0 && nf <= 7) {
        const p = this.squares[nr * 8 + nf]!;
        if (p !== 0) {
          if (p === targetBishop || p === targetQueen) return true;
          break;
        }
        nr += dr;
        nf += df;
      }
    }

    // 5. Orthogonal sliders (Rook / Queen)
    const targetRook = bySide * ROOK;
    for (let d = 0; d < 4; d++) {
      const [dr, df] = ROOK_DIRS[d]!;
      let nr = rank + dr;
      let nf = file + df;
      while (nr >= 0 && nr <= 7 && nf >= 0 && nf <= 7) {
        const p = this.squares[nr * 8 + nf]!;
        if (p !== 0) {
          if (p === targetRook || p === targetQueen) return true;
          break;
        }
        nr += dr;
        nf += df;
      }
    }

    return false;
  }

  isInCheck(side: Color = this.sideToMove): boolean {
    const kingSq = side === WHITE ? this.whiteKingSq : this.blackKingSq;
    if (kingSq < 0) return false;
    return this.isSquareAttacked(kingSq, (side === WHITE ? BLACK : WHITE));
  }

  makeMove(move: ChessMove, recordHistory = false): UndoState {
    const side = this.sideToMove;
    const enemy: Color = side === WHITE ? BLACK : WHITE;
    let capturedSquare = move.to;

    const undo: UndoState = {
      move,
      castling: this.castling,
      enPassant: this.enPassant,
      halfmoveClock: this.halfmoveClock,
      fullmoveNumber: this.fullmoveNumber,
      hashLo: this.hashLo,
      hashHi: this.hashHi,
      capturedSquare,
    };

    let lo = this.hashLo;
    let hi = this.hashHi;

    // Remove old castling & ep from hash
    lo ^= ZOBRIST.castleLo[this.castling]!;
    hi ^= ZOBRIST.castleHi[this.castling]!;
    if (this.enPassant !== -1) {
      const epFile = this.enPassant & 7;
      lo ^= ZOBRIST.epLo[epFile]!;
      hi ^= ZOBRIST.epHi[epFile]!;
    }

    const movingSigned = side * move.piece;
    const fromIdx = pieceZobristIndex(movingSigned) * 64 + move.from;
    lo ^= ZOBRIST.pieceLo[fromIdx]!;
    hi ^= ZOBRIST.pieceHi[fromIdx]!;
    this.squares[move.from] = EMPTY;

    if (move.flags & FLAG_EN_PASSANT) {
      capturedSquare = move.to - side * 8;
      undo.capturedSquare = capturedSquare;
      const capSigned = enemy * PAWN;
      const capIdx = pieceZobristIndex(capSigned) * 64 + capturedSquare;
      lo ^= ZOBRIST.pieceLo[capIdx]!;
      hi ^= ZOBRIST.pieceHi[capIdx]!;
      this.squares[capturedSquare] = EMPTY;
    } else if (move.captured !== EMPTY) {
      const capSigned = enemy * move.captured;
      const capIdx = pieceZobristIndex(capSigned) * 64 + move.to;
      lo ^= ZOBRIST.pieceLo[capIdx]!;
      hi ^= ZOBRIST.pieceHi[capIdx]!;
    }

    const placedPiece = move.promotion !== 0 ? move.promotion : move.piece;
    const placedSigned = side * placedPiece;
    this.squares[move.to] = placedSigned;
    const toIdx = pieceZobristIndex(placedSigned) * 64 + move.to;
    lo ^= ZOBRIST.pieceLo[toIdx]!;
    hi ^= ZOBRIST.pieceHi[toIdx]!;

    if (move.piece === KING) {
      if (side === WHITE) this.whiteKingSq = move.to;
      else this.blackKingSq = move.to;

      if (move.flags & FLAG_CASTLE) {
        let rookFrom = 0;
        let rookTo = 0;
        if (move.to === 6) { rookFrom = 7; rookTo = 5; }
        else if (move.to === 2) { rookFrom = 0; rookTo = 3; }
        else if (move.to === 62) { rookFrom = 63; rookTo = 61; }
        else if (move.to === 58) { rookFrom = 56; rookTo = 59; }
        const rookSigned = side * ROOK;
        const rfIdx = pieceZobristIndex(rookSigned) * 64 + rookFrom;
        const rtIdx = pieceZobristIndex(rookSigned) * 64 + rookTo;
        lo ^= ZOBRIST.pieceLo[rfIdx]! ^ ZOBRIST.pieceLo[rtIdx]!;
        hi ^= ZOBRIST.pieceHi[rfIdx]! ^ ZOBRIST.pieceHi[rtIdx]!;
        this.squares[rookFrom] = EMPTY;
        this.squares[rookTo] = rookSigned;
      }
    }

    this.castling &= CASTLING_MASK[move.from]! & CASTLING_MASK[move.to]!;
    lo ^= ZOBRIST.castleLo[this.castling]!;
    hi ^= ZOBRIST.castleHi[this.castling]!;

    if (move.flags & FLAG_DOUBLE_PAWN) {
      this.enPassant = (move.from + move.to) >> 1;
      const epFile = this.enPassant & 7;
      lo ^= ZOBRIST.epLo[epFile]!;
      hi ^= ZOBRIST.epHi[epFile]!;
    } else {
      this.enPassant = -1;
    }

    if (move.piece === PAWN || move.captured !== EMPTY) {
      this.halfmoveClock = 0;
    } else {
      this.halfmoveClock++;
    }

    if (side === BLACK) this.fullmoveNumber++;

    this.sideToMove = enemy;
    lo ^= ZOBRIST.sideLo;
    hi ^= ZOBRIST.sideHi;

    this.hashLo = lo >>> 0;
    this.hashHi = hi >>> 0;
    if (recordHistory) {
      this.hashHistory.push(this.hashKey());
    }
    return undo;
  }

  unmakeMove(undo: UndoState, popHistory = false): void {
    const move = undo.move;
    const prevSide: Color = this.sideToMove === WHITE ? BLACK : WHITE;
    const enemy = this.sideToMove;

    this.sideToMove = prevSide;
    this.castling = undo.castling;
    this.enPassant = undo.enPassant;
    this.halfmoveClock = undo.halfmoveClock;
    this.fullmoveNumber = undo.fullmoveNumber;
    this.hashLo = undo.hashLo;
    this.hashHi = undo.hashHi;

    this.squares[move.from] = prevSide * move.piece;
    this.squares[move.to] = EMPTY;

    if (move.flags & FLAG_EN_PASSANT) {
      this.squares[undo.capturedSquare] = enemy * PAWN;
    } else if (move.captured !== EMPTY) {
      this.squares[move.to] = enemy * move.captured;
    }

    if (move.piece === KING) {
      if (prevSide === WHITE) this.whiteKingSq = move.from;
      else this.blackKingSq = move.from;

      if (move.flags & FLAG_CASTLE) {
        if (move.to === 6) { this.squares[7] = WHITE * ROOK; this.squares[5] = EMPTY; }
        else if (move.to === 2) { this.squares[0] = WHITE * ROOK; this.squares[3] = EMPTY; }
        else if (move.to === 62) { this.squares[63] = BLACK * ROOK; this.squares[61] = EMPTY; }
        else if (move.to === 58) { this.squares[56] = BLACK * ROOK; this.squares[59] = EMPTY; }
      }
    }

    if (popHistory) {
      this.hashHistory.pop();
    }
  }

  generatePseudoLegalMoves(capturesOnly = false): ChessMove[] {
    const moves: ChessMove[] = [];
    const side = this.sideToMove;
    const enemy: Color = side === WHITE ? BLACK : WHITE;
    const promoRank = side === WHITE ? 7 : 0;
    const startRank = side === WHITE ? 1 : 6;

    for (let sq = 0; sq < 64; sq++) {
      const p = this.squares[sq]!;
      if (p === 0 || (side === WHITE ? p < 0 : p > 0)) continue;

      const piece = Math.abs(p);
      const rank = sq >> 3;
      const file = sq & 7;

      if (piece === PAWN) {
        const nextRank = rank + side;
        if (nextRank >= 0 && nextRank <= 7) {
          // Single push
          const fwd = nextRank * 8 + file;
          if (this.squares[fwd] === EMPTY) {
            if (nextRank === promoRank) {
              moves.push(
                { from: sq, to: fwd, piece: PAWN, captured: 0, promotion: QUEEN, flags: FLAG_NONE },
                { from: sq, to: fwd, piece: PAWN, captured: 0, promotion: ROOK, flags: FLAG_NONE },
                { from: sq, to: fwd, piece: PAWN, captured: 0, promotion: BISHOP, flags: FLAG_NONE },
                { from: sq, to: fwd, piece: PAWN, captured: 0, promotion: KNIGHT, flags: FLAG_NONE }
              );
            } else if (!capturesOnly) {
              moves.push({ from: sq, to: fwd, piece: PAWN, captured: 0, promotion: 0, flags: FLAG_NONE });
              if (rank === startRank) {
                const dbl = (rank + side * 2) * 8 + file;
                if (this.squares[dbl] === EMPTY) {
                  moves.push({
                    from: sq, to: dbl, piece: PAWN, captured: 0, promotion: 0, flags: FLAG_DOUBLE_PAWN,
                  });
                }
              }
            }
          }

          // Diagonal captures + en passant
          for (const df of [-1, 1]) {
            const nf = file + df;
            if (nf < 0 || nf > 7) continue;
            const capSq = nextRank * 8 + nf;
            const target = this.squares[capSq]!;
            if (target !== 0 && (side === WHITE ? target < 0 : target > 0)) {
              const capType = Math.abs(target);
              if (nextRank === promoRank) {
                moves.push(
                  { from: sq, to: capSq, piece: PAWN, captured: capType, promotion: QUEEN, flags: FLAG_NONE },
                  { from: sq, to: capSq, piece: PAWN, captured: capType, promotion: ROOK, flags: FLAG_NONE },
                  { from: sq, to: capSq, piece: PAWN, captured: capType, promotion: BISHOP, flags: FLAG_NONE },
                  { from: sq, to: capSq, piece: PAWN, captured: capType, promotion: KNIGHT, flags: FLAG_NONE }
                );
              } else {
                moves.push({
                  from: sq, to: capSq, piece: PAWN, captured: capType, promotion: 0, flags: FLAG_NONE,
                });
              }
            } else if (capSq === this.enPassant) {
              moves.push({
                from: sq, to: capSq, piece: PAWN, captured: PAWN, promotion: 0, flags: FLAG_EN_PASSANT,
              });
            }
          }
        }
      } else if (piece === KNIGHT) {
        for (let i = 0; i < 8; i++) {
          const [dr, df] = KNIGHT_OFFSETS[i]!;
          const nr = rank + dr;
          const nf = file + df;
          if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf;
          const target = this.squares[to]!;
          if (target === 0) {
            if (!capturesOnly) {
              moves.push({ from: sq, to, piece: KNIGHT, captured: 0, promotion: 0, flags: FLAG_NONE });
            }
          } else if (side === WHITE ? target < 0 : target > 0) {
            moves.push({ from: sq, to, piece: KNIGHT, captured: Math.abs(target), promotion: 0, flags: FLAG_NONE });
          }
        }
      } else if (piece === KING) {
        for (let i = 0; i < 8; i++) {
          const [dr, df] = KING_OFFSETS[i]!;
          const nr = rank + dr;
          const nf = file + df;
          if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf;
          const target = this.squares[to]!;
          if (target === 0) {
            if (!capturesOnly) {
              moves.push({ from: sq, to, piece: KING, captured: 0, promotion: 0, flags: FLAG_NONE });
            }
          } else if (side === WHITE ? target < 0 : target > 0) {
            moves.push({ from: sq, to, piece: KING, captured: Math.abs(target), promotion: 0, flags: FLAG_NONE });
          }
        }

        // Castling
        if (!capturesOnly) {
          if (side === WHITE && sq === 4) {
            if (
              (this.castling & CASTLE_WK) &&
              this.squares[5] === EMPTY &&
              this.squares[6] === EMPTY &&
              this.squares[7] === WHITE * ROOK &&
              !this.isSquareAttacked(4, enemy) &&
              !this.isSquareAttacked(5, enemy) &&
              !this.isSquareAttacked(6, enemy)
            ) {
              moves.push({ from: 4, to: 6, piece: KING, captured: 0, promotion: 0, flags: FLAG_CASTLE });
            }
            if (
              (this.castling & CASTLE_WQ) &&
              this.squares[1] === EMPTY &&
              this.squares[2] === EMPTY &&
              this.squares[3] === EMPTY &&
              this.squares[0] === WHITE * ROOK &&
              !this.isSquareAttacked(4, enemy) &&
              !this.isSquareAttacked(3, enemy) &&
              !this.isSquareAttacked(2, enemy)
            ) {
              moves.push({ from: 4, to: 2, piece: KING, captured: 0, promotion: 0, flags: FLAG_CASTLE });
            }
          } else if (side === BLACK && sq === 60) {
            if (
              (this.castling & CASTLE_BK) &&
              this.squares[61] === EMPTY &&
              this.squares[62] === EMPTY &&
              this.squares[63] === BLACK * ROOK &&
              !this.isSquareAttacked(60, enemy) &&
              !this.isSquareAttacked(61, enemy) &&
              !this.isSquareAttacked(62, enemy)
            ) {
              moves.push({ from: 60, to: 62, piece: KING, captured: 0, promotion: 0, flags: FLAG_CASTLE });
            }
            if (
              (this.castling & CASTLE_BQ) &&
              this.squares[57] === EMPTY &&
              this.squares[58] === EMPTY &&
              this.squares[59] === EMPTY &&
              this.squares[56] === BLACK * ROOK &&
              !this.isSquareAttacked(60, enemy) &&
              !this.isSquareAttacked(59, enemy) &&
              !this.isSquareAttacked(58, enemy)
            ) {
              moves.push({ from: 60, to: 58, piece: KING, captured: 0, promotion: 0, flags: FLAG_CASTLE });
            }
          }
        }
      } else {
        const dirs =
          piece === BISHOP
            ? BISHOP_DIRS
            : piece === ROOK
              ? ROOK_DIRS
              : [...BISHOP_DIRS, ...ROOK_DIRS];
        for (let d = 0; d < dirs.length; d++) {
          const [dr, df] = dirs[d]!;
          let nr = rank + dr;
          let nf = file + df;
          while (nr >= 0 && nr <= 7 && nf >= 0 && nf <= 7) {
            const to = nr * 8 + nf;
            const target = this.squares[to]!;
            if (target === 0) {
              if (!capturesOnly) {
                moves.push({ from: sq, to, piece, captured: 0, promotion: 0, flags: FLAG_NONE });
              }
            } else {
              if (side === WHITE ? target < 0 : target > 0) {
                moves.push({ from: sq, to, piece, captured: Math.abs(target), promotion: 0, flags: FLAG_NONE });
              }
              break;
            }
            nr += dr;
            nf += df;
          }
        }
      }
    }

    return moves;
  }

  generateLegalMoves(capturesOnly = false): ChessMove[] {
    const pseudo = this.generatePseudoLegalMoves(capturesOnly);
    const legal: ChessMove[] = [];
    const mover = this.sideToMove;
    for (let i = 0; i < pseudo.length; i++) {
      const m = pseudo[i]!;
      const undo = this.makeMove(m, false);
      if (!this.isInCheck(mover)) {
        legal.push(m);
      }
      this.unmakeMove(undo, false);
    }
    return legal;
  }

  findMoveByUci(uci: string): ChessMove | null {
    const normalized = uci.trim().toLowerCase();
    for (const m of this.generateLegalMoves()) {
      if (moveToUci(m) === normalized) return m;
    }
    return null;
  }

  isInsufficientMaterial(): boolean {
    let whiteMinor = 0;
    let blackMinor = 0;
    let whiteBishopColor = -1;
    let blackBishopColor = -1;
    for (let sq = 0; sq < 64; sq++) {
      const p = this.squares[sq]!;
      if (p === 0 || Math.abs(p) === KING) continue;
      const abs = Math.abs(p);
      if (abs === PAWN || abs === ROOK || abs === QUEEN) return false;
      if (p > 0) {
        whiteMinor++;
        if (abs === BISHOP) whiteBishopColor = ((sq >> 3) + (sq & 7)) & 1;
      } else {
        blackMinor++;
        if (abs === BISHOP) blackBishopColor = ((sq >> 3) + (sq & 7)) & 1;
      }
    }
    if (whiteMinor === 0 && blackMinor === 0) return true;
    if (whiteMinor + blackMinor === 1) return true;
    if (
      whiteMinor === 1 &&
      blackMinor === 1 &&
      whiteBishopColor !== -1 &&
      whiteBishopColor === blackBishopColor
    ) {
      return true;
    }
    return false;
  }

  repetitionCount(): number {
    const current = this.hashKey();
    let count = 0;
    for (let i = 0; i < this.hashHistory.length; i++) {
      if (this.hashHistory[i] === current) count++;
    }
    return count;
  }

  getGameOutcome(): GameOutcome {
    const legal = this.generateLegalMoves();
    if (legal.length === 0) {
      if (this.isInCheck(this.sideToMove)) {
        return { status: 'checkmate', winner: this.sideToMove === WHITE ? BLACK : WHITE };
      }
      return { status: 'stalemate' };
    }
    if (this.halfmoveClock >= 100) return { status: 'draw_50move' };
    if (this.repetitionCount() >= 3) return { status: 'draw_repetition' };
    if (this.isInsufficientMaterial()) return { status: 'draw_insufficient' };
    return { status: 'playing' };
  }

  moveToSan(move: ChessMove, legalMoves?: ChessMove[]): string {
    const allLegal = legalMoves ?? this.generateLegalMoves();
    let san = '';

    if (move.flags & FLAG_CASTLE) {
      san = (move.to & 7) === 6 ? 'O-O' : 'O-O-O';
    } else if (move.piece === PAWN) {
      if (move.captured !== EMPTY) {
        san += String.fromCharCode(97 + (move.from & 7)) + 'x';
      }
      san += squareToAlgebraic(move.to);
      if (move.promotion !== 0) {
        san += '=' + PIECE_CHARS[move.promotion]!;
      }
    } else {
      san += PIECE_CHARS[move.piece]!;
      const ambiguous = allLegal.filter(
        (m) => m.from !== move.from && m.to === move.to && m.piece === move.piece
      );
      if (ambiguous.length > 0) {
        const sameFile = ambiguous.some((m) => (m.from & 7) === (move.from & 7));
        const sameRank = ambiguous.some((m) => (m.from >> 3) === (move.from >> 3));
        if (!sameFile) {
          san += String.fromCharCode(97 + (move.from & 7));
        } else if (!sameRank) {
          san += String((move.from >> 3) + 1);
        } else {
          san += squareToAlgebraic(move.from);
        }
      }
      if (move.captured !== EMPTY) san += 'x';
      san += squareToAlgebraic(move.to);
    }

    const undo = this.makeMove(move, false);
    const oppInCheck = this.isInCheck(this.sideToMove);
    if (oppInCheck) {
      const oppMoves = this.generateLegalMoves();
      san += oppMoves.length === 0 ? '#' : '+';
    }
    this.unmakeMove(undo, false);
    return san;
  }
}

export function perft(board: ChessBoard, depth: number): number {
  if (depth <= 0) return 1;
  const moves = board.generateLegalMoves();
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (let i = 0; i < moves.length; i++) {
    const undo = board.makeMove(moves[i]!, false);
    nodes += perft(board, depth - 1);
    board.unmakeMove(undo, false);
  }
  return nodes;
}
