/*
 * Booking API core — runtime-agnostic.
 *
 * Works with standard Web Request/Response objects so the same logic runs in
 * the local Node server (server.js, file storage) and on Netlify Functions
 * (netlify/functions/api.js, Netlify Blobs storage).
 *
 * Storage adapter contract:
 *   read()                -> { db: { bookings, blocks }, version }
 *   write(db, version)    -> true when saved, false when someone else wrote first
 */

import crypto from 'node:crypto';

const HOLDING_STATUSES = new Set(['pending', 'confirmed']); // these block the calendar
const ALL_STATUSES = ['pending', 'confirmed', 'declined', 'cancelled', 'completed'];
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SESSION_MS = 12 * 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

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

function dayInfo(cfg, db, date, excludeBookingId) {
  const av = cfg.availability;
  const today = todayInTz(av.timezone);
  if (date < addDays(today, av.minNoticeDays ?? 0)) return { open: false, reason: date < today ? 'past' : 'notice' };
  if (date > addDays(today, av.maxAdvanceDays ?? 365)) return { open: false, reason: 'too-far' };

  const blocks = db.blocks.filter((b) => b.date === date);
  if (blocks.some((b) => !b.startTime)) return { open: false, reason: 'blocked' };

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

function slotsFor(cfg, db, date, duration, excludeBookingId) {
  const info = dayInfo(cfg, db, date, excludeBookingId);
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

function dayStatus(cfg, db, date) {
  const shortest = Math.min(...cfg.availability.durations);
  const res = slotsFor(cfg, db, date, shortest);
  if (!res.open) return { status: 'closed', reason: res.reason };
  if (res.dayFull) return { status: 'full' };
  const free = res.slots.filter((s) => s.available).length;
  if (free === 0) return { status: 'full' };
  if (res.busy.length > 0) return { status: 'limited', free };
  return { status: 'available', free };
}

/* --------------------------------------------------------------- helpers */

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

async function readJson(request, limit = 50_000) {
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, 'Request body too large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function str(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeRef(db) {
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
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(b.email)) errors.email = 'Please enter a valid email.';
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

function checkSlot(cfg, db, date, startTime, duration, excludeId) {
  const res = slotsFor(cfg, db, date, duration, excludeId);
  if (!res.open) return 'That date is not available for bookings.';
  const slot = res.slots.find((s) => s.time === startTime);
  if (!slot || !slot.available) return 'That time was just taken or is outside available hours — please pick another slot.';
  return null;
}

/* ------------------------------------------------------------- the API */

/**
 * @param {object} opts
 * @param {() => object} opts.getConfig         returns the parsed config.json
 * @param {{read: Function, write: Function}} opts.storage
 * @param {string|undefined} opts.adminPassword  admin login disabled when empty
 * @param {(msg: string) => void} [opts.log]
 */
export function createApi({ getConfig, storage, adminPassword, log = () => {} }) {
  /* ---- stateless signed admin sessions (work across serverless instances) */
  const sessionKey = adminPassword ? crypto.createHash('sha256').update('admin-session|' + adminPassword).digest() : null;
  const sign = (payload) => crypto.createHmac('sha256', sessionKey).update(payload).digest('base64url');

  function makeToken() {
    const exp = String(Date.now() + SESSION_MS);
    return `${exp}.${sign(exp)}`;
  }
  function tokenValid(token) {
    if (!sessionKey || !token) return false;
    const [exp, sig] = token.split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function passwordMatches(input) {
    if (!adminPassword) return false;
    const a = crypto.createHash('sha256').update(String(input)).digest();
    const b = crypto.createHash('sha256').update(adminPassword).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /* ---- best-effort rate limiting (per instance) */
  const buckets = new Map();
  function rateLimited(key, limit, windowMs) {
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    hits.push(now);
    buckets.set(key, hits);
    if (buckets.size > 5000) buckets.clear();
    return hits.length > limit;
  }

  /*
   * Read-modify-write with optimistic concurrency.
   * `fn` mutates the db and returns a result; `landed(db, result)` checks the
   * change is really in storage. Conditional writes should already prevent
   * lost updates, but reading back guards against a store that doesn't
   * enforce them strictly: if another writer overwrote us, we retry, and the
   * retry re-runs all checks (e.g. "is this slot still free?").
   */
  async function mutate(fn, landed) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const { db, version } = await storage.read();
      const result = await fn(db); // may throw HttpError
      if (!(await storage.write(db, version))) continue;
      if (!landed) return result;
      const { db: after } = await storage.read();
      if (landed(after, result)) return result;
    }
    throw new HttpError(503, 'The calendar is busy right now — please try again.');
  }
  const hasBooking = (db, b) => db.bookings.some((x) => x.id === b.id && x.rev === b.rev);

  async function route(request, { ip }) {
    const cfg = getConfig();
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '');
    const m = request.method;
    const cookies = parseCookies(request.headers.get('cookie'));
    const secure = url.protocol === 'https:' ? '; Secure' : '';

    /* ----- public ----- */

    if (m === 'GET' && p === '/api/profile') return json(200, publicProfile(cfg));

    if (m === 'GET' && p === '/api/calendar') {
      const month = url.searchParams.get('month') || todayInTz(cfg.availability.timezone).slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json(400, { error: 'month must be YYYY-MM' });
      const { db } = await storage.read();
      const days = {};
      for (let d = month + '-01'; d.startsWith(month); d = addDays(d, 1)) days[d] = dayStatus(cfg, db, d);
      return json(200, { month, today: todayInTz(cfg.availability.timezone), days });
    }

    if (m === 'GET' && p === '/api/day') {
      const date = url.searchParams.get('date');
      const duration = Number(url.searchParams.get('duration')) || Math.min(...cfg.availability.durations);
      if (!isValidDate(date)) return json(400, { error: 'Invalid date' });
      if (!cfg.availability.durations.includes(duration)) return json(400, { error: 'Invalid duration' });
      const { db } = await storage.read();
      const r = slotsFor(cfg, db, date, duration);
      return json(200, {
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
      const { db } = await storage.read();
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
      return json(200, { events });
    }

    if (m === 'POST' && p === '/api/bookings') {
      if (rateLimited('book:' + ip, 8, 3600_000)) {
        return json(429, { error: 'Too many requests from this network. Please try again later.' });
      }
      const input = await readJson(request);
      if (input.website) return json(201, { ref: 'BK-THANKS' }); // honeypot: silently drop bots
      const { booking, errors } = validateBooking(input, cfg);
      if (Object.keys(errors).length) return json(422, { error: 'Please fix the highlighted fields.', fields: errors });

      const record = await mutate((db) => {
        const slotError = checkSlot(cfg, db, booking.date, booking.startTime, booking.duration);
        if (slotError) throw new HttpError(409, slotError);
        const now = new Date().toISOString();
        const rec = {
          id: crypto.randomUUID(),
          ref: makeRef(db),
          ...booking,
          status: 'pending',
          adminNote: '',
          showPublicly: false,
          rev: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        };
        db.bookings.push(rec);
        return rec;
      }, hasBooking);
      log(`[booking] ${record.ref} ${record.date} ${record.startTime} — ${record.organization} (${record.name})`);
      return json(201, { ref: record.ref, date: record.date, startTime: record.startTime, duration: record.duration });
    }

    if (m === 'GET' && p === '/api/bookings/lookup') {
      if (rateLimited('lookup:' + ip, 30, 3600_000)) return json(429, { error: 'Too many lookups. Try later.' });
      const ref = str(url.searchParams.get('ref'), 12).toUpperCase();
      const email = str(url.searchParams.get('email'), 160).toLowerCase();
      const { db } = await storage.read();
      const b = db.bookings.find((x) => x.ref === ref && x.email === email);
      if (!b) return json(404, { error: 'No booking found for that reference and email.' });
      return json(200, {
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
      if (!adminPassword) {
        return json(503, { error: 'Admin is not set up: add an ADMIN_PASSWORD environment variable and redeploy.' });
      }
      if (rateLimited('login:' + ip, 10, 15 * 60_000)) return json(429, { error: 'Too many attempts. Wait 15 minutes.' });
      const { password } = await readJson(request);
      if (!password || !passwordMatches(password)) return json(401, { error: 'Wrong password.' });
      return json(200, { ok: true }, {
        'Set-Cookie': `admin_session=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`,
      });
    }

    if (m === 'POST' && p === '/api/admin/logout') {
      return json(200, { ok: true }, { 'Set-Cookie': `admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` });
    }

    if (p.startsWith('/api/admin/')) {
      if (!tokenValid(cookies.admin_session)) return json(401, { error: 'Not signed in.' });

      if (m === 'GET' && p === '/api/admin/me') return json(200, { ok: true });

      if (m === 'GET' && p === '/api/admin/bookings') {
        const { db } = await storage.read();
        const bookings = [...db.bookings].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
        return json(200, { bookings, today: todayInTz(cfg.availability.timezone) });
      }

      const bm = p.match(/^\/api\/admin\/bookings\/([\w-]+)$/);
      if (bm && m === 'PATCH') {
        const input = await readJson(request);
        const booking = await mutate((db) => {
          const b = db.bookings.find((x) => x.id === bm[1]);
          if (!b) throw new HttpError(404, 'Booking not found.');
          const next = { ...b };
          if (input.status !== undefined) {
            if (!ALL_STATUSES.includes(input.status)) throw new HttpError(400, 'Unknown status.');
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
              throw new HttpError(400, 'Invalid date, time or duration.');
            }
            if (HOLDING_STATUSES.has(next.status) && !input.force) {
              // Admin may book inside the notice window, so only check for clashes.
              const relaxed = { ...cfg, availability: { ...cfg.availability, minNoticeDays: 0, maxAdvanceDays: 3650, maxBookingsPerDay: 0 } };
              const info = dayInfo(relaxed, db, next.date, b.id);
              const s = toMin(next.startTime);
              const e = s + next.duration;
              if (info.open && info.busy.some((x) => s < x.end && e > x.start)) {
                throw new HttpError(409, 'That clashes with another booking or blocked time.', { canForce: true });
              }
            }
          }
          next.updatedAt = new Date().toISOString();
          next.rev = crypto.randomUUID();
          Object.assign(b, next);
          return b;
        }, hasBooking);
        return json(200, { booking });
      }

      if (bm && m === 'DELETE') {
        await mutate((db) => {
          const i = db.bookings.findIndex((x) => x.id === bm[1]);
          if (i === -1) throw new HttpError(404, 'Booking not found.');
          db.bookings.splice(i, 1);
        }, (db) => !db.bookings.some((x) => x.id === bm[1]));
        return json(200, { ok: true });
      }

      if (m === 'GET' && p === '/api/admin/blocks') {
        const { db } = await storage.read();
        return json(200, { blocks: [...db.blocks].sort((a, b) => a.date.localeCompare(b.date)) });
      }

      if (m === 'POST' && p === '/api/admin/blocks') {
        const input = await readJson(request);
        const date = str(input.date, 10);
        const endDate = str(input.endDate, 10) || date;
        const startTime = str(input.startTime, 5) || null;
        const endTime = str(input.endTime, 5) || null;
        const reason = str(input.reason, 200);
        if (!isValidDate(date) || !isValidDate(endDate) || endDate < date) return json(400, { error: 'Invalid date range.' });
        if ((startTime || endTime) && !(isValidTime(startTime) && isValidTime(endTime) && toMin(endTime) > toMin(startTime))) {
          return json(400, { error: 'Give both a start and end time (end after start), or neither for a full day.' });
        }
        const created = await mutate((db) => {
          const out = [];
          for (let d = date, i = 0; d <= endDate && i < 120; d = addDays(d, 1), i++) {
            const block = { id: crypto.randomUUID(), date: d, startTime, endTime, reason, createdAt: new Date().toISOString() };
            db.blocks.push(block);
            out.push(block);
          }
          return out;
        }, (db, out) => out.every((o) => db.blocks.some((x) => x.id === o.id)));
        return json(201, { blocks: created });
      }

      const blm = p.match(/^\/api\/admin\/blocks\/([\w-]+)$/);
      if (blm && m === 'DELETE') {
        await mutate((db) => {
          const i = db.blocks.findIndex((x) => x.id === blm[1]);
          if (i === -1) throw new HttpError(404, 'Block not found.');
          db.blocks.splice(i, 1);
        }, (db) => !db.blocks.some((x) => x.id === blm[1]));
        return json(200, { ok: true });
      }

      if (m === 'GET' && p === '/api/admin/export.csv') {
        const { db } = await storage.read();
        const cols = ['ref', 'status', 'date', 'startTime', 'duration', 'name', 'email', 'phone', 'organization', 'role',
          'eventType', 'topic', 'mode', 'location', 'audienceSize', 'audienceType', 'description', 'adminNote', 'createdAt'];
        const cell = (v) => {
          let s = v === undefined || v === null ? '' : String(v);
          if (/^[=+\-@]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
          return '"' + s.replace(/"/g, '""') + '"';
        };
        const csv = [cols.join(','), ...db.bookings.map((b) => cols.map((c) => cell(b[c])).join(','))].join('\r\n');
        return new Response(csv, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="bookings.csv"',
            'Cache-Control': 'no-store',
          },
        });
      }
    }

    return json(404, { error: 'Not found' });
  }

  /** Handle one API request. `ip` is used for rate limiting. */
  return async function handle(request, { ip = 'unknown' } = {}) {
    try {
      if (request.method !== 'GET' && request.method !== 'DELETE') {
        // Basic CSRF guard: state-changing calls must be same-origin JSON.
        if (!(request.headers.get('content-type') || '').includes('application/json')) {
          return json(415, { error: 'Use application/json' });
        }
      }
      const origin = request.headers.get('origin');
      if (request.method !== 'GET' && origin) {
        const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
        let originHost;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = null;
        }
        if (originHost !== host) return json(403, { error: 'Cross-origin request blocked' });
      }
      return await route(request, { ip });
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra });
      console.error(err);
      return json(500, { error: 'Something went wrong on our side.' });
    }
  };
}
