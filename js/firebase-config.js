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

// ← REPLACE THESE VALUES with your Firebase project config
const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
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
  async joinQueue(userId, displayName, boardSize, elo = 1200) {
    if (!this._ready) return null;
    const ref = this.db.collection('matchmaking').doc(userId);
    await ref.set({
      userId, displayName, boardSize, elo,
      status: 'waiting',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref;
  }

  async leaveQueue(userId) {
    if (!this._ready) return;
    await this.db.collection('matchmaking').doc(userId).delete();
  }

  async findOpponent(userId, boardSize) {
    if (!this._ready) return null;
    const snap = await this.db.collection('matchmaking')
      .where('status', '==', 'waiting')
      .where('boardSize', '==', boardSize)
      .limit(5)
      .get();
    const others = snap.docs.filter(d => d.id !== userId);
    return others.length ? others[0].data() : null;
  }

  async createGame(blackId, whiteId, boardSize) {
    if (!this._ready) return null;
    const ref = this.db.collection('games').doc();
    const data = {
      blackId, whiteId, boardSize,
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
}

window.firebaseService = new FirebaseService();
