/**
 * ZIGA Go Board Renderer
 * Draws board on <canvas> with:
 *  – Wood-tone background, grid lines, star points (hoshi)
 *  – Gradient stones (black/white) with shadow
 *  – Last-move marker
 *  – Ghost preview on hover
 *  – Territory overlay after game ends
 *  – Stone placement sound via Web Audio API
 */
'use strict';

class GoBoard {
  constructor(canvasId, engine, opts = {}) {
    this.canvas  = document.getElementById(canvasId);
    this.ctx     = this.canvas.getContext('2d');
    this.engine  = engine;
    this.onPlace = opts.onPlace || (() => {});  // callback(x, y)

    this._hover     = null;   // {x, y} grid coord
    this._showTerr  = false;  // show territory overlay
    this._terrMap   = null;
    this._disabled  = false;  // block input (opponent's turn, game over)
    this._myColor   = BLACK;  // which color the local player plays

    this._initAudio();
    this._attachEvents();
    this.resize();
  }

  /* ── sizing ───────────────────────────────────── */
  resize() {
    const wrapper = this.canvas.parentElement;
    const avail   = Math.min(wrapper.clientWidth, wrapper.clientHeight, 680);
    const size    = Math.max(avail, 260);
    this.canvas.width  = size;
    this.canvas.height = size;
    this._compute();
    this.draw();
  }

  _compute() {
    const n   = this.engine.size;
    const pad = Math.round(this.canvas.width * 0.05); // 5% padding
    this.pad  = pad;
    this.cell = (this.canvas.width - pad * 2) / (n - 1);
    this.stoneR = this.cell * 0.465;
  }

  /* ── main draw ────────────────────────────────── */
  draw() {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);

    this._drawBoard();
    this._drawLines();
    this._drawHoshi();
    if (this._showTerr && this._terrMap) this._drawTerritory();
    this._drawStones();
    if (this._hover && !this._disabled) this._drawGhost();
    this._drawLastMove();
  }

  /* ── board background ─────────────────────────── */
  _drawBoard() {
    const ctx = this.ctx;
    const { width, height } = this.canvas;

    // Wood grain gradient
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0,   '#dcb56a');
    grad.addColorStop(0.3, '#d4a85c');
    grad.addColorStop(0.7, '#c9973f');
    grad.addColorStop(1,   '#bf8c2e');

    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(0, 0, width, height, 8);
    } else {
      ctx.rect(0, 0, width, height);
    }
    ctx.fillStyle = grad;
    ctx.fill();

    // Subtle inner shadow
    const ig = ctx.createRadialGradient(width/2, height/2, width*0.2, width/2, height/2, width*0.75);
    ig.addColorStop(0, 'rgba(0,0,0,0)');
    ig.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = ig;
    ctx.fill();
  }

  /* ── grid lines ───────────────────────────────── */
  _drawLines() {
    const ctx  = this.ctx;
    const n    = this.engine.size;
    ctx.strokeStyle = 'rgba(80,50,10,0.75)';
    ctx.lineWidth   = 0.8;

    for (let i = 0; i < n; i++) {
      const x = this.pad + i * this.cell;
      const y = this.pad + i * this.cell;
      // vertical
      ctx.beginPath();
      ctx.moveTo(x, this.pad);
      ctx.lineTo(x, this.pad + (n-1) * this.cell);
      ctx.stroke();
      // horizontal
      ctx.beginPath();
      ctx.moveTo(this.pad, y);
      ctx.lineTo(this.pad + (n-1) * this.cell, y);
      ctx.stroke();
    }
  }

  /* ── star points ──────────────────────────────── */
  _drawHoshi() {
    const ctx   = this.ctx;
    const n     = this.engine.size;
    const hoshi = this._hoshiPoints(n);
    ctx.fillStyle = 'rgba(80,50,10,0.85)';
    for (const [hx, hy] of hoshi) {
      const cx = this.pad + hx * this.cell;
      const cy = this.pad + hy * this.cell;
      ctx.beginPath();
      ctx.arc(cx, cy, this.stoneR * 0.22, 0, Math.PI*2);
      ctx.fill();
    }
  }

  _hoshiPoints(n) {
    if (n === 19) return [
      [3,3],[9,3],[15,3],[3,9],[9,9],[15,9],[3,15],[9,15],[15,15]
    ];
    if (n === 13) return [
      [3,3],[9,3],[3,9],[9,9],[6,6]
    ];
    if (n === 9)  return [
      [2,2],[6,2],[2,6],[6,6],[4,4]
    ];
    return [];
  }

  /* ── stones ───────────────────────────────────── */
  _drawStones() {
    const engine = this.engine;
    const n      = engine.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const c = engine.board[y][x];
        if (c) this._drawStone(x, y, c);
      }
    }
  }

  _drawStone(gx, gy, color, alpha = 1) {
    const ctx = this.ctx;
    const cx  = this.pad + gx * this.cell;
    const cy  = this.pad + gy * this.cell;
    const r   = this.stoneR;

    ctx.globalAlpha = alpha;

    // Shadow
    ctx.shadowColor   = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur    = r * 0.6;
    ctx.shadowOffsetX = r * 0.12;
    ctx.shadowOffsetY = r * 0.16;

    if (color === BLACK) {
      const g = ctx.createRadialGradient(cx - r*0.3, cy - r*0.3, r*0.05, cx, cy, r);
      g.addColorStop(0, '#6a6a7a');
      g.addColorStop(0.35, '#222230');
      g.addColorStop(1,  '#050508');
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI*2);
      ctx.fillStyle = g;
      ctx.fill();
    } else {
      const g = ctx.createRadialGradient(cx - r*0.3, cy - r*0.3, r*0.05, cx, cy, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.5, '#efefef');
      g.addColorStop(1,  '#c8c8c8');
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI*2);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = '#aaa';
      ctx.lineWidth   = 0.5;
      ctx.stroke();
    }

    ctx.shadowColor   = 'transparent';
    ctx.shadowBlur    = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.globalAlpha   = 1;
  }

  /* ── hover ghost ──────────────────────────────── */
  _drawGhost() {
    const { x, y } = this._hover;
    if (!this.engine.isValid(x, y, this._myColor)) return;
    this._drawStone(x, y, this._myColor, 0.38);
  }

  /* ── last move marker ─────────────────────────── */
  _drawLastMove() {
    const lm = this.engine.lastMove;
    if (!lm || lm.pass) return;
    const ctx = this.ctx;
    const cx  = this.pad + lm.x * this.cell;
    const cy  = this.pad + lm.y * this.cell;
    const r   = this.stoneR * 0.32;

    ctx.strokeStyle = lm.color === BLACK ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.stroke();
  }

  /* ── territory overlay ────────────────────────── */
  _drawTerritory() {
    const ctx    = this.ctx;
    const n      = this.engine.size;
    const map    = this._terrMap;
    const r      = this.stoneR * 0.28;

    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (this.engine.board[y][x]) continue; // occupied
        const t  = map[y][x];
        if (!t || t === 3) continue;
        const cx = this.pad + x * this.cell;
        const cy = this.pad + y * this.cell;
        ctx.globalAlpha = 0.7;
        ctx.fillStyle   = t === BLACK ? '#1a1a2e' : '#f0f0f0';
        ctx.fillRect(cx - r, cy - r, r*2, r*2);
        ctx.globalAlpha = 1;
      }
    }
  }

  /* ── show territory after game ends ──────────── */
  showTerritory(terrMap) {
    this._terrMap  = terrMap;
    this._showTerr = true;
    this.draw();
  }
  hideTerritory() {
    this._showTerr = false;
    this._terrMap  = null;
    this.draw();
  }

  /* ── input events ─────────────────────────────── */
  _attachEvents() {
    this.canvas.addEventListener('mousemove', e => this._onMouseMove(e));
    this.canvas.addEventListener('mouseleave', () => { this._hover = null; this.draw(); });
    this.canvas.addEventListener('click',     e => this._onClick(e));
    this.canvas.addEventListener('touchend',  e => { e.preventDefault(); this._onClick(e.changedTouches[0]); });
    window.addEventListener('resize', () => this.resize());
  }

  _gridCoord(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const px = (clientX - rect.left) * scaleX;
    const py = (clientY - rect.top)  * scaleY;
    const x  = Math.round((px - this.pad) / this.cell);
    const y  = Math.round((py - this.pad) / this.cell);
    return { x, y };
  }

  _onMouseMove(e) {
    const { x, y } = this._gridCoord(e.clientX, e.clientY);
    const n = this.engine.size;
    if (x >= 0 && x < n && y >= 0 && y < n) {
      if (!this._hover || this._hover.x !== x || this._hover.y !== y) {
        this._hover = { x, y };
        this.draw();
      }
    } else {
      if (this._hover) { this._hover = null; this.draw(); }
    }
  }

  _onClick(e) {
    if (this._disabled) return;
    const { x, y } = this._gridCoord(e.clientX, e.clientY);
    const n = this.engine.size;
    if (x < 0 || x >= n || y < 0 || y >= n) return;
    if (!this.engine.isValid(x, y, this.engine.current)) return;
    this._playSound(this.engine.current);
    this.onPlace(x, y);
  }

  /* ── set state ────────────────────────────────── */
  setDisabled(v) { this._disabled = v; }
  setMyColor(c)  { this._myColor  = c; }

  /* ── audio ────────────────────────────────────── */
  _initAudio() {
    try {
      this._ac = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      this._ac = null;
    }
  }

  _playSound(color) {
    if (!this._ac) return;
    const buf = this._ac.createBuffer(1, this._ac.sampleRate * 0.06, this._ac.sampleRate);
    const data = buf.getChannelData(0);
    const freq  = color === BLACK ? 220 : 330; // lower for black, higher for white
    for (let i = 0; i < data.length; i++) {
      const t = i / this._ac.sampleRate;
      data[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 60);
    }
    const src = this._ac.createBufferSource();
    src.buffer = buf;
    // small gain
    const gain = this._ac.createGain();
    gain.gain.value = 0.18;
    src.connect(gain);
    gain.connect(this._ac.destination);
    src.start();
  }
}

window.GoBoard = GoBoard;
