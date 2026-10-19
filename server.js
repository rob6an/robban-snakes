'use strict';
/*
 * ROBBAN.IO — Snake Arena
 * Authoritative multiplayer snake server (Node.js + ws).
 * Run:  npm install && npm start   →  http://localhost:3000
 *
 * Env vars (optional):
 *   PORT         port to listen on (hosts like Render set this automatically)
 *   MIN_SNAKES   bots fill the arena up to this many snakes (default 12)
 *   MAX_PLAYERS  max human players at once (default 100)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MIN_SNAKES = Number(process.env.MIN_SNAKES ?? 12);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS ?? 100);

const WORLD_R = 3000;          // arena radius
const TPS = 20;                // simulation + network ticks per second
const BASE_FOOD = 900;         // food kept on the map
const FOOD_CAP = 5000;         // hard cap (incl. dropped food)
const START_MASS = 30;
const MIN_BOOST_MASS = 20;
const SPEED = 7.5;             // px per tick
const BOOST_SPEED = 15;
const CELL = 128;              // spatial grid cell size
const COLORS = 12;

const BOT_NAMES = ['Tajine', 'Sardine Slayer', 'Atlas', 'Couscous King', 'Mint Tea', 'Zellige',
  'Casa Noodle', 'Harira', 'Msemen', 'Babouche', 'Chebakia', 'Djemaa', 'Argan', 'Sahara',
  'Medina', 'Kasbah', 'Pastilla', 'Rfissa', 'Sfenj', 'Briouat'];

const rnd = (a, b) => a + Math.random() * (b - a);
const radiusOf = m => Math.min(9 + Math.sqrt(m) * 0.9, 42);
const segCountOf = m => Math.min(Math.floor(8 + m / 3), 700);
const viewOf = m => Math.min(620 + m * 0.35, 1700);
const turnOf = m => Math.max(0.08, 0.22 - m / 6000);

let tick = 0;
let lastId = 0;
let leader = null;
const snakes = new Map();   // id -> snake
const foods = [];           // {x, y, v, c}
const clients = new Set();
let grid = new Map();

// ---------- helpers ----------
function randPos(margin) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * (WORLD_R - margin);
  return [Math.cos(a) * r, Math.sin(a) * r];
}

function addFood(x, y, v, c) {
  if (foods.length >= FOOD_CAP) return;
  if (x * x + y * y > (WORLD_R - 15) ** 2) return;
  foods.push({ x, y, v: Math.max(1, Math.min(255, v | 0)), c: c % COLORS });
}

function spawnFood() {
  const [x, y] = randPos(40);
  addFood(x, y, 1 + Math.floor(Math.random() * 3), Math.floor(Math.random() * COLORS));
}

function newId() {
  do { lastId = (lastId % 65000) + 1; } while (snakes.has(lastId));
  return lastId;
}

function sendJSON(c, obj) {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj));
}
function broadcastJSON(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) if (c.ws.readyState === 1) c.ws.send(s);
}

function cellKey(cx, cy) { return (cx + 512) * 1024 + (cy + 512); }

function buildGrid() {
  grid = new Map();
  for (const s of snakes.values()) {
    for (let i = 0; i < s.segs.length; i++) {
      const p = s.segs[i];
      const k = cellKey(Math.floor(p.x / CELL), Math.floor(p.y / CELL));
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push(s, i);
    }
  }
}

// returns the snake whose body overlaps the circle (x, y, rad), ignoring `self`
function hitTest(x, y, rad, self) {
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const a = grid.get(cellKey(gx, gy));
      if (!a) continue;
      for (let j = 0; j < a.length; j += 2) {
        const o = a[j];
        if (o === self || !o.alive) continue;
        const p = o.segs[a[j + 1]];
        if (!p) continue;
        const dx = p.x - x, dy = p.y - y, rr = rad + o.r;
        if (dx * dx + dy * dy < rr * rr) return o;
      }
    }
  }
  return null;
}

function spawnIsSafe(x, y) {
  for (const s of snakes.values()) {
    for (let i = 0; i < s.segs.length; i += 3) {
      const p = s.segs[i];
      if ((p.x - x) ** 2 + (p.y - y) ** 2 < 350 * 350) return false;
    }
  }
  return true;
}

function makeSnake(name, color, client) {
  let x = 0, y = 0;
  for (let t = 0; t < 20; t++) {
    [x, y] = randPos(700);
    if (spawnIsSafe(x, y)) break;
  }
  const angle = Math.atan2(-y, -x) + rnd(-1, 1); // roughly face the centre
  const s = {
    id: newId(), name, color, client, bot: !client,
    mass: START_MASS, angle, target: angle, boost: false, boosting: false,
    alive: true, segs: [], kills: 0, dropAcc: 0, born: Date.now(),
    dodge: 0, boostTicks: 0, r: radiusOf(START_MASS), enc: null,
    minX: x, maxX: x, minY: y, maxY: y,
  };
  const n = segCountOf(s.mass), sp = s.r * 0.55;
  for (let i = 0; i < n; i++) s.segs.push({ x: x - Math.cos(angle) * i * sp, y: y - Math.sin(angle) * i * sp });
  snakes.set(s.id, s);
  broadcastJSON({ t: 'n', id: s.id, n: s.name });
  return s;
}

function kill(s, killer) {
  if (!s.alive) return;
  s.alive = false;
  snakes.delete(s.id);

  // drop the body as food
  const total = s.mass * 0.7;
  const pieces = Math.max(1, Math.ceil(s.segs.length / 2));
  const per = total / pieces;
  for (let i = 0; i < s.segs.length; i += 2) {
    const p = s.segs[i];
    let v = per;
    while (v > 0.5) {
      const piece = Math.min(v, 8);
      addFood(p.x + rnd(-s.r, s.r), p.y + rnd(-s.r, s.r), Math.round(piece), s.color);
      v -= piece;
    }
  }

  if (killer && killer.alive) killer.kills++;
  if (!s.bot || (killer && !killer.bot)) {
    broadcastJSON({ t: 'k', a: killer ? killer.name : null, b: s.name });
  }
  if (s.client) {
    const c = s.client;
    c.snake = null;
    c.cam = { x: s.segs[0].x, y: s.segs[0].y };
    c.deadAt = tick;
    sendJSON(c, {
      t: 'd', score: Math.floor(s.mass), kills: s.kills,
      by: killer ? killer.name : null, ms: Date.now() - s.born,
    });
  }
}

// ---------- simulation ----------
function botThink(s) {
  const h = s.segs[0], r = s.r;
  if (s.boostTicks > 0) s.boostTicks--;
  s.boost = s.boostTicks > 0;

  // stay away from the wall
  if (Math.hypot(h.x, h.y) > WORLD_R - 250 - r * 4) {
    s.target = Math.atan2(-h.y, -h.x) + rnd(-0.3, 0.3);
    s.boost = false; s.boostTicks = 0;
    return;
  }
  if (s.dodge > 0) { s.dodge--; return; }

  // look ahead for other snakes
  const look = 50 + r * 2.5;
  for (const off of [0, 0.45, -0.45]) {
    const a = s.angle + off;
    if (hitTest(h.x + Math.cos(a) * look, h.y + Math.sin(a) * look, r + 6, s)) {
      const left = hitTest(h.x + Math.cos(s.angle - 1.3) * look, h.y + Math.sin(s.angle - 1.3) * look, r + 6, s);
      s.target = s.angle + (left ? 1.6 : -1.6);
      s.dodge = 6;
      return;
    }
  }

  if ((tick + s.id) % 5 !== 0) return;
  // seek the best nearby food
  let best = null, bestScore = 0;
  const R = 450;
  for (const f of foods) {
    const dx = f.x - h.x, dy = f.y - h.y;
    if (dx > R || dx < -R || dy > R || dy < -R) continue;
    const sc = f.v / (dx * dx + dy * dy + 400);
    if (sc > bestScore) { bestScore = sc; best = f; }
  }
  if (best) {
    s.target = Math.atan2(best.y - h.y, best.x - h.x);
    if (best.v >= 4 && s.mass > 60 && Math.random() < 0.25) s.boostTicks = 15;
  } else {
    s.target = s.angle + rnd(-0.8, 0.8);
  }
}

function moveSnake(s) {
  let d = s.target - s.angle;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const t = turnOf(s.mass);
  s.angle += Math.max(-t, Math.min(t, d));

  s.boosting = s.boost && s.mass > MIN_BOOST_MASS;
  const sp = s.boosting ? BOOST_SPEED : SPEED;
  const segs = s.segs, h = segs[0];
  h.x += Math.cos(s.angle) * sp;
  h.y += Math.sin(s.angle) * sp;

  s.r = radiusOf(s.mass);
  const spacing = s.r * 0.55;
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1], b = segs[i];
    const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
    if (dist > spacing) { const k = spacing / dist; b.x = a.x + dx * k; b.y = a.y + dy * k; }
  }

  const want = segCountOf(s.mass);
  while (segs.length < want) { const l = segs[segs.length - 1]; segs.push({ x: l.x, y: l.y }); }
  while (segs.length > want) segs.pop();

  if (s.boosting) {
    const loss = 0.2 + s.mass * 0.0015;
    s.mass -= loss;
    s.dropAcc += loss;
    if (s.dropAcc >= 1.2) {
      const tl = segs[segs.length - 1];
      addFood(tl.x + rnd(-4, 4), tl.y + rnd(-4, 4), 1, s.color);
      s.dropAcc -= 1.2;
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of segs) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  s.minX = minX - s.r; s.maxX = maxX + s.r; s.minY = minY - s.r; s.maxY = maxY + s.r;
}

function eat(s) {
  const h = s.segs[0], rr = s.r + 14, rr2 = rr * rr;
  for (let i = foods.length - 1; i >= 0; i--) {
    const f = foods[i];
    const dx = f.x - h.x, dy = f.y - h.y;
    if (dx > rr || dx < -rr || dy > rr || dy < -rr) continue;
    if (dx * dx + dy * dy < rr2) {
      s.mass = Math.min(60000, s.mass + f.v);
      foods[i] = foods[foods.length - 1];
      foods.pop();
    }
  }
}

function step() {
  tick++;

  for (const s of snakes.values()) if (s.bot) botThink(s);
  for (const s of snakes.values()) moveSnake(s);

  // wall deaths
  for (const s of [...snakes.values()]) {
    const h = s.segs[0];
    if (h.x * h.x + h.y * h.y > WORLD_R * WORLD_R) kill(s, null);
  }

  buildGrid();

  // head vs body collisions
  for (const s of [...snakes.values()]) {
    if (!s.alive) continue;
    const h = s.segs[0];
    const other = hitTest(h.x, h.y, s.r * 0.75, s);
    if (other) kill(s, other);
  }

  for (const s of snakes.values()) eat(s);

  // keep the map stocked
  for (let i = 0; i < 25 && foods.length < BASE_FOOD; i++) spawnFood();

  // bots fill empty arenas
  if (snakes.size < MIN_SNAKES && tick % 10 === 0) {
    const used = new Set([...snakes.values()].map(s => s.name));
    const free = BOT_NAMES.filter(n => !used.has(n));
    const pool = free.length ? free : BOT_NAMES;
    makeSnake(pool[Math.floor(Math.random() * pool.length)], Math.floor(Math.random() * COLORS), null);
  }

  leader = null;
  for (const s of snakes.values()) if (!leader || s.mass > leader.mass) leader = s;

  encodeSnakes();
  for (const c of clients) sendState(c);

  if (tick % 10 === 0) sendLeaderboard();
}

// ---------- networking ----------
// Per-snake binary block (built once per tick, reused for every viewer):
// u16 id | u8 color | u8 flags | u16 mass | u16 npts | i16 headX | i16 headY | (npts-1) × (i8 dx, i8 dy)
function encodeSnakes() {
  for (const s of snakes.values()) {
    const segs = s.segs, idx = [];
    for (let i = 0; i < segs.length; i += 2) idx.push(i);
    if (idx[idx.length - 1] !== segs.length - 1) idx.push(segs.length - 1);
    const buf = Buffer.allocUnsafe(12 + (idx.length - 1) * 2);
    buf.writeUInt16LE(s.id, 0);
    buf.writeUInt8(s.color, 2);
    buf.writeUInt8(s.boosting ? 1 : 0, 3);
    buf.writeUInt16LE(Math.min(65535, Math.floor(s.mass)), 4);
    buf.writeUInt16LE(idx.length, 6);
    let px = Math.round(segs[0].x), py = Math.round(segs[0].y);
    buf.writeInt16LE(px, 8);
    buf.writeInt16LE(py, 10);
    let o = 12;
    for (let k = 1; k < idx.length; k++) {
      const p = segs[idx[k]];
      const dx = Math.max(-127, Math.min(127, Math.round(p.x - px)));
      const dy = Math.max(-127, Math.min(127, Math.round(p.y - py)));
      buf.writeInt8(dx, o++); buf.writeInt8(dy, o++);
      px += dx; py += dy;
    }
    s.enc = buf;
  }
}

function sendState(c) {
  if (c.ws.readyState !== 1) return;
  if (c.ws.bufferedAmount > 512 * 1024) return; // slow connection: skip a frame

  let cx, cy, view;
  const me = c.snake;
  if (me) {
    cx = me.segs[0].x; cy = me.segs[0].y; view = viewOf(me.mass);
  } else if (tick - c.deadAt < 50) {
    cx = c.cam.x; cy = c.cam.y; view = 800;
  } else if (leader) {
    cx = leader.segs[0].x; cy = leader.segs[0].y; view = viewOf(leader.mass) + 150;
    c.cam = { x: cx, y: cy };
  } else {
    cx = 0; cy = 0; view = 900;
  }

  const hx = view * Math.max(c.aspect, 1) + 120;
  const hy = view * Math.max(1 / c.aspect, 1) + 120;
  const parts = [];
  let size = 11, n = 0;
  for (const s of snakes.values()) {
    if (s.maxX < cx - hx || s.minX > cx + hx || s.maxY < cy - hy || s.minY > cy + hy) continue;
    parts.push(s.enc); size += s.enc.length; n++;
  }
  const head = Buffer.allocUnsafe(11);
  head.writeUInt8(1, 0);
  head.writeUInt16LE(me ? me.id : 0, 1);
  head.writeInt16LE(Math.round(cx), 3);
  head.writeInt16LE(Math.round(cy), 5);
  head.writeUInt16LE(Math.round(view), 7);
  head.writeUInt16LE(n, 9);
  c.ws.send(Buffer.concat([head, ...parts], size));

  // food: 5 times a second, only what's on screen
  if ((tick + c.phase) % 4 === 0) {
    const fx = hx + 60, fy = hy + 60;
    const list = [];
    for (const f of foods) {
      if (f.x < cx - fx || f.x > cx + fx || f.y < cy - fy || f.y > cy + fy) continue;
      list.push(f);
      if (list.length >= 2500) break;
    }
    const fb = Buffer.allocUnsafe(3 + list.length * 6);
    fb.writeUInt8(2, 0);
    fb.writeUInt16LE(list.length, 1);
    let o = 3;
    for (const f of list) {
      fb.writeInt16LE(Math.round(f.x), o); fb.writeInt16LE(Math.round(f.y), o + 2);
      fb.writeUInt8(f.v, o + 4); fb.writeUInt8(f.c, o + 5);
      o += 6;
    }
    c.ws.send(fb);
  }
}

function sendLeaderboard() {
  const all = [...snakes.values()].sort((a, b) => b.mass - a.mass);
  const top = all.slice(0, 10).map(s => [s.id, s.name, Math.floor(s.mass), s.bot ? 1 : 0]);
  const map = all.map(s => [Math.round(s.segs[0].x / 30), Math.round(s.segs[0].y / 30), Math.round(s.r)]);
  let humans = 0;
  for (const s of all) if (!s.bot) humans++;
  const base = { t: 'l', top, map, online: clients.size, playing: humans, total: all.length };
  for (const c of clients) {
    if (c.ws.readyState !== 1) continue;
    const rank = c.snake ? all.indexOf(c.snake) + 1 : 0;
    c.ws.send(JSON.stringify({ ...base, rank }));
  }
}

function cleanName(n) {
  return String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Viewer';
}

function humanCount() {
  let n = 0;
  for (const s of snakes.values()) if (!s.bot) n++;
  return n;
}

// ---------- HTTP (static files) ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, online: clients.size, snakes: snakes.size }));
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 1024 });

wss.on('connection', ws => {
  const c = { ws, snake: null, cam: { x: 0, y: 0 }, deadAt: -999, aspect: 16 / 9, phase: Math.floor(Math.random() * 4), alive: true, msgs: 0, msgWindow: Date.now() };
  clients.add(c);
  sendJSON(c, { t: 'w', world: WORLD_R, tps: TPS });
  sendJSON(c, { t: 'N', list: [...snakes.values()].map(s => [s.id, s.name]) });

  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, isBinary) => {
    // simple flood protection
    const now = Date.now();
    if (now - c.msgWindow > 1000) { c.msgWindow = now; c.msgs = 0; }
    if (++c.msgs > 80 || isBinary) return;

    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'j') {
      if (c.snake) return;
      if (humanCount() >= MAX_PLAYERS) return sendJSON(c, { t: 'full' });
      const color = Number.isInteger(m.c) && m.c >= 0 && m.c < COLORS ? m.c : Math.floor(Math.random() * COLORS);
      c.snake = makeSnake(cleanName(m.n), color, c);
      sendJSON(c, { t: 's', id: c.snake.id });
    } else if (m.t === 'i' && c.snake) {
      const a = Number(m.a);
      if (Number.isFinite(a)) c.snake.target = a;
      c.snake.boost = !!m.b;
    } else if (m.t === 'v') {
      const a = Number(m.a);
      if (Number.isFinite(a)) c.aspect = Math.max(0.4, Math.min(3, a));
    }
  });

  ws.on('close', () => {
    if (c.snake) kill(c.snake, null);
    clients.delete(c);
  });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch {}
  }
}, 30000);

for (let i = 0; i < BASE_FOOD; i++) spawnFood();
setInterval(step, 1000 / TPS);

server.listen(PORT, () => console.log(`ROBBAN.IO Snake Arena running on http://localhost:${PORT}`));
