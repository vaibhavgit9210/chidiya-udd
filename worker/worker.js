// chidiya-udd — WebSocket game rooms for the online mode of the Chidiya Udd game.
// One Durable Object instance per 4-letter room code (idFromName). All state is
// in-memory: the room resets itself when the last socket closes.
//
// Protocol (JSON over WS), client -> server:
//   {t:'hold', down:bool}   finger on/off the pad
//   {t:'lift', round:n}     player lifted during a call window (means "it flies")
//   {t:'start'}             host starts the game (needs >=2 players)
//   {t:'again'}             host returns everyone to the lobby after game over
// server -> client:
//   {t:'joined', you, code}
//   {t:'lobby', state, players:[{id,name,alive,host,wins}]}
//   {t:'holds', h:[ids currently holding]}        (only between rounds)
//   {t:'call', round, word:{d,l,e}, windowMs}     word: devanagari, latin, emoji
//   {t:'result', round, flies, results:[{id,flew,ok}]}
//   {t:'gameover', winnerId|null}
//   {t:'error', msg}

// Keep in sync with WORDS in index.html (display strings come from here for
// online games, so a drifted client still shows the right word).
const WORDS = [
  ['चिड़िया', 'Chidiya', '🐦', 1], ['तोता', 'Tota', '🦜', 1], ['कबूतर', 'Kabootar', '🕊️', 1],
  ['कौआ', 'Kauwa', '🐦‍⬛', 1], ['तितली', 'Titli', '🦋', 1], ['मच्छर', 'Machhar', '🦟', 1],
  ['मक्खी', 'Makkhi', '🪰', 1], ['चील', 'Cheel', '🦅', 1], ['उल्लू', 'Ullu', '🦉', 1],
  ['बत्तख', 'Battakh', '🦆', 1], ['मधुमक्खी', 'Madhumakkhi', '🐝', 1], ['चमगादड़', 'Chamgadad', '🦇', 1],
  ['हवाई जहाज़', 'Hawai Jahaz', '✈️', 1], ['हेलीकॉप्टर', 'Helicopter', '🚁', 1],
  ['पतंग', 'Patang', '🪁', 1], ['रॉकेट', 'Rocket', '🚀', 1],
  ['गाय', 'Gaay', '🐄', 0], ['भैंस', 'Bhains', '🐃', 0], ['कुत्ता', 'Kutta', '🐕', 0],
  ['बिल्ली', 'Billi', '🐈', 0], ['हाथी', 'Hathi', '🐘', 0], ['घोड़ा', 'Ghoda', '🐴', 0],
  ['बकरी', 'Bakri', '🐐', 0], ['मछली', 'Machhli', '🐟', 0], ['साँप', 'Saanp', '🐍', 0],
  ['मेंढक', 'Mendak', '🐸', 0], ['कछुआ', 'Kachhua', '🐢', 0], ['केकड़ा', 'Kekda', '🦀', 0],
  ['पेंगुइन', 'Penguin', '🐧', 0], ['कुर्सी', 'Kursi', '🪑', 0], ['जूता', 'Joota', '👟', 0],
  ['पत्थर', 'Patthar', '🪨', 0], ['आलू', 'Aloo', '🥔', 0], ['रिक्शा', 'Rickshaw', '🛺', 0],
  ['साइकिल', 'Cycle', '🚲', 0], ['बस', 'Bus', '🚌', 0], ['रेलगाड़ी', 'Railgaadi', '🚂', 0],
];

const WINDOW_START = 2400, WINDOW_MIN = 900, WINDOW_DECAY = 0.93;
const LIFT_GRACE_MS = 300; // network slack past the window before judging

export default {
  fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/ws\/([A-Z]{4})$/);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket')
        return new Response('websocket expected', { status: 426 });
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
    }
    return new Response('chidiya-udd ok', {
      headers: { 'access-control-allow-origin': '*' },
    });
  },
};

export class Room {
  constructor() {
    this.reset();
    this.nextId = 1;
  }

  reset() {
    this.players = new Map(); // id -> {id,name,ws,alive,holding,host,wins,lifted}
    this.state = 'lobby';     // lobby | between | call | over
    this.round = 0;
    this.windowMs = WINDOW_START;
    this.word = null;
    this.preTimer = null;
    this.judgeTimer = null;
  }

  fetch(req) {
    const url = new URL(req.url);
    const code = url.pathname.split('/')[2];
    const name = (url.searchParams.get('name') || 'Player').slice(0, 14).trim() || 'Player';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    let refuse = null;
    if (this.players.size >= 8) refuse = 'Room bhara hua hai (max 8)';
    else if (this.state !== 'lobby' && this.state !== 'over') refuse = 'Game chal raha hai, thodi der mein aao';
    if (refuse) {
      server.send(JSON.stringify({ t: 'error', msg: refuse }));
      server.close(1000, refuse);
      return new Response(null, { status: 101, webSocket: client });
    }

    const p = {
      id: String(this.nextId++), name, ws: server,
      alive: true, holding: false, lifted: false,
      host: this.players.size === 0, wins: 0,
    };
    this.players.set(p.id, p);
    server.addEventListener('message', (e) => {
      try { this.onMsg(p, JSON.parse(e.data)); } catch { /* ignore junk */ }
    });
    server.addEventListener('close', () => this.onLeave(p));
    server.addEventListener('error', () => this.onLeave(p));

    this.send(p, { t: 'joined', you: p.id, code });
    this.lobby();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- messaging helpers ----
  send(p, msg) { try { p.ws.send(JSON.stringify(msg)); } catch { /* closing */ } }
  cast(msg) { const s = JSON.stringify(msg); for (const p of this.players.values()) { try { p.ws.send(s); } catch { } } }
  lobby() {
    this.cast({
      t: 'lobby', state: this.state,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, alive: p.alive, host: p.host, wins: p.wins })),
    });
  }
  clearTimers() {
    if (this.preTimer) { clearTimeout(this.preTimer); this.preTimer = null; }
    if (this.judgeTimer) { clearTimeout(this.judgeTimer); this.judgeTimer = null; }
  }

  // ---- inbound ----
  onMsg(p, m) {
    if (m.t === 'start' && p.host && (this.state === 'lobby' || this.state === 'over')) {
      if (this.players.size < 2) return this.send(p, { t: 'error', msg: 'Kam se kam 2 khiladi chahiye' });
      this.round = 0;
      this.windowMs = WINDOW_START;
      for (const q of this.players.values()) { q.alive = true; q.lifted = false; }
      this.state = 'between';
      this.lobby();
      this.checkStart();
    } else if (m.t === 'again' && p.host && this.state === 'over') {
      this.state = 'lobby';
      for (const q of this.players.values()) q.alive = true;
      this.lobby();
    } else if (m.t === 'hold') {
      p.holding = !!m.down;
      if (this.state === 'between') {
        this.cast({ t: 'holds', h: [...this.players.values()].filter((q) => q.holding).map((q) => q.id) });
        this.checkStart();
      }
    } else if (m.t === 'lift' && this.state === 'call' && m.round === this.round && p.alive) {
      p.lifted = true;
      p.holding = false;
    }
  }

  onLeave(p) {
    if (!this.players.has(p.id)) return;
    this.players.delete(p.id);
    if (this.players.size === 0) { this.clearTimers(); this.reset(); return; }
    if (p.host) [...this.players.values()][0].host = true;
    if (this.state === 'between' || this.state === 'call' || this.state === 'cooldown') {
      const alive = [...this.players.values()].filter((q) => q.alive);
      if (alive.length <= 1) return this.gameover(alive[0]?.id ?? null);
      if (this.state === 'between') this.checkStart();
    }
    this.lobby();
  }

  // ---- game flow ----
  checkStart() {
    if (this.state !== 'between') return;
    const alive = [...this.players.values()].filter((q) => q.alive);
    const ready = alive.every((q) => q.holding);
    if (!ready) { if (this.preTimer) { clearTimeout(this.preTimer); this.preTimer = null; } return; }
    if (this.preTimer) return; // already counting down to the call
    this.preTimer = setTimeout(() => { this.preTimer = null; this.call(); }, 600 + Math.random() * 1100);
  }

  call() {
    if (this.state !== 'between') return;
    const alive = [...this.players.values()].filter((q) => q.alive);
    if (!alive.every((q) => q.holding)) return this.checkStart(); // someone slipped off
    this.state = 'call';
    this.round++;
    for (const q of this.players.values()) q.lifted = false;
    // ~55% fliers keeps the tension up
    const pool = WORDS.filter((w) => w[3] === (Math.random() < 0.55 ? 1 : 0));
    this.word = pool[Math.floor(Math.random() * pool.length)];
    this.cast({
      t: 'call', round: this.round,
      word: { d: this.word[0], l: this.word[1], e: this.word[2] },
      windowMs: this.windowMs,
    });
    this.judgeTimer = setTimeout(() => { this.judgeTimer = null; this.judge(); }, this.windowMs + LIFT_GRACE_MS);
  }

  judge() {
    if (this.state !== 'call') return;
    const flies = this.word[3] === 1;
    const results = [];
    for (const q of this.players.values()) {
      if (!q.alive) continue;
      const ok = flies === q.lifted;
      if (!ok) q.alive = false;
      results.push({ id: q.id, flew: q.lifted, ok });
    }
    this.cast({ t: 'result', round: this.round, flies, results });
    const alive = [...this.players.values()].filter((q) => q.alive);
    if (alive.length <= 1) {
      const w = alive[0] ?? null;
      if (w) w.wins++;
      setTimeout(() => this.gameover(w?.id ?? null), 1400);
      this.state = 'judging'; // block stray messages until gameover fires
    } else {
      this.windowMs = Math.max(WINDOW_MIN, Math.round(this.windowMs * WINDOW_DECAY));
      // clients show the verdict for ~1s — don't let the next call cut it short
      this.state = 'cooldown';
      setTimeout(() => {
        if (this.state !== 'cooldown') return;
        this.state = 'between';
        this.checkStart();
      }, 1200);
    }
  }

  gameover(winnerId) {
    this.clearTimers();
    this.state = 'over';
    this.cast({ t: 'gameover', winnerId });
    this.lobby();
  }
}
