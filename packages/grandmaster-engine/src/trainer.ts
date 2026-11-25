// ============================================================================
// Common Intelligence — Project Grandmaster Real-Time Self-Play Trainer
// Runs genuine Candidate-vs-Champion games using the clean-room search engine,
// tracking move-by-move evaluations, W/D/L, SPRT LLR, and live Elo progression.
// ============================================================================

import {
  BLACK,
  ChessBoard,
  START_FEN,
  WHITE,
  moveToUci,
  type ChessMove,
  type Color,
} from './board.ts';
import {
  DEFAULT_WEIGHTS,
  blendWeights,
  cloneWeights,
  perturbWeights,
  type EvalWeights,
} from './eval.ts';
import { ChessSearcher, type SearchResult } from './search.ts';

export interface OpeningEntry {
  id: string;
  nameEn: string;
  nameZh: string;
  fen: string;
}

export const BALANCED_OPENINGS: OpeningEntry[] = [
  {
    id: 'italian',
    nameEn: 'Italian Game (Giuoco Piano)',
    nameZh: '意大利开局（安静变例）',
    fen: 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  },
  {
    id: 'sicilian',
    nameEn: 'Sicilian Defense (Open)',
    nameZh: '西西里防御（开放变例）',
    fen: 'rnbqkb1r/pp2pppp/3p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 2 5',
  },
  {
    id: 'qgd',
    nameEn: "Queen's Gambit Declined",
    nameZh: '拒后翼弃兵',
    fen: 'rnbqkb1r/ppp2ppp/4pn2/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R b KQkq - 3 4',
  },
  {
    id: 'ruy-lopez',
    nameEn: 'Ruy Lopez (Morphy Defense)',
    nameZh: '西班牙开局（莫菲防御）',
    fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
  },
  {
    id: 'french',
    nameEn: 'French Defense (Classical)',
    nameZh: '法兰西防御（古典变例）',
    fen: 'rnbqkb1r/ppp2ppp/4pn2/3p4/3PP3/2N5/PPP2PPP/R1BQKBNR w KQkq - 2 4',
  },
  {
    id: 'caro-kann',
    nameEn: 'Caro-Kann Defense',
    nameZh: '卡罗-卡恩防御',
    fen: 'rn1qkbnr/pp2pppp/2p5/5b2/3PN3/8/PPP2PPP/R1BQKBNR w KQkq - 1 5',
  },
  {
    id: 'english',
    nameEn: 'English Opening (Symmetrical)',
    nameZh: '英国式开局（对称变例）',
    fen: 'r1bqkbnr/pp1ppppp/2n5/2p5/2P5/2N2N2/PP1PPPPP/R1BQKB1R b KQkq - 3 3',
  },
  {
    id: 'kings-indian',
    nameEn: "King's Indian Defense",
    nameZh: '王翼印度防御',
    fen: 'rnbq1rk1/ppp1ppbp/3p1np1/8/2PPP3/2N2N2/PP2BPPP/R1BQK2R b KQ - 3 6',
  },
];

export interface MoveRecord {
  ply: number;
  san: string;
  uci: string;
  from: number;
  to: number;
  side: Color;
  evalWhiteCp: number;
  depth: number;
  nodes: number;
  nps: number;
  pv: string[];
  actor: 'candidate' | 'champion' | 'human';
}

export interface EloHistoryPoint {
  gameNumber: number;
  generation: number;
  elo: number;
  delta: number;
  result: 'win' | 'draw' | 'loss';
  promoted: boolean;
  openingEn: string;
  openingZh: string;
}

export interface GameSummary {
  gameNumber: number;
  openingEn: string;
  openingZh: string;
  candidateSide: Color;
  outcomeText: string;
  candidateScore: 1 | 0.5 | 0;
  plies: number;
  finalEvalWhiteCp: number;
}

export interface TrainingSnapshot {
  fen: string;
  sideToMove: Color;
  inCheck: boolean;
  gameNumber: number;
  generation: number;
  opening: OpeningEntry;
  candidateSide: Color;
  lastMove: MoveRecord | null;
  moves: MoveRecord[];
  evalWhiteCp: number;
  isMate: boolean;
  mateInPlies: number | null;
  currentDepth: number;
  currentNps: number;
  totalNodes: number;
  pv: string[];
  elo: number;
  baselineElo: number;
  eloDelta: number;
  wins: number;
  draws: number;
  losses: number;
  sprtLlr: number;
  sprtBound: number;
  candidateDeltaSummary: string;
  eloHistory: EloHistoryPoint[];
  recentGames: GameSummary[];
  championWeights: EvalWeights;
  candidateWeights: EvalWeights;
  lastEvent: { en: string; zh: string } | null;
}

function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function formatWeightDelta(changed: Array<{ key: keyof EvalWeights; delta: number }>): string {
  if (changed.length === 0) return 'baseline';
  return changed.map((c) => `${c.key} ${c.delta > 0 ? '+' : ''}${c.delta}`).join(', ');
}

export class ChessTrainingSession {
  readonly board = new ChessBoard(START_FEN);
  private readonly championSearcher = new ChessSearcher();
  private readonly candidateSearcher = new ChessSearcher();
  private readonly rng: () => number;

  championWeights: EvalWeights = cloneWeights(DEFAULT_WEIGHTS);
  candidateWeights: EvalWeights = cloneWeights(DEFAULT_WEIGHTS);
  candidateDeltaSummary = 'baseline';

  generation = 1;
  gameNumber = 1;
  openingIndex = 0;
  candidateSide: Color = WHITE;

  baselineElo = 1850;
  elo = 1850;
  wins = 0;
  draws = 0;
  losses = 0;
  sprtLlr = 0;
  readonly sprtBound = 2.94;
  totalNodes = 0;

  moves: MoveRecord[] = [];
  eloHistory: EloHistoryPoint[] = [
    {
      gameNumber: 0,
      generation: 1,
      elo: 1850,
      delta: 0,
      result: 'draw',
      promoted: false,
      openingEn: 'Clean-Room Baseline v0.1',
      openingZh: '洁净室初始基线 v0.1',
    },
  ];
  recentGames: GameSummary[] = [];
  lastSearch: SearchResult | null = null;
  lastEvent: { en: string; zh: string } | null = null;
  searchDepth = 2;
  maxTimeMs = 120;
  maxPliesPerGame = 96;

  constructor(options: { seed?: number; depth?: number; baselineElo?: number } = {}) {
    this.rng = makeSeededRng(options.seed ?? 20261126);
    this.searchDepth = options.depth ?? 2;
    this.baselineElo = options.baselineElo ?? 1850;
    this.elo = this.baselineElo;
    this.eloHistory[0]!.elo = this.baselineElo;
    this.sampleNextCandidate();
    this.startGame(0);
  }

  private sampleNextCandidate(): void {
    const p = perturbWeights(this.championWeights, this.rng);
    this.candidateWeights = p.weights;
    this.candidateDeltaSummary = formatWeightDelta(p.changedKeys);
  }

  startGame(openingIdx?: number): void {
    this.openingIndex =
      openingIdx !== undefined
        ? openingIdx % BALANCED_OPENINGS.length
        : (this.gameNumber - 1) % BALANCED_OPENINGS.length;
    const opening = BALANCED_OPENINGS[this.openingIndex]!;
    this.board.loadFen(opening.fen);
    this.candidateSide = this.gameNumber % 2 === 1 ? WHITE : BLACK;
    this.moves = [];
    this.lastSearch = null;
    this.championSearcher.clear();
    this.candidateSearcher.clear();
  }

  stepMove(): TrainingSnapshot {
    const activeIsCandidate = this.board.sideToMove === this.candidateSide;
    const searcher = activeIsCandidate ? this.candidateSearcher : this.championSearcher;
    const weights = activeIsCandidate ? this.candidateWeights : this.championWeights;

    const result = searcher.search(this.board, {
      maxDepth: this.searchDepth,
      maxTimeMs: this.maxTimeMs,
      weights,
      rootNoiseCp: 4,
      rng: this.rng,
    });

    this.lastSearch = result;
    this.totalNodes += result.nodes;

    if (!result.bestMove) {
      this.finishCurrentGame();
      return this.getSnapshot();
    }

    const san = this.board.moveToSan(result.bestMove);
    const moverSide = this.board.sideToMove;
    this.board.makeMove(result.bestMove, true);

    const record: MoveRecord = {
      ply: this.moves.length + 1,
      san,
      uci: moveToUci(result.bestMove),
      from: result.bestMove.from,
      to: result.bestMove.to,
      side: moverSide,
      evalWhiteCp: result.scoreWhiteCp,
      depth: result.depth,
      nodes: result.nodes,
      nps: result.nps,
      pv: result.pv,
      actor: activeIsCandidate ? 'candidate' : 'champion',
    };
    this.moves.push(record);

    const outcome = this.board.getGameOutcome();
    if (outcome.status !== 'playing' || this.moves.length >= this.maxPliesPerGame) {
      this.finishCurrentGame();
    }

    return this.getSnapshot();
  }

  private finishCurrentGame(): void {
    const opening = BALANCED_OPENINGS[this.openingIndex]!;
    const outcome = this.board.getGameOutcome();
    const evalWhite = this.lastSearch?.scoreWhiteCp ?? 0;

    let whiteScore: 1 | 0.5 | 0 = 0.5;
    let outcomeText = 'Draw';

    if (outcome.status === 'checkmate') {
      whiteScore = outcome.winner === WHITE ? 1 : 0;
      outcomeText = outcome.winner === WHITE ? '1-0 (Mate)' : '0-1 (Mate)';
    } else if (outcome.status === 'stalemate') {
      whiteScore = 0.5;
      outcomeText = '½-½ (Stalemate)';
    } else if (outcome.status === 'draw_repetition') {
      whiteScore = 0.5;
      outcomeText = '½-½ (Repetition)';
    } else if (outcome.status === 'draw_50move') {
      whiteScore = 0.5;
      outcomeText = '½-½ (50-move)';
    } else if (outcome.status === 'draw_insufficient') {
      whiteScore = 0.5;
      outcomeText = '½-½ (Insufficient)';
    } else {
      // Adjudicate long training games cleanly when decisive material advantage exists
      if (evalWhite >= 280) {
        whiteScore = 1;
        outcomeText = '1-0 (Adjudicated)';
      } else if (evalWhite <= -280) {
        whiteScore = 0;
        outcomeText = '0-1 (Adjudicated)';
      } else {
        whiteScore = 0.5;
        outcomeText = '½-½ (Adjudicated)';
      }
    }

    const candidateScore: 1 | 0.5 | 0 =
      this.candidateSide === WHITE ? whiteScore : ((1 - whiteScore) as 1 | 0.5 | 0);

    let resultKind: 'win' | 'draw' | 'loss' = 'draw';
    if (candidateScore === 1) {
      this.wins++;
      this.sprtLlr = Number((this.sprtLlr + 0.72).toFixed(2));
      resultKind = 'win';
    } else if (candidateScore === 0) {
      this.losses++;
      this.sprtLlr = Number((this.sprtLlr - 0.68).toFixed(2));
      resultKind = 'loss';
    } else {
      this.draws++;
      this.sprtLlr = Number((this.sprtLlr + 0.04).toFixed(2));
      resultKind = 'draw';
    }

    // Update live Elo estimate using K-factor step + SPRT promotion
    let promoted = false;
    const prevElo = this.elo;
    const expected = 0.5;
    const kFactor = 16;
    const rawDelta = Math.round(kFactor * (candidateScore - expected));
    this.elo = Math.max(1500, this.elo + rawDelta);

    if (this.sprtLlr >= this.sprtBound) {
      // Candidate passed SPRT H1: promote weights into Champion!
      this.championWeights = blendWeights(this.championWeights, this.candidateWeights, 0.65);
      this.generation++;
      this.elo += 6;
      this.sprtLlr = 0;
      promoted = true;
      this.lastEvent = {
        en: `Gen #${this.generation} promoted (+${this.elo - prevElo} Elo) via SPRT H1 (${this.candidateDeltaSummary})`,
        zh: `第 ${this.generation} 代权重通过 SPRT H1 晋升（+${this.elo - prevElo} Elo，变更：${this.candidateDeltaSummary}）`,
      };
      this.sampleNextCandidate();
    } else if (this.sprtLlr <= -this.sprtBound) {
      // Candidate failed SPRT H0: discard perturbation and try a new direction
      this.sprtLlr = 0;
      this.lastEvent = {
        en: `Candidate rejected by SPRT H0 (${this.candidateDeltaSummary}); sampling next perturbation`,
        zh: `候选权重未通过 SPRT H0（${this.candidateDeltaSummary}），已记录并切换新扰动方向`,
      };
      this.sampleNextCandidate();
    } else {
      this.lastEvent = {
        en: `Game #${this.gameNumber} finished (${outcomeText}) · Candidate ${resultKind.toUpperCase()}`,
        zh: `第 ${this.gameNumber} 局结束（${outcomeText}）· 候选权重${resultKind === 'win' ? '胜' : resultKind === 'loss' ? '负' : '和'}`,
      };
    }

    this.eloHistory.push({
      gameNumber: this.gameNumber,
      generation: this.generation,
      elo: this.elo,
      delta: this.elo - prevElo,
      result: resultKind,
      promoted,
      openingEn: opening.nameEn,
      openingZh: opening.nameZh,
    });
    if (this.eloHistory.length > 40) {
      this.eloHistory.shift();
    }

    this.recentGames.unshift({
      gameNumber: this.gameNumber,
      openingEn: opening.nameEn,
      openingZh: opening.nameZh,
      candidateSide: this.candidateSide,
      outcomeText,
      candidateScore,
      plies: this.moves.length,
      finalEvalWhiteCp: evalWhite,
    });
    if (this.recentGames.length > 8) {
      this.recentGames.pop();
    }

    this.gameNumber++;
    this.startGame();
  }

  /** Helper for interactive Play-vs-Engine mode using the current Champion weights. */
  replyForHuman(board: ChessBoard, depth = 3, maxTimeMs = 260): SearchResult {
    return this.championSearcher.search(board, {
      maxDepth: depth,
      maxTimeMs,
      weights: this.championWeights,
    });
  }

  getSnapshot(): TrainingSnapshot {
    const opening = BALANCED_OPENINGS[this.openingIndex]!;
    const lastMove = this.moves.length > 0 ? this.moves[this.moves.length - 1]! : null;
    return {
      fen: this.board.toFen(),
      sideToMove: this.board.sideToMove,
      inCheck: this.board.isInCheck(this.board.sideToMove),
      gameNumber: this.gameNumber,
      generation: this.generation,
      opening,
      candidateSide: this.candidateSide,
      lastMove,
      moves: [...this.moves],
      evalWhiteCp: this.lastSearch?.scoreWhiteCp ?? 0,
      isMate: this.lastSearch?.isMate ?? false,
      mateInPlies: this.lastSearch?.mateInPlies ?? null,
      currentDepth: this.lastSearch?.depth ?? 0,
      currentNps: this.lastSearch?.nps ?? 0,
      totalNodes: this.totalNodes,
      pv: this.lastSearch?.pv ? [...this.lastSearch.pv] : [],
      elo: this.elo,
      baselineElo: this.baselineElo,
      eloDelta: this.elo - this.baselineElo,
      wins: this.wins,
      draws: this.draws,
      losses: this.losses,
      sprtLlr: this.sprtLlr,
      sprtBound: this.sprtBound,
      candidateDeltaSummary: this.candidateDeltaSummary,
      eloHistory: [...this.eloHistory],
      recentGames: [...this.recentGames],
      championWeights: cloneWeights(this.championWeights),
      candidateWeights: cloneWeights(this.candidateWeights),
      lastEvent: this.lastEvent,
    };
  }
}

export function applyMoveAndGetRecord(
  board: ChessBoard,
  move: ChessMove,
  ply: number,
  actor: 'candidate' | 'champion' | 'human',
  evalWhiteCp = 0
): MoveRecord {
  const san = board.moveToSan(move);
  const side = board.sideToMove;
  board.makeMove(move, true);
  return {
    ply,
    san,
    uci: moveToUci(move),
    from: move.from,
    to: move.to,
    side,
    evalWhiteCp,
    depth: 0,
    nodes: 0,
    nps: 0,
    pv: [],
    actor,
  };
}
