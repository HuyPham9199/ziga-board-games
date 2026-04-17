/**
 * ZIGA Chess Board Renderer v2
 * – Drag-and-drop pieces
 * – Slide animation on moves
 * – MP3 sound (move / capture / check)
 * – Polished canvas rendering with glows, outlines, gradients
 */
'use strict';

const CHESS_UNICODE = {
  wK:'♔', wQ:'♕', wR:'♖', wB:'♗', wN:'♘', wP:'♙',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟',
};

class ChessBoard {
  constructor(canvasId, onMove) {
    this.canvas    = document.getElementById(canvasId);
    this.ctx       = this.canvas.getContext('2d');
    this.onMove    = onMove;
    this.engine    = null;
    this.flipped   = false;
    this.selected  = null;    // [row, col]
    this.legalDots = [];      // [[row, col], ...]
    this.lastMove  = null;    // { from:[r,c], to:[r,c] }
    this.disabled  = false;

    // Drag state
    this._drag   = null;   // { piece, fromR, fromC, x, y }
    this._wasDrag = false; // suppress click after a drag

    // Slide animation state
    this._anim      = null;
    this._animFrame = null;

    // Sound
    this._soundBuf = null;
    this._audioCtx = null;
    this._initSound();

    this._bindEvents();
  }

  /* ── Sound ── */
  _initSound() {
    try { this._audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    if (!this._audioCtx) return;
    fetch('assets/sounds/freesound_community-ficha-de-ajedrez-34722.mp3')
      .then(r => r.arrayBuffer())
      .then(buf => this._audioCtx.decodeAudioData(buf))
      .then(decoded => { this._soundBuf = decoded; })
      .catch(() => {});
  }

  _playSound(type = 'move') {
    if (!this._audioCtx || !this._soundBuf) return;
    // Resume context if suspended (autoplay policy)
    if (this._audioCtx.state === 'suspended') this._audioCtx.resume();

    const src  = this._audioCtx.createBufferSource();
    const gain = this._audioCtx.createGain();
    src.buffer = this._soundBuf;
    src.connect(gain);
    gain.connect(this._audioCtx.destination);

    // Detune for variety: captures = brighter, check = extra accent
    src.detune.value  = type === 'capture' ? 200 : type === 'check' ? 400 : 0;
    gain.gain.value   = type === 'check' ? 0.9 : 0.65;
    src.start(0);

    // Extra ping on check via oscillator
    if (type === 'check') {
      const osc  = this._audioCtx.createOscillator();
      const ogain = this._audioCtx.createGain();
      osc.connect(ogain); ogain.connect(this._audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, this._audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, this._audioCtx.currentTime + 0.25);
      ogain.gain.setValueAtTime(0.12, this._audioCtx.currentTime);
      ogain.gain.exponentialRampToValueAtTime(0.001, this._audioCtx.currentTime + 0.3);
      osc.start(); osc.stop(this._audioCtx.currentTime + 0.3);
    }
  }

  /* ── Public API ── */
  setEngine(engine) {
    this.engine    = engine;
    this.selected  = null;
    this.legalDots = [];
    this._drag     = null;
    this._cancelAnim();
    this.draw();
  }

  setFlipped(flipped) { this.flipped = flipped; this.draw(); }
  setDisabled(v)      { this.disabled = v; }

  resize() {
    const wrapper = this.canvas.parentElement;
    const raw  = Math.min(wrapper.clientWidth, wrapper.clientHeight, 620);
    const size = Math.floor(raw / 8) * 8;  // integer cell size
    this.canvas.width  = size;
    this.canvas.height = size;
    this.draw();
  }

  get cell() { return this.canvas.width / 8; }

  /* ── Coordinate helpers ── */
  _toDisplay(r, c) {
    return this.flipped ? [7 - r, 7 - c] : [r, c];
  }
  _cellToPixel(r, c) {
    const [dr, dc] = this._toDisplay(r, c);
    return [dc * this.cell, dr * this.cell];
  }
  _pixelToCell(px, py) {
    const cell = this.cell;
    const dc = Math.floor(px / cell);
    const dr = Math.floor(py / cell);
    if (dc < 0 || dc > 7 || dr < 0 || dr > 7) return null;
    return this.flipped ? [7 - dr, 7 - dc] : [dr, dc];
  }
  _cellCenter(r, c) {
    const [px, py] = this._cellToPixel(r, c);
    const half = this.cell / 2;
    return [px + half, py + half];
  }

  /* ── Main draw ── */
  draw() {
    if (!this.canvas || !this.canvas.width) return;
    const ctx  = this.ctx;
    const cell = this.cell;
    const size = this.canvas.width;

    ctx.clearRect(0, 0, size, size);
    this._drawSquares(ctx, cell, size);
    this._drawHighlights(ctx, cell);
    this._drawLegalDots(ctx, cell);
    this._drawCheckGlow(ctx, cell);
    this._drawPieces(ctx, cell);
    this._drawCoords(ctx, cell);
    if (this._drag) this._drawDragPiece(ctx, cell);
  }

  _drawSquares(ctx, cell, size) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const [px, py] = this._cellToPixel(r, c);
        const light = (r + c) % 2 === 0;
        ctx.fillStyle = light ? '#f0d9b5' : '#b58863';
        ctx.fillRect(px, py, cell, cell);
        // Subtle inner gradient
        const g = ctx.createRadialGradient(px + cell * .5, py + cell * .5, 0,
                                           px + cell * .5, py + cell * .5, cell * .72);
        g.addColorStop(0,   light ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0)');
        g.addColorStop(1,   light ? 'rgba(0,0,0,0.04)'       : 'rgba(0,0,0,0.08)');
        ctx.fillStyle = g;
        ctx.fillRect(px, py, cell, cell);
      }
    }
    // Border
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth   = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);
  }

  _drawHighlights(ctx, cell) {
    // Last move
    if (this.lastMove) {
      for (const [r, c] of [this.lastMove.from, this.lastMove.to]) {
        const [px, py] = this._cellToPixel(r, c);
        ctx.fillStyle = 'rgba(252,210,0,0.48)';
        ctx.fillRect(px, py, cell, cell);
      }
    }
    // Selected
    if (this.selected) {
      const [px, py] = this._cellToPixel(...this.selected);
      ctx.fillStyle = 'rgba(20,130,60,0.52)';
      ctx.fillRect(px, py, cell, cell);
      ctx.strokeStyle = 'rgba(60,210,100,0.75)';
      ctx.lineWidth   = 2.5;
      ctx.strokeRect(px + 1.5, py + 1.5, cell - 3, cell - 3);
    }
  }

  _drawLegalDots(ctx, cell) {
    for (const [r, c] of this.legalDots) {
      const [px, py] = this._cellToPixel(r, c);
      const cx = px + cell / 2, cy = py + cell / 2;
      const hasEnemy = this.engine?.board[r][c];
      if (hasEnemy) {
        // Capture ring
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.46, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(20,130,60,0.6)';
        ctx.lineWidth   = cell * 0.12;
        ctx.stroke();
        // Inner fill
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.32, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,130,60,0.12)';
        ctx.fill();
      } else {
        // Move dot
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.155, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,130,60,0.48)';
        ctx.fill();
        // Outer glow
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.23, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,130,60,0.1)';
        ctx.fill();
      }
    }
  }

  _drawCheckGlow(ctx, cell) {
    if (!this.engine?.inCheck) return;
    const color = this.engine.current;
    let kr = -1, kc = -1;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
      if (this.engine.board[r][c] === color + 'K') { kr = r; kc = c; }
    if (kr < 0) return;
    const [px, py] = this._cellToPixel(kr, kc);
    const cx = px + cell / 2, cy = py + cell / 2;
    const g = ctx.createRadialGradient(cx, cy, cell * 0.05, cx, cy, cell * 0.72);
    g.addColorStop(0,   'rgba(255,30,30,0.92)');
    g.addColorStop(0.45,'rgba(255,0,0,0.38)');
    g.addColorStop(1,   'rgba(255,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(px, py, cell, cell);
    ctx.strokeStyle = 'rgba(255,60,60,0.85)';
    ctx.lineWidth   = 3;
    ctx.strokeRect(px + 1.5, py + 1.5, cell - 3, cell - 3);
  }

  _drawPieces(ctx, cell) {
    if (!this.engine) return;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = this.engine.board[r][c];
        if (!piece) continue;
        // Skip drag source / slide-anim destination
        if (this._drag  && this._drag.fromR === r && this._drag.fromC === c) continue;
        if (this._anim  && this._anim.toR   === r && this._anim.toC   === c) continue;
        const [px, py] = this._cellToPixel(r, c);
        this._drawPieceAt(ctx, piece, px + cell / 2, py + cell / 2, cell, 1);
      }
    }
  }

  _drawPieceAt(ctx, piece, cx, cy, cell, alpha) {
    const isWhite = piece[0] === 'w';
    const sym = CHESS_UNICODE[piece] || '?';
    const fs  = cell * 0.75;

    ctx.save();
    ctx.globalAlpha   = alpha;
    ctx.font          = `${fs}px serif`;
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';
    ctx.lineJoin      = 'round';
    ctx.miterLimit    = 2;

    const dy = cell * 0.025;  // slight downward nudge for optical centering

    // Outline for contrast on both square colors
    ctx.lineWidth   = fs * 0.09;
    ctx.strokeStyle = isWhite ? 'rgba(90,55,10,0.55)' : 'rgba(255,255,255,0.22)';
    ctx.strokeText(sym, cx, cy + dy);

    // Main fill
    ctx.fillStyle = isWhite ? '#f5f0e6' : '#180f04';
    ctx.fillText(sym, cx, cy + dy);

    // Highlight shimmer on white pieces
    if (isWhite) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillText(sym, cx - 0.7, cy + dy - 0.7);
    }

    ctx.restore();
  }

  _drawDragPiece(ctx, cell) {
    if (!this._drag) return;
    const { piece, x, y } = this._drag;
    ctx.save();
    ctx.shadowColor   = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur    = 22;
    ctx.shadowOffsetX = 5;
    ctx.shadowOffsetY = 8;
    this._drawPieceAt(ctx, piece, x, y, cell * 1.18, 0.9);
    ctx.restore();
  }

  _drawCoords(ctx, cell) {
    const fs = Math.max(9, cell * 0.165);
    ctx.font = `bold ${fs}px sans-serif`;
    for (let i = 0; i < 8; i++) {
      const light = i % 2 === 0;
      ctx.fillStyle = light ? '#b58863' : '#f0d9b5';
      // Rank (left)
      const rank = this.flipped ? i + 1 : 8 - i;
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(rank, 2, i * cell + 2);
      // File (bottom, same column i)
      const lightB = (7 + i) % 2 === 0;
      ctx.fillStyle = lightB ? '#b58863' : '#f0d9b5';
      const file = this.flipped ? String.fromCharCode(104 - i) : String.fromCharCode(97 + i);
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(file, (i + 1) * cell - 2, 8 * cell - 2);
    }
  }

  /* ── Slide animation ── */
  _animatePiece(piece, fromR, fromC, toR, toC, onDone) {
    this._cancelAnim();
    const [fx, fy] = this._cellCenter(fromR, fromC);
    const [tx, ty] = this._cellCenter(toR, toC);
    this._anim = { piece, fromR, fromC, toR, toC, fx, fy, tx, ty,
                   startT: performance.now(), duration: 160, onDone };
    this._tickAnim();
  }

  _tickAnim() {
    const a = this._anim;
    if (!a) return;
    const raw  = (performance.now() - a.startT) / a.duration;
    const t    = Math.min(1, raw);
    const ease = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t; // ease-in-out quad

    const cx = a.fx + (a.tx - a.fx) * ease;
    const cy = a.fy + (a.ty - a.fy) * ease;

    this.draw();   // draws board + all pieces except destination (skipped in _drawPieces)

    // Draw animated piece on top
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor   = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur    = 14;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 5;
    this._drawPieceAt(ctx, a.piece, cx, cy, this.cell, 1);
    ctx.restore();

    if (t < 1) {
      this._animFrame = requestAnimationFrame(() => this._tickAnim());
    } else {
      this._anim = null; this._animFrame = null;
      if (a.onDone) a.onDone();
    }
  }

  _cancelAnim() {
    if (this._animFrame) { cancelAnimationFrame(this._animFrame); this._animFrame = null; }
    this._anim = null;
  }

  /* ── Event bindings ── */
  _bindEvents() {
    this.canvas.addEventListener('mousedown', e => this._onMouseDown(e));
    window.addEventListener('mousemove',      e => this._onMouseMove(e));
    window.addEventListener('mouseup',        e => this._onMouseUp(e));

    this.canvas.addEventListener('touchstart', e => this._onTouchStart(e), { passive: false });
    window.addEventListener('touchmove',       e => this._onTouchMove(e),  { passive: false });
    window.addEventListener('touchend',        e => this._onTouchEnd(e),   { passive: false });

    this.canvas.addEventListener('click', e => this._onClick(e));

    window.addEventListener('resize', () => this.resize());
  }

  _xy(clientX, clientY) {
    const rect   = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return [(clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY];
  }

  _canInteract() {
    return !this.disabled && this.engine && !this.engine.gameOver;
  }

  /* Mouse */
  _onMouseDown(e) {
    if (!this._canInteract() || e.button !== 0) return;
    const [px, py] = this._xy(e.clientX, e.clientY);
    const cell = this._pixelToCell(px, py);
    if (!cell) return;
    const [r, c] = cell;
    const piece = this.engine.board[r][c];
    if (!piece || piece[0] !== this.engine.current) return;

    this._drag    = { piece, fromR: r, fromC: c, x: px, y: py, moved: false };
    this.selected  = [r, c];
    this.legalDots = this._legalFrom(r, c);
    this.draw();
    e.preventDefault();
  }

  _onMouseMove(e) {
    if (!this._drag) return;
    const [px, py] = this._xy(e.clientX, e.clientY);
    const dx = px - this._drag.x, dy = py - this._drag.y;
    if (!this._drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) this._drag.moved = true;
    this._drag.x = px; this._drag.y = py;
    this.draw();
  }

  _onMouseUp(e) {
    if (!this._drag) return;
    const wasMoved = this._drag.moved;
    const [px, py] = this._xy(e.clientX, e.clientY);
    const { fromR, fromC } = this._drag;
    this._drag = null;

    if (wasMoved) {
      this._wasDrag = true;
      const target = this._pixelToCell(px, py);
      if (target) {
        const [tr, tc] = target;
        if (this.legalDots.some(([lr, lc]) => lr === tr && lc === tc) && (tr !== fromR || tc !== fromC)) {
          this._commitMove(fromR, fromC, tr, tc);
          return;
        }
      }
      this.selected = null; this.legalDots = []; this.draw();
    }
  }

  _onClick(e) {
    if (this._wasDrag) { this._wasDrag = false; return; }
    if (!this._canInteract()) return;
    const [px, py] = this._xy(e.clientX, e.clientY);
    this._handleXY(px, py);
  }

  /* Touch */
  _onTouchStart(e) {
    e.preventDefault();
    if (!this._canInteract()) return;
    const t = e.touches[0];
    const [px, py] = this._xy(t.clientX, t.clientY);
    const cell = this._pixelToCell(px, py);
    if (!cell) return;
    const [r, c] = cell;
    const piece = this.engine.board[r][c];
    if (!piece || piece[0] !== this.engine.current) return;
    this._drag = { piece, fromR: r, fromC: c, x: px, y: py, moved: false };
    this.selected  = [r, c];
    this.legalDots = this._legalFrom(r, c);
    this.draw();
  }

  _onTouchMove(e) {
    if (!this._drag) return;
    e.preventDefault();
    const t = e.touches[0];
    const [px, py] = this._xy(t.clientX, t.clientY);
    this._drag.moved = true;
    this._drag.x = px; this._drag.y = py;
    this.draw();
  }

  _onTouchEnd(e) {
    if (!this._drag) return;
    e.preventDefault();
    const wasMoved = this._drag.moved;
    const t = e.changedTouches[0];
    const [px, py] = this._xy(t.clientX, t.clientY);
    const { fromR, fromC } = this._drag;
    this._drag = null;

    const target = this._pixelToCell(px, py);
    if (target) {
      const [tr, tc] = target;
      if (this.legalDots.some(([lr, lc]) => lr === tr && lc === tc)) {
        if (tr !== fromR || tc !== fromC) { this._commitMove(fromR, fromC, tr, tc); return; }
      }
    }
    if (!wasMoved) this._handleXY(px, py); // treat as tap/click
    else { this.selected = null; this.legalDots = []; this.draw(); }
  }

  /* Click / tap logic */
  _handleXY(px, py) {
    const cell = this._pixelToCell(px, py);
    if (!cell) return;
    const [r, c] = cell;

    if (!this.selected) {
      const p = this.engine.board[r][c];
      if (p && p[0] === this.engine.current) {
        this.selected  = [r, c];
        this.legalDots = this._legalFrom(r, c);
        this.draw();
      }
      return;
    }

    const [sr, sc] = this.selected;
    if (r === sr && c === sc) { this.selected = null; this.legalDots = []; this.draw(); return; }

    if (this.legalDots.some(([lr, lc]) => lr === r && lc === c)) {
      this._commitMove(sr, sc, r, c);
    } else {
      const p = this.engine.board[r][c];
      if (p && p[0] === this.engine.current) {
        this.selected  = [r, c];
        this.legalDots = this._legalFrom(r, c);
      } else {
        this.selected = null; this.legalDots = [];
      }
      this.draw();
    }
  }

  _legalFrom(r, c) {
    return this.engine.getLegalMoves()
      .filter(m => m.from[0] === r && m.from[1] === c)
      .map(m => m.to);
  }

  _commitMove(fromR, fromC, toR, toC) {
    const piece    = this.engine.board[fromR][fromC];
    const promoRow = piece?.[0] === 'w' ? 0 : 7;
    const isPromo  = piece?.[1] === 'P' && toR === promoRow;

    this.selected = null; this.legalDots = [];
    this.draw();
    // null = player must pick promotion piece; undefined = no promo
    if (this.onMove) this.onMove([fromR, fromC], [toR, toC], isPromo ? null : undefined);
  }

  /* Called by app after the engine has applied the move */
  applyMove(from, to, soundType = 'move') {
    this.lastMove  = { from, to };
    this.selected  = null;
    this.legalDots = [];
    this._drag     = null;

    this._playSound(soundType);

    // Animate piece sliding to destination
    const piece = this.engine?.board[to[0]][to[1]];
    if (piece) {
      this._animatePiece(piece, from[0], from[1], to[0], to[1], () => this.draw());
    } else {
      this.draw();
    }
  }

  reset() {
    this.selected  = null;
    this.legalDots = [];
    this.lastMove  = null;
    this._drag     = null;
    this._cancelAnim();
    this.draw();
  }
}

window.ChessBoard    = ChessBoard;
window.CHESS_UNICODE = CHESS_UNICODE;
