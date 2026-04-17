/**
 * ZIGA Go Bot – 3 difficulty levels
 *   EASY   : weighted random (prefers captures, avoids self-atari)
 *   MEDIUM : pattern-based heuristics + capture/defense
 *   HARD   : simplified Monte Carlo Tree Search (MCTS, ~100 playouts)
 */
'use strict';

class GoBot {
  constructor(difficulty = 'medium') {
    this.difficulty = difficulty; // 'easy' | 'medium' | 'hard'
    this._busy = false;
  }

  /* ── public entry point ───────────────────────── */
  async getMove(engine) {
    if (this._busy) return null;
    this._busy = true;
    // Small delay so UI renders the opponent "thinking"
    await this._sleep(this.difficulty === 'hard' ? 600 : 300);
    let move;
    try {
      switch (this.difficulty) {
        case 'easy':   move = this._easyMove(engine);  break;
        case 'medium': move = this._mediumMove(engine); break;
        case 'hard':   move = this._hardMove(engine);  break;
        default:       move = this._mediumMove(engine);
      }
    } finally {
      this._busy = false;
    }
    return move; // { x, y } or null for pass
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ═══════════════ EASY ═══════════════ */
  _easyMove(engine) {
    const color = engine.current;
    const moves = engine.legalMoves(color);
    if (!moves.length) return null; // pass

    // Filter out suicidal-looking moves (self-atari of 1-stone groups)
    const safe = moves.filter(([x,y]) => !this._isSelfAtari(engine, x, y, color));
    const pool = safe.length > 3 ? safe : moves;

    // 20% chance to capture an opponent stone if available
    const captures = pool.filter(([x,y]) => this._wouldCapture(engine, x, y, color));
    if (captures.length && Math.random() < 0.2) {
      return this._pick(captures);
    }

    return this._pick(pool);
  }

  /* ═══════════════ MEDIUM ═══════════════ */
  _mediumMove(engine) {
    const color = engine.current;
    const opp   = color === BLACK ? WHITE : BLACK;
    const moves = engine.legalMoves(color);
    if (!moves.length) return null;

    const scored = moves.map(([x,y]) => ({ x, y, score: this._evalMove(engine, x, y, color) }));
    scored.sort((a,b) => b.score - a.score);

    // Pick from top-5 with some randomness
    const topK = Math.min(5, scored.length);
    const top  = scored.slice(0, topK);
    // Weighted random among top
    const total = top.reduce((s,m) => s + Math.max(0, m.score) + 1, 0);
    let r = Math.random() * total;
    for (const m of top) {
      r -= (Math.max(0, m.score) + 1);
      if (r <= 0) return { x: m.x, y: m.y };
    }
    return { x: top[0].x, y: top[0].y };
  }

  _evalMove(engine, x, y, color) {
    let score = 0;
    const opp = color === BLACK ? WHITE : BLACK;
    const size = engine.size;

    // Capture score
    const captured = this._countCapture(engine, x, y, color);
    score += captured * 15;

    // Save own group in atari
    if (this._savesAtari(engine, x, y, color)) score += 12;

    // Put opponent in atari
    if (this._putsInAtari(engine, x, y, color)) score += 8;

    // Avoid self-atari
    if (this._isSelfAtari(engine, x, y, color)) score -= 20;

    // Prefer center on small boards
    const cx = (size-1)/2, cy = (size-1)/2;
    const dist = Math.sqrt((x-cx)**2 + (y-cy)**2);
    score += Math.max(0, (size/2) - dist) * 0.4;

    // Avoid edges early game
    const moveNum = engine.history.length;
    if (moveNum < size * 2) {
      if (x === 0 || x === size-1 || y === 0 || y === size-1) score -= 5;
    }

    // Connectivity: prefer adjacent to own stones
    for (const [nx, ny] of engine._neighbors(x, y)) {
      if (engine.board[ny][nx] === color) score += 2;
    }

    // Territory expansion heuristic
    const emptyNeighbors = engine._neighbors(x, y).filter(([nx,ny]) => engine.board[ny][nx] === EMPTY).length;
    score += emptyNeighbors * 0.5;

    return score;
  }

  /* ═══════════════ HARD (MCTS) ═══════════════ */
  _hardMove(engine) {
    const color  = engine.current;
    const moves  = engine.legalMoves(color);
    if (!moves.length) return null;

    const PLAYOUTS = 80;
    const scores   = new Map();

    for (const [x, y] of moves) {
      let wins = 0;
      for (let i = 0; i < PLAYOUTS; i++) {
        const clone = this._cloneEngine(engine);
        clone.place(x, y);
        wins += this._randomPlayout(clone, color);
      }
      scores.set(`${x},${y}`, wins);
    }

    // Best move
    let best = null, bestScore = -Infinity;
    for (const [x,y] of moves) {
      const s = scores.get(`${x},${y}`);
      if (s > bestScore) { bestScore = s; best = { x, y }; }
    }

    // If all playouts look bad, pass (rare)
    if (bestScore < PLAYOUTS * 0.15) {
      // Consider passing only in endgame
      if (engine.history.length > engine.size * engine.size * 0.5) return null;
    }

    return best;
  }

  _randomPlayout(engine, rootColor) {
    const maxMoves = engine.size * engine.size * 2;
    let passes = 0;
    for (let i = 0; i < maxMoves; i++) {
      if (engine.gameOver) break;
      const moves = engine.legalMoves(engine.current);
      // Filter self-atari for slightly smarter playout
      const safe = moves.filter(([x,y]) => !this._isSelfAtari(engine, x, y, engine.current));
      const pool = safe.length ? safe : moves;
      if (!pool.length) {
        engine.pass();
        passes++;
        if (passes >= 2) break;
      } else {
        passes = 0;
        const [x, y] = pool[Math.floor(Math.random() * pool.length)];
        engine.place(x, y);
      }
    }
    const result = engine.score();
    return result.winner === rootColor ? 1 : 0;
  }

  _cloneEngine(engine) {
    const clone = new GoEngine(engine.size, engine.komi);
    clone.board     = engine._copyBoard(engine.board);
    clone.current   = engine.current;
    clone.captures  = { ...engine.captures };
    clone.koPoint   = engine.koPoint ? { ...engine.koPoint } : null;
    clone.prevBoard = engine.prevBoard ? engine._copyBoard(engine.prevBoard) : null;
    clone.passCount = engine.passCount;
    clone.gameOver  = engine.gameOver;
    clone.history   = [];   // shallow – we don't need undo in clone
    return clone;
  }

  /* ═══════════════ HELPERS ═══════════════ */
  _pick(arr) {
    if (!arr.length) return null;
    const [x, y] = arr[Math.floor(Math.random() * arr.length)];
    return { x, y };
  }

  _isSelfAtari(engine, x, y, color) {
    const testBoard = engine._copyBoard(engine.board);
    testBoard[y][x] = color;
    const opp = color === BLACK ? WHITE : BLACK;
    // Remove captures first
    for (const [nx,ny] of engine._neighbors(x, y)) {
      if (testBoard[ny][nx] === opp) {
        const g = engine._group(testBoard, nx, ny);
        if (g.liberties.size === 0) {
          for (const [sx,sy] of g.stones) testBoard[sy][sx] = EMPTY;
        }
      }
    }
    const own = engine._group(testBoard, x, y);
    return own.liberties.size === 1;
  }

  _wouldCapture(engine, x, y, color) {
    return this._countCapture(engine, x, y, color) > 0;
  }

  _countCapture(engine, x, y, color) {
    const opp = color === BLACK ? WHITE : BLACK;
    const testBoard = engine._copyBoard(engine.board);
    testBoard[y][x] = color;
    let count = 0;
    for (const [nx,ny] of engine._neighbors(x, y)) {
      if (testBoard[ny][nx] === opp) {
        const g = engine._group(testBoard, nx, ny);
        if (g.liberties.size === 0) count += g.stones.length;
      }
    }
    return count;
  }

  _savesAtari(engine, x, y, color) {
    // Check if any adjacent own group is in atari and placing here adds a liberty
    for (const [nx, ny] of engine._neighbors(x, y)) {
      if (engine.board[ny][nx] === color) {
        const g = engine._group(engine.board, nx, ny);
        if (g.liberties.size === 1) return true;
      }
    }
    return false;
  }

  _putsInAtari(engine, x, y, color) {
    const opp = color === BLACK ? WHITE : BLACK;
    const testBoard = engine._copyBoard(engine.board);
    testBoard[y][x] = color;
    // Remove captured
    for (const [nx,ny] of engine._neighbors(x, y)) {
      if (testBoard[ny][nx] === opp) {
        const g = engine._group(testBoard, nx, ny);
        if (g.liberties.size === 0) for (const [sx,sy] of g.stones) testBoard[sy][sx] = EMPTY;
      }
    }
    for (const [nx, ny] of engine._neighbors(x, y)) {
      if (testBoard[ny][nx] === opp) {
        const g = engine._group(testBoard, nx, ny);
        if (g.liberties.size === 1) return true;
      }
    }
    return false;
  }
}

window.GoBot = GoBot;
