(function () {
  'use strict';
  const { api, esc, fmtDate, fmtRange, getProfile } = window.App;
  const $ = (s) => document.querySelector(s);

  getProfile().then((p) => {
    if (p.photo) {
      const img = new Image();
      img.alt = p.name;
      img.src = p.photo;
      img.onload = () => {
        $('#portrait .initials').remove();
        $('#portrait').prepend(img);
      };
    }

    $('#stats').innerHTML = (p.stats || [])
      .map((s) => `<div class="stat"><div class="stat-value">${esc(s.value)}</div><div class="stat-label">${esc(s.label)}</div></div>`)
      .join('');

    $('#socials').innerHTML = [
      ...(p.contactEmail ? [`<a class="btn btn-ghost btn-sm" href="mailto:${esc(p.contactEmail)}">Email me</a>`] : []),
      ...(p.socials || []).map((s) => `<a class="btn btn-ghost btn-sm" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a>`),
    ].join('');

    $('#topic-grid').innerHTML = (p.topics || [])
      .map(
        (t, i) => `
        <article class="card topic-card reveal">
          <div class="topic-num">${String(i + 1).padStart(2, '0')}</div>
          <h3>${esc(t.title)}</h3>
          <p>${esc(t.description)}</p>
          <div class="tags">${(t.tags || []).map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</div>
          <a class="link" href="/book?topic=${encodeURIComponent(t.title)}">Book this talk →</a>
        </article>`,
      )
      .join('');

    $('#formats').innerHTML = (p.formats || [])
      .map((f) => `<div class="format"><h4>${esc(f.name)}</h4><p>${esc(f.description)}</p></div>`)
      .join('');

    $('#quotes').innerHTML = (p.testimonials || [])
      .map((q) => `<figure class="card quote reveal"><blockquote>${esc(q.quote)}</blockquote><cite>${esc(q.name)}</cite><span class="muted small">${esc(q.role)}</span></figure>`)
      .join('');
    if (!(p.testimonials || []).length) $('#testimonials').remove();

    $('#faq-list').innerHTML = (p.faqs || [])
      .map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`)
      .join('');

    observeReveals();
  });

  // Upcoming public talks
  api('/api/events')
    .then(({ events }) => {
      const box = $('#events');
      if (!events.length) {
        box.innerHTML = '<div class="empty">No public talks listed right now — the calendar is open for bookings.</div>';
        return;
      }
      box.innerHTML = events
        .map((e) => {
          const d = window.App.parseDate(e.date);
          return `
          <div class="event">
            <div class="event-date">
              <div class="d">${d.getUTCDate()}</div>
              <div class="m">${fmtDate(e.date, { month: 'short' })}</div>
            </div>
            <div>
              <h4>${esc(e.topic)}</h4>
              <div class="muted small">${esc(e.organization)} · ${esc(e.eventType)} · ${fmtRange(e.startTime, e.duration)}</div>
            </div>
            <span class="tag">${esc(e.mode)}</span>
          </div>`;
        })
        .join('');
    })
    .catch(() => ($('#events').innerHTML = '<div class="empty">Schedule unavailable right now.</div>'));

  // "Next open date" teaser in the hero card: look at this month, then next.
  (async function nextOpen() {
    const el = $('#next-open');
    try {
      const first = await api('/api/calendar');
      const [y, m] = first.month.split('-').map(Number);
      const nextMonth = `${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, '0')}`;
      const months = [first, await api(`/api/calendar?month=${nextMonth}`)];
      for (const cal of months) {
        const hit = Object.entries(cal.days).find(([, v]) => v.status === 'available' || v.status === 'limited');
        if (hit) {
          el.textContent = `Next open date: ${fmtDate(hit[0], { weekday: 'short', day: 'numeric', month: 'short' })}`;
          return;
        }
      }
      el.textContent = 'Calendar is busy — check later dates';
    } catch {
      el.textContent = 'See the live calendar';
    }
  })();

  function observeReveals() {
    const els = document.querySelectorAll('.reveal:not(.in)');
    if (!('IntersectionObserver' in window)) return els.forEach((e) => e.classList.add('in'));
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      }),
      { threshold: 0.12 },
    );
    els.forEach((e) => io.observe(e));
  }
  observeReveals();
})();
