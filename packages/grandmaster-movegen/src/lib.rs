//! # grandmaster-movegen
//!
//! Clean-room chess rules core for Project Grandmaster:
//!
//! * bitboard board representation (one `u64` per colour/piece) plus a mailbox,
//! * pseudo-legal and fully legal move generation (castling, en passant,
//!   promotions, check evasion, pins via make-and-test),
//! * FEN parsing / serialisation, UCI move strings,
//! * Zobrist position keys (fixed-seed SplitMix64, generated at start-up),
//! * game termination: checkmate, stalemate, 50-move rule, threefold
//!   repetition and insufficient material,
//! * Perft / divide with a built-in regression suite ([`PERFT_SUITE`]).
//!
//! Square indexing: `a1 = 0, b1 = 1, …, h1 = 7, a2 = 8, …, h8 = 63`.
//!
//! Written from scratch from the rules of chess; no code, tables or data were
//! copied from Stockfish or any other engine. Perft reference node counts are
//! the publicly documented values for well-known test positions.

use std::fmt;
use std::sync::OnceLock;

/// A set of squares, bit `n` = square `n`.
pub type Bitboard = u64;

// ---------------------------------------------------------------------------
// Colours, pieces, squares
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Color {
    White = 0,
    Black = 1,
}

impl Color {
    #[inline]
    pub fn other(self) -> Color {
        match self {
            Color::White => Color::Black,
            Color::Black => Color::White,
        }
    }
    #[inline]
    pub fn idx(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Piece {
    Pawn = 0,
    Knight = 1,
    Bishop = 2,
    Rook = 3,
    Queen = 4,
    King = 5,
}

impl Piece {
    pub const ALL: [Piece; 6] = [
        Piece::Pawn,
        Piece::Knight,
        Piece::Bishop,
        Piece::Rook,
        Piece::Queen,
        Piece::King,
    ];
    const PROMOTIONS: [Piece; 4] = [Piece::Queen, Piece::Rook, Piece::Bishop, Piece::Knight];

    #[inline]
    pub fn idx(self) -> usize {
        self as usize
    }

    /// FEN letter: upper case for White, lower case for Black.
    pub fn to_char(self, color: Color) -> char {
        let c = match self {
            Piece::Pawn => 'p',
            Piece::Knight => 'n',
            Piece::Bishop => 'b',
            Piece::Rook => 'r',
            Piece::Queen => 'q',
            Piece::King => 'k',
        };
        if color == Color::White {
            c.to_ascii_uppercase()
        } else {
            c
        }
    }

    pub fn from_char(c: char) -> Option<(Color, Piece)> {
        let color = if c.is_ascii_uppercase() {
            Color::White
        } else {
            Color::Black
        };
        let p = match c.to_ascii_lowercase() {
            'p' => Piece::Pawn,
            'n' => Piece::Knight,
            'b' => Piece::Bishop,
            'r' => Piece::Rook,
            'q' => Piece::Queen,
            'k' => Piece::King,
            _ => return None,
        };
        Some((color, p))
    }
}

pub const CASTLE_WK: u8 = 1;
pub const CASTLE_WQ: u8 = 2;
pub const CASTLE_BK: u8 = 4;
pub const CASTLE_BQ: u8 = 8;

pub const START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

#[inline]
pub const fn sq_bb(sq: u8) -> Bitboard {
    1u64 << sq
}
#[inline]
pub const fn file_of(sq: u8) -> u8 {
    sq & 7
}
#[inline]
pub const fn rank_of(sq: u8) -> u8 {
    sq >> 3
}

pub fn square_name(sq: u8) -> String {
    let mut s = String::with_capacity(2);
    s.push((b'a' + file_of(sq)) as char);
    s.push((b'1' + rank_of(sq)) as char);
    s
}

pub fn parse_square(s: &str) -> Option<u8> {
    let b = s.as_bytes();
    if b.len() != 2 {
        return None;
    }
    let f = b[0].wrapping_sub(b'a');
    let r = b[1].wrapping_sub(b'1');
    if f < 8 && r < 8 {
        Some(r * 8 + f)
    } else {
        None
    }
}

#[inline]
fn pop_lsb(bb: &mut Bitboard) -> u8 {
    let s = bb.trailing_zeros() as u8;
    *bb &= *bb - 1;
    s
}

// ---------------------------------------------------------------------------
// Precomputed tables
// ---------------------------------------------------------------------------

struct Tables {
    knight: [Bitboard; 64],
    king: [Bitboard; 64],
    pawn: [[Bitboard; 64]; 2],
    /// Rays per direction, excluding the origin square.
    rays: [[Bitboard; 64]; 8],
    z_piece: [[[u64; 64]; 6]; 2],
    z_side: u64,
    z_castle: [u64; 16],
    z_ep_file: [u64; 8],
}

/// (file delta, rank delta). Indices 0..4 increase the square index
/// (N, E, NE, NW); indices 4..8 decrease it (S, W, SE, SW).
const DIRS: [(i8, i8); 8] = [
    (0, 1),
    (1, 0),
    (1, 1),
    (-1, 1),
    (0, -1),
    (-1, 0),
    (1, -1),
    (-1, -1),
];
const ROOK_DIRS: [usize; 4] = [0, 1, 4, 5];
const BISHOP_DIRS: [usize; 4] = [2, 3, 6, 7];

fn offset(sq: u8, df: i8, dr: i8) -> Option<u8> {
    let f = file_of(sq) as i8 + df;
    let r = rank_of(sq) as i8 + dr;
    if (0..8).contains(&f) && (0..8).contains(&r) {
        Some((r * 8 + f) as u8)
    } else {
        None
    }
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn build_tables() -> Tables {
    let mut t = Tables {
        knight: [0; 64],
        king: [0; 64],
        pawn: [[0; 64]; 2],
        rays: [[0; 64]; 8],
        z_piece: [[[0; 64]; 6]; 2],
        z_side: 0,
        z_castle: [0; 16],
        z_ep_file: [0; 8],
    };
    const KNIGHT_JUMPS: [(i8, i8); 8] = [
        (1, 2),
        (2, 1),
        (2, -1),
        (1, -2),
        (-1, -2),
        (-2, -1),
        (-2, 1),
        (-1, 2),
    ];
    for sq in 0..64u8 {
        let i = sq as usize;
        for &(df, dr) in &KNIGHT_JUMPS {
            if let Some(s) = offset(sq, df, dr) {
                t.knight[i] |= sq_bb(s);
            }
        }
        for df in -1..=1i8 {
            for dr in -1..=1i8 {
                if (df, dr) != (0, 0) {
                    if let Some(s) = offset(sq, df, dr) {
                        t.king[i] |= sq_bb(s);
                    }
                }
            }
        }
        for df in [-1i8, 1] {
            if let Some(s) = offset(sq, df, 1) {
                t.pawn[Color::White.idx()][i] |= sq_bb(s);
            }
            if let Some(s) = offset(sq, df, -1) {
                t.pawn[Color::Black.idx()][i] |= sq_bb(s);
            }
        }
        for (d, &(df, dr)) in DIRS.iter().enumerate() {
            let mut cur = sq;
            while let Some(s) = offset(cur, df, dr) {
                t.rays[d][i] |= sq_bb(s);
                cur = s;
            }
        }
    }
    // Arbitrary fixed seed ("GRANDMST") so keys are reproducible across runs.
    let mut seed = 0x4752_414E_444D_5354u64;
    for c in 0..2 {
        for p in 0..6 {
            for s in 0..64 {
                t.z_piece[c][p][s] = splitmix64(&mut seed);
            }
        }
    }
    t.z_side = splitmix64(&mut seed);
    for i in 1..16 {
        t.z_castle[i] = splitmix64(&mut seed);
    }
    for f in 0..8 {
        t.z_ep_file[f] = splitmix64(&mut seed);
    }
    t
}

static TABLES: OnceLock<Tables> = OnceLock::new();

#[inline]
fn tables() -> &'static Tables {
    TABLES.get_or_init(build_tables)
}

#[inline]
fn ray_attacks(t: &Tables, dir: usize, sq: u8, occ: Bitboard) -> Bitboard {
    let ray = t.rays[dir][sq as usize];
    let blockers = ray & occ;
    if blockers == 0 {
        return ray;
    }
    let first = (if dir < 4 {
        blockers.trailing_zeros()
    } else {
        63 - blockers.leading_zeros()
    }) as usize;
    ray ^ t.rays[dir][first]
}

pub fn rook_attacks(sq: u8, occ: Bitboard) -> Bitboard {
    let t = tables();
    ROOK_DIRS
        .iter()
        .fold(0, |acc, &d| acc | ray_attacks(t, d, sq, occ))
}

pub fn bishop_attacks(sq: u8, occ: Bitboard) -> Bitboard {
    let t = tables();
    BISHOP_DIRS
        .iter()
        .fold(0, |acc, &d| acc | ray_attacks(t, d, sq, occ))
}

pub fn queen_attacks(sq: u8, occ: Bitboard) -> Bitboard {
    rook_attacks(sq, occ) | bishop_attacks(sq, occ)
}

pub fn knight_attacks(sq: u8) -> Bitboard {
    tables().knight[sq as usize]
}

pub fn king_attacks(sq: u8) -> Bitboard {
    tables().king[sq as usize]
}

/// Squares attacked by a pawn of `color` standing on `sq`.
pub fn pawn_attacks(color: Color, sq: u8) -> Bitboard {
    tables().pawn[color.idx()][sq as usize]
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MoveKind {
    Quiet,
    Capture,
    DoublePush,
    EnPassant,
    CastleKingside,
    CastleQueenside,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Move {
    pub from: u8,
    pub to: u8,
    pub promotion: Option<Piece>,
    pub kind: MoveKind,
}

impl Move {
    pub const NULL: Move = Move {
        from: 0,
        to: 0,
        promotion: None,
        kind: MoveKind::Quiet,
    };

    #[inline]
    pub fn is_capture(&self) -> bool {
        matches!(self.kind, MoveKind::Capture | MoveKind::EnPassant)
    }

    #[inline]
    pub fn is_castle(&self) -> bool {
        matches!(
            self.kind,
            MoveKind::CastleKingside | MoveKind::CastleQueenside
        )
    }

    /// Long algebraic UCI notation, e.g. `e2e4`, `e7e8q`, `e1g1`.
    pub fn to_uci(&self) -> String {
        let mut s = square_name(self.from);
        s.push_str(&square_name(self.to));
        if let Some(p) = self.promotion {
            s.push(p.to_char(Color::Black));
        }
        s
    }
}

impl fmt::Display for Move {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_uci())
    }
}

/// Fixed-capacity move buffer (no heap allocation in the search/perft path).
#[derive(Clone)]
pub struct MoveList {
    moves: [Move; MoveList::CAPACITY],
    len: usize,
}

impl MoveList {
    /// Legal positions have at most 218 moves; pseudo-legal lists stay well below this.
    pub const CAPACITY: usize = 320;

    pub fn new() -> Self {
        MoveList {
            moves: [Move::NULL; Self::CAPACITY],
            len: 0,
        }
    }
    #[inline]
    pub fn push(&mut self, m: Move) {
        self.moves[self.len] = m;
        self.len += 1;
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    #[inline]
    pub fn as_slice(&self) -> &[Move] {
        &self.moves[..self.len]
    }
    fn retain(&mut self, mut keep: impl FnMut(Move) -> bool) {
        let mut w = 0;
        for r in 0..self.len {
            let m = self.moves[r];
            if keep(m) {
                self.moves[w] = m;
                w += 1;
            }
        }
        self.len = w;
    }
}

impl Default for MoveList {
    fn default() -> Self {
        Self::new()
    }
}

impl std::ops::Deref for MoveList {
    type Target = [Move];
    fn deref(&self) -> &[Move] {
        self.as_slice()
    }
}

impl fmt::Debug for MoveList {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list()
            .entries(self.as_slice().iter().map(|m| m.to_uci()))
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FenError(pub String);

impl fmt::Display for FenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid FEN: {}", self.0)
    }
}

impl std::error::Error for FenError {}

fn fen_err<T>(msg: impl Into<String>) -> Result<T, FenError> {
    Err(FenError(msg.into()))
}

const fn castle_masks() -> [u8; 64] {
    let mut m = [15u8; 64];
    m[0] = 15 & !CASTLE_WQ; // a1
    m[4] = 15 & !(CASTLE_WK | CASTLE_WQ); // e1
    m[7] = 15 & !CASTLE_WK; // h1
    m[56] = 15 & !CASTLE_BQ; // a8
    m[60] = 15 & !(CASTLE_BK | CASTLE_BQ); // e8
    m[63] = 15 & !CASTLE_BK; // h8
    m
}

/// Castling rights that survive a move touching each square.
const CASTLE_MASK: [u8; 64] = castle_masks();

#[inline]
const fn encode(c: Color, p: Piece) -> u8 {
    1 + (c as u8) * 6 + p as u8
}

#[inline]
fn decode(v: u8) -> Option<(Color, Piece)> {
    if v == 0 {
        None
    } else {
        let v = v - 1;
        let c = if v < 6 { Color::White } else { Color::Black };
        Some((c, Piece::ALL[(v % 6) as usize]))
    }
}

/// A chess position. `Copy`, so search/perft can use copy-make.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Position {
    pieces: [[Bitboard; 6]; 2],
    occupancy: [Bitboard; 2],
    /// Mailbox: 0 = empty, otherwise `1 + colour * 6 + piece`.
    board: [u8; 64],
    side: Color,
    castling: u8,
    ep: Option<u8>,
    halfmove: u32,
    fullmove: u32,
    /// Zobrist hash of piece placement and side to move. Castling rights and
    /// the en-passant file are folded in by [`Position::key`].
    hash: u64,
}

impl Default for Position {
    fn default() -> Self {
        Self::startpos()
    }
}

impl Position {
    fn empty() -> Self {
        Position {
            pieces: [[0; 6]; 2],
            occupancy: [0; 2],
            board: [0; 64],
            side: Color::White,
            castling: 0,
            ep: None,
            halfmove: 0,
            fullmove: 1,
            hash: 0,
        }
    }

    pub fn startpos() -> Self {
        Self::from_fen(START_FEN).expect("start position FEN is valid")
    }

    #[inline]
    fn put(&mut self, c: Color, p: Piece, sq: u8) {
        let b = sq_bb(sq);
        self.pieces[c.idx()][p.idx()] |= b;
        self.occupancy[c.idx()] |= b;
        self.board[sq as usize] = encode(c, p);
        self.hash ^= tables().z_piece[c.idx()][p.idx()][sq as usize];
    }

    #[inline]
    fn remove(&mut self, c: Color, p: Piece, sq: u8) {
        let b = sq_bb(sq);
        self.pieces[c.idx()][p.idx()] &= !b;
        self.occupancy[c.idx()] &= !b;
        self.board[sq as usize] = 0;
        self.hash ^= tables().z_piece[c.idx()][p.idx()][sq as usize];
    }

    // ----- accessors ------------------------------------------------------

    #[inline]
    pub fn piece_at(&self, sq: u8) -> Option<(Color, Piece)> {
        decode(self.board[sq as usize])
    }
    #[inline]
    pub fn side_to_move(&self) -> Color {
        self.side
    }
    #[inline]
    pub fn castling_rights(&self) -> u8 {
        self.castling
    }
    #[inline]
    pub fn en_passant(&self) -> Option<u8> {
        self.ep
    }
    #[inline]
    pub fn halfmove_clock(&self) -> u32 {
        self.halfmove
    }
    #[inline]
    pub fn fullmove_number(&self) -> u32 {
        self.fullmove
    }
    #[inline]
    pub fn pieces(&self, c: Color, p: Piece) -> Bitboard {
        self.pieces[c.idx()][p.idx()]
    }
    #[inline]
    pub fn occupancy(&self, c: Color) -> Bitboard {
        self.occupancy[c.idx()]
    }
    #[inline]
    pub fn all(&self) -> Bitboard {
        self.occupancy[0] | self.occupancy[1]
    }
    #[inline]
    pub fn king_square(&self, c: Color) -> u8 {
        self.pieces[c.idx()][Piece::King.idx()].trailing_zeros() as u8
    }

    /// Position key for repetition detection / transposition tables:
    /// placement + side to move + castling rights + en-passant file (the
    /// latter only when a pawn of the side to move attacks the ep square).
    pub fn key(&self) -> u64 {
        let t = tables();
        let mut k = self.hash ^ t.z_castle[self.castling as usize];
        if let Some(ep) = self.ep {
            if pawn_attacks(self.side.other(), ep) & self.pieces(self.side, Piece::Pawn) != 0 {
                k ^= t.z_ep_file[file_of(ep) as usize];
            }
        }
        k
    }

    // ----- attacks --------------------------------------------------------

    /// Is `sq` attacked by any piece of colour `by`?
    pub fn is_attacked(&self, sq: u8, by: Color) -> bool {
        let occ = self.all();
        let t = tables();
        let b = by.idx();
        let p = &self.pieces[b];
        // A `by` pawn attacks `sq` iff it stands where an opposite pawn on `sq` would attack.
        if t.pawn[by.other().idx()][sq as usize] & p[Piece::Pawn.idx()] != 0 {
            return true;
        }
        if t.knight[sq as usize] & p[Piece::Knight.idx()] != 0 {
            return true;
        }
        if t.king[sq as usize] & p[Piece::King.idx()] != 0 {
            return true;
        }
        let diag = p[Piece::Bishop.idx()] | p[Piece::Queen.idx()];
        if diag != 0 && bishop_attacks(sq, occ) & diag != 0 {
            return true;
        }
        let ortho = p[Piece::Rook.idx()] | p[Piece::Queen.idx()];
        ortho != 0 && rook_attacks(sq, occ) & ortho != 0
    }

    /// Is the side to move in check?
    pub fn in_check(&self) -> bool {
        self.is_attacked(self.king_square(self.side), self.side.other())
    }

    // ----- move generation ------------------------------------------------

    /// Append all pseudo-legal moves (may leave own king in check; castling
    /// is already fully checked) to `list`.
    pub fn pseudo_legal_moves(&self, list: &mut MoveList) {
        let us = self.side;
        let t = tables();
        let own = self.occupancy[us.idx()];
        let opp = self.occupancy[us.other().idx()];
        let occ = own | opp;

        // Pawns
        let (push, start_rank, pre_promo_rank): (i8, u8, u8) = match us {
            Color::White => (8, 1, 6),
            Color::Black => (-8, 6, 1),
        };
        let mut pawns = self.pieces(us, Piece::Pawn);
        while pawns != 0 {
            let from = pop_lsb(&mut pawns);
            let r = rank_of(from);
            let promotes = r == pre_promo_rank;
            let one = (from as i8 + push) as u8;
            if occ & sq_bb(one) == 0 {
                if promotes {
                    push_promotions(list, from, one, MoveKind::Quiet);
                } else {
                    list.push(Move {
                        from,
                        to: one,
                        promotion: None,
                        kind: MoveKind::Quiet,
                    });
                    if r == start_rank {
                        let two = (one as i8 + push) as u8;
                        if occ & sq_bb(two) == 0 {
                            list.push(Move {
                                from,
                                to: two,
                                promotion: None,
                                kind: MoveKind::DoublePush,
                            });
                        }
                    }
                }
            }
            let attacks = t.pawn[us.idx()][from as usize];
            let mut caps = attacks & opp;
            while caps != 0 {
                let to = pop_lsb(&mut caps);
                if promotes {
                    push_promotions(list, from, to, MoveKind::Capture);
                } else {
                    list.push(Move {
                        from,
                        to,
                        promotion: None,
                        kind: MoveKind::Capture,
                    });
                }
            }
            if let Some(ep) = self.ep {
                if attacks & sq_bb(ep) != 0 {
                    list.push(Move {
                        from,
                        to: ep,
                        promotion: None,
                        kind: MoveKind::EnPassant,
                    });
                }
            }
        }

        // Pieces
        for piece in [
            Piece::Knight,
            Piece::Bishop,
            Piece::Rook,
            Piece::Queen,
            Piece::King,
        ] {
            let mut bb = self.pieces(us, piece);
            while bb != 0 {
                let from = pop_lsb(&mut bb);
                let attacks = match piece {
                    Piece::Knight => t.knight[from as usize],
                    Piece::Bishop => bishop_attacks(from, occ),
                    Piece::Rook => rook_attacks(from, occ),
                    Piece::Queen => queen_attacks(from, occ),
                    Piece::King => t.king[from as usize],
                    Piece::Pawn => unreachable!(),
                };
                let mut targets = attacks & !own;
                while targets != 0 {
                    let to = pop_lsb(&mut targets);
                    let kind = if opp & sq_bb(to) != 0 {
                        MoveKind::Capture
                    } else {
                        MoveKind::Quiet
                    };
                    list.push(Move {
                        from,
                        to,
                        promotion: None,
                        kind,
                    });
                }
            }
        }

        self.castling_moves(list, occ);
    }

    fn castling_moves(&self, list: &mut MoveList, occ: Bitboard) {
        let us = self.side;
        let them = us.other();
        let (k_right, q_right, base) = match us {
            Color::White => (CASTLE_WK, CASTLE_WQ, 0u8),
            Color::Black => (CASTLE_BK, CASTLE_BQ, 56u8),
        };
        if self.castling & (k_right | q_right) == 0 {
            return;
        }
        let e = base + 4;
        if self.is_attacked(e, them) {
            return; // cannot castle out of check
        }
        if self.castling & k_right != 0 {
            let (f, g) = (base + 5, base + 6);
            if occ & (sq_bb(f) | sq_bb(g)) == 0
                && !self.is_attacked(f, them)
                && !self.is_attacked(g, them)
            {
                list.push(Move {
                    from: e,
                    to: g,
                    promotion: None,
                    kind: MoveKind::CastleKingside,
                });
            }
        }
        if self.castling & q_right != 0 {
            let (b, c, d) = (base + 1, base + 2, base + 3);
            if occ & (sq_bb(b) | sq_bb(c) | sq_bb(d)) == 0
                && !self.is_attacked(d, them)
                && !self.is_attacked(c, them)
            {
                list.push(Move {
                    from: e,
                    to: c,
                    promotion: None,
                    kind: MoveKind::CastleQueenside,
                });
            }
        }
    }

    /// All legal moves in the position.
    pub fn legal_moves(&self) -> MoveList {
        let mut list = MoveList::new();
        self.pseudo_legal_moves(&mut list);
        let us = self.side;
        list.retain(|m| {
            let next = self.make_move(m);
            !next.is_attacked(next.king_square(us), us.other())
        });
        list
    }

    /// Is `m` (assumed pseudo-legal) legal?
    pub fn is_legal(&self, m: Move) -> bool {
        self.legal_moves().contains(&m)
    }

    /// Find the legal move matching a UCI string (`e2e4`, `e7e8q`, `e1g1`).
    pub fn parse_uci_move(&self, uci: &str) -> Option<Move> {
        let uci = uci.trim().to_ascii_lowercase();
        self.legal_moves()
            .iter()
            .copied()
            .find(|m| m.to_uci() == uci)
    }

    /// Return the position after playing `m`. `m` must be pseudo-legal for
    /// this position (as produced by the generator).
    pub fn make_move(&self, m: Move) -> Position {
        let mut p = *self;
        let us = self.side;
        let them = us.other();
        let (_, piece) = self.piece_at(m.from).expect("make_move: empty from-square");

        p.halfmove += 1;
        if m.kind == MoveKind::EnPassant {
            let cap = if us == Color::White {
                m.to - 8
            } else {
                m.to + 8
            };
            p.remove(them, Piece::Pawn, cap);
            p.halfmove = 0;
        } else if let Some((c, captured)) = self.piece_at(m.to) {
            debug_assert!(c == them, "make_move: capturing own piece");
            p.remove(c, captured, m.to);
            p.halfmove = 0;
        }

        p.remove(us, piece, m.from);
        p.put(us, m.promotion.unwrap_or(piece), m.to);
        if piece == Piece::Pawn {
            p.halfmove = 0;
        }

        let base = if us == Color::White { 0u8 } else { 56u8 };
        match m.kind {
            MoveKind::CastleKingside => {
                p.remove(us, Piece::Rook, base + 7);
                p.put(us, Piece::Rook, base + 5);
            }
            MoveKind::CastleQueenside => {
                p.remove(us, Piece::Rook, base);
                p.put(us, Piece::Rook, base + 3);
            }
            _ => {}
        }

        p.ep = if m.kind == MoveKind::DoublePush {
            Some((m.from + m.to) / 2)
        } else {
            None
        };
        p.castling &= CASTLE_MASK[m.from as usize] & CASTLE_MASK[m.to as usize];
        p.side = them;
        p.hash ^= tables().z_side;
        if us == Color::Black {
            p.fullmove += 1;
        }
        p
    }

    /// No pawns, rooks or queens, and either at most one minor piece in total
    /// or only bishops all standing on squares of one colour.
    pub fn is_insufficient_material(&self) -> bool {
        for c in [Color::White, Color::Black] {
            if self.pieces(c, Piece::Pawn)
                | self.pieces(c, Piece::Rook)
                | self.pieces(c, Piece::Queen)
                != 0
            {
                return false;
            }
        }
        let knights =
            self.pieces(Color::White, Piece::Knight) | self.pieces(Color::Black, Piece::Knight);
        let bishops =
            self.pieces(Color::White, Piece::Bishop) | self.pieces(Color::Black, Piece::Bishop);
        if (knights | bishops).count_ones() <= 1 {
            return true;
        }
        if knights == 0 {
            const LIGHT: Bitboard = 0x55AA_55AA_55AA_55AA;
            let light = bishops & LIGHT;
            return light == 0 || light == bishops;
        }
        false
    }

    // ----- FEN ------------------------------------------------------------

    pub fn from_fen(fen: &str) -> Result<Position, FenError> {
        let parts: Vec<&str> = fen.split_whitespace().collect();
        if parts.len() < 4 || parts.len() > 6 {
            return fen_err("expected 4 to 6 space-separated fields");
        }
        let mut pos = Position::empty();

        let ranks: Vec<&str> = parts[0].split('/').collect();
        if ranks.len() != 8 {
            return fen_err("placement must have 8 ranks");
        }
        for (i, rank_str) in ranks.iter().enumerate() {
            let rank = 7 - i as u8;
            let mut file = 0u8;
            for ch in rank_str.chars() {
                if let Some(d) = ch.to_digit(10) {
                    if d == 0 || d > 8 {
                        return fen_err(format!("bad empty-square count '{ch}'"));
                    }
                    file += d as u8;
                } else {
                    let (c, p) = Piece::from_char(ch)
                        .ok_or_else(|| FenError(format!("bad piece '{ch}'")))?;
                    if file >= 8 {
                        return fen_err(format!("rank {} too long", rank + 1));
                    }
                    if p == Piece::Pawn && (rank == 0 || rank == 7) {
                        return fen_err("pawn on first or last rank");
                    }
                    pos.put(c, p, rank * 8 + file);
                    file += 1;
                }
                if file > 8 {
                    return fen_err(format!("rank {} too long", rank + 1));
                }
            }
            if file != 8 {
                return fen_err(format!("rank {} has {} files", rank + 1, file));
            }
        }
        for c in [Color::White, Color::Black] {
            if pos.pieces(c, Piece::King).count_ones() != 1 {
                return fen_err("each side needs exactly one king");
            }
        }

        pos.side = match parts[1] {
            "w" => Color::White,
            "b" => Color::Black,
            s => return fen_err(format!("bad side to move '{s}'")),
        };
        if pos.side == Color::Black {
            pos.hash ^= tables().z_side;
        }

        if parts[2] != "-" {
            for ch in parts[2].chars() {
                pos.castling |= match ch {
                    'K' => CASTLE_WK,
                    'Q' => CASTLE_WQ,
                    'k' => CASTLE_BK,
                    'q' => CASTLE_BQ,
                    _ => return fen_err(format!("bad castling flag '{ch}'")),
                };
            }
        }
        // Drop rights whose king/rook are not on their original squares.
        let has = |pos: &Position, c: Color, p: Piece, sq: u8| pos.piece_at(sq) == Some((c, p));
        for (right, c, rook_sq, king_sq) in [
            (CASTLE_WK, Color::White, 7u8, 4u8),
            (CASTLE_WQ, Color::White, 0, 4),
            (CASTLE_BK, Color::Black, 63, 60),
            (CASTLE_BQ, Color::Black, 56, 60),
        ] {
            if pos.castling & right != 0
                && !(has(&pos, c, Piece::King, king_sq) && has(&pos, c, Piece::Rook, rook_sq))
            {
                pos.castling &= !right;
            }
        }

        pos.ep = if parts[3] == "-" {
            None
        } else {
            let sq = parse_square(parts[3])
                .ok_or_else(|| FenError(format!("bad en-passant square '{}'", parts[3])))?;
            let expected_rank = if pos.side == Color::White { 5 } else { 2 };
            if rank_of(sq) != expected_rank {
                return fen_err("en-passant square on wrong rank");
            }
            Some(sq)
        };

        pos.halfmove = match parts.get(4) {
            Some(s) => s
                .parse()
                .map_err(|_| FenError(format!("bad halfmove clock '{s}'")))?,
            None => 0,
        };
        pos.fullmove = match parts.get(5) {
            Some(s) => s
                .parse()
                .map_err(|_| FenError(format!("bad fullmove number '{s}'")))?,
            None => 1,
        };
        if pos.fullmove == 0 {
            pos.fullmove = 1;
        }

        if pos.is_attacked(pos.king_square(pos.side.other()), pos.side) {
            return fen_err("side not to move is in check");
        }
        Ok(pos)
    }

    pub fn to_fen(&self) -> String {
        let mut s = String::with_capacity(90);
        for rank in (0..8u8).rev() {
            let mut empty = 0;
            for file in 0..8u8 {
                match self.piece_at(rank * 8 + file) {
                    None => empty += 1,
                    Some((c, p)) => {
                        if empty > 0 {
                            s.push((b'0' + empty) as char);
                            empty = 0;
                        }
                        s.push(p.to_char(c));
                    }
                }
            }
            if empty > 0 {
                s.push((b'0' + empty) as char);
            }
            if rank > 0 {
                s.push('/');
            }
        }
        s.push(' ');
        s.push(if self.side == Color::White { 'w' } else { 'b' });
        s.push(' ');
        if self.castling == 0 {
            s.push('-');
        } else {
            for (bit, ch) in [
                (CASTLE_WK, 'K'),
                (CASTLE_WQ, 'Q'),
                (CASTLE_BK, 'k'),
                (CASTLE_BQ, 'q'),
            ] {
                if self.castling & bit != 0 {
                    s.push(ch);
                }
            }
        }
        s.push(' ');
        match self.ep {
            Some(sq) => s.push_str(&square_name(sq)),
            None => s.push('-'),
        }
        s.push_str(&format!(" {} {}", self.halfmove, self.fullmove));
        s
    }
}

impl fmt::Debug for Position {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Position({})", self.to_fen())
    }
}

impl fmt::Display for Position {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for rank in (0..8u8).rev() {
            write!(f, "{} ", rank + 1)?;
            for file in 0..8u8 {
                let ch = self
                    .piece_at(rank * 8 + file)
                    .map(|(c, p)| p.to_char(c))
                    .unwrap_or('.');
                write!(f, "{ch} ")?;
            }
            writeln!(f)?;
        }
        writeln!(f, "  a b c d e f g h")?;
        write!(f, "{}", self.to_fen())
    }
}

fn push_promotions(list: &mut MoveList, from: u8, to: u8, kind: MoveKind) {
    for p in Piece::PROMOTIONS {
        list.push(Move {
            from,
            to,
            promotion: Some(p),
            kind,
        });
    }
}

// ---------------------------------------------------------------------------
// Game state: termination and draw rules
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GameStatus {
    Ongoing,
    Checkmate {
        winner: Color,
    },
    Stalemate,
    /// 100 half-moves without a capture or pawn move (claimable draw).
    FiftyMoveRule,
    /// Current position occurred for the third time (claimable draw).
    ThreefoldRepetition,
    InsufficientMaterial,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IllegalMove(pub String);

impl fmt::Display for IllegalMove {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "illegal move: {}", self.0)
    }
}

impl std::error::Error for IllegalMove {}

/// A position plus the key history needed for repetition detection.
#[derive(Clone, Debug)]
pub struct Game {
    position: Position,
    /// Keys of all earlier positions in this game, oldest first.
    history: Vec<u64>,
}

impl Game {
    pub fn new(position: Position) -> Self {
        Game {
            position,
            history: Vec::new(),
        }
    }

    pub fn from_fen(fen: &str) -> Result<Self, FenError> {
        Ok(Self::new(Position::from_fen(fen)?))
    }

    #[inline]
    pub fn position(&self) -> &Position {
        &self.position
    }

    pub fn play(&mut self, m: Move) -> Result<(), IllegalMove> {
        if !self.position.is_legal(m) {
            return Err(IllegalMove(m.to_uci()));
        }
        self.history.push(self.position.key());
        self.position = self.position.make_move(m);
        Ok(())
    }

    pub fn play_uci(&mut self, uci: &str) -> Result<Move, IllegalMove> {
        let m = self
            .position
            .parse_uci_move(uci)
            .ok_or_else(|| IllegalMove(uci.to_string()))?;
        self.play(m)?;
        Ok(m)
    }

    /// How many times the current position has occurred (including now).
    /// Only positions since the last irreversible move can repeat.
    pub fn repetition_count(&self) -> usize {
        let key = self.position.key();
        let window = self.position.halfmove as usize;
        1 + self
            .history
            .iter()
            .rev()
            .take(window)
            .filter(|&&k| k == key)
            .count()
    }

    pub fn status(&self) -> GameStatus {
        let pos = &self.position;
        if pos.legal_moves().is_empty() {
            return if pos.in_check() {
                GameStatus::Checkmate {
                    winner: pos.side.other(),
                }
            } else {
                GameStatus::Stalemate
            };
        }
        if pos.is_insufficient_material() {
            return GameStatus::InsufficientMaterial;
        }
        if pos.halfmove >= 100 {
            return GameStatus::FiftyMoveRule;
        }
        if self.repetition_count() >= 3 {
            return GameStatus::ThreefoldRepetition;
        }
        GameStatus::Ongoing
    }
}

// ---------------------------------------------------------------------------
// Perft
// ---------------------------------------------------------------------------

/// Number of leaf nodes of the legal move tree to `depth` plies.
pub fn perft(pos: &Position, depth: u32) -> u64 {
    if depth == 0 {
        return 1;
    }
    let moves = pos.legal_moves();
    if depth == 1 {
        return moves.len() as u64;
    }
    moves
        .iter()
        .map(|&m| perft(&pos.make_move(m), depth - 1))
        .sum()
}

/// Per-root-move perft counts (for debugging against a reference).
pub fn divide(pos: &Position, depth: u32) -> Vec<(Move, u64)> {
    assert!(depth >= 1, "divide needs depth >= 1");
    pos.legal_moves()
        .iter()
        .map(|&m| (m, perft(&pos.make_move(m), depth - 1)))
        .collect()
}

/// A Perft regression case: `(name, fen, [(depth, expected_nodes), ...])`.
pub type PerftCase = (&'static str, &'static str, &'static [(u32, u64)]);

/// Publicly documented Perft reference counts for standard test positions.
pub const PERFT_SUITE: &[PerftCase] = &[
    (
        "startpos",
        START_FEN,
        &[(1, 20), (2, 400), (3, 8_902), (4, 197_281), (5, 4_865_609)],
    ),
    (
        "kiwipete",
        "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
        &[(1, 48), (2, 2_039), (3, 97_862), (4, 4_085_603)],
    ),
    (
        "position3-ep-pins",
        "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
        &[(1, 14), (2, 191), (3, 2_812), (4, 43_238), (5, 674_624)],
    ),
    (
        "position4-promotions",
        "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
        &[(1, 6), (2, 264), (3, 9_467), (4, 422_333)],
    ),
    (
        "position4-mirrored",
        "r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1",
        &[(1, 6), (2, 264), (3, 9_467), (4, 422_333)],
    ),
    (
        "position5",
        "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
        &[(1, 44), (2, 1_486), (3, 62_379), (4, 2_103_487)],
    ),
    (
        "position6",
        "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
        &[(1, 46), (2, 2_079), (3, 89_890), (4, 3_894_594)],
    ),
    (
        "illegal-ep-1",
        "3k4/3p4/8/K1P4r/8/8/8/8 b - - 0 1",
        &[(6, 1_134_888)],
    ),
    (
        "illegal-ep-2",
        "8/8/4k3/8/2p5/8/B2P2K1/8 w - - 0 1",
        &[(6, 1_015_133)],
    ),
    (
        "ep-gives-check",
        "8/8/1k6/2b5/2pP4/8/5K2/8 b - d3 0 1",
        &[(6, 1_440_467)],
    ),
    (
        "short-castle-check",
        "5k2/8/8/8/8/8/8/4K2R w K - 0 1",
        &[(6, 661_072)],
    ),
    (
        "long-castle-check",
        "3k4/8/8/8/8/8/8/R3K3 w Q - 0 1",
        &[(6, 803_711)],
    ),
    (
        "castle-rights",
        "r3k2r/1b4bq/8/8/8/8/7B/R3K2R w KQkq - 0 1",
        &[(4, 1_274_206)],
    ),
    (
        "castle-prevented",
        "r3k2r/8/3Q4/8/8/5q2/8/R3K2R b KQkq - 0 1",
        &[(4, 1_720_476)],
    ),
    (
        "promote-out-of-check",
        "2K2r2/4P3/8/8/8/8/8/3k4 w - - 0 1",
        &[(6, 3_821_001)],
    ),
    (
        "discovered-check",
        "8/8/1P2K3/8/2n5/1q6/8/5k2 b - - 0 1",
        &[(5, 1_004_658)],
    ),
    (
        "promote-gives-check",
        "4k3/1P6/8/8/8/8/K7/8 w - - 0 1",
        &[(6, 217_342)],
    ),
    (
        "underpromote-check",
        "8/P1k5/K7/8/8/8/8/8 w - - 0 1",
        &[(6, 92_683)],
    ),
    (
        "self-stalemate",
        "K1k5/8/P7/8/8/8/8/8 w - - 0 1",
        &[(6, 2_217)],
    ),
    (
        "stalemate-checkmate-1",
        "8/k1P5/8/1K6/8/8/8/8 w - - 0 1",
        &[(7, 567_584)],
    ),
    (
        "stalemate-checkmate-2",
        "8/8/2k5/5q2/5n2/8/5K2/8 b - - 0 1",
        &[(4, 23_527)],
    ),
];
