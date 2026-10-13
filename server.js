'use strict';
// Campus Room Reservation: Node.js server with MySQL storage.
// Serves the front end from /public and exposes a JSON API under /api.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

// ---------- configuration (.env is read only on the server) ----------
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 5055);
// DB_* names come from .env. On Railway, the MySQL* variables it provides are used when DB_* is not set.
const DB = {
  host: process.env.DB_HOST || process.env.MYSQLHOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
  user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
  database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'campusroom_sections',
};
// Campus dates are decided in campus time, not the server's clock (Railway runs in UTC).
const CAMPUS_TIME_ZONE = process.env.CAMPUS_TIME_ZONE || 'Asia/Manila';
const SESSION_HOURS = 12;
const DEFAULT_SETTINGS = { campusName: 'Campus Room Reservation', openTime: '07:00', closeTime: '20:00' };
const MIN_PASSWORD = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I, so codes are easy to read aloud

let pool;

// ---------- helpers ----------
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new ApiError(400, msg);

const q = async (sql, params = []) => (await pool.query(sql, params))[0];
const one = async (sql, params = []) => (await q(sql, params))[0] || null;

function clean(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}
function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function normTime(s) {
  const t = String(s || '');
  if (/^\d{2}:\d{2}$/.test(t)) return t + ':00';
  if (/^\d{2}:\d{2}:\d{2}$/.test(t)) return t;
  return null;
}
function validTime(t) {
  if (!t) return false;
  const [h, m, s] = t.split(':').map(Number);
  return h < 24 && m < 60 && s < 60;
}
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 190; }
function weekday(dateStr) { // 1 = Monday ... 7 = Sunday
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}
function todayStr() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: CAMPUS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw bad(`Password must be at least ${MIN_PASSWORD} characters.`);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Failed-attempt limiter (in memory). Only failed attempts count, so successful sign-ins and
// registrations never lock anyone out. On Railway or Vercel the socket address is the proxy's,
// so the client address comes from X-Forwarded-For unless TRUST_PROXY=false.
const attempts = new Map();
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
function clientAddress(req) {
  const forwarded = process.env.TRUST_PROXY === 'false' ? '' : String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}
function tooManyFailures(req, key, max) {
  const rec = attempts.get(key + ':' + clientAddress(req));
  return Boolean(rec && rec.reset > Date.now() && rec.count >= max);
}
function recordFailure(req, key) {
  const id = key + ':' + clientAddress(req);
  const now = Date.now();
  let rec = attempts.get(id);
  if (!rec || rec.reset <= now) rec = { count: 0, reset: now + ATTEMPT_WINDOW_MS };
  rec.count += 1;
  attempts.set(id, rec);
}
function clearFailures(req, key) { attempts.delete(key + ':' + clientAddress(req)); }

function makeJoinCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}
async function uniqueJoinCode(conn = pool) {
  for (let i = 0; i < 20; i++) {
    const code = makeJoinCode();
    const [rows] = await conn.query('SELECT id FROM classes WHERE join_code = ?', [code]);
    if (!rows.length) return code;
  }
  throw new Error('Could not create a unique join code. Please try again.');
}

async function getSettings() {
  const rows = await q('SELECT setting_key, setting_value FROM settings');
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.setting_key in s) s[r.setting_key] = r.setting_value;
  return s;
}
async function notify(userIds, message, conn = pool) {
  for (const id of [...new Set(userIds)]) {
    await conn.query('INSERT INTO notifications (user_id, message) VALUES (?, ?)', [id, message.slice(0, 255)]);
  }
}
async function adminIds(conn = pool) {
  const [rows] = await conn.query("SELECT id FROM users WHERE role = 'admin' AND active = 1");
  return rows.map((r) => r.id);
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

// ---------- sessions ----------
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
async function currentUser(req) {
  const token = readCookie(req, 'cr_session');
  if (!token) return null;
  return one(
    `SELECT u.id, u.name, u.email, u.role FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > NOW() AND u.active = 1`,
    [sha256(token)]
  );
}
async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q('DELETE FROM sessions WHERE expires_at <= NOW()');
  await q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))',
    [sha256(token), userId, SESSION_HOURS]);
  res.setHeader('Set-Cookie', `cr_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
}
async function endSession(req, res) {
  const token = readCookie(req, 'cr_session');
  if (token) await q('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
  res.setHeader('Set-Cookie', 'cr_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}
function requireUser(user, roles) {
  if (!user) throw new ApiError(401, 'Please sign in.');
  if (roles && !roles.includes(user.role)) throw new ApiError(403, 'Your role cannot do this.');
  return user;
}

// ---------- HTTP plumbing ----------
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new ApiError(413, 'Request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(bad('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
function serveStatic(req, res, pathname) {
  const publicDir = path.join(__dirname, 'public');
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

// ---------- reservation rules shared by request and approval ----------
async function findConflicts(conn, { roomId, date, start, end, excludeId = 0 }) {
  const [approved] = await conn.query(
    `SELECT id FROM reservations
      WHERE room_id = ? AND booking_date = ? AND status = 'approved' AND id <> ?
        AND start_time < ? AND end_time > ? LIMIT 1`,
    [roomId, date, excludeId, end, start]);
  if (approved.length) return 'That room is already booked for this time.';
  const [classes] = await conn.query(
    `SELECT id FROM classes
      WHERE room_id = ? AND day_of_week = ? AND start_time < ? AND end_time > ? LIMIT 1`,
    [roomId, weekday(date), end, start]);
  if (classes.length) return 'That room has a scheduled class at this time.';
  return null;
}
async function checkWithinHours(date, start, end) {
  const s = await getSettings();
  if (start < s.openTime + ':00' || end > s.closeTime + ':00') {
    throw bad(`Bookings are only accepted between ${s.openTime} and ${s.closeTime}.`);
  }
}

// ---------- API routes ----------
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

// Setup and authentication
route('GET', '/api/setup-status', async () => {
  const row = await one('SELECT COUNT(*) AS c FROM users');
  return { needsSetup: row.c === 0 };
});

route('POST', '/api/setup', async (ctx) => {
  const { body, res } = ctx;
  const name = clean(body.name, 100), email = clean(body.email, 190).toLowerCase();
  if (!name) throw bad('Name is required.');
  if (!isEmail(email)) throw bad('Enter a valid email address.');
  checkPassword(body.password);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[c]] = await conn.query('SELECT COUNT(*) AS c FROM users FOR UPDATE');
    if (c.c > 0) throw new ApiError(409, 'Setup is already complete. Please sign in.');
    const [r] = await conn.query("INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, 'admin', ?)",
      [name, email, hashPassword(body.password)]);
    await conn.commit();
    await createSession(res, r.insertId);
    return { user: publicUser({ id: r.insertId, name, email, role: 'admin' }) };
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
});

route('POST', '/api/login', async (ctx) => {
  if (tooManyFailures(ctx.req, 'login', 20)) throw new ApiError(429, 'Too many sign-in attempts. Please wait a few minutes.');
  const email = clean(ctx.body.email, 190).toLowerCase();
  const u = await one('SELECT * FROM users WHERE email = ? AND active = 1', [email]);
  if (!u || typeof ctx.body.password !== 'string' || !verifyPassword(ctx.body.password, u.password_hash)) {
    recordFailure(ctx.req, 'login');
    throw new ApiError(401, 'Wrong email or password.');
  }
  clearFailures(ctx.req, 'login');
  await createSession(ctx.res, u.id);
  return { user: publicUser(u) };
});

// Students create their own account with the join code from their teacher.
route('POST', '/api/register', async (ctx) => {
  if (tooManyFailures(ctx.req, 'register', 10)) throw new ApiError(429, 'Too many attempts. Please wait a few minutes.');
  const { body, res } = ctx;
  const name = clean(body.name, 100);
  const email = clean(body.email, 190).toLowerCase();
  const joinCode = clean(body.joinCode, 20).toUpperCase().replace(/\s/g, '');
  if (!name) throw bad('Enter your full name.');
  if (!isEmail(email)) throw bad('Enter a valid email address.');
  if (!joinCode) throw bad('Enter the section code from your teacher.');
  checkPassword(body.password);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT c.id, c.name, c.teacher_id FROM classes c
         JOIN users t ON t.id = c.teacher_id AND t.active = 1
        WHERE c.join_code = ? FOR UPDATE`, [joinCode]);
    if (!rows.length) {
      recordFailure(ctx.req, 'register');
      throw bad('That section code is not valid. Check it with your teacher.');
    }
    const cls = rows[0];
    const [r] = await conn.query("INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, 'student', ?)",
      [name, email, hashPassword(body.password)]);
    await conn.query('INSERT INTO enrollments (class_id, user_id) VALUES (?, ?)', [cls.id, r.insertId]);
    await notify([cls.teacher_id], `${name} joined ${cls.name}.`, conn);
    await conn.commit();
    await createSession(res, r.insertId);
    return { user: publicUser({ id: r.insertId, name, email, role: 'student' }) };
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') throw new ApiError(409, 'An account with this email already exists. Sign in instead.');
    throw e;
  } finally { conn.release(); }
});

route('POST', '/api/logout', async (ctx) => { await endSession(ctx.req, ctx.res); return { ok: true }; });

route('GET', '/api/me', async (ctx) => ({ user: publicUser(requireUser(ctx.user)) }));

route('PATCH', '/api/me', async (ctx) => {
  const user = requireUser(ctx.user);
  const { body } = ctx;
  const u = await one('SELECT * FROM users WHERE id = ?', [user.id]);
  const updates = {};
  if (body.name !== undefined) {
    const name = clean(body.name, 100);
    if (!name) throw bad('Name is required.');
    updates.name = name;
  }
  if (body.newPassword) {
    if (!verifyPassword(String(body.currentPassword || ''), u.password_hash)) throw bad('Current password is incorrect.');
    checkPassword(body.newPassword);
    updates.password_hash = hashPassword(body.newPassword);
  }
  if (Object.keys(updates).length) {
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    await q(`UPDATE users SET ${sets} WHERE id = ?`, [...Object.values(updates), user.id]);
  }
  const fresh = await one('SELECT id, name, email, role FROM users WHERE id = ?', [user.id]);
  return { user: publicUser(fresh) };
});

// Settings
route('GET', '/api/settings', async (ctx) => { requireUser(ctx.user); return getSettings(); });

route('PUT', '/api/settings', async (ctx) => {
  requireUser(ctx.user, ['admin']);
  const { body } = ctx;
  const campusName = clean(body.campusName, 100);
  const openTime = normTime(body.openTime), closeTime = normTime(body.closeTime);
  if (!campusName) throw bad('Campus name is required.');
  if (!validTime(openTime) || !validTime(closeTime)) throw bad('Enter valid opening and closing times.');
  if (openTime >= closeTime) throw bad('Closing time must be after opening time.');
  const pairs = { campusName, openTime: openTime.slice(0, 5), closeTime: closeTime.slice(0, 5) };
  for (const [k, v] of Object.entries(pairs)) {
    await q('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [k, v]);
  }
  return getSettings();
});

// Rooms
route('GET', '/api/rooms', async (ctx) => {
  requireUser(ctx.user, ['admin', 'teacher']);
  return { rooms: await q('SELECT * FROM rooms ORDER BY code') };
});

function roomFields(body) {
  const code = clean(body.code, 20).toUpperCase();
  const name = clean(body.name, 100);
  if (!code) throw bad('Room code is required.');
  if (!name) throw bad('Room name is required.');
  const capacity = Number(body.capacity || 0);
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 10000) throw bad('Capacity must be a whole number.');
  return {
    code, name,
    building: clean(body.building, 100), floor: clean(body.floor, 20),
    capacity, equipment: clean(body.equipment, 255),
    active: body.active === false ? 0 : 1,
  };
}
route('POST', '/api/rooms', async (ctx) => {
  requireUser(ctx.user, ['admin']);
  const f = roomFields(ctx.body);
  try {
    const r = await q('INSERT INTO rooms (code, name, building, floor, capacity, equipment, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [f.code, f.name, f.building, f.floor, f.capacity, f.equipment, f.active]);
    return { id: r.insertId };
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw new ApiError(409, 'A room with this code already exists.'); throw e; }
});
route('PUT', '/api/rooms/:id', async (ctx) => {
  requireUser(ctx.user, ['admin']);
  const f = roomFields(ctx.body);
  try {
    await q('UPDATE rooms SET code=?, name=?, building=?, floor=?, capacity=?, equipment=?, active=? WHERE id=?',
      [f.code, f.name, f.building, f.floor, f.capacity, f.equipment, f.active, ctx.params.id]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw new ApiError(409, 'A room with this code already exists.'); throw e; }
  return { ok: true };
});
route('DELETE', '/api/rooms/:id', async (ctx) => {
  requireUser(ctx.user, ['admin']);
  const used = await one(
    `SELECT (SELECT COUNT(*) FROM reservations WHERE room_id = ?) + (SELECT COUNT(*) FROM classes WHERE room_id = ?) AS n`,
    [ctx.params.id, ctx.params.id]);
  if (used.n > 0) throw new ApiError(409, 'This room has bookings or sections. Mark it inactive instead.');
  await q('DELETE FROM rooms WHERE id = ?', [ctx.params.id]);
  return { ok: true };
});

// Sections (classes). Admins manage all of them; a teacher manages their own.
// Each section has a join code that students use to create their account.
const CLASS_SELECT = `
  SELECT c.id, c.code, c.name, c.teacher_id, c.room_id, c.day_of_week, c.join_code,
         TIME_FORMAT(c.start_time, '%H:%i') AS start_time, TIME_FORMAT(c.end_time, '%H:%i') AS end_time,
         u.name AS teacher_name, r.code AS room_code, r.name AS room_name,
         (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS student_count
    FROM classes c
    JOIN users u ON u.id = c.teacher_id
    JOIN rooms r ON r.id = c.room_id`;

route('GET', '/api/classes', async (ctx) => {
  const user = requireUser(ctx.user);
  let rows;
  if (user.role === 'admin') {
    rows = await q(`${CLASS_SELECT} ORDER BY c.day_of_week, c.start_time`);
  } else if (user.role === 'teacher') {
    rows = await q(`${CLASS_SELECT} WHERE c.teacher_id = ? ORDER BY c.day_of_week, c.start_time`, [user.id]);
  } else {
    // Students see only the sections they joined, and never the join code.
    rows = await q(`${CLASS_SELECT} JOIN enrollments en ON en.class_id = c.id AND en.user_id = ?
                    ORDER BY c.day_of_week, c.start_time`, [user.id]);
    rows = rows.map(({ join_code, student_count, ...rest }) => rest);
  }
  return { classes: rows };
});

async function sectionFields(body, user, excludeId) {
  const code = clean(body.code, 30), name = clean(body.name, 120);
  if (!code || !name) throw bad('Section code and name are required.');
  const teacherId = user.role === 'teacher' ? user.id : Number(body.teacher_id);
  if (!Number.isInteger(teacherId)) throw bad('Choose a teacher.');
  const teacher = await one("SELECT id FROM users WHERE id = ? AND role = 'teacher' AND active = 1", [teacherId]);
  if (!teacher) throw bad('Choose an active teacher.');
  const roomId = Number(body.room_id);
  const room = Number.isInteger(roomId) ? await one('SELECT id FROM rooms WHERE id = ? AND active = 1', [roomId]) : null;
  if (!room) throw bad('Choose an active room.');
  const day = Number(body.day_of_week);
  if (!Number.isInteger(day) || day < 1 || day > 7) throw bad('Choose a day of the week.');
  const start = normTime(body.start_time), end = normTime(body.end_time);
  if (!validTime(start) || !validTime(end) || start >= end) throw bad('End time must be after start time.');
  const [clash] = await pool.query(
    'SELECT id FROM classes WHERE room_id = ? AND day_of_week = ? AND id <> ? AND start_time < ? AND end_time > ? LIMIT 1',
    [room.id, day, excludeId, end, start]);
  if (clash.length) throw new ApiError(409, 'This room already has a section at that time.');
  return { code, name, teacher_id: teacher.id, room_id: room.id, day_of_week: day, start_time: start, end_time: end };
}

async function ownSection(user, id) {
  const c = await one('SELECT * FROM classes WHERE id = ?', [id]);
  if (!c) throw new ApiError(404, 'Section not found.');
  if (user.role !== 'admin' && c.teacher_id !== user.id) throw new ApiError(403, 'You can only change your own sections.');
  return c;
}

route('POST', '/api/classes', async (ctx) => {
  const user = requireUser(ctx.user, ['admin', 'teacher']);
  const f = await sectionFields(ctx.body, user, 0);
  const joinCode = await uniqueJoinCode();
  const r = await q(
    'INSERT INTO classes (code, name, teacher_id, room_id, day_of_week, start_time, end_time, join_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [f.code, f.name, f.teacher_id, f.room_id, f.day_of_week, f.start_time, f.end_time, joinCode]);
  return { id: r.insertId, join_code: joinCode };
});

route('PUT', '/api/classes/:id', async (ctx) => {
  const user = requireUser(ctx.user, ['admin', 'teacher']);
  await ownSection(user, ctx.params.id);
  const f = await sectionFields(ctx.body, user, Number(ctx.params.id));
  await q('UPDATE classes SET code=?, name=?, teacher_id=?, room_id=?, day_of_week=?, start_time=?, end_time=? WHERE id=?',
    [f.code, f.name, f.teacher_id, f.room_id, f.day_of_week, f.start_time, f.end_time, ctx.params.id]);
  return { ok: true };
});

route('DELETE', '/api/classes/:id', async (ctx) => {
  const user = requireUser(ctx.user, ['admin', 'teacher']);
  await ownSection(user, ctx.params.id);
  await q('DELETE FROM classes WHERE id = ?', [ctx.params.id]);
  return { ok: true };
});

// Issue a new join code (the old code stops working immediately).
route('POST', '/api/classes/:id/new-code', async (ctx) => {
  const user = requireUser(ctx.user, ['admin', 'teacher']);
  await ownSection(user, ctx.params.id);
  const joinCode = await uniqueJoinCode();
  await q('UPDATE classes SET join_code = ? WHERE id = ?', [joinCode, ctx.params.id]);
  return { join_code: joinCode };
});

// Who has joined a section (teacher of that section, or admin).
route('GET', '/api/classes/:id/roster', async (ctx) => {
  const user = requireUser(ctx.user, ['admin', 'teacher']);
  await ownSection(user, ctx.params.id);
  const students = await q(
    `SELECT u.name, u.email, DATE_FORMAT(en.joined_at, '%Y-%m-%d') AS joined_at
       FROM enrollments en JOIN users u ON u.id = en.user_id
      WHERE en.class_id = ? ORDER BY u.name`, [ctx.params.id]);
  return { students };
});

// Reservations
route('GET', '/api/reservations', async (ctx) => {
  const user = requireUser(ctx.user, ['admin', 'teacher']);
  const params = ctx.query;
  const where = [];
  const args = [];
  if (params.from) { if (!isDate(params.from)) throw bad('Invalid start date.'); where.push('r.booking_date >= ?'); args.push(params.from); }
  if (params.to) { if (!isDate(params.to)) throw bad('Invalid end date.'); where.push('r.booking_date <= ?'); args.push(params.to); }
  if (params.room_id) { where.push('r.room_id = ?'); args.push(Number(params.room_id)); }
  if (params.mine === '1') { where.push('r.user_id = ?'); args.push(user.id); }
  if (params.status && ['pending', 'approved', 'rejected', 'cancelled'].includes(params.status)) { where.push('r.status = ?'); args.push(params.status); }
  const sql = `
    SELECT r.id, r.room_id, r.user_id, r.title, r.purpose, r.status, r.cancel_requested, r.decision_note,
           r.class_id, DATE_FORMAT(r.booking_date, '%Y-%m-%d') AS booking_date,
           TIME_FORMAT(r.start_time, '%H:%i') AS start_time, TIME_FORMAT(r.end_time, '%H:%i') AS end_time,
           u.name AS user_name, rm.code AS room_code, rm.name AS room_name,
           c.code AS class_code, c.name AS class_name
      FROM reservations r
      JOIN users u ON u.id = r.user_id
      JOIN rooms rm ON rm.id = r.room_id
      LEFT JOIN classes c ON c.id = r.class_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.booking_date, r.start_time LIMIT 1000`;
  const rows = await q(sql, args);
  // Privacy: only admins and the booking owner see details. Others see that the slot is taken.
  const out = rows.map((r) => {
    const own = user.role === 'admin' || r.user_id === user.id;
    if (own) return { ...r, mine: r.user_id === user.id };
    return { id: r.id, room_id: r.room_id, room_code: r.room_code, room_name: r.room_name, booking_date: r.booking_date,
             start_time: r.start_time, end_time: r.end_time, status: r.status, title: 'Reserved', purpose: '', user_name: '',
             class_code: '', class_name: '', mine: false, cancel_requested: 0 };
  });
  return { reservations: out };
});

route('POST', '/api/reservations', async (ctx) => {
  const user = requireUser(ctx.user, ['teacher']);
  const { body } = ctx;
  const roomId = Number(body.room_id);
  if (!Number.isInteger(roomId)) throw bad('Choose an active room.');
  const title = clean(body.title, 150), purpose = clean(body.purpose, 1000);
  const date = clean(body.booking_date, 10);
  const start = normTime(body.start_time), end = normTime(body.end_time);
  if (!title) throw bad('Add a title for the booking.');
  if (!isDate(date)) throw bad('Choose a valid date.');
  if (date < todayStr()) throw bad('You cannot request a date in the past.');
  if (!validTime(start) || !validTime(end) || start >= end) throw bad('End time must be after start time.');
  const minutes = (end.slice(0, 2) * 60 + Number(end.slice(3, 5))) - (start.slice(0, 2) * 60 + Number(start.slice(3, 5)));
  if (minutes < 30) throw bad('Bookings must be at least 30 minutes.');
  await checkWithinHours(date, start, end);
  let classId = null;
  if (body.class_id) {
    const cid = Number(body.class_id);
    const own = Number.isInteger(cid) ? await one('SELECT id FROM classes WHERE id = ? AND teacher_id = ?', [cid, user.id]) : null;
    if (!own) throw bad('Choose one of your own sections, or leave it blank.');
    classId = own.id;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[room]] = await conn.query('SELECT id FROM rooms WHERE id = ? AND active = 1 FOR UPDATE', [roomId]);
    if (!room) throw bad('Choose an active room.');
    const conflict = await findConflicts(conn, { roomId, date, start, end });
    if (conflict) throw new ApiError(409, conflict);
    const [r] = await conn.query(
      `INSERT INTO reservations (room_id, user_id, class_id, title, purpose, booking_date, start_time, end_time, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [roomId, user.id, classId, title, purpose, date, start, end]);
    await notify(await adminIds(conn), `New room request from ${user.name}: ${title}`, conn);
    await conn.commit();
    return { id: r.insertId };
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
});

route('POST', '/api/reservations/:id/decide', async (ctx) => {
  const admin = requireUser(ctx.user, ['admin']);
  const decision = ctx.body.decision;
  if (!['approve', 'reject'].includes(decision)) throw bad('Decision must be approve or reject.');
  const note = clean(ctx.body.note, 255);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[r]] = await conn.query('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [ctx.params.id]);
    if (!r) throw new ApiError(404, 'Request not found.');
    if (r.status !== 'pending') throw new ApiError(409, 'Only pending requests can be decided.');
    if (decision === 'approve') {
      await conn.query('SELECT id FROM rooms WHERE id = ? FOR UPDATE', [r.room_id]);
      const date = String(r.booking_date).slice(0, 10);
      const conflict = await findConflicts(conn, { roomId: r.room_id, date, start: r.start_time, end: r.end_time, excludeId: r.id });
      if (conflict) throw new ApiError(409, conflict);
      await conn.query("UPDATE reservations SET status='approved', decided_by=?, decision_note=? WHERE id=?", [admin.id, note, r.id]);
      await notify([r.user_id], `Your booking "${r.title}" was approved.`, conn);
    } else {
      await conn.query("UPDATE reservations SET status='rejected', decided_by=?, decision_note=? WHERE id=?", [admin.id, note, r.id]);
      await notify([r.user_id], `Your booking "${r.title}" was declined${note ? ': ' + note : '.'}`, conn);
    }
    await conn.commit();
    return { ok: true };
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
});

route('POST', '/api/reservations/:id/cancel', async (ctx) => {
  const user = requireUser(ctx.user, ['admin', 'teacher']);
  const r = await one('SELECT * FROM reservations WHERE id = ?', [ctx.params.id]);
  if (!r) throw new ApiError(404, 'Booking not found.');
  if (user.role !== 'admin' && r.user_id !== user.id) throw new ApiError(403, 'You can only cancel your own bookings.');
  if (!['pending', 'approved'].includes(r.status)) throw new ApiError(409, 'This booking cannot be cancelled.');
  if (user.role === 'admin') {
    await q("UPDATE reservations SET status='cancelled', cancel_requested=0 WHERE id=?", [r.id]);
    await notify([r.user_id], `Your booking "${r.title}" was cancelled by the administrator.`);
  } else if (r.status === 'pending') {
    await q("UPDATE reservations SET status='cancelled' WHERE id=?", [r.id]);
  } else {
    if (r.cancel_requested) throw new ApiError(409, 'A cancellation has already been requested.');
    await q('UPDATE reservations SET cancel_requested=1 WHERE id=?', [r.id]);
    await notify(await adminIds(), `${user.name} asked to cancel "${r.title}".`);
  }
  return { ok: true };
});

route('POST', '/api/reservations/:id/cancel-decision', async (ctx) => {
  requireUser(ctx.user, ['admin']);
  const r = await one('SELECT * FROM reservations WHERE id = ?', [ctx.params.id]);
  if (!r || !r.cancel_requested || r.status !== 'approved') throw new ApiError(409, 'There is no cancellation request for this booking.');
  if (ctx.body.approve) {
    await q("UPDATE reservations SET status='cancelled', cancel_requested=0 WHERE id=?", [r.id]);
    await notify([r.user_id], `Cancellation of "${r.title}" was approved.`);
  } else {
    await q('UPDATE reservations SET cancel_requested=0 WHERE id=?', [r.id]);
    await notify([r.user_id], `Cancellation of "${r.title}" was declined; the booking stands.`);
  }
  return { ok: true };
});

// Users (administrator only)
route('GET', '/api/users', async (ctx) => {
  requireUser(ctx.user, ['admin']);
  return { users: await q('SELECT id, name, email, role, active, DATE_FORMAT(created_at, "%Y-%m-%d") AS created_at FROM users ORDER BY role, name') };
});
route('POST', '/api/users', async (ctx) => {
  requireUser(ctx.user, ['admin']);
  const { body } = ctx;
  const name = clean(body.name, 100), email = clean(body.email, 190).toLowerCase();
  const role = body.role;
  if (!name) throw bad('Name is required.');
  if (!isEmail(email)) throw bad('Enter a valid email address.');
  if (!['teacher', 'student'].includes(role)) throw bad('Role must be teacher or student.');
  checkPassword(body.password);
  try {
    const r = await q('INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, ?, ?)', [name, email, role, hashPassword(body.password)]);
    return { id: r.insertId };
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw new ApiError(409, 'That email is already registered.'); throw e; }
});
route('PATCH', '/api/users/:id', async (ctx) => {
  const admin = requireUser(ctx.user, ['admin']);
  const id = Number(ctx.params.id);
  if (id === admin.id) throw bad('You cannot change your own account here.');
  const target = await one('SELECT * FROM users WHERE id = ?', [id]);
  if (!target) throw new ApiError(404, 'User not found.');
  if (target.role === 'admin') throw bad('Administrator accounts cannot be changed here.');
  const { body } = ctx;
  if (body.role !== undefined) {
    if (!['teacher', 'student'].includes(body.role)) throw bad('Role must be teacher or student.');
    await q('UPDATE users SET role = ? WHERE id = ?', [body.role, id]);
  }
  if (body.active !== undefined) {
    const active = body.active ? 1 : 0;
    await q('UPDATE users SET active = ? WHERE id = ?', [active, id]);
    if (!active) await q('DELETE FROM sessions WHERE user_id = ?', [id]);
  }
  return { ok: true };
});

// Announcements
route('GET', '/api/announcements', async (ctx) => {
  requireUser(ctx.user);
  return { announcements: await q(
    `SELECT a.id, a.title, a.body, u.name AS author, DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i') AS created_at
       FROM announcements a JOIN users u ON u.id = a.author_id ORDER BY a.created_at DESC LIMIT 100`) };
});
route('POST', '/api/announcements', async (ctx) => {
  const admin = requireUser(ctx.user, ['admin']);
  const title = clean(ctx.body.title, 150), body = clean(ctx.body.body, 5000);
  if (!title || !body) throw bad('Title and message are required.');
  const r = await q('INSERT INTO announcements (title, body, author_id) VALUES (?, ?, ?)', [title, body, admin.id]);
  return { id: r.insertId };
});
route('DELETE', '/api/announcements/:id', async (ctx) => {
  requireUser(ctx.user, ['admin']);
  await q('DELETE FROM announcements WHERE id = ?', [ctx.params.id]);
  return { ok: true };
});

// Notifications
route('GET', '/api/notifications', async (ctx) => {
  const user = requireUser(ctx.user);
  const items = await q(
    `SELECT id, message, is_read, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at
       FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`, [user.id]);
  const unread = await one('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', [user.id]);
  return { notifications: items, unread: unread.n };
});
route('POST', '/api/notifications/read', async (ctx) => {
  const user = requireUser(ctx.user);
  await q('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [user.id]);
  return { ok: true };
});

// Summary numbers for the dashboard (computed from the database, never hardcoded)
route('GET', '/api/summary', async (ctx) => {
  const user = requireUser(ctx.user);
  const today = todayStr();
  const out = { today };
  if (user.role === 'student') {
    // Students only ever see their own classes.
    out.mySections = (await one('SELECT COUNT(*) AS n FROM enrollments WHERE user_id = ?', [user.id])).n;
    return out;
  }
  out.rooms = (await one('SELECT COUNT(*) AS n FROM rooms WHERE active = 1')).n;
  out.approvedToday = (await one("SELECT COUNT(*) AS n FROM reservations WHERE status='approved' AND booking_date = ?", [today])).n;
  if (user.role === 'admin') {
    out.pending = (await one("SELECT COUNT(*) AS n FROM reservations WHERE status='pending'")).n;
    out.cancelRequests = (await one('SELECT COUNT(*) AS n FROM reservations WHERE cancel_requested = 1')).n;
    out.users = (await one('SELECT COUNT(*) AS n FROM users WHERE active = 1')).n;
  } else if (user.role === 'teacher') {
    out.pending = (await one("SELECT COUNT(*) AS n FROM reservations WHERE status='pending' AND user_id = ?", [user.id])).n;
    out.myApproved = (await one("SELECT COUNT(*) AS n FROM reservations WHERE status='approved' AND user_id = ? AND booking_date >= ?", [user.id, today])).n;
    out.mySections = (await one('SELECT COUNT(*) AS n FROM classes WHERE teacher_id = ?', [user.id])).n;
  }
  return out;
});

// ---------- request dispatcher ----------
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const names = [];
    const rx = new RegExp('^' + r.pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    const m = pathname.match(rx);
    if (m) {
      const params = {};
      names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
  }
  return null;
}

async function handleApi(req, res, url) {
  const found = matchRoute(req.method, url.pathname);
  if (!found) return send(res, 404, { error: 'Not found.' });
  const ctx = { req, res, params: found.params, query: Object.fromEntries(url.searchParams), body: {} };
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) ctx.body = await readBody(req);
  ctx.user = await currentUser(req);
  const data = await found.handler(ctx);
  return send(res, 200, data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err instanceof ApiError) return send(res, err.status, { error: err.message });
    console.error('[server]', err);
    return send(res, 500, { error: 'Something went wrong on the server. Check the server log.' });
  }
});

// ---------- startup: create database objects (no data is inserted) ----------
async function init() {
  if (!/^[A-Za-z0-9_]+$/.test(DB.database)) throw new Error('DB_NAME may only contain letters, numbers and underscores.');
  // Run schema.sql one statement at a time, so a failure names the exact statement that broke.
  const raw = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/campusroom_reservation/g, DB.database);
  const statements = raw
    .split(/;\s*\r?\n/)
    .map((chunk) => chunk.split(/\r?\n/).filter((line) => !line.trim().startsWith('--')).join('\n').trim())
    .filter((chunk) => chunk.length > 0);

  const setup = await mysql.createConnection({ host: DB.host, port: DB.port, user: DB.user, password: DB.password, dateStrings: true });
  for (const sql of statements) {
    try {
      await setup.query(sql);
    } catch (e) {
      const firstLine = sql.split(/\r?\n/).find((l) => l.trim()) || '';
      console.error(`Schema step failed: ${firstLine.trim()}`);
      console.error(`MySQL said: [${e.code}] ${e.sqlMessage || e.message}`);
      await setup.end();
      process.exit(1);
    }
  }
  const [tables] = await setup.query('SHOW TABLES');
  console.log(`Database ${DB.database} ready. Tables: ${tables.map((t) => Object.values(t)[0]).join(', ')}`);
  await setup.end();

  pool = mysql.createPool({ host: DB.host, port: DB.port, user: DB.user, password: DB.password, database: DB.database,
    waitForConnections: true, connectionLimit: 10, dateStrings: true, charset: 'utf8mb4' });
  await pool.query('SELECT 1');
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Change PORT in .env to a free port (for example 5056) and start again.`);
    else console.error(e.message);
    process.exit(1);
  });
  server.listen(PORT, () => console.log(`Campus Room Reservation running at http://localhost:${PORT}`));
}

init().catch((e) => {
  console.error('Could not start. Check the database settings in .env and that MySQL is running.');
  console.error(`[${e.code || 'error'}] ${e.sqlMessage || e.message}`);
  process.exit(1);
});
