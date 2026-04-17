/**
 * ZIGA Chess Bot – Minimax + Alpha-Beta Pruning
 * EASY   : depth 1, random from top moves
 * MEDIUM : depth 3, full minimax
 * HARD   : depth 4, iterative deepening + move ordering
 */
'use strict';

class ChessBot {
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
    if (engine.gameOver) return null;
    const color = engine.current;

    switch (this.difficulty) {
      case 'easy':
        await this._sleep(200 + Math.random() * 200);
        return this._easyMove(engine, color);
      case 'medium':
        await this._sleep(100);
        return this._minimaxMove(engine, color, 3);
      case 'hard':
        await this._sleep(50);
        return this._minimaxMove(engine, color, 4);
      default:
        return this._minimaxMove(engine, color, 3);
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  _easyMove(engine, color) {
    const moves = engine.getLegalMoves();
    if (!moves.length) return null;

    // Score moves simply (captures > others), pick from top 5 randomly
    const scored = moves.map(m => ({ m, s: this._quickScore(m) }));
    scored.sort((a, b) => b.s - a.s);
    const pool = scored.slice(0, Math.min(5, scored.length));
    const pick = pool[Math.floor(Math.random() * pool.length)].m;
    return { from: pick.from, to: pick.to, promo: pick.promo ? 'Q' : null };
  }

  _quickScore(move) {
    let s = 0;
    if (move.captured) s += (CHESS_VALS[move.captured[1]] || 0);
    if (move.promo)    s += 800;
    if (move.castle)   s += 50;
    return s + Math.random() * 30;
  }

  _minimaxMove(engine, color, depth) {
    const moves = this._orderedMoves(engine);
    if (!moves.length) return null;

    const maximize = color === 'w';
    let bestMove  = moves[0];
    let bestScore = maximize ? -Infinity : Infinity;
    const alpha   = -Infinity;
    const beta    = Infinity;

    for (const move of moves) {
      const clone = engine.clone();
      clone.move(move.from, move.to, move.promo ? 'Q' : undefined);
      const score = this._minimax(clone, depth - 1, alpha, beta, !maximize);
      if (maximize ? score > bestScore : score < bestScore) {
        bestScore = score;
        bestMove  = move;
      }
    }

    return { from: bestMove.from, to: bestMove.to, promo: bestMove.promo ? 'Q' : null };
  }

  _minimax(engine, depth, alpha, beta, maximizing) {
    if (depth === 0 || engine.gameOver) return engine.evaluate();

    const moves = this._orderedMoves(engine);
    if (!moves.length) return engine.evaluate();

    if (maximizing) {
      let best = -Infinity;
      for (const move of moves) {
        const clone = engine.clone();
        clone.move(move.from, move.to, move.promo ? 'Q' : undefined);
        const score = this._minimax(clone, depth - 1, alpha, beta, false);
        best  = Math.max(best, score);
        alpha = Math.max(alpha, score);
        if (beta <= alpha) break; // β cut-off
      }
      return best;
    } else {
      let best = Infinity;
      for (const move of moves) {
        const clone = engine.clone();
        clone.move(move.from, move.to, move.promo ? 'Q' : undefined);
        const score = this._minimax(clone, depth - 1, alpha, beta, true);
        best = Math.min(best, score);
        beta = Math.min(beta, score);
        if (beta <= alpha) break; // α cut-off
      }
      return best;
    }
  }

  /* Move ordering: captures (MVV-LVA) > promotions > castles > quiet */
  _orderedMoves(engine) {
    const moves = engine.getLegalMoves();
    return moves.sort((a, b) => this._moveScore(b) - this._moveScore(a));
  }

  _moveScore(move) {
    let s = 0;
    if (move.captured) {
      // MVV-LVA: value of victim minus small fraction of attacker
      const victim   = CHESS_VALS[move.captured[1]] || 0;
      const attacker = (CHESS_VALS[move.piece[1]] || 0) / 100;
      s += victim - attacker + 10000;
    }
    if (move.promo)  s += 9000;
    if (move.castle) s += 300;
    return s;
  }
}

window.ChessBot = ChessBot;
