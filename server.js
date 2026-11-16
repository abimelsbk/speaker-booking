/*
 * Local server for the speaker booking platform.
 *
 *   npm start            -> http://localhost:3000
 *
 * Uses the same API code as the Netlify deployment (lib/core.js) but keeps
 * data in ./data/db.json. config.json edits are picked up without a restart.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApi } from './lib/core.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PASSWORD_FILE = path.join(DATA_DIR, '.admin-password');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ config */

let configCache = { mtime: 0, value: null };
function getConfig() {
  const st = fs.statSync(CONFIG_FILE);
  if (st.mtimeMs !== configCache.mtime) {
    try {
      configCache = { mtime: st.mtimeMs, value: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    } catch (err) {
      console.error('[config] config.json is invalid JSON:', err.message);
      if (!configCache.value) throw err;
    }
  }
  return configCache.value;
}

/* ---------------------------------------------------------------- storage */

// Single process, so an in-memory version counter is enough to detect conflicts.
let version = 0;
const fileStorage = {
  async read() {
    if (!fs.existsSync(DB_FILE)) return { db: { bookings: [], blocks: [] }, version };
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { db: { bookings: parsed.bookings || [], blocks: parsed.blocks || [] }, version };
  },
  async write(db, expected) {
    if (expected !== version) return false;
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
    version++;
    return true;
  },
};

/* ------------------------------------------------------------ admin password */

function resolveAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return { value: process.env.ADMIN_PASSWORD, source: 'ADMIN_PASSWORD env var' };
  if (fs.existsSync(PASSWORD_FILE)) return { value: fs.readFileSync(PASSWORD_FILE, 'utf8').trim(), source: 'data/.admin-password' };
  const generated = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(PASSWORD_FILE, generated + '\n');
  return { value: generated, source: 'data/.admin-password (newly generated)' };
}
const ADMIN = resolveAdminPassword();

const handleApi = createApi({ getConfig, storage: fileStorage, adminPassword: ADMIN.value, log: console.log });

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
      res.writeHead(400).end('Bad request');
      return;
    }
  }
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      fs.readFile(path.join(PUBLIC_DIR, '404.html'), (e2, html) => {
        res.writeHead(404, { 'Content-Type': e2 ? 'text/plain' : MIME['.html'] });
        res.end(e2 ? 'Not found' : html);
      });
      return;
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

async function toWebRequest(req, url) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) break;
    chunks.push(c);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, { method: req.method, headers: req.headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const response = await handleApi(await toWebRequest(req, url), { ip: req.socket.remoteAddress || 'unknown' });
      const headers = Object.fromEntries(response.headers);
      const cookie = response.headers.getSetCookie();
      if (cookie.length) headers['set-cookie'] = cookie;
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error');
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
