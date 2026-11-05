(function () {
  'use strict';
  const { api, esc, fmtDate, fmtRange } = window.App;
  const $ = (s) => document.querySelector(s);

  const MESSAGES = {
    pending: 'Your request is holding the slot and waiting for review.',
    confirmed: 'Confirmed — see you there!',
    declined: 'Unfortunately this request could not be accepted.',
    cancelled: 'This booking was cancelled.',
    completed: 'This session has taken place. Thank you for hosting!',
  };

  const ref = new URLSearchParams(location.search).get('ref');
  if (ref) {
    $('#ref').value = ref;
    $('#email').focus();
  }

  $('#lookup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('#result');
    const q = new URLSearchParams({ ref: $('#ref').value.trim(), email: $('#email').value.trim() });
    try {
      const b = await api(`/api/bookings/lookup?${q}`);
      out.innerHTML = `
        <div class="panel">
          <div class="toolbar"><h3>${esc(b.topic)}</h3><span class="badge badge-${esc(b.status)}">${esc(b.status)}</span></div>
          <p>${esc(MESSAGES[b.status] || '')}</p>
          <dl class="detail-grid">
            <dt>Reference</dt><dd>${esc(b.ref)}</dd>
            <dt>Organisation</dt><dd>${esc(b.organization)}</dd>
            <dt>Date</dt><dd>${esc(fmtDate(b.date))}</dd>
            <dt>Time</dt><dd>${esc(fmtRange(b.startTime, b.duration))}</dd>
            ${b.adminNote ? `<dt>Message</dt><dd>${esc(b.adminNote)}</dd>` : ''}
          </dl>
        </div>`;
    } catch (err) {
      out.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  });
})();
