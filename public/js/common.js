/* Shared helpers for every page. */
(function () {
  'use strict';

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, init);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  function fmtTime(t) {
    const m = typeof t === 'number' ? t : toMin(t);
    const h = Math.floor(m / 60) % 24;
    const mm = String(m % 60).padStart(2, '0');
    return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
  }

  function fmtRange(start, duration) {
    return `${fmtTime(start)} – ${fmtTime(toMin(start) + Number(duration))}`;
  }

  function fmtDuration(min) {
    min = Number(min);
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${m} min` : `${h} hour${h > 1 ? 's' : ''}`;
  }

  // Dates are YYYY-MM-DD in the speaker's timezone; render them without shifting.
  function parseDate(d) {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, day));
  }
  function fmtDate(d, opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) {
    return new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: 'UTC' }).format(parseDate(d));
  }

  let profilePromise;
  function getProfile() {
    profilePromise = profilePromise || api('/api/profile');
    return profilePromise;
  }

  // Fill simple text slots: <span data-p="name"></span>
  function fillProfileText(profile) {
    document.querySelectorAll('[data-p]').forEach((el) => {
      const v = el.dataset.p.split('.').reduce((o, k) => (o ? o[k] : undefined), profile);
      if (v !== undefined && v !== null) el.textContent = v;
    });
    if (document.body.dataset.titleSuffix) document.title = `${profile.name} — ${document.body.dataset.titleSuffix}`;
  }

  let toastTimer;
  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // Sticky nav border once the page scrolls
  const nav = document.querySelector('.nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = new Date().getFullYear()));

  getProfile().then(fillProfileText).catch(() => {});

  window.App = { api, esc, toMin, fmtTime, fmtRange, fmtDuration, fmtDate, parseDate, getProfile, toast };
})();
