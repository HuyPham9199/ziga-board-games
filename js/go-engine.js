/**
 * ZIGA Go Engine – Full rules implementation
 * Supports: 9x9, 13x13, 19x19
 * Rules: captures, ko, suicide prevention, territory scoring (Japanese)
 */
'use strict';

const EMPTY = 0, BLACK = 1, WHITE = 2;

class GoEngine {
  constructor(size = 19, komi = 6.5) {
    this.size   = size;
    this.komi   = komi;
    this.board  = this._emptyBoard();
    this.current = BLACK;           // who moves next
    this.captures = { [BLACK]: 0, [WHITE]: 0 }; // stones each player captured
    this.koPoint   = null;           // {x,y} or null
    this.prevBoard = null;           // board BEFORE last move (for ko check)
    this.history   = [];             // [{x,y,color,captured:[],ko}]
    this.passCount = 0;
    this.gameOver  = false;
    this.lastMove  = null;
  }

  /* ── helpers ─────────────────────────────────── */
  _emptyBoard() {
    return Array.from({ length: this.size }, () => new Uint8Array(this.size));
  }
  _copyBoard(b) {
    return b.map(row => row.slice());
  }
  _boardsEqual(a, b) {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (a[y][x] !== b[y][x]) return false;
    return true;
  }
  _neighbors(x, y) {
    const n = [];
    if (x > 0)            n.push([x-1, y]);
    if (x < this.size-1)  n.push([x+1, y]);
    if (y > 0)            n.push([x, y-1]);
    if (y < this.size-1)  n.push([x, y+1]);
    return n;
  }

  /* ── group analysis (on arbitrary board) ─────── */
  _group(board, x, y) {
    const color = board[y][x];
    if (!color) return { stones: [], liberties: new Set() };
    const visited  = new Set();
    const liberties = new Set();
    const stones   = [];
    const stack    = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      const key = cy * this.size + cx;
      if (visited.has(key)) continue;
      visited.add(key);
      stones.push([cx, cy]);
      for (const [nx, ny] of this._neighbors(cx, cy)) {
        const c = board[ny][nx];
        if (c === EMPTY) {
          liberties.add(ny * this.size + nx);
        } else if (c === color) {
          const nk = ny * this.size + nx;
          if (!visited.has(nk)) stack.push([nx, ny]);
        }
      }
    }
    return { stones, liberties };
  }

  /* ── move validation ─────────────────────────── */
  isValid(x, y, color) {
    if (x < 0 || x >= this.size || y < 0 || y >= this.size) return false;
    if (this.board[y][x] !== EMPTY) return false;
    // Ko restriction
    if (this.koPoint && this.koPoint.x === x && this.koPoint.y === y) return false;

    const opponent = color === BLACK ? WHITE : BLACK;
    const testBoard = this._copyBoard(this.board);
    testBoard[y][x] = color;

    // Remove captured enemy groups
    let anyCapture = false;
    for (const [nx, ny] of this._neighbors(x, y)) {
      if (testBoard[ny][nx] === opponent) {
        const g = this._group(testBoard, nx, ny);
        if (g.liberties.size === 0) {
          anyCapture = true;
          for (const [sx, sy] of g.stones) testBoard[sy][sx] = EMPTY;
        }
      }
    }

    // Suicide check
    const own = this._group(testBoard, x, y);
    if (own.liberties.size === 0) return false;  // suicide

    // Ko check: would recreate prev board state?
    if (this.prevBoard && this._boardsEqual(testBoard, this.prevBoard)) return false;

    return true;
  }

  /* ── place stone ──────────────────────────────── */
  place(x, y) {
    const color    = this.current;
    const opponent = color === BLACK ? WHITE : BLACK;

    if (!this.isValid(x, y, color)) return null;

    // Save state for undo
    const prevSnap  = this._copyBoard(this.board);
    const prevKo    = this.koPoint;
    const prevCaps  = { ...this.captures };

    this.prevBoard = prevSnap;          // for ko detection
    this.board[y][x] = color;
    this.koPoint = null;

    // Capture
    const capturedStones = [];
    for (const [nx, ny] of this._neighbors(x, y)) {
      if (this.board[ny][nx] === opponent) {
        const g = this._group(this.board, nx, ny);
        if (g.liberties.size === 0) {
          for (const [sx, sy] of g.stones) {
            this.board[sy][sx] = EMPTY;
            capturedStones.push([sx, sy]);
          }
        }
      }
    }
    this.captures[color] += capturedStones.length;

    // Ko: if exactly 1 captured and own group has exactly 1 stone with 1 liberty
    if (capturedStones.length === 1) {
      const own = this._group(this.board, x, y);
      if (own.stones.length === 1 && own.liberties.size === 1) {
        const [kx, ky] = capturedStones[0];
        this.koPoint = { x: kx, y: ky };
      }
    }

    this.passCount = 0;
    this.lastMove  = { x, y, color };
    this.history.push({ x, y, color, captured: capturedStones, prevBoard: prevSnap, prevKo, prevCaps });
    this.current = opponent;

    return { x, y, color, captured: capturedStones };
  }

  /* ── pass ─────────────────────────────────────── */
  pass() {
    this.passCount++;
    this.history.push({ pass: true, color: this.current, prevBoard: this._copyBoard(this.board), prevKo: this.koPoint, prevCaps: { ...this.captures } });
    this.prevBoard = null;
    this.koPoint   = null;
    this.lastMove  = { pass: true, color: this.current };
    this.current   = this.current === BLACK ? WHITE : BLACK;
    if (this.passCount >= 2) this.gameOver = true;
    return true;
  }

  /* ── undo ─────────────────────────────────────── */
  undo() {
    if (!this.history.length) return false;
    const last = this.history.pop();
    this.board     = last.prevBoard;
    this.koPoint   = last.prevKo;
    this.captures  = last.prevCaps;
    this.current   = last.color;      // revert to the player who made this move
    this.passCount = 0;
    this.gameOver  = false;
    this.lastMove  = this.history.length ? this.history[this.history.length-1] : null;
    return true;
  }

  /* ── scoring (Japanese rules) ─────────────────── */
  score() {
    // Territory: flood fill empty intersections
    const territory = { [BLACK]: 0, [WHITE]: 0, neutral: 0 };
    const stones    = { [BLACK]: 0, [WHITE]: 0 };
    const terrMap   = Array.from({ length: this.size }, () => new Uint8Array(this.size)); // 0=unset,1=B,2=W,3=neutral

    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (this.board[y][x]) stones[this.board[y][x]]++;

    const visited = new Uint8Array(this.size * this.size);

    for (let sy = 0; sy < this.size; sy++) {
      for (let sx = 0; sx < this.size; sx++) {
        const idx = sy * this.size + sx;
        if (this.board[sy][sx] !== EMPTY || visited[idx]) continue;

        // BFS for empty region
        const region = [];
        const borders = new Set();
        const queue = [[sx, sy]];
        const rvis = new Uint8Array(this.size * this.size);

        while (queue.length) {
          const [cx, cy] = queue.shift();
          const ci = cy * this.size + cx;
          if (rvis[ci]) continue;
          rvis[ci] = 1; visited[ci] = 1;
          region.push([cx, cy]);
          for (const [nx, ny] of this._neighbors(cx, cy)) {
            const ni = ny * this.size + nx;
            if (this.board[ny][nx] === EMPTY && !rvis[ni]) queue.push([nx, ny]);
            else if (this.board[ny][nx]) borders.add(this.board[ny][nx]);
          }
        }

        let owner = 0;
        if (borders.size === 1) owner = [...borders][0];

        for (const [rx, ry] of region) {
          terrMap[ry][rx] = owner || 3;
          if (owner) territory[owner]++;
          else territory.neutral++;
        }
      }
    }

    // Japanese: territory + captured
    const blackScore = territory[BLACK] + this.captures[BLACK];
    const whiteScore = territory[WHITE] + this.captures[WHITE] + this.komi;

    return {
      black: blackScore,
      white: whiteScore,
      territory: territory,
      territoryMap: terrMap,
      stones,
      captures: { ...this.captures },
      winner: blackScore > whiteScore ? BLACK : WHITE,
      margin: Math.abs(blackScore - whiteScore)
    };
  }

  /* ── utility: list all legal moves ───────────── */
  legalMoves(color) {
    const moves = [];
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (this.isValid(x, y, color)) moves.push([x, y]);
    return moves;
  }

  /* ── reset ────────────────────────────────────── */
  reset() {
    this.board     = this._emptyBoard();
    this.current   = BLACK;
    this.captures  = { [BLACK]: 0, [WHITE]: 0 };
    this.koPoint   = null;
    this.prevBoard = null;
    this.history   = [];
    this.passCount = 0;
    this.gameOver  = false;
    this.lastMove  = null;
  }

  /* ── serialise for Firestore ──────────────────── */
  toJSON() {
    return {
      board: this.board.map(r => Array.from(r)),
      current: this.current,
      captures: this.captures,
      koPoint: this.koPoint,
      passCount: this.passCount,
      gameOver: this.gameOver,
      history: this.history.map(h => ({
        x: h.x, y: h.y, color: h.color,
        pass: h.pass || false,
        captured: h.captured || []
      }))
    };
  }

  fromJSON(data) {
    this.board     = data.board.map(r => Uint8Array.from(r));
    this.current   = data.current;
    this.captures  = data.captures;
    this.koPoint   = data.koPoint || null;
    this.passCount = data.passCount || 0;
    this.gameOver  = data.gameOver || false;
  }
}

/* expose globally */
window.GoEngine = GoEngine;
window.BLACK = BLACK;
window.WHITE = WHITE;
window.EMPTY = EMPTY;
