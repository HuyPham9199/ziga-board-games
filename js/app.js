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
  gameId:      null,
  gameUnsub:   null,
  chatUnsub:   null,

  // Timer
  timers:      { [BLACK]: 600, [WHITE]: 600 },
  timerInterval: null,

  // Matchmaking
  mmPollInterval: null,
  mmUnsub:        null,

  // Presence & Invite
  presenceUnsub:  null,
  inviteUnsub:    null,
  onlinePlayers:  [],          // raw list from Firestore
  onlineFilter:   'all',       // 'all' | 'looking' | 'in-game'
  onlineSearch:   '',
  pendingInviteId: null,       // invite I sent (waiting response)
  inviteRespUnsub: null,
  incomingInvite:  null,       // invite currently shown in modal
  inviteCountdown: null,       // timer interval for countdown
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
    const stats = await firebaseService.getUserStats(user.uid);
    if (stats) State.stats = stats;
    updateNavUser();
    showView('view-lobby');
    initLobby();
    startPresence('online');
    startListeningPresence();
    startListeningInvites();
  } else if (State.isGuest) {
    showView('view-login');
  }
}

function updateNavUser() {
  const name    = State.user ? (State.user.displayName || State.user.email || 'Người dùng') : 'Khách';
  const initial = name[0].toUpperCase();
  // Topnav
  $('nav-avatar').textContent   = initial;
  $('nav-username').textContent = name;
  // User menu profile
  if ($('um-avatar')) $('um-avatar').textContent = initial;
  if ($('um-name'))   $('um-name').textContent   = name;
  if ($('um-elo'))    $('um-elo').textContent     = State.stats.elo;
  updateStats();
}

function updateStats() {
  $('stat-wins').textContent   = State.stats.wins;
  $('stat-losses').textContent = State.stats.losses;
  $('stat-games').textContent  = State.stats.games;
  $('stat-elo').textContent    = State.stats.elo;
  // Sync ELO in user menu too
  if ($('um-elo')) $('um-elo').textContent = State.stats.elo;
}

/* ════════════════════════════════════════════════
   LOBBY
═══════════════════════════════════════════════ */
function initLobby() {
  // Online count is updated by renderOnlinePanel() via real Firebase presence.
  // Only show a placeholder when there's no Firebase connection.
  if (!firebaseService._ready) {
    $('lobby-online-count').textContent = '–';
    $('online-total').textContent       = '–';
  }
}

/* ════════════════════════════════════════════════
   PRESENCE
═══════════════════════════════════════════════ */
async function startPresence(status, gameInfo = {}) {
  if (!firebaseService._ready || !State.user) return;
  const name = State.user.displayName || State.user.email || 'Ẩn danh';
  await firebaseService.setPresence(State.user.uid, {
    displayName: name,
    avatar: name[0].toUpperCase(),
    elo:    State.stats.elo,
    status,                    // 'online' | 'looking' | 'in-game'
    game:      gameInfo.game      || null,
    boardSize: gameInfo.boardSize || null,
  });
}

function startListeningPresence() {
  if (!firebaseService._ready) return;
  if (State.presenceUnsub) State.presenceUnsub();
  State.presenceUnsub = firebaseService.listenPresence(players => {
    State.onlinePlayers = players;
    renderOnlinePanel();
  });
}

function stopPresence() {
  if (firebaseService._ready && State.user) {
    firebaseService.removePresence(State.user.uid);
  }
  if (State.presenceUnsub) { State.presenceUnsub(); State.presenceUnsub = null; }
}

/* ════════════════════════════════════════════════
   SEND INVITE
═══════════════════════════════════════════════ */
async function sendInviteTo(target, gameType = 'go') {
  if (!firebaseService._ready || !State.user) {
    toast('Cần đăng nhập Firebase để mời', 'error'); return;
  }
  if (State.pendingInviteId) {
    toast('Bạn đang có lời mời đang chờ', 'error'); return;
  }

  const from = {
    userId:      State.user.uid,
    displayName: State.user.displayName || 'Ẩn danh',
    elo:         State.stats.elo,
    avatar:      (State.user.displayName || 'A')[0].toUpperCase(),
  };

  try {
    const inviteId = await firebaseService.sendInvite(from, target.id, {
      game: gameType,
      boardSize: gameType === 'chess' ? 8 : State.boardSize
    });
    State.pendingInviteId = inviteId;
    showInviteSentModal(target.displayName, gameType);
    listenInviteResponse(inviteId, gameType);
  } catch (e) {
    toast('Không gửi được lời mời: ' + e.message, 'error');
  }
}

function showInviteSentModal(toName, gameType = 'go') {
  const gameLabel = gameType === 'chess' ? 'Cờ Vua ♔' : `Cờ Vây ${State.boardSize}×${State.boardSize}`;
  $('invite-sent-to').textContent = `Đã mời ${toName} vào ván ${gameLabel}`;
  $('modal-invite-sent').classList.remove('hidden');
}

function hideInviteSentModal() {
  $('modal-invite-sent').classList.add('hidden');
}

function listenInviteResponse(inviteId, gameType = 'go') {
  if (State.inviteRespUnsub) State.inviteRespUnsub();
  State.inviteRespUnsub = firebaseService.listenInviteResponse(inviteId, async data => {
    if (!data || data.status === 'pending') return;
    // Wait until invitee writes gameId before proceeding
    if (data.status === 'accepted' && !data.gameId) return;

    State.inviteRespUnsub?.();
    State.inviteRespUnsub = null;
    State.pendingInviteId = null;
    hideInviteSentModal();

    if (data.status === 'accepted') {
      toast('Đối thủ đồng ý! Đang bắt đầu ván đấu...', 'success');
      const gameId = data.gameId;
      await firebaseService.deleteInvite(inviteId);
      if (gameType === 'chess') {
        startChessOnlineGameWithId(gameId, 'w'); // inviter = white (first mover)
      } else {
        startOnlineGameWithId(gameId, BLACK);    // inviter = black (first mover)
      }
    } else {
      toast('Đối thủ từ chối lời mời', 'info');
      firebaseService.deleteInvite(inviteId);
    }
  });
}

/* ════════════════════════════════════════════════
   LISTEN INCOMING INVITES
═══════════════════════════════════════════════ */
function startListeningInvites() {
  if (!firebaseService._ready || !State.user) return;
  if (State.inviteUnsub) State.inviteUnsub();
  State.inviteUnsub = firebaseService.listenIncomingInvites(State.user.uid, invite => {
    showIncomingInvite(invite);
  });
}

function showIncomingInvite(invite) {
  // Don't stack invites
  if (State.incomingInvite) return;
  State.incomingInvite = invite;

  $('invite-from-avatar').textContent = invite.from.avatar || '?';
  $('invite-from-name').textContent   = invite.from.displayName || 'Ai đó';
  $('invite-from-elo').textContent    = `ELO ${invite.from.elo || 1200}`;
  $('invite-game-label').textContent  = invite.game === 'chess'
    ? 'Cờ Vua ♔'
    : `Cờ Vây ${invite.boardSize || 19}×${invite.boardSize || 19}`;
  $('modal-invite').classList.remove('hidden');

  // Countdown 30s
  let sec = 30;
  $('invite-countdown').textContent = sec;
  const fill = $('invite-progress');
  fill.style.transform = 'scaleX(1)';

  if (State.inviteCountdown) clearInterval(State.inviteCountdown);
  State.inviteCountdown = setInterval(() => {
    sec--;
    $('invite-countdown').textContent = sec;
    fill.style.transform = `scaleX(${sec / 30})`;
    if (sec <= 0) {
      clearInterval(State.inviteCountdown);
      declineInvite();
    }
  }, 1000);
}

async function acceptInvite() {
  const invite = State.incomingInvite;
  if (!invite) return;
  clearInterval(State.inviteCountdown);
  $('modal-invite').classList.add('hidden');
  State.incomingInvite = null;

  const gameType = invite.game || 'go';
  let gameId;

  if (gameType === 'chess') {
    // inviter = white (first mover), me = black
    gameId = await firebaseService.createChessGame(invite.from.userId, State.user.uid);
  } else {
    // inviter = black (first mover), me = white
    gameId = await firebaseService.createGame(invite.from.userId, State.user.uid, invite.boardSize || 19);
  }

  // Write accepted + gameId so inviter can join the same game (inviter deletes invite)
  await firebaseService.respondInvite(invite.id, 'accepted', gameId);
  toast('Đã đồng ý! Đang bắt đầu ván đấu...', 'success');

  if (gameType === 'chess') {
    startChessOnlineGameWithId(gameId, 'b');
  } else {
    State.boardSize = invite.boardSize || 19; // sync board size from invite
    startOnlineGameWithId(gameId, WHITE);
  }
}

async function declineInvite() {
  const invite = State.incomingInvite;
  if (!invite) return;
  clearInterval(State.inviteCountdown);
  $('modal-invite').classList.add('hidden');
  State.incomingInvite = null;

  await firebaseService.respondInvite(invite.id, 'declined');
  await firebaseService.deleteInvite(invite.id);
}

/* ════════════════════════════════════════════════
   START ONLINE GAME WITH KNOWN ID
═══════════════════════════════════════════════ */
function startOnlineGameWithId(gameId, myColor) {
  State.gameMode   = 'online';
  State.boardSize  = State.boardSize;
  State.playerColor = myColor;
  State.gameId     = gameId;

  State.engine  = new GoEngine(State.boardSize, 6.5);
  State.myColor = myColor;
  State.botColor = myColor === BLACK ? WHITE : BLACK;

  setupGameUI();
  State.board = new GoBoard('go-board', State.engine, {
    onPlace: (x, y) => onPlayerMove(x, y)
  });
  State.board.setMyColor(myColor);
  State.board.setDisabled(myColor !== BLACK); // black goes first

  const t = State.timeControl > 0 ? State.timeControl : 0;
  State.timers = { [BLACK]: t, [WHITE]: t };
  updateTimerDisplay();

  $('info-mode').textContent = 'Online (Lời mời)';
  showView('view-game');
  State.board.resize();
  startPresence('in-game', { game: 'go', boardSize: State.boardSize });
  startOnlineListener();
  startTimer();
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
  const myName  = State.user?.displayName || 'Bạn';
  const oppName = mode.startsWith('bot') ? ({ 'bot-easy':'Bot Dễ', 'bot-medium':'Bot Thường', 'bot-hard':'Bot Khó' }[mode]||'Bot') : (mode==='local'?'Người chơi 2':'Đối thủ');
  if (mode === 'online') {
    startPresence('looking', { game: 'go', boardSize: State.boardSize });
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
function stopMatchmaking() {
  clearInterval(State.mmPollInterval);
  State.mmPollInterval = null;
  if (State.mmUnsub) { State.mmUnsub(); State.mmUnsub = null; }
}

async function startOnlineGame() {
  if (!firebaseService._ready || !State.user) {
    toast('Cần đăng nhập và cấu hình Firebase để chơi online', 'error');
    showView('view-setup');
    return;
  }
  showMatchmakingModal();
  const uid  = State.user.uid;
  const name = State.user.displayName || 'Khách';

  await firebaseService.joinQueue(uid, name, State.boardSize, State.stats.elo, 'go');

  let matched = false;
  stopMatchmaking(); // clear any stale matchmaking

  // Passive: someone else found me and wrote my gameId
  const myRef = firebaseService.db.collection('matchmaking').doc(uid);
  State.mmUnsub = myRef.onSnapshot(async doc => {
    if (matched) return;
    const data = doc.data();
    if (data && data.gameId) {
      matched = true;
      stopMatchmaking();
      await firebaseService.leaveQueue(uid);
      State.gameId  = data.gameId;
      State.myColor = WHITE;
      State.board.setMyColor(WHITE);
      State.board.setDisabled(true);
      const oppName = data.oppName || 'Đối thủ';
      $('opp-name').textContent   = oppName;
      $('opp-avatar').textContent = oppName[0].toUpperCase();
      $('opp-rating').textContent = `ELO ${data.oppElo || 1200}`;
      $('info-mode').textContent  = 'Online';
      hideMatchmakingModal();
      toast(`Đã kết nối với ${oppName}!`, 'success');
      startPresence('in-game', { game: 'go', boardSize: State.boardSize, vsName: oppName });
      startOnlineListener();
      startTimer();
    }
  });

  // Active: I search for opponent
  State.mmPollInterval = setInterval(async () => {
    if (matched) { stopMatchmaking(); return; }
    const opp = await firebaseService.findOpponent(uid, State.boardSize, 'go');
    if (opp) {
      matched = true;
      stopMatchmaking();
      const gameId = await firebaseService.createGame(uid, opp.userId, State.boardSize);
      // Notify opponent: write gameId + my info so they can show my name
      try {
        await firebaseService.db.collection('matchmaking').doc(opp.userId).update({
          gameId, oppName: name, oppElo: State.stats.elo,
        });
      } catch(e) {}
      await firebaseService.leaveQueue(uid);
      State.gameId  = gameId;
      State.myColor = BLACK;
      State.board.setMyColor(BLACK);
      State.board.setDisabled(false);
      $('opp-name').textContent   = opp.displayName;
      $('opp-avatar').textContent = opp.displayName[0].toUpperCase();
      $('opp-rating').textContent = `ELO ${opp.elo}`;
      $('info-mode').textContent  = 'Online';
      hideMatchmakingModal();
      toast(`Tìm được đối thủ: ${opp.displayName}!`, 'success');
      startPresence('in-game', { game: 'go', boardSize: State.boardSize, vsName: opp.displayName });
      startOnlineListener();
      startTimer();
    }
    $('mm-status').textContent = `Đang chờ... ${Math.floor(Math.random()*5)+1} người trong hàng`;
  }, 2500);
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
   CHESS ONLINE MATCHMAKING
═══════════════════════════════════════════════ */
async function startChessOnlineGame() {
  if (!firebaseService._ready || !State.user) {
    toast('Cần đăng nhập và cấu hình Firebase để chơi online', 'error');
    showView('view-chess-setup');
    return;
  }
  showMatchmakingModal();
  const uid  = State.user.uid;
  const name = State.user.displayName || 'Khách';

  await firebaseService.joinQueue(uid, name, 8, State.stats.elo, 'chess');

  let matched = false;
  stopMatchmaking();

  const myRef = firebaseService.db.collection('matchmaking').doc(uid);
  State.mmUnsub = myRef.onSnapshot(async doc => {
    if (matched) return;
    const data = doc.data();
    if (data && data.gameId) {
      matched = true;
      stopMatchmaking();
      await firebaseService.leaveQueue(uid);
      hideMatchmakingModal();
      const oppName = data.oppName || 'Đối thủ';
      toast(`Đã kết nối với ${oppName}!`, 'success');
      startChessOnlineGameWithId(data.gameId, 'b', oppName, data.oppElo);
    }
  });

  State.mmPollInterval = setInterval(async () => {
    if (matched) { stopMatchmaking(); return; }
    const opp = await firebaseService.findOpponent(uid, 8, 'chess');
    if (opp) {
      matched = true;
      stopMatchmaking();
      const gameId = await firebaseService.createChessGame(uid, opp.userId);
      try {
        await firebaseService.db.collection('matchmaking').doc(opp.userId).update({
          gameId, oppName: name, oppElo: State.stats.elo,
        });
      } catch(e) {}
      await firebaseService.leaveQueue(uid);
      hideMatchmakingModal();
      toast(`Tìm được đối thủ: ${opp.displayName}!`, 'success');
      startChessOnlineGameWithId(gameId, 'w', opp.displayName, opp.elo);
    }
    $('mm-status').textContent = `Đang chờ... ${Math.floor(Math.random()*5)+1} người trong hàng`;
  }, 2500);
}

function startChessOnlineGameWithId(gameId, myColor, oppDisplayName = 'Đối thủ', oppElo = 1200) {
  Chess.gameId   = gameId;
  Chess.myColor  = myColor;
  Chess.gameMode = 'online';
  Chess.engine   = new ChessEngine();
  Chess.pendingPromo = null;

  const myName   = State.user?.displayName || 'Bạn';
  const selfStone = myColor === 'w' ? '♔' : '♚';
  const oppStone  = myColor === 'w' ? '♚' : '♔';

  $('chess-self-avatar').textContent  = myName[0].toUpperCase();
  $('chess-self-name').textContent    = myName;
  $('chess-self-rating').textContent  = `ELO ${State.stats.elo}`;
  $('chess-self-stone').textContent   = selfStone;
  $('chess-opp-avatar').textContent   = oppDisplayName[0].toUpperCase();
  $('chess-opp-name').textContent     = oppDisplayName;
  $('chess-opp-rating').textContent   = `ELO ${oppElo}`;
  $('chess-opp-stone').textContent    = oppStone;
  $('chess-info-mode').textContent    = 'Online';
  $('chess-info-move').textContent    = 0;
  $('chess-move-num').textContent     = 0;
  $('chess-move-list').innerHTML      = '';
  $('chess-result-overlay').classList.add('hidden');
  $('chess-check-badge').classList.add('hidden');
  $('chess-captured-by-me').innerHTML  = '';
  $('chess-captured-by-opp').innerHTML = '';

  const t = Chess.timeControl > 0 ? Chess.timeControl : 0;
  Chess.timers = { w: t, b: t };
  chessUpdateTimerDisplay();

  showView('view-chess-game');

  setTimeout(() => {
    Chess.board = new ChessBoard('chess-board', (from, to, promoTo) => {
      onChessPlayerMove(from, to, promoTo);
    });
    Chess.board.setEngine(Chess.engine);
    Chess.board.setFlipped(myColor === 'b');
    Chess.board.setDisabled(myColor !== 'w'); // white goes first
    Chess.board.resize();

    startPresence('in-game', { game: 'chess', boardSize: 8 });
    startChessOnlineListener();
    if (Chess.timeControl > 0) startChessTimer();
  }, 80);
}

function startChessOnlineListener() {
  if (Chess.gameUnsub) Chess.gameUnsub();
  Chess.gameUnsub = firebaseService.listenChessGame(Chess.gameId, data => {
    if (!data) return;
    Chess.engine.fromJSON(data);
    if (Chess.board) {
      Chess.board.setEngine(Chess.engine);
      Chess.board.reset();
    }
    const isMyTurn = Chess.engine.current === Chess.myColor;
    Chess.board?.setDisabled(!isMyTurn || Chess.engine.gameOver);
    chessUpdateTurnIndicator();
    updateChessCaptured();
    chessUpdateTimerDisplay();
    if ((data.status === 'finished' || Chess.engine.gameOver) && !Chess.engine._endShown) {
      Chess.engine._endShown = true;
      endChessGame();
    }
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

  // Lobby → Chess Setup
  $('card-chess').addEventListener('click', () => showView('view-chess-setup'));
  document.querySelector('#card-chess .btn-play').addEventListener('click', e => {
    e.stopPropagation();
    showView('view-chess-setup');
  });

  // Chess setup back
  $('btn-chess-setup-back').addEventListener('click', () => showView('view-lobby'));

  // Start chess
  $('btn-start-chess').addEventListener('click', startChessGame);

  // Chess game controls
  $('btn-chess-back').addEventListener('click', async () => {
    stopChessTimer();
    showView('view-lobby');
  });

  $('btn-chess-flip').addEventListener('click', () => {
    if (Chess.board) {
      Chess.board.setFlipped(!Chess.board.flipped);
      toast('Đã lật bàn cờ', 'info', 1200);
    }
  });

  $('btn-chess-resign').addEventListener('click', async () => {
    try {
      await showConfirm({ icon: '🏳', title: 'Đầu hàng?', msg: 'Bạn có chắc muốn đầu hàng không?', okText: 'Đầu hàng', danger: true });
    } catch { return; }
    stopChessTimer();
    const winner = Chess.myColor === 'w' ? 'b' : 'w';
    showChessResult({ type: 'resign', winner });
  });

  $('btn-chess-undo').addEventListener('click', () => {
    const engine = Chess.engine;
    if (!engine) return;
    if (Chess.gameMode !== 'local') {
      engine.undo(); // undo bot's move
      if (engine.history.length && engine.current !== Chess.myColor) engine.undo(); // undo player's move
    } else {
      engine.undo();
    }
    Chess.board.setEngine(engine);
    Chess.board.reset();
    $('chess-info-move').textContent = engine.history.length;
    $('chess-move-num').textContent  = engine.history.length;
    $('chess-check-badge').classList.toggle('hidden', !engine.inCheck);
    updateChessCaptured();
    Chess.board.setDisabled(Chess.gameMode !== 'local' && engine.current !== Chess.myColor);
    chessUpdateTurnIndicator();
    toast('Đã hủy nước đi', 'info');
  });

  $('btn-chess-rematch').addEventListener('click', () => {
    $('chess-result-overlay').classList.add('hidden');
    startChessGame();
  });

  $('btn-chess-to-lobby').addEventListener('click', () => {
    stopChessTimer();
    showView('view-lobby');
  });

  // Promotion modal
  document.querySelectorAll('.promo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $('chess-promo-modal').classList.add('hidden');
      if (!Chess.pendingPromo) return;
      const { from, to } = Chess.pendingPromo;
      Chess.pendingPromo = null;
      onChessPlayerMove(from, to, btn.dataset.piece);
    });
  });

  // Chess chat
  const chessChat = () => {
    const input = $('chess-chat-input');
    const text  = input.value.trim();
    if (!text) return;
    input.value = '';
    const name = State.user?.displayName || 'Bạn';
    addChatMsgToEl($('chess-chat-messages'), `${name}: ${text}`, 'self');
    if (Chess.gameMode !== 'local' && Math.random() < 0.25) {
      const replies = ['🤔', 'Hm...', 'OK!', 'Hay đấy!'];
      setTimeout(() => addChatMsgToEl($('chess-chat-messages'), `Bot: ${replies[Math.floor(Math.random()*replies.length)]}`, 'opp'), 900);
    }
  };
  $('btn-chess-chat-send').addEventListener('click', chessChat);
  $('chess-chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') chessChat(); });
  document.querySelectorAll('.qc-chess').forEach(btn => {
    btn.addEventListener('click', () => {
      $('chess-chat-input').value = btn.dataset.msg;
      chessChat();
    });
  });

  // Lobby → Setup
  $('card-go').addEventListener('click', () => {
    startPresence('looking', { game: 'go', boardSize: State.boardSize });
    showView('view-setup');
  });
  document.querySelector('#card-go .btn-play').addEventListener('click', e => {
    e.stopPropagation();
    startPresence('looking', { game: 'go', boardSize: State.boardSize });
    showView('view-setup');
  });

  // Back buttons
  $('btn-setup-back').addEventListener('click', () => {
    startPresence('online'); // back to lobby = online idle
    showView('view-lobby');
  });
  $('btn-game-back').addEventListener('click', () => {
    stopTimer();
    if (State.gameUnsub) { State.gameUnsub(); State.gameUnsub = null; }
    if (State.chatUnsub) { State.chatUnsub(); State.chatUnsub = null; }
    if (State.gameMode === 'online' && State.user) {
      firebaseService.leaveQueue(State.user.uid);
    }
    startPresence('online'); // back to lobby
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
    stopMatchmaking();
    if (State.user) await firebaseService.leaveQueue(State.user.uid);
    hideMatchmakingModal();
    showView('view-setup');
  });

  // Online filter tabs
  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      State.onlineFilter = btn.dataset.filter;
      renderOnlinePanel();
    });
  });

  // Online search
  $('online-search-input').addEventListener('input', e => {
    State.onlineSearch = e.target.value;
    renderOnlinePanel();
  });

  // Invite modal buttons
  $('btn-invite-accept').addEventListener('click', acceptInvite);
  $('btn-invite-decline').addEventListener('click', declineInvite);

  // Cancel sent invite
  $('btn-cancel-invite').addEventListener('click', async () => {
    if (State.pendingInviteId) {
      await firebaseService.deleteInvite(State.pendingInviteId);
      if (State.inviteRespUnsub) { State.inviteRespUnsub(); State.inviteRespUnsub = null; }
      State.pendingInviteId = null;
    }
    hideInviteSentModal();
  });

  // Result → lobby
  $('btn-to-lobby').addEventListener('click', () => {
    stopTimer();
    startPresence('online');
    showView('view-lobby');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const view = document.querySelector('.view.active');
    if (!view || view.id !== 'view-game') return;
    if (e.key === 'p' || e.key === 'P') passMove();
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undoMove(); }
  });

  // Close user menu when clicking outside
  document.addEventListener('click', e => {
    const menu = $('user-menu');
    if (!menu.classList.contains('hidden') &&
        !menu.contains(e.target) &&
        e.target !== $('btn-user-menu')) {
      menu.classList.add('hidden');
    }
  });

  // Spectate back button
  $('btn-spectate-back').addEventListener('click', () => {
    stopSpectate();
    showView('view-lobby');
  });

  // Confirm modal
  $('btn-confirm-cancel').addEventListener('click', () => {
    $('modal-confirm').classList.add('hidden');
    State._confirmReject?.();
  });
  $('btn-confirm-ok').addEventListener('click', () => {
    $('modal-confirm').classList.add('hidden');
    State._confirmResolve?.();
  });
}

/* ════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════ */
function initTheme() {
  const saved = localStorage.getItem('ziga-theme') || 'dark';
  setTheme(saved, false);
}

function setTheme(theme, save = true) {
  document.documentElement.setAttribute('data-theme', theme);
  if (save) localStorage.setItem('ziga-theme', theme);

  const isDark = theme === 'dark';
  const icon   = isDark ? '🌙' : '☀️';
  const label  = isDark ? '🌙 Chế độ tối' : '☀️ Chế độ sáng';
  if ($('btn-theme'))  $('btn-theme').textContent  = icon;
  if ($('um-theme'))   $('um-theme').textContent   = label;
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  setTheme(current === 'dark' ? 'light' : 'dark');
}

/* ════════════════════════════════════════════════
   CONFIRM DIALOG (promise-based)
═══════════════════════════════════════════════ */
function showConfirm(opts = {}) {
  return new Promise((resolve, reject) => {
    $('confirm-icon').textContent  = opts.icon  || '⚠️';
    $('confirm-title').textContent = opts.title || 'Bạn có chắc không?';
    $('confirm-msg').textContent   = opts.msg   || '';
    $('btn-confirm-ok').textContent = opts.okText || 'Xác nhận';
    $('btn-confirm-ok').className   = `btn-play${opts.danger ? ' danger-btn' : ''}`;
    State._confirmResolve = resolve;
    State._confirmReject  = reject;
    $('modal-confirm').classList.remove('hidden');
  });
}

/* ════════════════════════════════════════════════
   USER MENU BINDINGS (after DOM ready)
═══════════════════════════════════════════════ */
function bindUserMenu() {
  $('btn-user-menu').addEventListener('click', e => {
    e.stopPropagation();
    $('user-menu').classList.toggle('hidden');
  });

  $('btn-theme').addEventListener('click', toggleTheme);
  $('um-theme').addEventListener('click', () => {
    toggleTheme();
    $('user-menu').classList.add('hidden');
  });

  // Logout with confirm
  $('btn-logout').addEventListener('click', async () => {
    $('user-menu').classList.add('hidden');
    try {
      await showConfirm({
        icon: '⏻', title: 'Đăng xuất?',
        msg: 'Bạn có chắc muốn đăng xuất không?',
        okText: 'Đăng xuất', danger: true
      });
    } catch { return; } // cancelled

    stopPresence();
    if (State.inviteUnsub)   { State.inviteUnsub();   State.inviteUnsub   = null; }
    if (State.presenceUnsub) { State.presenceUnsub(); State.presenceUnsub = null; }
    await firebaseService.signOut();
    State.user = null; State.isGuest = false;
    State.stats = { wins: 0, losses: 0, games: 0, elo: 1200 };
    State.onlinePlayers = [];
    updateStats();
    showView('view-login');
    toast('Đã đăng xuất', 'info');
  });
}

/* ════════════════════════════════════════════════
   REDESIGNED ONLINE PANEL
═══════════════════════════════════════════════ */
function renderOnlinePanel() {
  const list   = $('online-list');
  const empty  = $('online-empty');
  const myId   = State.user?.uid;
  const search = State.onlineSearch.toLowerCase();
  const filter = State.onlineFilter;

  // Filter players
  let players = State.onlinePlayers.filter(p => {
    if (search && !p.displayName?.toLowerCase().includes(search)) return false;
    if (filter === 'looking' && p.status !== 'looking')  return false;
    if (filter === 'in-game' && p.status !== 'in-game')  return false;
    return true;
  });

  // Update counters
  $('online-total').textContent        = State.onlinePlayers.length;
  $('lobby-online-count').textContent  = State.onlinePlayers.length;

  if (!players.length) {
    list.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = '';

  // Group into sections
  const inGame  = players.filter(p => p.status === 'in-game');
  const looking = players.filter(p => p.status === 'looking');
  const online  = players.filter(p => p.status === 'online' || !p.status);

  const addSection = (label, count, items) => {
    if (!items.length) return;
    const hdr = document.createElement('div');
    hdr.className   = 'online-section-header';
    hdr.textContent = `${label} (${count})`;
    list.appendChild(hdr);
    items.forEach(p => list.appendChild(buildPlayerRow(p, myId)));
  };

  addSection('🔴 Đang chơi', inGame.length,  inGame);
  addSection('🟡 Tìm trận',  looking.length, looking);
  addSection('🟢 Online',    online.length,  online);
}

function buildPlayerRow(p, myId) {
  const isMe      = p.id === myId;
  const canInvite = !isMe && (p.status === 'online' || p.status === 'looking');
  const inGame    = p.status === 'in-game';

  const statusLabels = { online: 'Online', looking: 'Tìm trận', 'in-game': 'Đang chơi' };
  const gameText = p.game === 'chess' ? '♟ Cờ Vua' : p.game === 'go' ? `⬛⬜ Cờ Vây ${p.boardSize || 19}×${p.boardSize || 19}` : '';

  const row = document.createElement('div');
  row.className = `player-row${isMe ? ' is-me' : ''}`;
  row.dataset.uid = p.id;

  // Opponent name for in-game (stored as p.vsName)
  const vsInfo = inGame && p.vsName ? `<div class="pr-vs-info">vs ${escHtml(p.vsName)}</div>` : '';
  const gameTag = gameText ? `<div class="pr-game-tag">${gameText}</div>` : '';

  let actionBtn = '';
  if (canInvite) {
    actionBtn = `<button class="btn-invite-go" data-uid="${p.id}" title="Mời chơi Cờ Vây">⬛ Cờ Vây</button><button class="btn-invite-chess" data-uid="${p.id}" title="Mời chơi Cờ Vua">♔ Cờ Vua</button>`;
  } else if (inGame && p.gameId) {
    actionBtn = `<button class="btn-spectate" data-gameid="${p.gameId}" data-bname="${escHtml(p.blackName||'Đen')}" data-wname="${escHtml(p.whiteName||'Trắng')}" data-belo="${p.blackElo||1200}" data-welo="${p.whiteElo||1200}" data-size="${p.boardSize||19}">👁 Xem</button>`;
  }

  row.innerHTML = `
    <div class="pr-avatar">
      ${escHtml((p.avatar || p.displayName?.[0] || '?').toString())}
      <span class="pr-status-dot ${p.status || 'online'}"></span>
    </div>
    <div class="pr-info">
      <div class="pr-name">${escHtml(p.displayName || 'Ẩn danh')}${isMe ? ' <small style="color:var(--accent);font-size:10px">(bạn)</small>' : ''}</div>
      <div class="pr-meta">
        <span class="pr-elo">ELO ${p.elo || 1200}</span>
        <span class="pr-status-badge ${p.status || 'online'}">${statusLabels[p.status] || 'Online'}</span>
      </div>
      ${gameTag}${vsInfo}
    </div>
    <div class="pr-actions">${actionBtn}</div>`;

  // Bind action
  row.querySelector('.btn-invite-go')?.addEventListener('click',    () => sendInviteTo(p, 'go'));
  row.querySelector('.btn-invite-chess')?.addEventListener('click', () => sendInviteTo(p, 'chess'));
  const specBtn = row.querySelector('.btn-spectate');
  if (specBtn) specBtn.addEventListener('click', () => {
    const d = specBtn.dataset;
    startSpectate(d.gameid, {
      blackName: d.bname, whiteName: d.wname,
      blackElo: +d.belo, whiteElo: +d.welo,
      boardSize: +d.size
    });
  });

  return row;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ════════════════════════════════════════════════
   CHESS STATE
═══════════════════════════════════════════════ */
const Chess = {
  engine:      null,
  board:       null,
  bot:         null,
  myColor:     'w',      // 'w' | 'b'
  gameMode:    'bot-hard',
  timeControl: 300,
  timers:      { w: 300, b: 300 },
  timerInterval: null,
  pendingPromo: null,    // { from, to } waiting for piece selection
  gameId:      null,
  gameUnsub:   null,
};

/* ════════════════════════════════════════════════
   CHESS SETUP
═══════════════════════════════════════════════ */
function initChessSetup() {
  document.querySelectorAll('[data-chess-mode]').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('[data-chess-mode]').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      Chess.gameMode = card.dataset.chessMode;
    });
  });

  document.querySelectorAll('.chess-color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chess-color-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const c = btn.dataset.chessColor;
      if (c === 'white') Chess.myColor = 'w';
      else if (c === 'black') Chess.myColor = 'b';
      else Chess.myColor = Math.random() < 0.5 ? 'w' : 'b';
    });
  });

  document.querySelectorAll('.chess-time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chess-time-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      Chess.timeControl = parseInt(btn.dataset.chessTime);
    });
  });
}

/* ════════════════════════════════════════════════
   START CHESS GAME
═══════════════════════════════════════════════ */
function startChessGame() {
  if (Chess.gameMode === 'online') {
    // Need board view open before async matchmaking
    Chess.engine = new ChessEngine();
    Chess.pendingPromo = null;
    startChessOnlineGame();
    return;
  }

  Chess.engine = new ChessEngine();
  Chess.pendingPromo = null;

  const myColor  = Chess.myColor;
  const mode     = Chess.gameMode;
  const myName   = State.user?.displayName || 'Bạn';
  const botNames = { 'bot-easy': 'Bot Dễ', 'bot-medium': 'Bot Thường', 'bot-hard': 'Bot Khó' };
  const oppName  = mode.startsWith('bot') ? (botNames[mode] || 'Bot') : 'Người chơi 2';

  // Setup UI
  const selfStone = myColor === 'w' ? '♔' : '♚';
  const oppStone  = myColor === 'w' ? '♚' : '♔';
  $('chess-self-avatar').textContent  = myName[0].toUpperCase();
  $('chess-self-name').textContent    = myName;
  $('chess-self-rating').textContent  = `ELO ${State.stats.elo}`;
  $('chess-self-stone').textContent   = selfStone;
  $('chess-opp-avatar').textContent   = mode.startsWith('bot') ? '🤖' : oppName[0].toUpperCase();
  $('chess-opp-name').textContent     = oppName;
  $('chess-opp-rating').textContent   = { 'bot-easy':'ELO 800', 'bot-medium':'ELO 1200', 'bot-hard':'ELO 1800' }[mode] || 'ELO 1200';
  $('chess-opp-stone').textContent    = oppStone;
  $('chess-info-mode').textContent    = botNames[mode] || '2 Người';
  $('chess-info-move').textContent    = 0;
  $('chess-move-list').innerHTML      = '';
  $('chess-result-overlay').classList.add('hidden');
  $('chess-check-badge').classList.add('hidden');
  $('chess-captured-by-me').innerHTML  = '';
  $('chess-captured-by-opp').innerHTML = '';

  // Timer
  const t = Chess.timeControl > 0 ? Chess.timeControl : 0;
  Chess.timers = { w: t, b: t };
  chessUpdateTimerDisplay();

  showView('view-chess-game');

  // Create board after view is visible
  setTimeout(() => {
    Chess.board = new ChessBoard('chess-board', (from, to, promoTo) => {
      onChessPlayerMove(from, to, promoTo);
    });
    Chess.board.setEngine(Chess.engine);
    Chess.board.setFlipped(myColor === 'b');
    Chess.board.resize();

    if (mode.startsWith('bot')) {
      const diff = mode.replace('bot-', '');
      Chess.bot  = new ChessBot(diff);
      // If player is black, bot (white) goes first
      if (myColor === 'b') {
        Chess.board.setDisabled(true);
        doChessBotMove();
      } else {
        Chess.board.setDisabled(false);
      }
    } else {
      Chess.bot = null;
      Chess.board.setDisabled(false); // local: allow all moves
    }

    if (Chess.timeControl > 0) startChessTimer();
  }, 80);
}

/* ════════════════════════════════════════════════
   CHESS MOVE HANDLER
═══════════════════════════════════════════════ */
function onChessPlayerMove(from, to, promoTo) {
  const engine = Chess.engine;
  const mode   = Chess.gameMode;

  // Online: only move on your turn
  if (mode === 'online' && engine.current !== Chess.myColor) return;

  // Check if promotion is needed
  const piece    = engine.board[from[0]][from[1]];
  const promoRow = piece && piece[0] === 'w' ? 0 : 7;
  const isPromo  = piece && piece[1] === 'P' && to[0] === promoRow;

  if (isPromo && !promoTo) {
    Chess.pendingPromo = { from, to };
    showChessPromoModal(piece[0]);
    return;
  }

  const result = engine.move(from, to, promoTo || 'Q');
  if (!result) return;

  const snd = engine.inCheck ? 'check' : result.captured ? 'capture' : 'move';
  Chess.board.applyMove(from, to, snd);
  Chess.board.setEngine(engine);
  afterChessMove(result);

  if (mode === 'online') {
    Chess.board.setDisabled(true); // wait for opponent
    firebaseService.pushChessMove(Chess.gameId, engine.toJSON());
    if (engine.gameOver) {
      let type, winner;
      if (engine.result === 'draw') { type = 'draw'; winner = null; }
      else { type = engine.inCheck ? 'checkmate' : 'stalemate'; winner = engine.result; }
      firebaseService.endChessGame(Chess.gameId, { type, winner });
      endChessGame();
    }
    return;
  }

  if (engine.gameOver) { endChessGame(); return; }

  if (mode.startsWith('bot')) {
    Chess.board.setDisabled(true);
    doChessBotMove();
  } else {
    Chess.board.setDisabled(false);
  }
}

function showChessPromoModal(color) {
  const modal   = $('chess-promo-modal');
  const choices = modal.querySelectorAll('.promo-btn');
  // Show correct color symbols
  const pieces  = color === 'w'
    ? { Q:'♕', R:'♖', B:'♗', N:'♘' }
    : { Q:'♛', R:'♜', B:'♝', N:'♞' };
  choices.forEach(btn => { btn.textContent = pieces[btn.dataset.piece]; });
  modal.classList.remove('hidden');
}

async function doChessBotMove() {
  const engine = Chess.engine;
  if (!Chess.bot || engine.gameOver) return;

  $('chess-turn-text').textContent = 'Bot đang suy nghĩ...';

  let move;
  try {
    move = await Chess.bot.getMove(engine);
  } catch (e) {
    console.error('Chess bot error:', e);
    move = null;
  }

  if (!move || engine.gameOver) return;

  const result = engine.move(move.from, move.to, move.promo || 'Q');
  if (!result) return;

  const snd2 = engine.inCheck ? 'check' : result.captured ? 'capture' : 'move';
  Chess.board.applyMove(move.from, move.to, snd2);
  Chess.board.setEngine(engine);
  afterChessMove(result);

  if (engine.gameOver) {
    endChessGame();
  } else {
    Chess.board.setDisabled(engine.current !== Chess.myColor);
    chessUpdateTurnIndicator();
  }
}

function afterChessMove(move) {
  const engine = Chess.engine;
  $('chess-info-move').textContent = engine.history.length;
  $('chess-move-num').textContent  = engine.history.length;

  // Update check badge
  if (engine.inCheck) {
    $('chess-check-badge').classList.remove('hidden');
  } else {
    $('chess-check-badge').classList.add('hidden');
  }

  // Captured pieces display
  updateChessCaptured();

  // Move history
  const entry = document.createElement('div');
  const num   = Math.ceil(engine.history.length / 2);
  const isWhiteMove = move.piece[0] === 'w';
  const pieceSymbol = CHESS_UNICODE[move.piece] || '';
  const fileStr = String.fromCharCode(97 + move.to[1]);
  const rankStr = 8 - move.to[0];
  const captStr = move.captured ? 'x' : '';
  const label   = `${pieceSymbol}${captStr}${fileStr}${rankStr}${move.promo ? '=♕' : ''}${engine.inCheck ? '+' : ''}`;
  if (isWhiteMove) {
    entry.textContent = `${num}. ${label}`;
    entry.id = `chess-move-${engine.history.length}`;
  } else {
    const prev = $(`chess-move-${engine.history.length - 1}`);
    if (prev) { prev.textContent += `  ${label}`; }
    else { entry.textContent = `${num}. ... ${label}`; }
  }
  if (entry.textContent) $('chess-move-list').appendChild(entry);
  $('chess-move-list').scrollTop = $('chess-move-list').scrollHeight;

  chessUpdateTurnIndicator();
  chessUpdateTimerDisplay();
}

function updateChessCaptured() {
  const engine  = Chess.engine;
  const myColor = Chess.myColor;
  const oppColor = myColor === 'w' ? 'b' : 'w';

  // Tally captured pieces from board
  const initial = { P:8, N:2, B:2, R:2, Q:1 };
  const onBoard = { w:{}, b:{} };
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = engine.board[r][c];
    if (!p) continue;
    onBoard[p[0]][p[1]] = (onBoard[p[0]][p[1]] || 0) + 1;
  }
  const capturedByMe  = {}; // pieces of opp color captured by me
  const capturedByOpp = {};
  for (const [t, cnt] of Object.entries(initial)) {
    const byMe  = cnt - (onBoard[oppColor][t] || 0);
    const byOpp = cnt - (onBoard[myColor][t]  || 0);
    if (byMe  > 0) capturedByMe[t]  = byMe;
    if (byOpp > 0) capturedByOpp[t] = byOpp;
  }

  const renderCaps = (el, caps, color) => {
    el.innerHTML = '';
    const order = ['Q','R','B','N','P'];
    let total = '';
    for (const t of order) {
      if (!caps[t]) continue;
      const sym = CHESS_UNICODE[color + t] || t;
      total += sym.repeat(caps[t]);
    }
    if (total) el.textContent = total;
  };

  renderCaps($('chess-captured-by-me'),  capturedByMe,  oppColor);
  renderCaps($('chess-captured-by-opp'), capturedByOpp, myColor);
}

function chessUpdateTurnIndicator() {
  const engine  = Chess.engine;
  const myColor = Chess.myColor;
  const mode    = Chess.gameMode;
  const isWhite = engine.current === 'w';
  let text;
  if (mode === 'local') {
    text = `Lượt: ${isWhite ? 'Trắng ♔' : 'Đen ♚'}`;
  } else if (engine.current === myColor) {
    text = 'Lượt của bạn';
  } else {
    text = mode.startsWith('bot') ? 'Bot đang suy nghĩ...' : 'Đợi đối thủ...';
  }
  $('chess-turn-text').textContent = text;
}

/* ════════════════════════════════════════════════
   CHESS TIMER
═══════════════════════════════════════════════ */
function startChessTimer() {
  stopChessTimer();
  Chess.timerInterval = setInterval(() => {
    const engine = Chess.engine;
    if (!engine || engine.gameOver) { stopChessTimer(); return; }
    const cur = engine.current;
    Chess.timers[cur] = Math.max(0, Chess.timers[cur] - 1);
    chessUpdateTimerDisplay();
    if (Chess.timers[cur] <= 0) {
      stopChessTimer();
      const winner = cur === 'w' ? 'b' : 'w';
      toast(`Hết giờ! ${cur === 'w' ? 'Trắng' : 'Đen'} thua`, 'error');
      showChessResult({ type: 'timeout', winner });
    }
  }, 1000);
}

function stopChessTimer() {
  clearInterval(Chess.timerInterval);
  Chess.timerInterval = null;
}

function chessUpdateTimerDisplay() {
  const myColor  = Chess.myColor;
  const oppColor = myColor === 'w' ? 'b' : 'w';
  const myT  = Chess.timers[myColor];
  const oppT = Chess.timers[oppColor];

  if (Chess.timeControl === 0) {
    $('chess-timer-self-val').textContent = '∞';
    $('chess-timer-opp-val').textContent  = '∞';
    return;
  }
  $('chess-timer-self-val').textContent = formatTime(myT);
  $('chess-timer-opp-val').textContent  = formatTime(oppT);

  const isMyTurn = Chess.engine && Chess.engine.current === myColor;
  $('chess-timer-self').classList.toggle('active', isMyTurn);
  $('chess-timer-self').classList.toggle('low', myT > 0 && myT <= 30);
  $('chess-timer-opp').classList.toggle('active', !isMyTurn);
  $('chess-timer-opp').classList.toggle('low', oppT > 0 && oppT <= 30);
}

/* ════════════════════════════════════════════════
   CHESS GAME END
═══════════════════════════════════════════════ */
function endChessGame() {
  stopChessTimer();
  Chess.board?.setDisabled(true);
  const engine = Chess.engine;

  let type, winner;
  if (engine.result === 'draw') { type = 'draw'; winner = null; }
  else { type = engine.inCheck ? 'checkmate' : 'stalemate'; winner = engine.result; }

  if (!State.isGuest && type === 'checkmate') {
    const won = winner === Chess.myColor;
    State.stats.games++;
    if (won) { State.stats.wins++; State.stats.elo += 20; }
    else     { State.stats.losses++; State.stats.elo = Math.max(100, State.stats.elo - 15); }
    if (State.user) firebaseService.updateUserStats(State.user.uid, State.stats);
    updateStats();
  }
  showChessResult({ type, winner });
}

function showChessResult({ type, winner }) {
  let title, banner;
  if (type === 'checkmate') {
    const isWin = winner === Chess.myColor;
    title  = isWin ? '🎉 Bạn thắng!' : 'Bạn thua!';
    banner = `${winner === 'w' ? 'Trắng ♔' : 'Đen ♚'} thắng bằng chiếu hết`;
  } else if (type === 'stalemate') {
    title = 'Hòa!'; banner = 'Pat – không còn nước đi hợp lệ';
  } else if (type === 'draw') {
    title = 'Hòa!'; banner = '50 nước không ăn quân – Hòa';
  } else if (type === 'timeout') {
    const isWin = winner === Chess.myColor;
    title  = isWin ? '🎉 Bạn thắng!' : 'Bạn thua!';
    banner = `${winner === 'w' ? 'Trắng ♔' : 'Đen ♚'} thắng do hết giờ`;
  } else if (type === 'resign') {
    const isWin = winner === Chess.myColor;
    title  = isWin ? '🎉 Bạn thắng!' : 'Bạn đầu hàng';
    banner = `${winner === 'w' ? 'Trắng ♔' : 'Đen ♚'} thắng do đầu hàng`;
  }
  $('chess-result-title').textContent  = title;
  $('chess-winner-banner').textContent = banner;
  $('chess-result-overlay').classList.remove('hidden');
}

/* ════════════════════════════════════════════════
   SPECTATE MODE
═══════════════════════════════════════════════ */
const Spectate = {
  gameUnsub: null,
  engine:    null,
  board:     null,
};

function startSpectate(gameId, info) {
  if (!firebaseService._ready) { toast('Cần Firebase để xem trận đấu', 'error'); return; }

  // Setup UI
  $('spec-black-name').textContent = info.blackName;
  $('spec-white-name').textContent = info.whiteName;
  $('spec-black-elo').textContent  = `ELO ${info.blackElo}`;
  $('spec-white-elo').textContent  = `ELO ${info.whiteElo}`;
  $('spec-black-avatar').textContent = info.blackName?.[0]?.toUpperCase() || 'B';
  $('spec-white-avatar').textContent = info.whiteName?.[0]?.toUpperCase() || 'W';
  $('spec-game-info').textContent  = `${info.boardSize}×${info.boardSize}`;
  $('spec-move-list').innerHTML    = '';
  $('spec-move-num').textContent   = 0;

  // Create read-only engine & board
  Spectate.engine = new GoEngine(info.boardSize, 6.5);
  showView('view-spectate');

  // Small delay so canvas is visible before sizing
  setTimeout(() => {
    Spectate.board = new GoBoard('spec-board', Spectate.engine, { onPlace: () => {} });
    Spectate.board.setDisabled(true);
    Spectate.board.resize();

    // Listen to Firestore game
    Spectate.gameUnsub = firebaseService.listenGame(gameId, data => {
      if (!data) return;
      Spectate.engine.fromJSON(data);
      Spectate.board.draw();

      // Update UI
      const isBlack = Spectate.engine.current === BLACK;
      $('spec-turn-indicator').querySelector('.turn-stone').className = `turn-stone ${isBlack ? 'black' : 'white'}`;
      $('spec-turn-text').textContent = `Lượt: ${isBlack ? info.blackName : info.whiteName}`;
      $('spec-move-num').textContent  = Spectate.engine.history.length;
      $('spec-cap-black').textContent = Spectate.engine.captures[BLACK];
      $('spec-cap-white').textContent = Spectate.engine.captures[WHITE];

      // Append latest move to list
      if (data.moves?.length) {
        const ml = $('spec-move-list');
        ml.innerHTML = '';
        data.moves.slice(-20).forEach((m, i) => {
          const el = document.createElement('div');
          const label = m.pass ? 'bỏ lượt' : `${colToLetter(m.x)}${info.boardSize - m.y}`;
          el.textContent = `${data.moves.length - 20 + i + 1}. ${m.color === BLACK ? '●' : '○'} ${label}`;
          ml.appendChild(el);
        });
        ml.scrollTop = ml.scrollHeight;
      }

      if (data.status === 'finished') {
        addChatMsgToEl($('spec-chat-messages'), '🏁 Trận đấu kết thúc', 'system');
      }
    });

    toast(`Đang xem trận: ${info.blackName} vs ${info.whiteName}`, 'info');
  }, 100);
}

function stopSpectate() {
  if (Spectate.gameUnsub) { Spectate.gameUnsub(); Spectate.gameUnsub = null; }
  Spectate.engine = null;
  Spectate.board  = null;
}

function addChatMsgToEl(el, text, cls) {
  const div = document.createElement('div');
  div.className   = `chat-msg ${cls}`;
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

/* ════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
async function init() {
  initTheme();
  showView('view-loading');
  initParticles();
  bindEvents();
  bindUserMenu();
  initSetup();

  initChessSetup();

  const fbReady = await firebaseService.init();
  if (fbReady) {
    firebaseService.onAuthChange(user => handleAuthReady(user));
    setTimeout(() => { if (!State.user) showView('view-login'); }, 1500);
  } else {
    setTimeout(() => showView('view-login'), 800);
  }
}

document.addEventListener('DOMContentLoaded', init);
