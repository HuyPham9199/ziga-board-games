/**
 * ZIGA – Main Application Controller
 * Handles: routing, login, lobby, game setup, game flow,
 *          timers, chat, matchmaking, stats
 */
'use strict';

/* ════════════════════════════════════════════════
   UTILITY
═══════════════════════════════════════════════ */
const $ = id => document.getElementById(id);
const qs = sel => document.querySelector(sel);

function toast(msg, type = 'info', dur = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), dur);
}

function formatTime(seconds) {
  if (seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function colToLetter(x) {
  // Skip 'I'
  return 'ABCDEFGHJKLMNOPQRST'[x];
}
function coordLabel(x, y, size) {
  return `${colToLetter(x)}${size - y}`;
}

/* ════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════ */
const State = {
  user:        null,   // Firebase user | guest
  isGuest:     true,
  stats:       { wins: 0, losses: 0, games: 0, elo: 1200 },

  // Setup choices
  gameMode:    'bot-hard',  // online | bot-easy | bot-medium | bot-hard | local
  boardSize:   19,
  playerColor: BLACK,       // BLACK or WHITE
  timeControl: 600,         // seconds per side, 0 = none

  // Active game
  engine:      null,
  board:       null,
  bot:         null,
  botColor:    WHITE,
  myColor:     BLACK,
  gameId:      null,        // Firestore ID for online games
  gameUnsub:   null,        // Firestore listener unsub
  chatUnsub:   null,

  // Timer
  timers:      { [BLACK]: 600, [WHITE]: 600 },
  timerInterval: null,
};

/* ════════════════════════════════════════════════
   ROUTER
═══════════════════════════════════════════════ */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const v = $(id);
  if (v) v.classList.add('active');
}

/* ════════════════════════════════════════════════
   PARTICLES (login background)
═══════════════════════════════════════════════ */
function initParticles() {
  const canvas = $('particles-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function makeParticles() {
    particles = Array.from({ length: 40 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 4 + 1,
      vx: (Math.random() - .5) * .4,
      vy: (Math.random() - .5) * .4,
      a: Math.random() * .6 + .1
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      ctx.fillStyle = `rgba(140,120,255,${p.a})`;
      ctx.fill();
    }
    requestAnimationFrame(draw);
  }

  resize();
  makeParticles();
  draw();
  window.addEventListener('resize', () => { resize(); makeParticles(); });
}

/* ════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════ */
async function handleAuthReady(user) {
  if (user) {
    State.user    = user;
    State.isGuest = false;
    // Load stats
    const stats = await firebaseService.getUserStats(user.uid);
    if (stats) State.stats = stats;
    updateNavUser();
    showView('view-lobby');
  } else if (State.isGuest) {
    // Stay on login
    showView('view-login');
  }
}

function updateNavUser() {
  const name   = State.user ? (State.user.displayName || State.user.email) : 'Khách';
  const initial = name[0].toUpperCase();
  $('nav-avatar').textContent   = initial;
  $('nav-username').textContent = name;
  updateStats();
}

function updateStats() {
  $('stat-wins').textContent   = State.stats.wins;
  $('stat-losses').textContent = State.stats.losses;
  $('stat-games').textContent  = State.stats.games;
  $('stat-elo').textContent    = State.stats.elo;
}

/* ════════════════════════════════════════════════
   LOBBY
═══════════════════════════════════════════════ */
function initLobby() {
  // Simulate online count
  setInterval(() => {
    const count = Math.floor(Math.random() * 40) + 12;
    $('lobby-online-count').textContent = count;
  }, 5000);
  $('lobby-online-count').textContent = Math.floor(Math.random() * 40) + 12;
}

/* ════════════════════════════════════════════════
   SETUP
═══════════════════════════════════════════════ */
function initSetup() {
  // Mode cards
  document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      State.gameMode = card.dataset.mode;
      // Online mode: check firebase
      if (State.gameMode === 'online' && !firebaseService._ready) {
        toast('Firebase chưa được cấu hình. Vui lòng thiết lập Firebase để chơi online.', 'error', 5000);
      }
    });
  });

  // Board size
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      State.boardSize = parseInt(btn.dataset.size);
    });
  });

  // Color
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const c = btn.dataset.color;
      if (c === 'black')  State.playerColor = BLACK;
      else if (c === 'white') State.playerColor = WHITE;
      else State.playerColor = Math.random() < .5 ? BLACK : WHITE;
    });
  });

  // Time
  document.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      State.timeControl = parseInt(btn.dataset.time);
    });
  });
}

/* ════════════════════════════════════════════════
   START GAME
═══════════════════════════════════════════════ */
async function startGame() {
  const mode = State.gameMode;

  // Determine player color
  let myColor = State.playerColor;

  // Create engine
  State.engine = new GoEngine(State.boardSize, 6.5);
  State.myColor = myColor;
  State.botColor = myColor === BLACK ? WHITE : BLACK;

  // Setup UI
  setupGameUI();

  // Create board renderer
  State.board = new GoBoard('go-board', State.engine, {
    onPlace: (x, y) => onPlayerMove(x, y)
  });
  State.board.setMyColor(myColor);

  // Timer setup
  const t = State.timeControl > 0 ? State.timeControl : 0;
  State.timers = { [BLACK]: t, [WHITE]: t };
  updateTimerDisplay();

  showView('view-game');
  State.board.resize();

  if (mode === 'online') {
    await startOnlineGame();
  } else if (mode === 'local') {
    // 2-player local: both sides allowed
    State.board.setMyColor(BLACK); // local: show ghost for current player
    State.board.setDisabled(false);
    toast('Chơi 2 người – Đen đi trước', 'info');
    startTimer();
  } else {
    // Bot game
    const diff = mode.replace('bot-', '');
    State.bot = new GoBot(diff);
    const botName = { easy: 'Bot Dễ', medium: 'Bot Thường', hard: 'Bot Khó' }[diff] || 'Bot';
    $('opp-name').textContent   = botName;
    $('opp-avatar').textContent = '🤖';
    $('opp-rating').textContent = { easy: 'ELO 800', medium: 'ELO 1200', hard: 'ELO 1800' }[diff];
    $('info-mode').textContent  = botName;

    // If player is white, bot (black) goes first
    if (myColor === WHITE) {
      State.board.setDisabled(true);
      toast('Bạn chơi Trắng. Bot đang suy nghĩ...', 'info');
      doBotMove();
    } else {
      State.board.setDisabled(false);
    }
    startTimer();
  }
}

function setupGameUI() {
  const name = State.user ? (State.user.displayName || 'Bạn') : 'Khách';
  const init  = name[0].toUpperCase();
  $('self-avatar').textContent = init;
  $('self-name').textContent   = name;
  $('self-rating').textContent = `ELO ${State.stats.elo}`;
  $('info-size').textContent   = `${State.boardSize}×${State.boardSize}`;
  $('move-num').textContent    = 0;
  $('info-move').textContent   = 0;
  $('cap-black').textContent   = 0;
  $('cap-white').textContent   = 0;
  $('move-list').innerHTML     = '';
  $('scoring-overlay').classList.add('hidden');
  $('komi-val').textContent    = '6.5';

  // Color stones in sidebar
  const selfStone = $('panel-self').querySelector('.player-stone');
  const oppStone  = $('panel-opponent').querySelector('.player-stone');
  if (State.myColor === BLACK) {
    selfStone.className = 'player-stone stone-black';
    oppStone.className  = 'player-stone stone-white';
  } else {
    selfStone.className = 'player-stone stone-white';
    oppStone.className  = 'player-stone stone-black';
  }

  addChatMessage('Ván đấu bắt đầu! Chúc bạn chơi vui!', 'system');
}

/* ════════════════════════════════════════════════
   ONLINE GAME
═══════════════════════════════════════════════ */
async function startOnlineGame() {
  if (!firebaseService._ready || !State.user) {
    toast('Cần đăng nhập và cấu hình Firebase để chơi online', 'error');
    showView('view-setup');
    return;
  }
  showMatchmakingModal();
  const uid  = State.user.uid;
  const name = State.user.displayName || 'Khách';

  await firebaseService.joinQueue(uid, name, State.boardSize, State.stats.elo);

  // Poll for opponent
  const pollInterval = setInterval(async () => {
    const opp = await firebaseService.findOpponent(uid, State.boardSize);
    if (opp) {
      clearInterval(pollInterval);
      // I found someone: I am black
      const gameId = await firebaseService.createGame(uid, opp.userId, State.boardSize);
      await firebaseService.leaveQueue(uid);
      await firebaseService.leaveQueue(opp.userId);
      State.gameId = gameId;
      State.myColor = BLACK;
      State.board.setMyColor(BLACK);
      State.board.setDisabled(false);
      $('opp-name').textContent   = opp.displayName;
      $('opp-avatar').textContent = opp.displayName[0].toUpperCase();
      $('opp-rating').textContent = `ELO ${opp.elo}`;
      $('info-mode').textContent  = 'Online';
      hideMatchmakingModal();
      toast(`Tìm được đối thủ: ${opp.displayName}!`, 'success');
      startOnlineListener();
      startTimer();
    }
    $('mm-status').textContent = `Đang chờ... ${Math.floor(Math.random()*5)+1} người trong hàng`;
  }, 2500);

  // If I'm being matched by someone else
  const myRef = firebaseService.db.collection('matchmaking').doc(uid);
  const unsub = myRef.onSnapshot(async doc => {
    const data = doc.data();
    if (data && data.gameId) {
      clearInterval(pollInterval);
      unsub();
      State.gameId = data.gameId;
      State.myColor = WHITE;
      State.board.setMyColor(WHITE);
      State.board.setDisabled(true); // black goes first
      $('info-mode').textContent = 'Online';
      hideMatchmakingModal();
      toast('Đã kết nối với đối thủ!', 'success');
      startOnlineListener();
      startTimer();
    }
  });
}

function startOnlineListener() {
  if (State.gameUnsub) State.gameUnsub();
  State.gameUnsub = firebaseService.listenGame(State.gameId, data => {
    if (!data) return;
    // Sync engine state
    State.engine.fromJSON(data);
    State.board.draw();
    updateGameUI();
    // Enable my turn
    const isMyTurn = State.engine.current === State.myColor;
    State.board.setDisabled(!isMyTurn || State.engine.gameOver);
    if (data.status === 'finished' && data.result) {
      showScoringOverlay(data.result);
    }
  });

  // Chat listener
  State.chatUnsub = firebaseService.listenChat(State.gameId, msg => {
    const isSelf = msg.userId === State.user?.uid;
    addChatMessage(`${msg.name}: ${msg.text}`, isSelf ? 'self' : 'opp');
  });
}

/* ════════════════════════════════════════════════
   GAME MOVES
═══════════════════════════════════════════════ */
function onPlayerMove(x, y) {
  const engine = State.engine;
  const mode   = State.gameMode;

  if (mode === 'local') {
    // Local 2-player: alternate
    const result = engine.place(x, y);
    if (!result) return;
    State.board.setMyColor(engine.current); // switch ghost
    afterMove(result);
    if (engine.gameOver) endGame();
  } else if (mode === 'online') {
    if (engine.current !== State.myColor) return;
    const result = engine.place(x, y);
    if (!result) return;
    State.board.setDisabled(true);
    afterMove(result);
    // Push to Firestore
    firebaseService.pushMove(State.gameId,
      { x, y, color: result.color, captured: result.captured },
      engine.toJSON()
    );
    if (engine.gameOver) {
      const score = engine.score();
      firebaseService.endGame(State.gameId, score);
      endGame();
    }
  } else {
    // vs Bot
    if (engine.current !== State.myColor) return;
    const result = engine.place(x, y);
    if (!result) return;
    State.board.setDisabled(true);
    afterMove(result);
    if (engine.gameOver) { endGame(); return; }
    doBotMove();
  }
}

async function doBotMove() {
  const engine = State.engine;
  if (!State.bot || engine.gameOver) return;

  $('turn-text').textContent = 'Bot đang suy nghĩ...';

  let move;
  try {
    move = await State.bot.getMove(engine);
  } catch (e) {
    console.error('Bot error:', e);
    move = null;
  }

  if (engine.gameOver) return;

  if (move === null) {
    // Bot passes
    engine.pass();
    const passEntry = document.createElement('div');
    passEntry.textContent = `${engine.history.length}. Bot bỏ lượt`;
    $('move-list').appendChild(passEntry);
    $('move-list').scrollTop = $('move-list').scrollHeight;
  } else {
    const result = engine.place(move.x, move.y);
    if (result) afterMove(result);
  }

  State.board.draw();
  State.board.setDisabled(engine.current !== State.myColor);

  if (engine.gameOver) {
    endGame();
  } else {
    updateTurnIndicator();
  }
}

function afterMove(result) {
  updateGameUI();
  updateTurnIndicator();
  State.board.draw();

  // Add to history list
  const moveNum = State.engine.history.length;
  const label   = result.pass ? 'bỏ lượt' : coordLabel(result.x, result.y, State.boardSize);
  const colorName = result.color === BLACK ? '●' : '○';
  const entry = document.createElement('div');
  entry.textContent = `${moveNum}. ${colorName} ${label}${result.captured?.length ? ` (×${result.captured.length})` : ''}`;
  $('move-list').appendChild(entry);
  $('move-list').scrollTop = $('move-list').scrollHeight;
}

/* ════════════════════════════════════════════════
   PASS / RESIGN / UNDO
═══════════════════════════════════════════════ */
function passMove() {
  const engine = State.engine;
  const mode   = State.gameMode;

  if (engine.current !== State.myColor && mode !== 'local') return;
  engine.pass();

  const color = State.engine.history[State.engine.history.length-1].color;
  const entry = document.createElement('div');
  entry.textContent = `${engine.history.length}. ${color === BLACK ? '●' : '○'} Bỏ lượt`;
  $('move-list').appendChild(entry);

  updateTurnIndicator();
  toast('Bạn đã bỏ lượt', 'info');

  if (engine.gameOver) { endGame(); return; }

  if (mode !== 'local' && mode !== 'online') {
    State.board.setDisabled(true);
    doBotMove();
  } else if (mode === 'local') {
    State.board.setMyColor(engine.current);
  } else if (mode === 'online') {
    firebaseService.pushMove(State.gameId,
      { pass: true, color },
      engine.toJSON()
    );
    State.board.setDisabled(true);
  }
}

function resignGame() {
  if (!confirm('Bạn có chắc muốn đầu hàng?')) return;
  const engine = State.engine;
  const myColor = State.myColor;
  stopTimer();

  const result = {
    winner: myColor === BLACK ? WHITE : BLACK,
    black: myColor === BLACK ? 0 : 999,
    white: myColor === WHITE ? 0 : 999,
    resign: true
  };
  showScoringOverlay(result);
  if (State.gameMode === 'online' && State.gameId) {
    firebaseService.endGame(State.gameId, result);
  }
}

function undoMove() {
  const mode = State.gameMode;
  if (mode === 'online') { toast('Không thể hủy trong ván online', 'error'); return; }

  const engine = State.engine;
  if (mode !== 'local') {
    // Undo twice: player's move + bot's last move
    engine.undo();
    if (engine.history.length && engine.current !== State.myColor) engine.undo();
  } else {
    engine.undo();
    State.board.setMyColor(engine.current);
  }

  // Remove last entry from move list
  const list = $('move-list');
  if (list.lastChild) list.removeChild(list.lastChild);
  if (mode !== 'local' && list.lastChild) list.removeChild(list.lastChild);

  updateGameUI();
  updateTurnIndicator();
  State.board.setDisabled(mode !== 'local' && engine.current !== State.myColor);
  State.board.draw();
  toast('Đã hủy nước đi', 'info');
}

/* ════════════════════════════════════════════════
   GAME END
═══════════════════════════════════════════════ */
function endGame() {
  stopTimer();
  State.board.setDisabled(true);
  const result = State.engine.score();

  // Show territory
  State.board.showTerritory(result.territoryMap);

  // Save stats
  if (!State.isGuest) {
    const won = result.winner === State.myColor;
    State.stats.games++;
    if (won) { State.stats.wins++; State.stats.elo += 20; }
    else     { State.stats.losses++; State.stats.elo = Math.max(100, State.stats.elo - 15); }
    if (State.user) {
      firebaseService.updateUserStats(State.user.uid, State.stats);
    }
    updateStats();
  }

  showScoringOverlay(result);
}

function showScoringOverlay(result) {
  $('result-black').textContent      = typeof result.black === 'number' ? result.black.toFixed(1) : '–';
  $('result-white').textContent      = typeof result.white === 'number' ? result.white.toFixed(1) : '–';
  $('result-black-name').textContent = State.myColor === BLACK ? 'Bạn (Đen)' : (result.resign ? 'Đầu hàng' : 'Đen');
  $('result-white-name').textContent = State.myColor === WHITE ? 'Bạn (Trắng)' : 'Trắng';

  if (result.territory) {
    $('result-black-detail').innerHTML =
      `Lãnh thổ: ${result.territory[BLACK]}<br>Bắt quân: ${result.captures?.[BLACK] ?? 0}`;
    $('result-white-detail').innerHTML =
      `Lãnh thổ: ${result.territory[WHITE]}<br>Bắt quân: ${result.captures?.[WHITE] ?? 0}<br>Komi: +6.5`;
  }

  let banner;
  if (result.resign) {
    banner = `${result.winner === BLACK ? 'Đen' : 'Trắng'} thắng (đối thủ đầu hàng)`;
  } else {
    const isMyWin = result.winner === State.myColor;
    banner = isMyWin
      ? `🎉 Bạn thắng! (${result.margin.toFixed(1)} điểm)`
      : `Bạn thua. (${result.margin.toFixed(1)} điểm)`;
  }
  $('winner-banner').textContent = banner;
  $('scoring-overlay').classList.remove('hidden');
}

/* ════════════════════════════════════════════════
   TIMER
═══════════════════════════════════════════════ */
function startTimer() {
  if (State.timeControl === 0) {
    $('timer-self-val').textContent = '∞';
    $('timer-opp-val').textContent  = '∞';
    return;
  }
  stopTimer();
  State.timerInterval = setInterval(() => {
    const engine = State.engine;
    if (engine.gameOver) { stopTimer(); return; }

    const cur = engine.current;
    State.timers[cur] = Math.max(0, State.timers[cur] - 1);
    updateTimerDisplay();

    if (State.timers[cur] <= 0) {
      stopTimer();
      toast(`Hết giờ! ${cur === BLACK ? 'Đen' : 'Trắng'} thua`, 'error');
      const result = {
        winner: cur === BLACK ? WHITE : BLACK,
        timeout: true,
        black: State.timers[BLACK],
        white: State.timers[WHITE]
      };
      showScoringOverlay(result);
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(State.timerInterval);
  State.timerInterval = null;
}

function updateTimerDisplay() {
  const myT  = State.timers[State.myColor];
  const oppT = State.timers[State.myColor === BLACK ? WHITE : BLACK];
  const selfEl = $('timer-self-val');
  const oppEl  = $('timer-opp-val');

  selfEl.textContent = formatTime(myT);
  oppEl.textContent  = formatTime(oppT);

  // Highlight active timer
  const isMyTurn = State.engine && State.engine.current === State.myColor;
  $('timer-self').classList.toggle('active', isMyTurn);
  $('timer-self').classList.toggle('low', myT > 0 && myT <= 30);
  $('timer-opp').classList.toggle('active', !isMyTurn);
  $('timer-opp').classList.toggle('low', oppT > 0 && oppT <= 30);
}

/* ════════════════════════════════════════════════
   UI UPDATES
═══════════════════════════════════════════════ */
function updateGameUI() {
  const engine = State.engine;
  $('cap-black').textContent = engine.captures[BLACK];
  $('cap-white').textContent = engine.captures[WHITE];
  $('move-num').textContent  = engine.history.length;
  $('info-move').textContent = engine.history.length;
  updateTimerDisplay();
}

function updateTurnIndicator() {
  const engine = State.engine;
  const isBlack = engine.current === BLACK;
  $('turn-indicator').querySelector('.turn-stone').className = `turn-stone ${isBlack ? 'black' : 'white'}`;

  let text;
  const mode = State.gameMode;
  if (mode === 'local') {
    text = `Lượt: ${isBlack ? 'Đen' : 'Trắng'}`;
  } else if (engine.current === State.myColor) {
    text = 'Lượt của bạn';
  } else {
    text = mode === 'online' ? 'Đợi đối thủ...' : 'Bot đang nghĩ...';
  }
  $('turn-text').textContent = text;
}

/* ════════════════════════════════════════════════
   CHAT
═══════════════════════════════════════════════ */
function addChatMessage(text, cls = 'opp') {
  const msgs = $('chat-messages');
  const el   = document.createElement('div');
  el.className = `chat-msg ${cls}`;
  el.textContent = text;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

function sendChat() {
  const input = $('chat-input');
  const text  = input.value.trim();
  if (!text) return;
  input.value = '';

  const name = State.user ? (State.user.displayName || 'Bạn') : 'Bạn';
  addChatMessage(`${name}: ${text}`, 'self');

  if (State.gameMode === 'online' && State.gameId && firebaseService._ready) {
    firebaseService.sendChatMessage(State.gameId, State.user?.uid, name, text);
  } else if (State.gameMode !== 'online') {
    // In bot/local mode: echo as "Bot" reply randomly
    if (State.gameMode !== 'local' && Math.random() < 0.3) {
      const replies = ['🤔', 'Hm...', 'Thú vị!', 'OK!', 'Nước hay đấy!'];
      setTimeout(() => addChatMessage(`Bot: ${replies[Math.floor(Math.random()*replies.length)]}`, 'opp'), 1000);
    }
  }
}

/* ════════════════════════════════════════════════
   MATCHMAKING MODAL
═══════════════════════════════════════════════ */
function showMatchmakingModal() {
  const name = State.user?.displayName || 'Khách';
  $('mm-self-avatar').textContent = name[0].toUpperCase();
  $('mm-self-name').textContent   = name;
  $('mm-status').textContent      = 'Đang kết nối...';
  $('modal-matchmaking').classList.remove('hidden');
}
function hideMatchmakingModal() {
  $('modal-matchmaking').classList.add('hidden');
}

/* ════════════════════════════════════════════════
   EVENT BINDINGS
═══════════════════════════════════════════════ */
function bindEvents() {
  // Login
  $('btn-google-login').addEventListener('click', async () => {
    try {
      await firebaseService.signInGoogle();
      // Auth state change handled in handleAuthReady
    } catch (e) {
      if (e.code === 'auth/cancelled-by-user') return;
      toast('Đăng nhập thất bại: ' + e.message, 'error');
    }
  });

  $('btn-guest').addEventListener('click', () => {
    State.isGuest = true;
    State.user    = null;
    updateNavUser();
    showView('view-lobby');
    initLobby();
  });

  // Logout
  $('btn-logout').addEventListener('click', async () => {
    await firebaseService.signOut();
    State.user    = null;
    State.isGuest = false;
    State.stats   = { wins: 0, losses: 0, games: 0, elo: 1200 };
    showView('view-login');
  });

  // Lobby → Setup
  $('card-go').addEventListener('click', () => {
    showView('view-setup');
  });
  document.querySelector('#card-go .btn-play').addEventListener('click', e => {
    e.stopPropagation();
    showView('view-setup');
  });

  // Back buttons
  $('btn-setup-back').addEventListener('click', () => showView('view-lobby'));
  $('btn-game-back').addEventListener('click', () => {
    stopTimer();
    if (State.gameUnsub) { State.gameUnsub(); State.gameUnsub = null; }
    if (State.chatUnsub) { State.chatUnsub(); State.chatUnsub = null; }
    if (State.gameMode === 'online' && State.user) {
      firebaseService.leaveQueue(State.user.uid);
    }
    showView('view-lobby');
  });

  // Start game
  $('btn-start-game').addEventListener('click', startGame);

  // Game controls
  $('btn-pass').addEventListener('click', passMove);
  $('btn-resign').addEventListener('click', resignGame);
  $('btn-undo').addEventListener('click', undoMove);

  // Result buttons
  $('btn-rematch').addEventListener('click', () => {
    $('scoring-overlay').classList.add('hidden');
    startGame();
  });
  $('btn-to-lobby').addEventListener('click', () => {
    stopTimer();
    showView('view-lobby');
  });

  // Chat
  $('btn-chat-send').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  document.querySelectorAll('.qc').forEach(btn => {
    btn.addEventListener('click', () => {
      $('chat-input').value = btn.dataset.msg;
      sendChat();
    });
  });

  // Matchmaking cancel
  $('btn-cancel-mm').addEventListener('click', async () => {
    if (State.user) await firebaseService.leaveQueue(State.user.uid);
    hideMatchmakingModal();
    showView('view-setup');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const view = document.querySelector('.view.active');
    if (!view || view.id !== 'view-game') return;
    if (e.key === 'p' || e.key === 'P') passMove();
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undoMove(); }
  });
}

/* ════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
async function init() {
  showView('view-loading');
  initParticles();
  bindEvents();
  initSetup();

  // Init Firebase
  const fbReady = await firebaseService.init();

  if (fbReady) {
    firebaseService.onAuthChange(user => handleAuthReady(user));
    // Auth state may fire quickly; if no user after a moment, show login
    setTimeout(() => {
      if (!State.user) showView('view-login');
    }, 1500);
  } else {
    // No Firebase: show login with guest option
    setTimeout(() => showView('view-login'), 800);
  }
}

document.addEventListener('DOMContentLoaded', init);
