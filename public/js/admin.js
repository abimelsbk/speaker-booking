(function () {
  'use strict';
  const { api, esc, fmtDate, fmtRange, fmtDuration, toast, getProfile } = window.App;
  const $ = (s) => document.querySelector(s);

  const state = { bookings: [], blocks: [], today: '', tab: 'pending', q: '', current: null, durations: [] };

  getProfile().then((p) => (state.durations = p.availability.durations));

  /* ---------------------------------------------------------- auth */

  async function boot() {
    try {
      await api('/api/admin/me');
      showDash();
    } catch {
      $('#login').classList.remove('hidden');
      $('#pw').focus();
    }
  }

  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-alert').innerHTML = '';
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } });
      $('#pw').value = '';
      $('#login').classList.add('hidden');
      showDash();
    } catch (err) {
      $('#login-alert').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST', body: {} });
    location.reload();
  });

  async function showDash() {
    $('#dash').classList.remove('hidden');
    $('#logout').classList.remove('hidden');
    await refresh();
  }

  async function refresh() {
    const [b, bl] = await Promise.all([api('/api/admin/bookings'), api('/api/admin/blocks')]);
    state.bookings = b.bookings;
    state.today = b.today;
    state.blocks = bl.blocks;
    render();
  }

  /* ---------------------------------------------------------- views */

  const groups = {
    pending: (b) => b.status === 'pending',
    upcoming: (b) => b.status === 'confirmed' && b.date >= state.today,
    past: (b) => !(b.status === 'pending' || (b.status === 'confirmed' && b.date >= state.today)),
  };

  function matches(b) {
    if (!state.q) return true;
    const hay = [b.ref, b.name, b.email, b.organization, b.topic, b.eventType, b.location].join(' ').toLowerCase();
    return hay.includes(state.q);
  }

  function render() {
    const upcoming = state.bookings.filter(groups.upcoming);
    const thisMonth = state.bookings.filter((b) => b.status === 'confirmed' && b.date.slice(0, 7) === state.today.slice(0, 7));
    const reached = state.bookings
      .filter((b) => b.status === 'completed' || (b.status === 'confirmed' && b.date < state.today))
      .reduce((n, b) => n + (parseInt(b.audienceSize, 10) || 0), 0);

    $('#kpis').innerHTML = [
      [state.bookings.filter(groups.pending).length, 'Awaiting review'],
      [upcoming.length, 'Upcoming confirmed'],
      [thisMonth.length, 'Talks this month'],
      [reached.toLocaleString('en-IN'), 'Audience reached'],
    ]
      .map(([v, l]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`)
      .join('');

    for (const k of Object.keys(groups)) {
      const n = state.bookings.filter(groups[k]).length;
      document.querySelector(`[data-count="${k}"]`).textContent = n || '';
    }
    document.querySelector('[data-count="blocks"]').textContent = state.blocks.filter((b) => b.date >= state.today).length || '';

    const isBlocks = state.tab === 'blocks';
    $('#list').classList.toggle('hidden', isBlocks);
    $('#blocks-view').classList.toggle('hidden', !isBlocks);
    $('#search').classList.toggle('hidden', isBlocks);
    if (isBlocks) return renderBlocks();

    let items = state.bookings.filter(groups[state.tab]).filter(matches);
    if (state.tab === 'past') items = items.reverse(); // most recent first

    if (!items.length) {
      const empty = { pending: 'No requests waiting. 🎉', upcoming: 'No confirmed upcoming talks yet.', past: 'Nothing here yet.' };
      $('#list').innerHTML = `<div class="empty">${state.q ? 'No matches.' : empty[state.tab]}</div>`;
      return;
    }

    $('#list').innerHTML = items
      .map(
        (b) => `
      <article class="bk ${b.date < state.today ? 'past' : ''}">
        <div class="bk-when">
          <div class="d">${esc(fmtDate(b.date, { day: 'numeric', month: 'short' }))}</div>
          <div class="t">${esc(fmtDate(b.date, { weekday: 'short', year: 'numeric' }))}</div>
          <div class="t">${esc(fmtRange(b.startTime, b.duration))}</div>
        </div>
        <div>
          <h4>${esc(b.topic)}</h4>
          <div class="bk-meta">
            <span>🏛 ${esc(b.organization)}</span>
            <span>👤 ${esc(b.name)}</span>
            <span>🎤 ${esc(b.eventType)}</span>
            <span>📍 ${esc(b.mode)}</span>
            ${b.audienceSize ? `<span>👥 ${esc(b.audienceSize)}</span>` : ''}
            <span class="muted">${esc(b.ref)}</span>
          </div>
        </div>
        <div class="bk-actions">
          <span class="badge badge-${esc(b.status)}">${esc(b.status)}</span>
          <div class="row">
            ${b.status === 'pending' ? `<button class="btn btn-primary btn-sm" data-act="confirmed" data-id="${b.id}">Confirm</button><button class="btn btn-ghost btn-sm" data-act="declined" data-id="${b.id}">Decline</button>` : ''}
            ${b.status === 'confirmed' && b.date < state.today ? `<button class="btn btn-ghost btn-sm" data-act="completed" data-id="${b.id}">Mark done</button>` : ''}
            <button class="btn btn-ghost btn-sm" data-open="${b.id}">Details</button>
          </div>
        </div>
      </article>`,
      )
      .join('');
  }

  function renderBlocks() {
    const items = state.blocks.filter((b) => b.date >= state.today);
    $('#block-list').innerHTML = items.length
      ? items
          .map(
            (b) => `
        <article class="bk">
          <div class="bk-when">
            <div class="d">${esc(fmtDate(b.date, { day: 'numeric', month: 'short' }))}</div>
            <div class="t">${esc(fmtDate(b.date, { weekday: 'short', year: 'numeric' }))}</div>
          </div>
          <div><h4>${b.startTime ? esc(`${App.fmtTime(b.startTime)} – ${App.fmtTime(b.endTime)}`) : 'Whole day'}</h4><div class="bk-meta">${esc(b.reason || 'No note')}</div></div>
          <div class="bk-actions"><button class="btn btn-ghost btn-sm" data-unblock="${b.id}">Remove</button></div>
        </article>`,
          )
          .join('')
      : '<div class="empty">No upcoming blocked time.</div>';
  }

  /* ---------------------------------------------------------- events */

  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    state.tab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    render();
  });

  $('#search').addEventListener('input', (e) => {
    state.q = e.target.value.trim().toLowerCase();
    render();
  });

  async function patch(id, body) {
    try {
      const { booking } = await api(`/api/admin/bookings/${id}`, { method: 'PATCH', body });
      Object.assign(state.bookings.find((b) => b.id === id), booking);
      render();
      return booking;
    } catch (err) {
      if (err.data && err.data.canForce && confirm(`${err.message}\n\nSave anyway?`)) return patch(id, { ...body, force: true });
      toast(err.message);
      throw err;
    }
  }

  $('#list').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      try {
        await patch(act.dataset.id, { status: act.dataset.act });
        toast(`Booking ${act.dataset.act}`);
      } catch {
        /* toast already shown */
      }
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) openDialog(open.dataset.open);
  });

  /* ---------------------------------------------------------- detail dialog */

  function openDialog(id) {
    const b = state.bookings.find((x) => x.id === id);
    state.current = b;
    $('#dlg-title').textContent = `${b.ref} · ${b.topic}`;
    const opt = (v, cur, label = v) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;
    const durations = [...new Set([...state.durations, b.duration])].sort((x, y) => x - y);
    const mail = `mailto:${b.email}?subject=${encodeURIComponent(`Your talk booking ${b.ref} — ${b.topic}`)}`;

    $('#dlg-body').innerHTML = `
      <dl class="detail-grid">
        <dt>Requested by</dt><dd>${esc(b.name)} (${esc(b.role || '—')})</dd>
        <dt>Email</dt><dd><a href="${esc(mail)}">${esc(b.email)}</a></dd>
        <dt>Phone</dt><dd>${esc(b.phone || '—')}</dd>
        <dt>Organisation</dt><dd>${esc(b.organization)}</dd>
        <dt>Event type</dt><dd>${esc(b.eventType)}</dd>
        <dt>Format</dt><dd>${esc(b.mode)}</dd>
        <dt>${b.mode === 'Online' ? 'Link' : 'Venue'}</dt><dd>${esc(b.location || '—')}</dd>
        <dt>Audience</dt><dd>${esc([b.audienceSize, b.audienceType].filter(Boolean).join(' · ') || '—')}</dd>
        <dt>Notes</dt><dd>${esc(b.description || '—')}</dd>
        <dt>Requested on</dt><dd>${esc(new Date(b.createdAt).toLocaleString('en-IN'))}</dd>
      </dl>
      <div class="form-grid">
        <div class="field"><label for="d-status">Status</label><select class="input" id="d-status">
          ${['pending', 'confirmed', 'declined', 'cancelled', 'completed'].map((s) => opt(s, b.status, s[0].toUpperCase() + s.slice(1))).join('')}
        </select></div>
        <div class="field"><label for="d-duration">Length</label><select class="input" id="d-duration">${durations.map((d) => opt(d, b.duration, fmtDuration(d))).join('')}</select></div>
        <div class="field"><label for="d-date">Date</label><input class="input" type="date" id="d-date" value="${esc(b.date)}" /></div>
        <div class="field"><label for="d-time">Start time</label><input class="input" type="time" id="d-time" value="${esc(b.startTime)}" step="900" /></div>
        <div class="field full"><label for="d-note">Message to requester <span class="opt">(shown on their status page)</span></label><textarea class="input" id="d-note" placeholder="e.g. Confirmed! Please share the hall details a week before.">${esc(b.adminNote)}</textarea></div>
        <label class="check full"><input type="checkbox" id="d-public" ${b.showPublicly ? 'checked' : ''} /> Show on the public “Upcoming talks” list (topic, organisation and time only)</label>
      </div>`;
    $('#dlg').showModal();
  }

  $('#dlg-save').addEventListener('click', async () => {
    const b = state.current;
    try {
      await patch(b.id, {
        status: $('#d-status').value,
        duration: Number($('#d-duration').value),
        date: $('#d-date').value,
        startTime: $('#d-time').value,
        adminNote: $('#d-note').value,
        showPublicly: $('#d-public').checked,
      });
      $('#dlg').close();
      toast('Saved');
    } catch {
      /* toast already shown */
    }
  });

  $('#dlg-delete').addEventListener('click', async () => {
    const b = state.current;
    if (!confirm(`Delete booking ${b.ref} permanently? Consider marking it cancelled instead.`)) return;
    await api(`/api/admin/bookings/${b.id}`, { method: 'DELETE' });
    state.bookings = state.bookings.filter((x) => x.id !== b.id);
    $('#dlg').close();
    render();
    toast('Deleted');
  });

  /* ---------------------------------------------------------- blocks */

  $('#block-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#block-alert').innerHTML = '';
    try {
      await api('/api/admin/blocks', {
        method: 'POST',
        body: {
          date: $('#b-date').value,
          endDate: $('#b-end').value,
          startTime: $('#b-start').value,
          endTime: $('#b-stop').value,
          reason: $('#b-reason').value,
        },
      });
      e.target.reset();
      await refresh();
      toast('Time blocked');
    } catch (err) {
      $('#block-alert').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  });

  $('#block-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-unblock]');
    if (!btn) return;
    await api(`/api/admin/blocks/${btn.dataset.unblock}`, { method: 'DELETE' });
    await refresh();
    toast('Block removed');
  });

  boot();
})();
