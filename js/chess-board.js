/**
 * ZIGA Chess Board Renderer
 * Renders on <canvas>, shows legal move dots, highlights, check glow
 * Coordinates: row 0 = rank 8, row 7 = rank 1 (engine convention)
 */
'use strict';

const CHESS_UNICODE = {
  wK:'♔', wQ:'♕', wR:'♖', wB:'♗', wN:'♘', wP:'♙',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟',
};

class ChessBoard {
  constructor(canvasId, onMove) {
    this.canvas  = document.getElementById(canvasId);
    this.ctx     = this.canvas.getContext('2d');
    this.onMove  = onMove;  // callback(from, to)
    this.engine  = null;
    this.flipped = false;   // true = black at bottom
    this.selected = null;   // [row, col]
    this.legalDots = [];    // array of [row,col]
    this.lastMove   = null; // {from:[r,c], to:[r,c]}
    this.disabled   = false;
    this.cell       = 60;

    this._bindEvents();
  }

  setEngine(engine) {
    this.engine   = engine;
    this.selected = null;
    this.legalDots = [];
    this.draw();
  }

  setFlipped(flipped) {
    this.flipped = flipped;
    this.draw();
  }

  setDisabled(v) { this.disabled = v; }

  resize() {
    const wrapper = this.canvas.parentElement;
    const size    = Math.min(wrapper.clientWidth, wrapper.clientHeight, 560);
    this.canvas.width  = size;
    this.canvas.height = size;
    this.cell = size / 8;
    this.draw();
  }

  /* Convert canvas pixel → board [row, col] accounting for flip */
  _pixelToCell(px, py) {
    const col = Math.floor(px / this.cell);
    const row = Math.floor(py / this.cell);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return this.flipped ? [7 - row, 7 - col] : [row, col];
  }

  _cellToPixel(row, col) {
    const dr = this.flipped ? 7 - row : row;
    const dc = this.flipped ? 7 - col : col;
    return [dc * this.cell, dr * this.cell];
  }

  /* ── Main draw ── */
  draw() {
    if (!this.canvas) return;
    const ctx  = this.ctx;
    const cell = this.cell;
    const size = this.canvas.width;

    ctx.clearRect(0, 0, size, size);

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const [px, py] = this._cellToPixel(r, c);
        const isLight  = (r + c) % 2 === 0;
        ctx.fillStyle  = isLight ? '#f0d9b5' : '#b58863';
        ctx.fillRect(px, py, cell, cell);
      }
    }

    // Last move highlight
    if (this.lastMove) {
      ctx.fillStyle = 'rgba(255,215,0,0.4)';
      for (const [r, c] of [this.lastMove.from, this.lastMove.to]) {
        const [px, py] = this._cellToPixel(r, c);
        ctx.fillRect(px, py, cell, cell);
      }
    }

    // Selected square highlight
    if (this.selected) {
      const [px, py] = this._cellToPixel(...this.selected);
      ctx.fillStyle = 'rgba(20,85,30,0.5)';
      ctx.fillRect(px, py, cell, cell);
    }

    // Legal move dots / capture rings
    for (const [r, c] of this.legalDots) {
      const [px, py] = this._cellToPixel(r, c);
      const cx = px + cell / 2, cy = py + cell / 2;
      const hasEnemy = this.engine && this.engine.board[r][c];
      ctx.beginPath();
      if (hasEnemy) {
        ctx.arc(cx, cy, cell * 0.46, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(20,85,30,0.5)';
        ctx.lineWidth = cell * 0.1;
        ctx.stroke();
      } else {
        ctx.arc(cx, cy, cell * 0.17, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,85,30,0.4)';
        ctx.fill();
      }
    }

    // Check highlight
    if (this.engine && this.engine.inCheck) {
      let kr = -1, kc = -1;
      const color = this.engine.current;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
        if (this.engine.board[r][c] === color + 'K') { kr = r; kc = c; }
      if (kr >= 0) {
        const [px, py] = this._cellToPixel(kr, kc);
        const grad = ctx.createRadialGradient(px+cell/2, py+cell/2, cell*0.1, px+cell/2, py+cell/2, cell*0.6);
        grad.addColorStop(0, 'rgba(255,0,0,0.8)');
        grad.addColorStop(1, 'rgba(255,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(px, py, cell, cell);
      }
    }

    // Pieces
    if (this.engine) {
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const piece = this.engine.board[r][c];
          if (!piece) continue;
          const [px, py] = this._cellToPixel(r, c);
          const cx = px + cell / 2, cy = py + cell / 2;

          // Shadow for readability
          ctx.font      = `${cell * 0.72}px serif`;
          ctx.fillStyle = piece[0] === 'w' ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.35)';
          ctx.fillText(CHESS_UNICODE[piece], cx + 1.5, cy + 1.5);

          ctx.fillStyle = piece[0] === 'w' ? '#ffffff' : '#1a1a1a';
          ctx.fillText(CHESS_UNICODE[piece], cx, cy);
        }
      }
    }

    // Coordinate labels
    ctx.font      = `bold ${cell * 0.18}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < 8; i++) {
      const rank = this.flipped ? i + 1 : 8 - i;
      const file = this.flipped ? String.fromCharCode(104 - i) : String.fromCharCode(97 + i);
      const isLight = i % 2 === 0;
      ctx.fillStyle = isLight ? '#b58863' : '#f0d9b5';
      ctx.fillText(rank, 2, i * cell + 2);
      ctx.textAlign = 'right';
      ctx.fillText(file, (i + 1) * cell - 2, 7 * cell + cell * 0.82);
      ctx.textAlign = 'left';
    }
  }

  /* ── Click / touch handling ── */
  _bindEvents() {
    this.canvas.addEventListener('click', e => this._handleClick(e));
    this.canvas.addEventListener('touchend', e => {
      e.preventDefault();
      const t = e.changedTouches[0];
      const rect = this.canvas.getBoundingClientRect();
      this._handleXY(t.clientX - rect.left, t.clientY - rect.top);
    }, { passive: false });
    window.addEventListener('resize', () => this.resize());
  }

  _handleClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    this._handleXY(e.clientX - rect.left, e.clientY - rect.top);
  }

  _handleXY(px, py) {
    if (this.disabled || !this.engine || this.engine.gameOver) return;
    const scaleX = this.canvas.width  / this.canvas.getBoundingClientRect().width;
    const scaleY = this.canvas.height / this.canvas.getBoundingClientRect().height;
    const cell   = this._pixelToCell(px * scaleX, py * scaleY);
    if (!cell) return;
    const [r, c] = cell;

    if (!this.selected) {
      // Select own piece
      const p = this.engine.board[r][c];
      if (p && p[0] === this.engine.current) {
        this.selected  = [r, c];
        this.legalDots = this.engine.getLegalMoves()
          .filter(m => m.from[0] === r && m.from[1] === c)
          .map(m => m.to);
        this.draw();
      }
    } else {
      const [sr, sc] = this.selected;
      // Deselect or move
      if (r === sr && c === sc) {
        this.selected  = null;
        this.legalDots = [];
        this.draw();
        return;
      }
      // Is this a legal target?
      const isLegal = this.legalDots.some(([lr, lc]) => lr === r && lc === c);
      if (isLegal) {
        // Check for promotion
        const piece = this.engine.board[sr][sc];
        const promoRow = piece && piece[0] === 'w' ? 0 : 7;
        const isPromo  = piece && piece[1] === 'P' && r === promoRow;
        const promoTo  = isPromo ? 'Q' : null; // always promote to Q for bot/auto; UI can handle later

        this.lastMove  = { from: [sr, sc], to: [r, c] };
        this.selected  = null;
        this.legalDots = [];
        this.draw();
        if (this.onMove) this.onMove([sr, sc], [r, c], promoTo);
      } else {
        // Try selecting new piece
        const p = this.engine.board[r][c];
        if (p && p[0] === this.engine.current) {
          this.selected  = [r, c];
          this.legalDots = this.engine.getLegalMoves()
            .filter(m => m.from[0] === r && m.from[1] === c)
            .map(m => m.to);
        } else {
          this.selected  = null;
          this.legalDots = [];
        }
        this.draw();
      }
    }
  }

  /* Called by app after move is applied to engine */
  applyMove(from, to) {
    this.lastMove  = { from, to };
    this.selected  = null;
    this.legalDots = [];
    this.draw();
  }

  reset() {
    this.selected  = null;
    this.legalDots = [];
    this.lastMove  = null;
    this.draw();
  }
}

window.ChessBoard = ChessBoard;
window.CHESS_UNICODE = CHESS_UNICODE;
