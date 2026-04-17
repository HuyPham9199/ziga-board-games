/**
 * ZIGA Chess Engine – Full rules implementation
 * Board: row 0 = rank 8 (black back rank), row 7 = rank 1 (white back rank)
 * Pieces: 'wK','wQ','wR','wB','wN','wP' / 'bK','bQ','bR','bB','bN','bP'
 * Supports: all legal moves, castling, en passant, promotion, check/checkmate/stalemate
 */
'use strict';

const CHESS_VALS = { P:100, N:320, B:330, R:500, Q:900, K:20000 };

// Position bonus tables (from white's perspective, row 0 = white back rank mirrored)
const POS_BONUS = {
  P: [[0,0,0,0,0,0,0,0],[50,50,50,50,50,50,50,50],[10,10,20,30,30,20,10,10],
      [5,5,10,25,25,10,5,5],[0,0,0,20,20,0,0,0],[5,-5,-10,0,0,-10,-5,5],
      [5,10,10,-20,-20,10,10,5],[0,0,0,0,0,0,0,0]],
  N: [[-50,-40,-30,-30,-30,-30,-40,-50],[-40,-20,0,0,0,0,-20,-40],
      [-30,0,10,15,15,10,0,-30],[-30,5,15,20,20,15,5,-30],
      [-30,0,15,20,20,15,0,-30],[-30,5,10,15,15,10,5,-30],
      [-40,-20,0,5,5,0,-20,-40],[-50,-40,-30,-30,-30,-30,-40,-50]],
  B: [[-20,-10,-10,-10,-10,-10,-10,-20],[-10,0,0,0,0,0,0,-10],
      [-10,0,5,10,10,5,0,-10],[-10,5,5,10,10,5,5,-10],
      [-10,0,10,10,10,10,0,-10],[-10,10,10,10,10,10,10,-10],
      [-10,5,0,0,0,0,5,-10],[-20,-10,-10,-10,-10,-10,-10,-20]],
  R: [[0,0,0,0,0,0,0,0],[5,10,10,10,10,10,10,5],[-5,0,0,0,0,0,0,-5],
      [-5,0,0,0,0,0,0,-5],[-5,0,0,0,0,0,0,-5],[-5,0,0,0,0,0,0,-5],
      [-5,0,0,0,0,0,0,-5],[0,0,0,5,5,0,0,0]],
  Q: [[-20,-10,-10,-5,-5,-10,-10,-20],[-10,0,0,0,0,0,0,-10],
      [-10,0,5,5,5,5,0,-10],[-5,0,5,5,5,5,0,-5],
      [0,0,5,5,5,5,0,-5],[-10,5,5,5,5,5,0,-10],
      [-10,0,5,0,0,0,0,-10],[-20,-10,-10,-5,-5,-10,-10,-20]],
  K: [[-30,-40,-40,-50,-50,-40,-40,-30],[-30,-40,-40,-50,-50,-40,-40,-30],
      [-30,-40,-40,-50,-50,-40,-40,-30],[-30,-40,-40,-50,-50,-40,-40,-30],
      [-20,-30,-30,-40,-40,-30,-30,-20],[-10,-20,-20,-20,-20,-20,-20,-10],
      [20,20,0,0,0,0,20,20],[20,30,10,0,0,10,30,20]],
};

class ChessEngine {
  constructor() {
    this.board    = this._initBoard();
    this.current  = 'w';
    this.castling = { wK:true, wQ:true, bK:true, bQ:true };
    this.enPassant = null;   // [row, col] square pawn can be captured on
    this.halfMoves = 0;
    this.fullMoves = 1;
    this.history   = [];
    this.gameOver  = false;
    this.result    = null;   // 'w' | 'b' | 'draw'
    this.inCheck   = false;
  }

  _initBoard() {
    const b    = Array(8).fill(null).map(() => Array(8).fill(null));
    const back = ['R','N','B','Q','K','B','N','R'];
    for (let c = 0; c < 8; c++) {
      b[0][c] = 'b' + back[c];
      b[1][c] = 'bP';
      b[6][c] = 'wP';
      b[7][c] = 'w' + back[c];
    }
    return b;
  }

  _inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
  _col(p) { return p ? p[0] : null; }
  _type(p) { return p ? p[1] : null; }
  _opp(color) { return color === 'w' ? 'b' : 'w'; }

  /* ── Pseudo-legal moves (doesn't check own king in check) ── */
  _pseudoMoves(r, c) {
    const piece = this.board[r][c];
    if (!piece) return [];
    const color = piece[0];
    const type  = piece[1];
    const opp   = this._opp(color);
    const moves = [];

    const push = (tr, tc, extra = {}) => {
      if (!this._inBounds(tr, tc)) return false;
      const tgt = this.board[tr][tc];
      if (tgt && tgt[0] === color) return false;
      moves.push({ from:[r,c], to:[tr,tc], piece, captured: tgt || null, ...extra });
      return !tgt; // true = square was empty → can continue sliding
    };

    const slide = (dr, dc) => {
      for (let i = 1; i < 8; i++) { if (!push(r+dr*i, c+dc*i)) break; }
    };

    if (type === 'P') {
      const dir      = color === 'w' ? -1 : 1;
      const startRow = color === 'w' ? 6 : 1;
      const promoRow = color === 'w' ? 0 : 7;
      // Forward
      if (this._inBounds(r+dir, c) && !this.board[r+dir][c]) {
        const promo = r+dir === promoRow;
        moves.push({ from:[r,c], to:[r+dir,c], piece, captured:null, promo });
        if (r === startRow && !this.board[r+dir*2][c])
          moves.push({ from:[r,c], to:[r+dir*2,c], piece, captured:null, doublePush:true });
      }
      // Diagonal captures + en passant
      for (const dc of [-1, 1]) {
        const tr = r+dir, tc = c+dc;
        if (!this._inBounds(tr, tc)) continue;
        const tgt = this.board[tr][tc];
        if (tgt && tgt[0] === opp)
          moves.push({ from:[r,c], to:[tr,tc], piece, captured:tgt, promo: tr===promoRow });
        if (this.enPassant && tr===this.enPassant[0] && tc===this.enPassant[1])
          moves.push({ from:[r,c], to:[tr,tc], piece, captured:null, enPassant:true });
      }
    }
    else if (type === 'N') {
      for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])
        push(r+dr, c+dc);
    }
    else if (type === 'B') { for (const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) slide(dr,dc); }
    else if (type === 'R') { for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]])   slide(dr,dc); }
    else if (type === 'Q') {
      for (const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]) slide(dr,dc);
    }
    else if (type === 'K') {
      for (const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) push(r+dr,c+dc);
      // Castling
      const rank = color === 'w' ? 7 : 0;
      if (r === rank) {
        const kKey = color+'K', qKey = color+'Q';
        if (this.castling[kKey] && !this.board[rank][5] && !this.board[rank][6]
            && this.board[rank][7] === color+'R')
          moves.push({ from:[r,c], to:[rank,6], piece, captured:null, castle:'K' });
        if (this.castling[qKey] && !this.board[rank][3] && !this.board[rank][2]
            && !this.board[rank][1] && this.board[rank][0] === color+'R')
          moves.push({ from:[r,c], to:[rank,2], piece, captured:null, castle:'Q' });
      }
    }
    return moves;
  }

  /* ── Apply move to a board copy ── */
  _applyMove(board, castling, enPassant, move, promoTo='Q') {
    const b   = board.map(r => [...r]);
    const c2  = { ...castling };
    const [fr,fc] = move.from;
    const [tr,tc] = move.to;
    const piece   = b[fr][fc];
    const color   = piece[0];
    let   newEP   = null;

    b[tr][tc] = piece;
    b[fr][fc] = null;

    if (move.enPassant) {
      const capRow = color === 'w' ? tr+1 : tr-1;
      b[capRow][tc] = null;
    }
    if (move.doublePush) {
      newEP = [color === 'w' ? tr+1 : tr-1, tc];
    }
    if (move.promo) {
      b[tr][tc] = color + promoTo;
    }
    if (move.castle === 'K') {
      const rank = color === 'w' ? 7 : 0;
      b[rank][5] = color+'R'; b[rank][7] = null;
    }
    if (move.castle === 'Q') {
      const rank = color === 'w' ? 7 : 0;
      b[rank][3] = color+'R'; b[rank][0] = null;
    }
    // Update castling rights
    if (piece === 'wK') { c2.wK=false; c2.wQ=false; }
    if (piece === 'bK') { c2.bK=false; c2.bQ=false; }
    if (piece==='wR' && fr===7 && fc===7) c2.wK=false;
    if (piece==='wR' && fr===7 && fc===0) c2.wQ=false;
    if (piece==='bR' && fr===0 && fc===7) c2.bK=false;
    if (piece==='bR' && fr===0 && fc===0) c2.bQ=false;
    // Also remove castling if rook captured
    if (move.captured === 'wR') {
      if (tr===7 && tc===7) c2.wK=false;
      if (tr===7 && tc===0) c2.wQ=false;
    }
    if (move.captured === 'bR') {
      if (tr===0 && tc===7) c2.bK=false;
      if (tr===0 && tc===0) c2.bQ=false;
    }
    return { board:b, castling:c2, enPassant:newEP };
  }

  /* ── Is color's king attacked? ── */
  isInCheck(color, board = this.board) {
    let kr=-1, kc=-1;
    for (let r=0;r<8;r++) for(let c=0;c<8;c++)
      if (board[r][c] === color+'K') { kr=r; kc=c; }
    if (kr<0) return false;

    const opp = this._opp(color);
    const origBoard = this.board;
    this.board = board; // temporarily swap for _pseudoMoves

    let attacked = false;
    outer: for (let r=0;r<8;r++) {
      for (let c=0;c<8;c++) {
        if (!board[r][c] || board[r][c][0]!==opp) continue;
        for (const m of this._pseudoMoves(r,c)) {
          if (m.to[0]===kr && m.to[1]===kc) { attacked=true; break outer; }
        }
      }
    }
    this.board = origBoard;
    return attacked;
  }

  /* ── All legal moves for current player ── */
  getLegalMoves() {
    const color = this.current;
    const legal = [];

    for (let r=0;r<8;r++) {
      for (let c=0;c<8;c++) {
        if (!this.board[r][c] || this.board[r][c][0]!==color) continue;
        for (const move of this._pseudoMoves(r,c)) {
          // Castling: extra checks
          if (move.castle) {
            if (this.isInCheck(color)) continue; // can't castle while in check
            const dir   = move.castle==='K' ? 1 : -1;
            const [kr,kc] = move.from;
            // King passes through this square
            const { board:b2 } = this._applyMove(
              this.board, this.castling, this.enPassant,
              { from:[kr,kc], to:[kr,kc+dir], piece:this.board[kr][kc], captured:null }
            );
            if (this.isInCheck(color, b2)) continue;
          }

          const { board:newB } = this._applyMove(
            this.board, this.castling, this.enPassant, move
          );
          if (!this.isInCheck(color, newB)) legal.push(move);
        }
      }
    }
    return legal;
  }

  /* ── Make a move (returns move obj or null if illegal) ── */
  move(from, to, promoTo='Q') {
    const [fr,fc] = from;
    const [tr,tc] = to;
    const legal   = this.getLegalMoves();
    let found     = legal.find(m=>m.from[0]===fr&&m.from[1]===fc&&m.to[0]===tr&&m.to[1]===tc);
    if (!found) return null;
    if (found.promo && !found.promoTo) found = { ...found, promoTo };

    // Save snapshot
    const snap = {
      board:     this.board.map(r=>[...r]),
      current:   this.current,
      castling:  { ...this.castling },
      enPassant: this.enPassant,
      halfMoves: this.halfMoves,
      fullMoves: this.fullMoves,
      inCheck:   this.inCheck,
      gameOver:  this.gameOver,
      result:    this.result,
    };

    const res = this._applyMove(this.board, this.castling, this.enPassant, found, found.promoTo||promoTo);
    this.board     = res.board;
    this.castling  = res.castling;
    this.enPassant = res.enPassant;

    if (found.captured || this._type(found.piece)==='P') this.halfMoves=0;
    else this.halfMoves++;
    if (this.current==='b') this.fullMoves++;

    this.current = this._opp(this.current);
    this.inCheck = this.isInCheck(this.current);
    this.history.push({ move:found, snap });

    // Game-over check
    const next = this.getLegalMoves();
    if (!next.length) {
      this.gameOver = true;
      this.result   = this.inCheck ? this._opp(this.current) : 'draw';
    } else if (this.halfMoves >= 100) {
      this.gameOver = true; this.result = 'draw';
    }
    return found;
  }

  /* ── Undo ── */
  undo() {
    if (!this.history.length) return false;
    const { snap } = this.history.pop();
    Object.assign(this, snap);
    return true;
  }

  /* ── Serialise ── */
  toJSON() {
    return {
      board:     this.board,
      current:   this.current,
      castling:  this.castling,
      enPassant: this.enPassant,
      halfMoves: this.halfMoves,
      fullMoves: this.fullMoves,
      gameOver:  this.gameOver,
      result:    this.result,
    };
  }
  fromJSON(d) {
    this.board     = d.board.map(r=>[...r]);
    this.current   = d.current;
    this.castling  = d.castling;
    this.enPassant = d.enPassant || null;
    this.halfMoves = d.halfMoves||0;
    this.fullMoves = d.fullMoves||1;
    this.gameOver  = d.gameOver||false;
    this.result    = d.result||null;
    this.inCheck   = this.isInCheck(this.current);
  }

  /* ── Piece static evaluation ── */
  evaluate() {
    let score = 0;
    for (let r=0;r<8;r++) for(let c=0;c<8;c++) {
      const p = this.board[r][c];
      if (!p) continue;
      const val = CHESS_VALS[p[1]]||0;
      // Positional bonus: white reads table normally, black mirrors
      const tableRow = p[0]==='w' ? 7-r : r;
      const bonus = (POS_BONUS[p[1]]||POS_BONUS.K)[tableRow][c];
      score += (p[0]==='w'?1:-1) * (val + bonus);
    }
    return score;
  }

  /* ── Helpers ── */
  reset() { Object.assign(this, new ChessEngine()); }
  clone() {
    const c = new ChessEngine();
    c.board     = this.board.map(r=>[...r]);
    c.current   = this.current;
    c.castling  = { ...this.castling };
    c.enPassant = this.enPassant;
    c.halfMoves = this.halfMoves;
    c.fullMoves = this.fullMoves;
    c.inCheck   = this.inCheck;
    c.gameOver  = this.gameOver;
    c.result    = this.result;
    c.history   = [];
    return c;
  }
}

window.ChessEngine = ChessEngine;
window.CHESS_VALS  = CHESS_VALS;
