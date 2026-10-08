require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Dama = require('./public/dama.js');

const { PORT = 23687, JWT_SECRET = 'change-me', TURN_SECONDS = 60 } = process.env;
const TURN_MS = Number(TURN_SECONDS) * 1000;
if (JWT_SECRET === 'change-me') console.warn('Warning: set JWT_SECRET in .env before going public.');

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'dama',
  waitForConnections: true,
  connectionLimit: 10,
});
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v); // MariaDB returns JSON as text

/* ---------------------------------- REST ---------------------------------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Server error.' }); });
const sign = (u) => jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: '7d' });
const userView = (u) => ({ id: u.id, username: u.username, rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws });
const auth = (req, res, next) => {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again.' });
  }
};

app.post('/api/register', wrap(async (req, res) => {
  const { username = '', password = '' } = req.body;
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username))
    return res.status(400).json({ error: 'Username must be 3 to 24 letters, numbers or underscores.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const [r] = await db.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, await bcrypt.hash(password, 10)]);
    const [[u]] = await db.execute('SELECT * FROM users WHERE id = ?', [r.insertId]);
    res.json({ token: sign(u), user: userView(u) });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That username is taken.' });
    throw e;
  }
}));

app.post('/api/login', wrap(async (req, res) => {
  const { username = '', password = '' } = req.body;
  const [[u]] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
  if (!u || !(await bcrypt.compare(password, u.password_hash)))
    return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: sign(u), user: userView(u) });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const [[u]] = await db.execute('SELECT * FROM users WHERE id = ?', [req.user.id]);
  u ? res.json(userView(u)) : res.status(401).json({ error: 'Please log in again.' });
}));

app.get('/api/leaderboard', wrap(async (_req, res) => {
  const [rows] = await db.execute('SELECT username, rating, wins, losses, draws FROM users ORDER BY rating DESC, wins DESC LIMIT 20');
  res.json(rows);
}));

app.get('/api/history', auth, wrap(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT g.id, g.winner, g.end_reason, g.white_delta, g.black_delta, w.username AS white, b.username AS black
       FROM games g JOIN users w ON w.id = g.white_id JOIN users b ON b.id = g.black_id
      WHERE g.status = 'finished' AND (g.white_id = ? OR g.black_id = ?)
      ORDER BY g.id DESC LIMIT 20`, [req.user.id, req.user.id]);
  res.json(rows);
}));

app.get('/api/games/:id', auth, wrap(async (req, res) => {
  const [[g]] = await db.execute(
    `SELECT g.id, g.winner, g.end_reason, w.username AS white, b.username AS black
       FROM games g JOIN users w ON w.id = g.white_id JOIN users b ON b.id = g.black_id
      WHERE g.id = ? AND g.status = 'finished'`, [req.params.id]);
  if (!g) return res.status(404).json({ error: 'Game not found.' });
  const [moves] = await db.execute('SELECT move FROM game_moves WHERE game_id = ? ORDER BY ply', [g.id]);
  res.json({ ...g, moves: moves.map((m) => parse(m.move)) });
}));

/* ------------------------------ Game manager ------------------------------ */
const games = new Map();   // gameId -> game
const byUser = new Map();  // userId -> gameId
const sockets = new Map(); // userId -> Set<ws>
let waiting = null;        // user waiting for an opponent

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const sendUser = (uid, msg) => (sockets.get(uid) || []).forEach((ws) => send(ws, msg));
const colorOf = (g, uid) => (g.white.id === uid ? 'w' : 'b');

const newGame = (id, white, black) => ({
  id, white, black, state: Dama.initialState(), history: [], moves: [],
  last: null, offer: null, chat: [], over: null, timer: null, deadline: 0,
});

function snapshot(g, uid) {
  const you = colorOf(g, uid);
  return {
    type: 'game', id: g.id, you, white: g.white, black: g.black, state: g.state,
    legal: !g.over && g.state.turn === you ? Dama.legalMoves(g.state) : [],
    ms: g.over ? null : Math.max(0, g.deadline - Date.now()),
    last: g.last, offer: g.offer, chat: g.chat, over: g.over,
    canUndo: !g.over && !g.offer && g.moves.length > 0 && (g.moves.length - 1) % 2 === (you === 'w' ? 0 : 1),
    online: { w: sockets.has(g.white.id), b: sockets.has(g.black.id) },
  };
}
const push = (g) => [g.white.id, g.black.id].forEach((uid) => sendUser(uid, snapshot(g, uid)));

function register(g) {
  games.set(g.id, g);
  byUser.set(g.white.id, g.id);
  byUser.set(g.black.id, g.id);
  armTimer(g);
}

// Turn timer: whoever runs out of time on their turn forfeits.
function armTimer(g) {
  clearTimeout(g.timer);
  g.deadline = Date.now() + TURN_MS;
  g.timer = setTimeout(
    () => finish(g, { winner: g.state.turn === 'w' ? 'b' : 'w', reason: 'timeout' }).catch(console.error),
    TURN_MS);
}

async function startGame(a, b) {
  const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
  const [r] = await db.execute('INSERT INTO games (white_id, black_id) VALUES (?, ?)', [white.id, black.id]);
  const g = newGame(r.insertId, white, black);
  register(g);
  push(g);
}

async function finish(g, { winner, reason }) {
  if (g.over) return;
  clearTimeout(g.timer);
  const K = 32;
  const expected = 1 / (1 + 10 ** ((g.black.rating - g.white.rating) / 400));
  const score = winner === 'w' ? 1 : winner === 'b' ? 0 : 0.5;
  const delta = Math.round(K * (score - expected)); // change for white; black gets the opposite
  g.over = { winner, reason, delta: { w: delta, b: -delta } };
  try {
    const col = (c) => (winner === null ? 'draws' : winner === c ? 'wins' : 'losses');
    const upd = (id, d, f) => db.execute(`UPDATE users SET rating = rating + ?, ${f} = ${f} + 1 WHERE id = ?`, [d, id]);
    await Promise.all([
      upd(g.white.id, delta, col('w')),
      upd(g.black.id, -delta, col('b')),
      db.execute("UPDATE games SET status = 'finished', winner = ?, end_reason = ?, white_delta = ?, black_delta = ?, ended_at = NOW() WHERE id = ?",
        [winner, reason, delta, -delta, g.id]),
    ]);
  } finally {
    push(g);
    games.delete(g.id);
    byUser.delete(g.white.id);
    byUser.delete(g.black.id);
  }
}

function handleMove(g, uid, msg) {
  if (g.over || g.state.turn !== colorOf(g, uid)) return;
  const key = JSON.stringify([msg.from, msg.path]);
  const m = Dama.legalMoves(g.state).find((x) => JSON.stringify([x.from, x.path]) === key);
  if (!m) return;
  g.history.push(g.state);
  g.moves.push(m);
  g.state = Dama.applyMove(g.state, m);
  g.last = m;
  g.offer = null;
  db.execute('INSERT INTO game_moves (game_id, ply, move) VALUES (?, ?, ?)', [g.id, g.moves.length - 1, JSON.stringify(m)]).catch(console.error);
  const o = Dama.outcome(g.state);
  if (o) finish(g, o).catch(console.error);
  else { armTimer(g); push(g); }
}

function handleOffer(g, uid, kind) {
  const you = colorOf(g, uid);
  if (g.over || g.offer) return;
  if (kind === 'undo' && !snapshot(g, uid).canUndo) return;
  if (kind !== 'draw' && kind !== 'undo') return;
  g.offer = { kind, from: you };
  push(g);
}

function handleRespond(g, uid, accept) {
  if (g.over || !g.offer || g.offer.from === colorOf(g, uid)) return;
  const { kind } = g.offer;
  g.offer = null;
  if (!accept) return push(g);
  if (kind === 'draw') return finish(g, { winner: null, reason: 'agreed' }).catch(console.error);
  g.state = g.history.pop(); // undo: take back the requester's last move
  g.moves.pop();
  g.last = g.moves[g.moves.length - 1] || null;
  db.execute('DELETE FROM game_moves WHERE game_id = ? AND ply = ?', [g.id, g.moves.length]).catch(console.error);
  armTimer(g);
  push(g);
}

function handleChat(g, uid, text) {
  text = String(text || '').trim().slice(0, 300);
  if (!text) return;
  const m = { from: colorOf(g, uid), text };
  g.chat.push(m);
  if (g.chat.length > 100) g.chat.shift();
  db.execute('INSERT INTO chat_messages (game_id, user_id, message) VALUES (?, ?, ?)', [g.id, uid, text]).catch(console.error);
  [g.white.id, g.black.id].forEach((id) => sendUser(id, { type: 'chat', msg: m }));
}

async function queue(uid) {
  const [[u]] = await db.execute('SELECT id, username, rating FROM users WHERE id = ?', [uid]);
  if (!u || byUser.has(uid) || waiting?.id === uid) return;
  if (waiting) {
    const other = waiting;
    waiting = null;
    await startGame(other, u);
  } else {
    waiting = u;
    sendUser(uid, { type: 'queued' });
  }
}

// After a server restart, rebuild unfinished games by replaying their stored moves.
async function loadActive() {
  const [rows] = await db.execute(
    `SELECT g.id, w.id AS wid, w.username AS wn, w.rating AS wr, b.id AS bid, b.username AS bn, b.rating AS br
       FROM games g JOIN users w ON w.id = g.white_id JOIN users b ON b.id = g.black_id WHERE g.status = 'active'`);
  for (const r of rows) {
    const g = newGame(r.id, { id: r.wid, username: r.wn, rating: r.wr }, { id: r.bid, username: r.bn, rating: r.br });
    const [mv] = await db.execute('SELECT move FROM game_moves WHERE game_id = ? ORDER BY ply', [r.id]);
    for (const { move } of mv) {
      const m = parse(move);
      g.history.push(g.state); g.moves.push(m); g.state = Dama.applyMove(g.state, m); g.last = m;
    }
    const [ch] = await db.execute('SELECT user_id, message FROM chat_messages WHERE game_id = ? ORDER BY id DESC LIMIT 100', [r.id]);
    g.chat = ch.reverse().map((c) => ({ from: c.user_id === r.wid ? 'w' : 'b', text: c.message }));
    register(g);
  }
  if (rows.length) console.log(`Restored ${rows.length} active game(s).`);
}

/* -------------------------------- WebSocket ------------------------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let uid = null;
  ws.on('pong', () => { ws.dead = false; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'auth') {
        uid = jwt.verify(msg.token, JWT_SECRET).id;
        if (!sockets.has(uid)) sockets.set(uid, new Set());
        sockets.get(uid).add(ws);
        send(ws, { type: 'ready', inGame: byUser.has(uid), queued: waiting?.id === uid });
        const g = games.get(byUser.get(uid));
        if (g) push(g); // rejoin: also tells the opponent you're back
        return;
      }
      if (!uid) return;
      const g = games.get(byUser.get(uid));
      switch (msg.type) {
        case 'queue': await queue(uid); break;
        case 'cancel':
          if (waiting?.id === uid) waiting = null;
          sendUser(uid, { type: 'lobby' });
          break;
        case 'move': if (g) handleMove(g, uid, msg); break;
        case 'offer': if (g) handleOffer(g, uid, msg.kind); break;
        case 'respond': if (g) handleRespond(g, uid, !!msg.accept); break;
        case 'chat': if (g) handleChat(g, uid, msg.text); break;
        case 'resign':
          if (g) await finish(g, { winner: colorOf(g, uid) === 'w' ? 'b' : 'w', reason: 'resign' });
          break;
      }
    } catch (e) {
      if (String(e.name).includes('Token')) send(ws, { type: 'authfail' });
      else console.error(e);
    }
  });

  ws.on('close', () => {
    if (uid === null) return;
    const set = sockets.get(uid);
    set.delete(ws);
    if (set.size) return;
    sockets.delete(uid);
    if (waiting?.id === uid) waiting = null;
    const g = games.get(byUser.get(uid));
    if (g) push(g); // opponent sees you went offline; your turn timer keeps running
  });
});

setInterval(() => wss.clients.forEach((ws) => {
  if (ws.dead) return ws.terminate();
  ws.dead = true;
  ws.ping();
}), 30000);

loadActive()
  .then(() => server.listen(PORT, () => console.log(`Dama is running at http://localhost:${PORT}`)))
  .catch((e) => { console.error('Could not start. Is MySQL running and schema.sql imported?\n', e.message); process.exit(1); });
