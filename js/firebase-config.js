/**
 * ZIGA Firebase Configuration
 * ─────────────────────────────────────────────────────────────
 * SETUP INSTRUCTIONS:
 *  1. Go to https://console.firebase.google.com/
 *  2. Create a new project (e.g. "ziga-boardgames")
 *  3. Enable Authentication → Google sign-in
 *  4. Enable Firestore Database (start in test mode)
 *  5. Add a Web App → copy the config below
 *  6. Replace the placeholder values with your actual config
 * ─────────────────────────────────────────────────────────────
 */

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBt_ezYNeOFmUQ2CH6JHvIrlDlDfkyzZuw",
  authDomain:        "ziga-board-games.firebaseapp.com",
  projectId:         "ziga-board-games",
  storageBucket:     "ziga-board-games.firebasestorage.app",
  messagingSenderId: "765668497317",
  appId:             "1:765668497317:web:8c2d0135d0ae60c2207a4c",
  measurementId:     "G-5KYRNNJZ6R"
};

/* ── Firebase SDK loader ──────────────────────────────────── */
class FirebaseService {
  constructor() {
    this.app      = null;
    this.auth     = null;
    this.db       = null;
    this.user     = null;
    this._ready   = false;
    this._listeners = [];
  }

  async init() {
    // Check if Firebase config is set
    if (FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY') {
      console.warn('[ZIGA] Firebase not configured – running in offline mode');
      this._ready = false;
      return false;
    }
    try {
      // Dynamically import Firebase SDK v9 compat (CDN)
      await this._loadScripts();
      firebase.initializeApp(FIREBASE_CONFIG);
      this.auth = firebase.auth();
      this.db   = firebase.firestore();
      this._ready = true;
      console.log('[ZIGA] Firebase ready');

      // Listen for auth state
      this.auth.onAuthStateChanged(user => {
        this.user = user;
        this._listeners.forEach(fn => fn(user));
      });
      return true;
    } catch (err) {
      console.error('[ZIGA] Firebase init error:', err);
      this._ready = false;
      return false;
    }
  }

  _loadScripts() {
    return new Promise((resolve, reject) => {
      if (window.firebase) return resolve();
      const scripts = [
        'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js',
        'https://www.gstatic.com/firebasejs/9.22.0/firebase-auth-compat.js',
        'https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore-compat.js'
      ];
      let loaded = 0;
      scripts.forEach(src => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => { if (++loaded === scripts.length) resolve(); };
        s.onerror = reject;
        document.head.appendChild(s);
      });
    });
  }

  onAuthChange(fn) { this._listeners.push(fn); }

  /* ── Auth ─────────────────────────────────────── */
  async signInGoogle() {
    if (!this._ready) throw new Error('Firebase not configured');
    const provider = new firebase.auth.GoogleAuthProvider();
    return this.auth.signInWithPopup(provider);
  }

  async signOut() {
    if (!this._ready) return;
    return this.auth.signOut();
  }

  /* ── Matchmaking ──────────────────────────────── */
  async joinQueue(userId, displayName, boardSize, elo = 1200, game = 'go') {
    if (!this._ready) return null;
    const ref = this.db.collection('matchmaking').doc(userId);
    await ref.set({
      userId, displayName, boardSize, elo, game,
      status: 'waiting',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref;
  }

  async leaveQueue(userId) {
    if (!this._ready) return;
    await this.db.collection('matchmaking').doc(userId).delete();
  }

  async findOpponent(userId, boardSize, game = 'go') {
    if (!this._ready) return null;
    // Single-field query avoids composite index requirement; filter client-side
    const snap = await this.db.collection('matchmaking')
      .where('status', '==', 'waiting')
      .limit(50)
      .get();
    const others = snap.docs.filter(d => {
      if (d.id === userId) return false;
      const data = d.data();
      return data.boardSize === boardSize && (data.game || 'go') === game;
    });
    return others.length ? others[0].data() : null;
  }

  async createGame(blackId, whiteId, boardSize, blackName = '', whiteName = '', blackElo = 1200, whiteElo = 1200) {
    if (!this._ready) return null;
    const ref = this.db.collection('games').doc();
    const data = {
      blackId, whiteId, boardSize, blackName, whiteName, blackElo, whiteElo,
      board: Array(boardSize).fill(null).map(() => Array(boardSize).fill(0)),
      current: BLACK,
      captures: { [BLACK]: 0, [WHITE]: 0 },
      koPoint: null,
      passCount: 0,
      status: 'playing',
      moves: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await ref.set(data);
    return ref.id;
  }

  /* Listen for a new game where I am whiteId/blackId (single-field query, no composite index needed) */
  listenForMyGame(userId, role, collectionName, callback) {
    if (!this._ready) return () => {};
    const field = role === 'white' ? 'whiteId' : 'blackId';
    return this.db.collection(collectionName)
      .where(field, '==', userId)
      .onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          if (change.type === 'added') {
            const data = { id: change.doc.id, ...change.doc.data() };
            if (data.status === 'playing') callback(data);
          }
        });
      });
  }

  listenGame(gameId, callback) {
    if (!this._ready) return () => {};
    return this.db.collection('games').doc(gameId)
      .onSnapshot(doc => callback(doc.data()));
  }

  async pushMove(gameId, moveData, engineJSON) {
    if (!this._ready) return;
    await this.db.collection('games').doc(gameId).update({
      ...engineJSON,
      moves: firebase.firestore.FieldValue.arrayUnion(moveData),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async endGame(gameId, result) {
    if (!this._ready) return;
    await this.db.collection('games').doc(gameId).update({
      status: 'finished',
      result,
      finishedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  /* ── Chess Online ─────────────────────────────── */
  async createChessGame(whiteId, blackId, whiteName = '', blackName = '', whiteElo = 1200, blackElo = 1200) {
    if (!this._ready) return null;
    const ref = this.db.collection('chess-games').doc();
    await ref.set({
      whiteId, blackId, whiteName, blackName, whiteElo, blackElo,
      board: [
        ['bR','bN','bB','bQ','bK','bB','bN','bR'],
        ['bP','bP','bP','bP','bP','bP','bP','bP'],
        [null,null,null,null,null,null,null,null],
        [null,null,null,null,null,null,null,null],
        [null,null,null,null,null,null,null,null],
        [null,null,null,null,null,null,null,null],
        ['wP','wP','wP','wP','wP','wP','wP','wP'],
        ['wR','wN','wB','wQ','wK','wB','wN','wR'],
      ],
      current: 'w',
      castling: { wK: true, wQ: true, bK: true, bQ: true },
      enPassant: null,
      halfMoves: 0,
      fullMoves: 1,
      gameOver: false,
      result: null,
      status: 'playing',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  }

  listenChessGame(gameId, callback) {
    if (!this._ready) return () => {};
    return this.db.collection('chess-games').doc(gameId)
      .onSnapshot(doc => callback(doc.data()));
  }

  async pushChessMove(gameId, engineJSON) {
    if (!this._ready) return;
    await this.db.collection('chess-games').doc(gameId).update({
      ...engineJSON,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async endChessGame(gameId, result) {
    if (!this._ready) return;
    await this.db.collection('chess-games').doc(gameId).update({
      status: 'finished',
      gameOver: true,
      result,
      finishedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  /* ── User stats ───────────────────────────────── */
  async getUserStats(userId) {
    if (!this._ready) return null;
    const doc = await this.db.collection('users').doc(userId).get();
    return doc.exists ? doc.data() : { wins: 0, losses: 0, games: 0, elo: 1200 };
  }

  async updateUserStats(userId, delta) {
    if (!this._ready) return;
    await this.db.collection('users').doc(userId).set(delta, { merge: true });
  }

  /* ── Chat ─────────────────────────────────────── */
  async sendChatMessage(gameId, userId, name, text) {
    if (!this._ready) return;
    await this.db.collection('games').doc(gameId)
      .collection('chat').add({
        userId, name, text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
  }

  listenChat(gameId, callback) {
    if (!this._ready) return () => {};
    return this.db.collection('games').doc(gameId)
      .collection('chat').orderBy('createdAt')
      .onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          if (change.type === 'added') callback(change.doc.data());
        });
      });
  }

  /* ── Presence ─────────────────────────────────────────────
   * status: 'online' | 'looking' | 'in-game'
   * game: 'go' | null
   * boardSize: 9 | 13 | 19 | null
   ─────────────────────────────────────────────────────────── */
  async setPresence(userId, data) {
    if (!this._ready) return;
    await this.db.collection('presence').doc(userId).set({
      ...data,
      lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Auto-remove on tab close
    if (!this._presenceCleanup) {
      this._presenceCleanup = () => {
        // Best-effort: use beacon API
        const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/presence/${userId}`;
        navigator.sendBeacon && navigator.sendBeacon(url);
        this.removePresence(userId);
      };
      window.addEventListener('beforeunload', this._presenceCleanup);
    }

    // Heartbeat every 25s
    if (!this._heartbeat) {
      this._heartbeat = setInterval(() => {
        if (!this._ready) return;
        this.db.collection('presence').doc(userId).update({
          lastSeen: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});
      }, 25000);
    }
  }

  async removePresence(userId) {
    if (!this._ready) return;
    clearInterval(this._heartbeat);
    this._heartbeat = null;
    await this.db.collection('presence').doc(userId).delete().catch(() => {});
  }

  listenPresence(callback) {
    if (!this._ready) return () => {};
    // Only show users seen within last 60 seconds
    const cutoff = new Date(Date.now() - 60000);
    return this.db.collection('presence')
      .where('lastSeen', '>', firebase.firestore.Timestamp.fromDate(cutoff))
      .onSnapshot(snap => {
        const players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        callback(players);
      });
  }

  /* ── Invites ──────────────────────────────────────────────
   * Sends invite from `from` user to `toUserId`
   ─────────────────────────────────────────────────────────── */
  async sendInvite(from, toUserId, gameConfig) {
    if (!this._ready) throw new Error('Firebase not ready');
    const ref = this.db.collection('invites').doc();
    await ref.set({
      id: ref.id,
      from,               // { userId, displayName, elo, avatar }
      toUserId,
      game: gameConfig.game,       // 'go'
      boardSize: gameConfig.boardSize,
      status: 'pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  }

  async respondInvite(inviteId, status, gameId = null) {
    if (!this._ready) return;
    const update = { status };
    if (gameId) update.gameId = gameId;
    await this.db.collection('invites').doc(inviteId).update(update);
  }

  listenIncomingInvites(userId, callback) {
    if (!this._ready) return () => {};
    return this.db.collection('invites')
      .where('toUserId', '==', userId)
      .where('status',   '==', 'pending')
      .onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          if (change.type === 'added') {
            callback({ id: change.doc.id, ...change.doc.data() });
          }
        });
      });
  }

  listenInviteResponse(inviteId, callback) {
    if (!this._ready) return () => {};
    return this.db.collection('invites').doc(inviteId)
      .onSnapshot(doc => {
        if (doc.exists) callback(doc.data());
      });
  }

  async deleteInvite(inviteId) {
    if (!this._ready) return;
    await this.db.collection('invites').doc(inviteId).delete().catch(() => {});
  }
}

window.firebaseService = new FirebaseService();
