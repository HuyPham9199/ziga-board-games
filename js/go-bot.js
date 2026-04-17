/**
 * ZIGA Go Bot v2 – Fast, smarter AI
 *
 * EASY   : 200ms delay, random + prefer captures, avoid obvious mistakes
 * MEDIUM : 400ms delay, full heuristic scoring over all legal moves
 * HARD   : Time-limited MCTS (700ms budget) with smart candidate pruning
 *          Uses UCT selection + async yield so UI never freezes
 */
'use strict';

class GoBot {
  constructor(difficulty = 'medium') {
    this.difficulty = difficulty;
    this._busy = false;
  }

  async getMove(engine) {
    if (this._busy) return null;
    this._busy = true;
    try {
      return await this._compute(engine);
    } finally {
      this._busy = false;
    }
  }

  async _compute(engine) {
    const color = engine.current;
    if (engine.gameOver) return null;

    switch (this.difficulty) {
      case 'easy':
        await this._sleep(180 + Math.random() * 120);
        return this._easyMove(engine, color);
      case 'medium':
        await this._sleep(280 + Math.random() * 160);
        return this._mediumMove(engine, color);
      case 'hard':
        return this._hardMove(engine, color, 700);
      default:
        return this._mediumMove(engine, color);
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ══════════════════════════════════
     EASY – random with basic sense
  ══════════════════════════════════ */
  _easyMove(engine, color) {
    const moves = engine.legalMoves(color);
    if (!moves.length) return null;

    // Priority 1: capture if available (50% chance)
    if (Math.random() < 0.5) {
      const caps = moves.filter(([x,y]) => this._wouldCapture(engine, x, y, color));
      if (caps.length) return this._pickRandom(caps);
    }

    // Filter out obvious self-atari on small groups
    const safe = moves.filter(([x,y]) => !this._isSelfAtari(engine, x, y, color));
    const pool = safe.length > 2 ? safe : moves;

    // Slight preference for non-edge moves early game
    if (engine.history.length < engine.size) {
      const inner = pool.filter(([x,y]) => {
        const m = 2;
        return x >= m && x < engine.size - m && y >= m && y < engine.size - m;
      });
      if (inner.length > 3) return this._pickRandom(inner);
    }

    return this._pickRandom(pool);
  }

  /* ══════════════════════════════════
     MEDIUM – fast heuristic scoring
  ══════════════════════════════════ */
  _mediumMove(engine, color) {
    const moves = engine.legalMoves(color);
    if (!moves.length) return null;

    // Score every move
    const scored = moves.map(([x,y]) => ({ x, y, s: this._evalMove(engine, x, y, color) }));
    scored.sort((a,b) => b.s - a.s);

    // Pick from top-4 with weighted random (better moves more likely)
    const topN  = Math.min(4, scored.length);
    const top   = scored.slice(0, topN);
    const total = top.reduce((sum, m) => sum + Math.max(m.s, 0) + 1, 0);
    let r = Math.random() * total;
    for (const m of top) {
      r -= (Math.max(m.s, 0) + 1);
      if (r <= 0) return { x: m.x, y: m.y };
    }
    return { x: top[0].x, y: top[0].y };
  }

  _evalMove(engine, x, y, color) {
    let score = 0;
    const opp  = color === BLACK ? WHITE : BLACK;
    const size = engine.size;
    const mid  = (size - 1) / 2;

    // Captures
    const caps = this._countCaptures(engine, x, y, color);
    score += caps * 18;

    // Save own atari
    if (this._savesAtari(engine, x, y, color)) score += 14;

    // Put opponent in atari
    if (this._putsInAtari(engine, x, y, color)) score += 9;

    // Avoid self-atari
    if (this._isSelfAtari(engine, x, y, color)) score -= 25;

    // Extend own group (connectivity)
    for (const [nx,ny] of engine._neighbors(x, y)) {
      if (engine.board[ny][nx] === color) score += 3;
      if (engine.board[ny][nx] === opp)   score += 1; // touching opponent = influence
    }

    // Center preference (diminishes after opening)
    const dist = Math.abs(x - mid) + Math.abs(y - mid);
    const openingFactor = Math.max(0, 1 - engine.history.length / (size * size * 0.3));
    score += (size - dist) * 0.6 * openingFactor;

    // Avoid edges early
    if (engine.history.length < size * 3) {
      if (x === 0 || x === size-1 || y === 0 || y === size-1) score -= 8;
      if (x === 1 || x === size-2 || y === 1 || y === size-2) score -= 3;
    }

    // Ko penalty (already blocked by engine but double check)
    if (engine.koPoint && engine.koPoint.x === x && engine.koPoint.y === y) score -= 99;

    return score;
  }

  /* ══════════════════════════════════
     HARD – Time-limited MCTS + UCT
  ══════════════════════════════════ */
  async _hardMove(engine, color, timeBudgetMs) {
    const deadline  = Date.now() + timeBudgetMs;
    const candidates = this._getCandidates(engine, color);
    if (!candidates.length) return null;

    // UCT stats
    const visits = new Array(candidates.length).fill(0);
    const wins   = new Array(candidates.length).fill(0);
    let totalVisits = 0;
    let iters = 0;

    while (Date.now() < deadline) {
      // UCT selection
      let best = 0, bestUCT = -Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const v = visits[i];
        const uct = v === 0
          ? 1e9 + Math.random()  // unexplored first
          : (wins[i] / v) + 1.5 * Math.sqrt(Math.log(totalVisits + 1) / v);
        if (uct > bestUCT) { bestUCT = uct; best = i; }
      }

      const [cx, cy] = candidates[best];
      const clone = this._cloneEngine(engine);
      if (!clone.place(cx, cy)) {
        candidates.splice(best, 1);
        visits.splice(best, 1);
        wins.splice(best, 1);
        if (!candidates.length) break;
        continue;
      }

      const win = this._rollout(clone, color);
      visits[best]++;
      wins[best] += win;
      totalVisits++;
      iters++;

      // Yield to browser every 15 iterations to keep UI responsive
      if (iters % 15 === 0) await this._sleep(0);
      if (Date.now() >= deadline) break;
    }

    // Best by visit count (most robust)
    let bestIdx = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (visits[i] > visits[bestIdx]) bestIdx = i;
    }

    console.log(`[HARD] ${iters} playouts in ${timeBudgetMs}ms, candidates: ${candidates.length}`);
    const [rx, ry] = candidates[bestIdx];
    return { x: rx, y: ry };
  }

  /* Generate candidate moves (much smaller set than all legal moves) */
  _getCandidates(engine, color) {
    const opp  = color === BLACK ? WHITE : BLACK;
    const size = engine.size;
    const set  = new Set();

    const add = (x, y) => {
      if (x >= 0 && x < size && y >= 0 && y < size
          && engine.board[y][x] === EMPTY
          && engine.isValid(x, y, color)) {
        set.add(x * size + y);
      }
    };

    // 1. Tactical: captures, atari saves, atari threats
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = engine.board[y][x];
        if (!c) continue;
        const g = engine._group(engine.board, x, y);

        if (c === opp && g.liberties.size <= 1) {
          // Capture opponent in atari
          g.liberties.forEach(k => {
            const lx = k % size, ly = Math.floor(k / size);
            add(lx, ly);
          });
        }
        if (c === color && g.liberties.size <= 2) {
          // Save own group in atari / near-atari
          g.liberties.forEach(k => {
            const lx = k % size, ly = Math.floor(k / size);
            add(lx, ly);
          });
          g.stones.forEach(([sx,sy]) => {
            engine._neighbors(sx, sy).forEach(([nx,ny]) => add(nx, ny));
          });
        }
      }
    }

    // 2. Near existing stones (distance ≤ 2)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!engine.board[y][x]) continue;
        // Distance 1 (adjacent)
        engine._neighbors(x, y).forEach(([nx,ny]) => add(nx, ny));
        // Distance 2 (knight + straight)
        for (const [dx, dy] of [
          [-2,0],[2,0],[0,-2],[0,2],
          [-1,-1],[1,-1],[-1,1],[1,1],
          [-2,-1],[-2,1],[2,-1],[2,1],
          [-1,-2],[1,-2],[-1,2],[1,2]
        ]) add(x+dx, y+dy);
      }
    }

    // 3. Opening: star points + center
    if (engine.history.length < size * 2) {
      this._hoshiPoints(size).forEach(([hx,hy]) => add(hx, hy));
      add(Math.floor(size/2), Math.floor(size/2));
    }

    // 4. Fallback: ensure at least 8 candidates
    if (set.size < 8) {
      const all = engine.legalMoves(color);
      for (const [x,y] of all.slice(0, 20)) add(x, y);
    }

    return [...set].map(k => [Math.floor(k / size), k % size])
                   .filter(([x,y]) => engine.isValid(x, y, color));
  }

  /* Light rollout: random but avoids self-atari */
  _rollout(engine, rootColor) {
    const maxMoves = engine.size * engine.size * 1.5;
    let passes = 0;

    for (let i = 0; i < maxMoves; i++) {
      if (engine.gameOver) break;
      const color = engine.current;
      const all   = engine.legalMoves(color);
      if (!all.length) { engine.pass(); passes++; if (passes >= 2) break; continue; }

      passes = 0;
      const safe = all.filter(([x,y]) => !this._isSelfAtari(engine, x, y, color));
      const pool = safe.length ? safe : all;
      const [x, y] = pool[Math.floor(Math.random() * pool.length)];
      engine.place(x, y);
    }

    return engine.score().winner === rootColor ? 1 : 0;
  }

  _cloneEngine(engine) {
    const c = new GoEngine(engine.size, engine.komi);
    c.board     = engine._copyBoard(engine.board);
    c.current   = engine.current;
    c.captures  = { ...engine.captures };
    c.koPoint   = engine.koPoint ? { ...engine.koPoint } : null;
    c.prevBoard = engine.prevBoard ? engine._copyBoard(engine.prevBoard) : null;
    c.passCount = engine.passCount;
    c.gameOver  = engine.gameOver;
    c.history   = [];
    return c;
  }

  /* ══════════════════════════════════
     HELPER UTILITIES
  ══════════════════════════════════ */
  _pickRandom(arr) {
    if (!arr.length) return null;
    const [x, y] = arr[Math.floor(Math.random() * arr.length)];
    return { x, y };
  }

  _wouldCapture(engine, x, y, color) {
    return this._countCaptures(engine, x, y, color) > 0;
  }

  _countCaptures(engine, x, y, color) {
    const opp   = color === BLACK ? WHITE : BLACK;
    const test  = engine._copyBoard(engine.board);
    test[y][x]  = color;
    let count   = 0;
    for (const [nx,ny] of engine._neighbors(x, y)) {
      if (test[ny][nx] === opp) {
        const g = engine._group(test, nx, ny);
        if (g.liberties.size === 0) count += g.stones.length;
      }
    }
    return count;
  }

  _isSelfAtari(engine, x, y, color) {
    const opp  = color === BLACK ? WHITE : BLACK;
    const test = engine._copyBoard(engine.board);
    test[y][x] = color;
    // Remove captures first
    for (const [nx,ny] of engine._neighbors(x, y)) {
      if (test[ny][nx] === opp) {
        const g = engine._group(test, nx, ny);
        if (g.liberties.size === 0) g.stones.forEach(([sx,sy]) => test[sy][sx] = EMPTY);
      }
    }
    const own = engine._group(test, x, y);
    return own.liberties.size === 1 && own.stones.length <= 3; // only flag small groups
  }

  _savesAtari(engine, x, y, color) {
    for (const [nx,ny] of engine._neighbors(x, y)) {
      if (engine.board[ny][nx] === color) {
        const g = engine._group(engine.board, nx, ny);
        if (g.liberties.size === 1) return true;
      }
    }
    return false;
  }

  _putsInAtari(engine, x, y, color) {
    const opp  = color === BLACK ? WHITE : BLACK;
    const test = engine._copyBoard(engine.board);
    test[y][x] = color;
    for (const [nx,ny] of engine._neighbors(x, y)) {
      if (test[ny][nx] === opp) {
        const g = engine._group(test, nx, ny);
        if (g.liberties.size === 0) g.stones.forEach(([sx,sy]) => test[sy][sx] = EMPTY);
      }
    }
    for (const [nx,ny] of engine._neighbors(x, y)) {
      if (test[ny][nx] === opp) {
        const g = engine._group(test, nx, ny);
        if (g.liberties.size === 1) return true;
      }
    }
    return false;
  }

  _hoshiPoints(n) {
    if (n === 19) return [[3,3],[9,3],[15,3],[3,9],[9,9],[15,9],[3,15],[9,15],[15,15]];
    if (n === 13) return [[3,3],[9,3],[3,9],[9,9],[6,6]];
    if (n === 9)  return [[2,2],[6,2],[2,6],[6,6],[4,4]];
    return [];
  }
}

window.GoBot = GoBot;
