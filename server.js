'use strict';

/*
 * Speaker booking platform — zero-dependency Node.js server.
 *
 *   npm start            -> http://localhost:3000
 *
 * Data lives in ./data/db.json, speaker profile + availability in ./config.json
 * (config edits are picked up without a restart).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PASSWORD_FILE = path.join(DATA_DIR, '.admin-password');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const HOLDING_STATUSES = new Set(['pending', 'confirmed']); // these block the calendar
const ALL_STATUSES = ['pending', 'confirmed', 'declined', 'cancelled', 'completed'];
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/* ------------------------------------------------------------------ config */

let configCache = { mtime: 0, value: null };
function getConfig() {
  const st = fs.statSync(CONFIG_FILE);
  if (st.mtimeMs !== configCache.mtime) {
    try {
      configCache = { mtime: st.mtimeMs, value: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    } catch (err) {
      console.error('[config] config.json is invalid JSON:', err.message);
      if (!configCache.value) throw err; // nothing good to fall back to
    }
  }
  return configCache.value;
}

/* ---------------------------------------------------------------- storage */

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return { bookings: [], blocks: [] };
  const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return { bookings: parsed.bookings || [], blocks: parsed.blocks || [] };
}
const db = loadDb();

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ------------------------------------------------------------ admin auth */

function resolveAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return { value: process.env.ADMIN_PASSWORD, source: 'ADMIN_PASSWORD env var' };
  if (fs.existsSync(PASSWORD_FILE)) {
    return { value: fs.readFileSync(PASSWORD_FILE, 'utf8').trim(), source: 'data/.admin-password' };
  }
  const generated = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(PASSWORD_FILE, generated + '\n');
  return { value: generated, source: 'data/.admin-password (newly generated)' };
}
const ADMIN = resolveAdminPassword();

const sessions = new Map(); // token -> expiresAt
const SESSION_MS = 12 * 60 * 60 * 1000;

function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(ADMIN.value).digest();
  return crypto.timingSafeEqual(a, b);
}

function isAdmin(req) {
  const token = parseCookies(req).admin_session;
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------ rate limit */

const buckets = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
  return hits.length > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of buckets) if (!hits.some((t) => now - t < 3600_000)) buckets.delete(k);
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 600_000).unref();

/* ----------------------------------------------------------- date / time */

function todayInTz(tz) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dayKey = (date) => DAY_KEYS[new Date(date + 'T00:00:00Z').getUTCDay()];

/* ---------------------------------------------------------- availability */

function dayInfo(cfg, date, excludeBookingId) {
  const av = cfg.availability;
  const today = todayInTz(av.timezone);
  if (date < addDays(today, av.minNoticeDays ?? 0)) return { open: false, reason: date < today ? 'past' : 'notice' };
  if (date > addDays(today, av.maxAdvanceDays ?? 365)) return { open: false, reason: 'too-far' };

  const blocks = db.blocks.filter((b) => b.date === date);
  const fullBlock = blocks.find((b) => !b.startTime);
  if (fullBlock) return { open: false, reason: 'blocked' };

  const ranges = (av.weeklyHours && av.weeklyHours[dayKey(date)]) || [];
  if (!ranges.length) return { open: false, reason: 'off-day' };

  const bookings = db.bookings.filter(
    (b) => b.date === date && HOLDING_STATUSES.has(b.status) && b.id !== excludeBookingId,
  );
  if (av.maxBookingsPerDay && bookings.length >= av.maxBookingsPerDay) {
    return { open: true, dayFull: true, windows: [], busy: [] };
  }

  const busy = [
    ...bookings.map((b) => ({
      start: toMin(b.startTime),
      end: toMin(b.startTime) + b.duration,
      kind: b.status === 'confirmed' ? 'booked' : 'hold',
      label: b.status === 'confirmed' && b.showPublicly ? `${b.topic} · ${b.organization}` : null,
    })),
    ...blocks.map((b) => ({ start: toMin(b.startTime), end: toMin(b.endTime), kind: 'busy', label: null })),
  ].sort((a, b) => a.start - b.start);

  const windows = ranges.map((r) => r.split('-').map((t) => toMin(t.trim())));
  return { open: true, windows, busy };
}

function slotsFor(cfg, date, duration, excludeBookingId) {
  const info = dayInfo(cfg, date, excludeBookingId);
  if (!info.open) return { ...info, slots: [] };
  const step = cfg.availability.slotStepMinutes || 30;
  const buffer = cfg.availability.bufferMinutes || 0;
  const slots = [];
  for (const [ws, we] of info.windows) {
    for (let s = ws; s + duration <= we; s += step) {
      const e = s + duration;
      const clash = info.busy.some((b) => s < b.end + buffer && e > b.start - buffer);
      slots.push({ time: fromMin(s), available: !clash });
    }
  }
  return { ...info, slots };
}

function dayStatus(cfg, date) {
  const shortest = Math.min(...cfg.availability.durations);
  const res = slotsFor(cfg, date, shortest);
  if (!res.open) return { status: 'closed', reason: res.reason };
  if (res.dayFull) return { status: 'full' };
  const free = res.slots.filter((s) => s.available).length;
  if (free === 0) return { status: 'full' };
  if (res.busy.length > 0) return { status: 'limited', free };
  return { status: 'available', free };
}

/* --------------------------------------------------------------- helpers */

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req, limit = 50_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function str(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeRef() {
  let ref;
  do {
    ref = 'BK-';
    for (let i = 0; i < 6; i++) ref += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
  } while (db.bookings.some((b) => b.ref === ref));
  return ref;
}

function publicProfile(cfg) {
  const { availability, ...profile } = cfg;
  return {
    ...profile,
    availability: {
      timezone: availability.timezone,
      timezoneLabel: availability.timezoneLabel || availability.timezone,
      durations: availability.durations,
      minNoticeDays: availability.minNoticeDays,
      maxAdvanceDays: availability.maxAdvanceDays,
      weeklyHours: availability.weeklyHours,
    },
  };
}

/* ------------------------------------------------------------ validation */

function validateBooking(input, cfg) {
  const errors = {};
  const b = {
    name: str(input.name, 100),
    email: str(input.email, 160).toLowerCase(),
    phone: str(input.phone, 30),
    organization: str(input.organization, 160),
    role: str(input.role, 60),
    eventType: str(input.eventType, 80),
    topic: str(input.topic, 160),
    description: str(input.description, 2000),
    date: str(input.date, 10),
    startTime: str(input.startTime, 5),
    duration: Number(input.duration),
    mode: str(input.mode, 20),
    location: str(input.location, 300),
    audienceSize: str(input.audienceSize, 20),
    audienceType: str(input.audienceType, 120),
  };

  if (b.name.length < 2) errors.name = 'Please enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(b.email)) errors.email = 'Please enter a valid email.';
  if (b.organization.length < 2) errors.organization = 'Which college or organisation is this for?';
  if (!b.eventType) errors.eventType = 'Choose an event type.';
  if (b.topic.length < 3) errors.topic = 'Add a topic or title for the session.';
  if (!['In person', 'Online', 'Hybrid'].includes(b.mode)) errors.mode = 'Choose how the session happens.';
  if (b.mode !== 'Online' && b.location.length < 3) errors.location = 'Where is the venue?';
  if (!cfg.availability.durations.includes(b.duration)) errors.duration = 'Pick one of the listed durations.';
  if (!isValidDate(b.date)) errors.date = 'Pick a date.';
  if (!isValidTime(b.startTime)) errors.startTime = 'Pick a start time.';
  return { booking: b, errors };
}

function checkSlot(cfg, date, startTime, duration, excludeId) {
  const res = slotsFor(cfg, date, duration, excludeId);
  if (!res.open) return 'That date is not available for bookings.';
  const slot = res.slots.find((s) => s.time === startTime);
  if (!slot || !slot.available) return 'That time was just taken or is outside available hours — please pick another slot.';
  return null;
}

/* ---------------------------------------------------------------- routes */

async function handleApi(req, res, url) {
  const cfg = getConfig();
  const p = url.pathname;
  const m = req.method;

  /* ----- public ----- */

  if (m === 'GET' && p === '/api/profile') return send(res, 200, publicProfile(cfg));

  if (m === 'GET' && p === '/api/calendar') {
    const month = url.searchParams.get('month') || todayInTz(cfg.availability.timezone).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return send(res, 400, { error: 'month must be YYYY-MM' });
    const days = {};
    for (let d = month + '-01'; d.startsWith(month); d = addDays(d, 1)) days[d] = dayStatus(cfg, d);
    return send(res, 200, { month, today: todayInTz(cfg.availability.timezone), days });
  }

  if (m === 'GET' && p === '/api/day') {
    const date = url.searchParams.get('date');
    const duration = Number(url.searchParams.get('duration')) || Math.min(...cfg.availability.durations);
    if (!isValidDate(date)) return send(res, 400, { error: 'Invalid date' });
    if (!cfg.availability.durations.includes(duration)) return send(res, 400, { error: 'Invalid duration' });
    const r = slotsFor(cfg, date, duration);
    return send(res, 200, {
      date,
      open: r.open,
      reason: r.reason || (r.dayFull ? 'day-full' : null),
      slots: r.slots,
      busy: (r.busy || []).map((b) => ({ start: fromMin(b.start), end: fromMin(b.end), kind: b.kind, label: b.label })),
      windows: (r.windows || []).map(([s, e]) => ({ start: fromMin(s), end: fromMin(e) })),
    });
  }

  if (m === 'GET' && p === '/api/events') {
    const today = todayInTz(cfg.availability.timezone);
    const events = db.bookings
      .filter((b) => b.status === 'confirmed' && b.showPublicly && b.date >= today)
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
      .slice(0, 6)
      .map((b) => ({
        date: b.date,
        startTime: b.startTime,
        duration: b.duration,
        topic: b.topic,
        organization: b.organization,
        eventType: b.eventType,
        mode: b.mode,
      }));
    return send(res, 200, { events });
  }

  if (m === 'POST' && p === '/api/bookings') {
    if (rateLimited('book:' + clientIp(req), 8, 3600_000)) {
      return send(res, 429, { error: 'Too many requests from this network. Please try again later.' });
    }
    const input = await readJson(req);
    if (input.website) return send(res, 201, { ref: 'BK-THANKS' }); // honeypot: silently drop bots
    const { booking, errors } = validateBooking(input, cfg);
    if (Object.keys(errors).length) return send(res, 422, { error: 'Please fix the highlighted fields.', fields: errors });
    const slotError = checkSlot(cfg, booking.date, booking.startTime, booking.duration);
    if (slotError) return send(res, 409, { error: slotError });

    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      ref: makeRef(),
      ...booking,
      status: 'pending',
      adminNote: '',
      showPublicly: false,
      createdAt: now,
      updatedAt: now,
    };
    db.bookings.push(record);
    saveDb();
    console.log(`[booking] ${record.ref} ${record.date} ${record.startTime} — ${record.organization} (${record.name})`);
    return send(res, 201, { ref: record.ref, date: record.date, startTime: record.startTime, duration: record.duration });
  }

  if (m === 'GET' && p === '/api/bookings/lookup') {
    if (rateLimited('lookup:' + clientIp(req), 30, 3600_000)) return send(res, 429, { error: 'Too many lookups. Try later.' });
    const ref = str(url.searchParams.get('ref'), 12).toUpperCase();
    const email = str(url.searchParams.get('email'), 160).toLowerCase();
    const b = db.bookings.find((x) => x.ref === ref && x.email === email);
    if (!b) return send(res, 404, { error: 'No booking found for that reference and email.' });
    return send(res, 200, {
      ref: b.ref,
      status: b.status,
      date: b.date,
      startTime: b.startTime,
      duration: b.duration,
      topic: b.topic,
      organization: b.organization,
      adminNote: b.adminNote,
    });
  }

  /* ----- admin auth ----- */

  if (m === 'POST' && p === '/api/admin/login') {
    if (rateLimited('login:' + clientIp(req), 10, 15 * 60_000)) {
      return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
    }
    const { password } = await readJson(req);
    if (!password || !passwordMatches(password)) return send(res, 401, { error: 'Wrong password.' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_MS);
    return send(res, 200, { ok: true }, {
      'Set-Cookie': `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`,
    });
  }

  if (m === 'POST' && p === '/api/admin/logout') {
    sessions.delete(parseCookies(req).admin_session);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'Not signed in.' });

    if (m === 'GET' && p === '/api/admin/me') return send(res, 200, { ok: true });

    if (m === 'GET' && p === '/api/admin/bookings') {
      const bookings = [...db.bookings].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
      return send(res, 200, { bookings, today: todayInTz(cfg.availability.timezone) });
    }

    const bm = p.match(/^\/api\/admin\/bookings\/([\w-]+)$/);
    if (bm) {
      const b = db.bookings.find((x) => x.id === bm[1]);
      if (!b) return send(res, 404, { error: 'Booking not found.' });

      if (m === 'PATCH') {
        const input = await readJson(req);
        const next = { ...b };
        if (input.status !== undefined) {
          if (!ALL_STATUSES.includes(input.status)) return send(res, 400, { error: 'Unknown status.' });
          next.status = input.status;
        }
        if (input.adminNote !== undefined) next.adminNote = str(input.adminNote, 1000);
        if (input.showPublicly !== undefined) next.showPublicly = Boolean(input.showPublicly);
        if (input.date !== undefined) next.date = str(input.date, 10);
        if (input.startTime !== undefined) next.startTime = str(input.startTime, 5);
        if (input.duration !== undefined) next.duration = Number(input.duration);

        const moved = next.date !== b.date || next.startTime !== b.startTime || next.duration !== b.duration;
        const reactivated = HOLDING_STATUSES.has(next.status) && !HOLDING_STATUSES.has(b.status);
        if (moved || reactivated) {
          if (!isValidDate(next.date) || !isValidTime(next.startTime) || !(next.duration > 0)) {
            return send(res, 400, { error: 'Invalid date, time or duration.' });
          }
          if (HOLDING_STATUSES.has(next.status)) {
            // Admin may reschedule inside notice window, so only check for clashes, not notice rules.
            const info = dayInfo({ ...cfg, availability: { ...cfg.availability, minNoticeDays: 0, maxAdvanceDays: 3650 } }, next.date, b.id);
            const s = toMin(next.startTime);
            const e = s + next.duration;
            const clash = info.open && info.busy.some((x) => s < x.end && e > x.start);
            if (clash && !input.force) {
              return send(res, 409, { error: 'That clashes with another booking or blocked time.', canForce: true });
            }
          }
        }
        next.updatedAt = new Date().toISOString();
        Object.assign(b, next);
        saveDb();
        return send(res, 200, { booking: b });
      }

      if (m === 'DELETE') {
        db.bookings.splice(db.bookings.indexOf(b), 1);
        saveDb();
        return send(res, 200, { ok: true });
      }
    }

    if (m === 'GET' && p === '/api/admin/blocks') {
      return send(res, 200, { blocks: [...db.blocks].sort((a, b) => a.date.localeCompare(b.date)) });
    }

    if (m === 'POST' && p === '/api/admin/blocks') {
      const input = await readJson(req);
      const date = str(input.date, 10);
      const endDate = str(input.endDate, 10) || date;
      const startTime = str(input.startTime, 5) || null;
      const endTime = str(input.endTime, 5) || null;
      const reason = str(input.reason, 200);
      if (!isValidDate(date) || !isValidDate(endDate) || endDate < date) return send(res, 400, { error: 'Invalid date range.' });
      if ((startTime || endTime) && !(isValidTime(startTime) && isValidTime(endTime) && toMin(endTime) > toMin(startTime))) {
        return send(res, 400, { error: 'Give both a start and end time (end after start), or neither for a full day.' });
      }
      const created = [];
      for (let d = date, i = 0; d <= endDate && i < 120; d = addDays(d, 1), i++) {
        const block = { id: crypto.randomUUID(), date: d, startTime, endTime, reason, createdAt: new Date().toISOString() };
        db.blocks.push(block);
        created.push(block);
      }
      saveDb();
      return send(res, 201, { blocks: created });
    }

    const blm = p.match(/^\/api\/admin\/blocks\/([\w-]+)$/);
    if (blm && m === 'DELETE') {
      const i = db.blocks.findIndex((x) => x.id === blm[1]);
      if (i === -1) return send(res, 404, { error: 'Block not found.' });
      db.blocks.splice(i, 1);
      saveDb();
      return send(res, 200, { ok: true });
    }

    if (m === 'GET' && p === '/api/admin/export.csv') {
      const cols = ['ref', 'status', 'date', 'startTime', 'duration', 'name', 'email', 'phone', 'organization', 'role',
        'eventType', 'topic', 'mode', 'location', 'audienceSize', 'audienceType', 'description', 'adminNote', 'createdAt'];
      const cell = (v) => {
        let s = v === undefined || v === null ? '' : String(v);
        if (/^[=+\-@]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
        return '"' + s.replace(/"/g, '""') + '"';
      };
      const csv = [cols.join(','), ...db.bookings.map((b) => cols.map((c) => cell(b[c])).join(','))].join('\r\n');
      return send(res, 200, csv, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="bookings.csv"',
      });
    }
  }

  return send(res, 404, { error: 'Not found' });
}

/* ---------------------------------------------------------------- static */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const PAGES = { '/': 'index.html', '/book': 'book.html', '/admin': 'admin.html', '/status': 'status.html' };

function serveStatic(req, res, url) {
  let rel = PAGES[url.pathname.replace(/\/+$/, '') || '/'];
  if (!rel) {
    try {
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      return send(res, 400, 'Bad request');
    }
  }
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      return fs.readFile(path.join(PUBLIC_DIR, '404.html'), (e2, html) =>
        e2 ? send(res, 404, 'Not found') : send(res, 404, html, { 'Content-Type': MIME['.html'] }));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------------------------------------------------------- server */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      // Basic CSRF guard: state-changing API calls must be same-origin JSON.
      if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json') && req.method !== 'DELETE') {
        return send(res, 415, { error: 'Use application/json' });
      }
      const origin = req.headers.origin;
      if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) {
        return send(res, 403, { error: 'Cross-origin request blocked' });
      }
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url);
  } catch (err) {
    if (err.status) return send(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong on our side.' });
  }
});

server.listen(PORT, HOST, () => {
  const cfg = getConfig();
  console.log(`\n  ${cfg.name} — booking platform`);
  console.log(`  Landing page : http://localhost:${PORT}/`);
  console.log(`  Book a slot  : http://localhost:${PORT}/book`);
  console.log(`  Admin        : http://localhost:${PORT}/admin`);
  console.log(`  Admin password is read from ${ADMIN.source}\n`);
});
