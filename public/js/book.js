(function () {
  'use strict';
  const { api, esc, fmtTime, fmtRange, fmtDuration, fmtDate, getProfile, toast } = window.App;
  const $ = (s) => document.querySelector(s);
  const CUSTOM = '__custom';

  const state = { profile: null, month: null, minMonth: null, maxMonth: null, duration: null, date: null, time: null };

  const monthAdd = (ym, n) => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  };

  /* ---------------------------------------------------------- setup */

  getProfile().then(async (p) => {
    state.profile = p;
    const durations = p.availability.durations;
    state.duration = durations.includes(60) ? 60 : durations[0];

    $('#durations').innerHTML = durations
      .map((d) => `<button type="button" class="chip" data-duration="${d}" aria-pressed="${d === state.duration}">${fmtDuration(d)}</button>`)
      .join('');

    $('#f-type').innerHTML = p.formats.map((f) => `<option>${esc(f.name)}</option>`).join('');
    $('#f-topic-pick').innerHTML =
      '<option value="">Choose a topic…</option>' +
      p.topics.map((t) => `<option>${esc(t.title)}</option>`).join('') +
      `<option value="${CUSTOM}">Something else (describe it)</option>`;

    const wanted = new URLSearchParams(location.search).get('topic');
    if (wanted && p.topics.some((t) => t.title === wanted)) $('#f-topic-pick').value = wanted;

    const cal = await api('/api/calendar');
    state.month = state.minMonth = cal.month;
    const [y, m, d] = cal.today.split('-').map(Number);
    state.maxMonth = new Date(Date.UTC(y, m - 1, d + p.availability.maxAdvanceDays)).toISOString().slice(0, 7);
    renderCalendar(cal);
    updateSummary();
  });

  /* ---------------------------------------------------------- calendar */

  async function loadMonth() {
    $('#calendar').setAttribute('aria-busy', 'true');
    const cal = await api(`/api/calendar?month=${state.month}`);
    renderCalendar(cal);
  }

  function renderCalendar(cal) {
    $('#cal-title').textContent = fmtDate(cal.month + '-01', { month: 'long', year: 'numeric' });
    $('#prev-month').disabled = state.month <= state.minMonth;
    $('#next-month').disabled = state.month >= state.maxMonth;

    const dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const first = new Date(cal.month + '-01T00:00:00Z').getUTCDay(); // 0 = Sun
    const lead = (first + 6) % 7;
    const labels = { available: 'open', limited: 'some slots taken', full: 'fully booked', closed: 'unavailable' };

    let html = dows.map((d) => `<div class="cal-dow" aria-hidden="true">${d}</div>`).join('');
    html += '<div></div>'.repeat(lead);
    for (const [date, info] of Object.entries(cal.days)) {
      const day = Number(date.slice(8));
      const pickable = info.status === 'available' || info.status === 'limited';
      const cls = ['cal-day', info.status, date === state.date ? 'selected' : '', date === cal.today ? 'today' : ''].join(' ');
      html += `<button type="button" class="${cls}" data-date="${date}" ${pickable ? '' : 'disabled'}
        aria-label="${fmtDate(date)} — ${labels[info.status]}">${day}<span class="ind"></span></button>`;
    }
    $('#calendar').innerHTML = html;
    $('#calendar').removeAttribute('aria-busy');
  }

  $('#prev-month').addEventListener('click', () => {
    state.month = monthAdd(state.month, -1);
    loadMonth();
  });
  $('#next-month').addEventListener('click', () => {
    state.month = monthAdd(state.month, 1);
    loadMonth();
  });

  $('#calendar').addEventListener('click', (e) => {
    const btn = e.target.closest('.cal-day');
    if (!btn || btn.disabled) return;
    document.querySelectorAll('.cal-day.selected').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.date = btn.dataset.date;
    state.time = null;
    loadSlots();
    updateSummary();
  });

  $('#durations').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-duration]');
    if (!btn) return;
    state.duration = Number(btn.dataset.duration);
    document.querySelectorAll('#durations .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === btn)));
    if (state.date) loadSlots();
    updateSummary();
  });

  /* ---------------------------------------------------------- slots */

  async function loadSlots() {
    const panel = $('#slot-panel');
    panel.classList.remove('locked');
    $('#slot-hint').textContent = 'Loading…';
    $('#slots').innerHTML = '';
    const day = await api(`/api/day?date=${state.date}&duration=${state.duration}`);

    const free = day.slots.filter((s) => s.available);
    if (state.time && !free.some((s) => s.time === state.time)) state.time = null;

    if (!day.open || !day.slots.length) {
      $('#slot-hint').textContent = 'This date is not available.';
    } else if (!free.length) {
      $('#slot-hint').textContent = `No ${fmtDuration(state.duration)} slot fits on this day — try a shorter session or another date.`;
    } else {
      $('#slot-hint').textContent = `${fmtDate(state.date)} · ${free.length} start time${free.length > 1 ? 's' : ''} available for a ${fmtDuration(state.duration)} session`;
    }

    $('#slots').innerHTML = day.slots
      .map((s) => `<button type="button" class="slot" data-time="${s.time}" aria-pressed="${s.time === state.time}" ${s.available ? '' : 'disabled aria-label="' + fmtTime(s.time) + ' unavailable"'}>${fmtTime(s.time)}</button>`)
      .join('');

    // Day schedule: open hours + what's already on the calendar
    const tl = $('#timeline');
    tl.classList.toggle('hidden', !day.open);
    if (day.open) {
      const hours = day.windows.map((w) => `${fmtTime(w.start)} – ${fmtTime(w.end)}`).join(', ');
      const kinds = { booked: ['pill-booked', 'Booked'], hold: ['pill-hold', 'On hold'], busy: ['pill-busy', 'Unavailable'] };
      const rows = day.busy.map((b) => {
        const [cls, label] = kinds[b.kind];
        return `<div class="timeline-row"><span class="pill ${cls}">${label}</span><span>${fmtTime(b.start)} – ${fmtTime(b.end)}${b.label ? ' · ' + esc(b.label) : ''}</span></div>`;
      });
      tl.innerHTML =
        `<div class="small muted">My schedule on this day · available ${hours}</div>` +
        (rows.length ? rows.join('') : '<div class="timeline-row"><span class="pill pill-open">Free</span><span>Nothing booked yet</span></div>');
    }
    setFormLocked(!state.time);
    updateSummary();
  }

  $('#slots').addEventListener('click', (e) => {
    const btn = e.target.closest('.slot');
    if (!btn || btn.disabled) return;
    state.time = btn.dataset.time;
    document.querySelectorAll('.slot').forEach((s) => s.setAttribute('aria-pressed', String(s === btn)));
    setFormLocked(false);
    updateSummary();
    $('#form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function setFormLocked(locked) {
    $('#form-panel').classList.toggle('locked', locked);
  }

  /* ---------------------------------------------------------- form */

  $('#f-topic-pick').addEventListener('change', () => {
    const custom = $('#f-topic-pick').value === CUSTOM;
    $('#custom-topic-field').classList.toggle('hidden', !custom);
    if (custom) $('#f-topic').focus();
    updateSummary();
  });
  $('#f-topic').addEventListener('input', updateSummary);

  $('#f-mode').addEventListener('change', () => {
    const online = $('#f-mode').value === 'Online';
    $('#f-location-label').innerHTML = online ? 'Meeting link or platform <span class="opt">(optional)</span>' : 'Venue address';
    $('#f-location').placeholder = online ? 'Zoom / Google Meet / Teams — can be shared later' : 'Hall name, campus, city';
  });

  function topicValue() {
    const pick = $('#f-topic-pick').value;
    return pick === CUSTOM ? $('#f-topic').value.trim() : pick;
  }

  function updateSummary() {
    const ph = (t) => `<span class="placeholder">${t}</span>`;
    $('#sum-date').innerHTML = state.date ? esc(fmtDate(state.date)) : ph('Not selected');
    $('#sum-time').innerHTML = state.time ? esc(fmtRange(state.time, state.duration)) : ph('Not selected');
    $('#sum-duration').textContent = state.duration ? fmtDuration(state.duration) : '';
    $('#sum-topic').innerHTML = topicValue() ? esc(topicValue()) : ph('—');
  }

  function clearErrors() {
    $('#form-alert').innerHTML = '';
    document.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
    document.querySelectorAll('.field-error').forEach((f) => f.remove());
  }

  function showFieldError(name, msg) {
    const input = name === 'topic' && $('#f-topic-pick').value !== CUSTOM ? $('#f-topic-pick') : document.querySelector(`[name="${name}"]`);
    if (!input) return false;
    const field = input.closest('.field');
    field.classList.add('invalid');
    field.insertAdjacentHTML('beforeend', `<div class="field-error">${esc(msg)}</div>`);
    return true;
  }

  $('#booking-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    if (!state.date || !state.time) {
      $('#form-alert').innerHTML = '<div class="alert alert-error">Pick a date and a start time first.</div>';
      return;
    }
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const payload = { ...fd, topic: topicValue(), date: state.date, startTime: state.time, duration: state.duration };

    const btn = $('#submit-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await api('/api/bookings', { method: 'POST', body: payload });
      showSuccess(res, payload);
    } catch (err) {
      const fields = err.data && err.data.fields;
      let first;
      if (fields) {
        for (const [k, msg] of Object.entries(fields)) if (showFieldError(k, msg) && !first) first = k;
      }
      $('#form-alert').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      if (err.status === 409) {
        state.time = null;
        await loadSlots();
        loadMonth();
        $('#slot-panel').scrollIntoView({ behavior: 'smooth' });
        toast('That slot was just taken — please pick another');
      } else {
        $('#form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send booking request';
    }
  });

  function showSuccess(res, payload) {
    $('#booking-area').classList.add('hidden');
    document.querySelector('.page-head').classList.add('hidden');
    const box = $('#success');
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="success-icon">✓</div>
      <h2>Request sent — your slot is on hold</h2>
      <p class="muted">${esc(fmtDate(res.date))} · ${esc(fmtRange(res.startTime, res.duration))} (${esc(state.profile.availability.timezoneLabel)})<br/>${esc(payload.topic)} · ${esc(payload.organization)}</p>
      <div>Your booking reference</div>
      <div class="ref">${esc(res.ref)}</div>
      <p class="muted small">Save this reference. Use it with your email (${esc(payload.email)}) to check whether the booking is confirmed.</p>
      <div class="hero-cta center">
        <a class="btn btn-dark" href="/status?ref=${encodeURIComponent(res.ref)}">Check status</a>
        <a class="btn btn-ghost" href="/">Back to home</a>
      </div>`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
})();
