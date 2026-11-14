(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat('en');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS_KEY = 'fj_signed';

  let countries = {};                       // ISO code -> name (allowlist)
  let stats = { total: 0, countries: Object.create(null), updated: null };
  let features = [];
  let globe = null;
  let hovered = null;
  let mine = null;                          // viewer's detected country
  let sitekey = null;
  let tsWidget = null;
  let tsToken = null;
  let tsWaiters = [];
  let tsErr = '';
  let tsInteractive = false;
  let submitting = false;

  // ---------- colour scale: more signatures = more green ----------
  const STOPS = [[0, [43, 67, 0]], [0.55, [118, 185, 0]], [1, [200, 255, 74]]];
  function heat(n, max) {
    if (!n) return '#262626';
    const t = max <= 1 ? 1 : Math.log1p(n) / Math.log1p(max);
    for (let i = 1; i < STOPS.length; i++) {
      const [t1, c1] = STOPS[i];
      const [t0, c0] = STOPS[i - 1];
      if (t <= t1) {
        const k = (t - t0) / (t1 - t0);
        const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
      }
    }
    return 'rgb(200,255,74)';
  }
  const maxCount = () => Math.max(0, ...Object.values(stats.countries));
  const countOf = (code) => stats.countries[code] || 0;
  const nameOf = (code) => (code && Object.prototype.hasOwnProperty.call(countries, code) ? countries[code] : null);

  // ---------- stats intake (strictly validated) ----------
  function ingest(s) {
    if (!s || !Number.isSafeInteger(s.total) || s.total < 0 || !s.countries || typeof s.countries !== 'object') return;
    const clean = Object.create(null);
    for (const [code, n] of Object.entries(s.countries)) {
      if (nameOf(code) && Number.isSafeInteger(n) && n > 0) clean[code] = n;
    }
    const updated = typeof s.updated === 'string' && !Number.isNaN(Date.parse(s.updated)) ? s.updated : null;
    const grew = stats.total && s.total > stats.total;
    stats = { total: s.total, countries: clean, updated };
    renderStats(grew);
  }

  // ---------- globe ----------
  function centroid(f) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let best = polys[0][0];
    for (const p of polys) if (p[0].length > best.length) best = p[0];
    let x = 0, y = 0;
    for (const [lng, lat] of best) { x += lng; y += lat; }
    return { lng: x / best.length, lat: y / best.length };
  }
  function focusCountry(code, ms = 1400) {
    if (!globe || !code) return;
    const f = features.find((ft) => ft.properties.c === code);
    if (f) globe.pointOfView({ ...centroid(f), altitude: 2.0 }, ms);
  }
  function capColor(f) {
    if (f === hovered) return '#e8ffb8';
    return heat(countOf(f.properties.c), maxCount());
  }
  function altitude(f) {
    const n = countOf(f.properties.c);
    const max = maxCount();
    const t = n && max ? Math.log1p(n) / Math.log1p(max) : 0;
    return 0.008 + t * 0.07 + (f === hovered ? 0.012 : 0);
  }
  function refreshGlobe() {
    if (!globe) return;
    globe.polygonCapColor(capColor).polygonAltitude(altitude)
      .polygonStrokeColor((f) => (f.properties.c === mine ? '#ffffff' : '#000000'));
  }
  function initGlobe() {
    const el = $('globe');
    if (typeof window.Globe !== 'function') throw new Error('globe library missing');
    globe = window.Globe()(el)
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true).atmosphereColor('#76b900').atmosphereAltitude(0.2)
      .showGraticules(true)
      .polygonsData(features)
      .polygonSideColor(() => 'rgba(118,185,0,0.22)')
      .polygonsTransitionDuration(600)
      .polygonLabel((f) => {
        const n = countOf(f.properties.c);
        return `<div class="globe-tip"><b>${esc(nameOf(f.properties.c) || f.properties.n)}</b><span>${fmt.format(n)}</span> signature${n === 1 ? '' : 's'}</div>`;
      })
      .onPolygonHover((f) => { hovered = f || null; el.style.cursor = f ? 'pointer' : ''; refreshGlobe(); })
      .onPolygonClick((f) => { globe.controls().autoRotate = false; focusCountry(f.properties.c, 900); });

    const mat = globe.globeMaterial();
    mat.color.set('#070707');
    if (mat.emissive) mat.emissive.set('#050805');
    if ('shininess' in mat) mat.shininess = 6;

    const c = globe.controls();
    c.autoRotate = true; c.autoRotateSpeed = 0.45;
    c.minDistance = 160; c.maxDistance = 520;
    globe.pointOfView({ lat: 25, lng: -30, altitude: 2.3 }, 0);

    const size = () => globe.width(el.clientWidth).height(el.clientHeight || el.clientWidth);
    size();
    new ResizeObserver(size).observe(el);
    refreshGlobe();
  }

  // ---------- render ----------
  let shownTotal = 0;
  function animateTotal(to) {
    const from = shownTotal;
    shownTotal = to;
    if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { $('total').textContent = fmt.format(to); return; }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 700);
      $('total').textContent = fmt.format(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderStats(grew) {
    animateTotal(stats.total);
    if (grew) {
      const c = document.querySelector('.counter-main');
      c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump');
    }
    const entries = Object.entries(stats.countries).sort((a, b) => b[1] - a[1]);
    $('ncountries').textContent = fmt.format(entries.length);
    if (stats.updated) {
      $('updated').textContent = `Last signature ${new Date(stats.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
    }
    const board = $('board');
    board.replaceChildren();
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'board-empty';
      li.textContent = 'No signatures yet. Be the first.';
      board.append(li);
    } else {
      const top = entries[0][1];
      entries.slice(0, 12).forEach(([code, n], i) => {
        const li = document.createElement('li');
        if (code === mine) li.className = 'is-mine';
        const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = String(i + 1).padStart(2, '0');
        const name = document.createElement('span'); name.className = 'name'; name.textContent = nameOf(code);
        const count = document.createElement('span'); count.className = 'count'; count.textContent = fmt.format(n);
        const bar = document.createElement('span'); bar.className = 'bar';
        const fill = document.createElement('i'); fill.style.width = `${Math.max(2, (n / top) * 100)}%`;
        bar.append(fill);
        li.append(rank, name, count, bar);
        board.append(li);
      });
    }
    refreshGlobe();
  }

  // ---------- live updates: SSE, with polling fallback ----------
  function setLive(on) { $('live-dot').classList.toggle('on', on); }
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { if (!document.hidden) refreshStats(); }, 20000);
  }
  function startLive() {
    if (!('EventSource' in window)) { startPolling(); return; }
    let es = null;
    let failures = 0;
    const open = () => {
      es = new EventSource('/api/live');
      es.onopen = () => { failures = 0; setLive(true); };
      es.onmessage = (e) => { try { ingest(JSON.parse(e.data)); } catch (_) {} };
      es.onerror = () => {
        setLive(false);
        if (++failures >= 4) { es.close(); startPolling(); }
      };
    };
    open();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { es && es.close(); setLive(false); }
      else if (!es || es.readyState === 2) { failures = 0; open(); refreshStats(); }
    });
  }

  async function refreshStats() {
    try {
      const r = await fetch('/api/stats', { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      const s = await r.json();
      ingest(s);
      return s;
    } catch (_) {
      return null;
    }
  }

  // ---------- signing ----------
  function setButton(label, enabled) {
    $('sign-label').textContent = label;
    $('sign-btn').disabled = !enabled;
  }
  function showError(msg) {
    const el = $('sign-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }
  function showSigned(sub) {
    $('sign-form').hidden = true;
    $('signed').hidden = false;
    if (sub) $('signed-sub').textContent = sub;
  }

  window.fjTurnstileReady = () => { if (sitekey) renderTurnstile(); };
  function renderTurnstile() {
    if (tsWidget !== null || !window.turnstile || !sitekey || !$('sign-form') || $('sign-form').hidden) return;
    tsWidget = window.turnstile.render('#turnstile', {
      sitekey,
      action: 'sign',
      theme: 'dark',
      appearance: 'interaction-only',
      callback: (t) => { tsToken = t; tsWaiters.splice(0).forEach((fn) => fn(t)); if (!submitting) setButton('Sign the petition', true); },
      'expired-callback': () => { tsToken = null; },
      'before-interactive-callback': () => {
        tsInteractive = true;
        setButton('Tick "Verify you are human" above', false);
        $('turnstile').scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
      'after-interactive-callback': () => { tsInteractive = false; },
      'error-callback': (code) => { tsToken = null; tsErr = String(code || '').replace(/[^0-9a-z]/gi, '').slice(0, 12); tsWaiters.splice(0).forEach((fn) => fn(null)); if (!submitting) setButton('Sign the petition', true); return true; },
    });
    if (!submitting) setButton('Sign the petition', true);
  }
  function waitForToken(ms) {
    if (tsToken) return Promise.resolve(tsToken);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      tsWaiters.push((tok) => { clearTimeout(t); resolve(tok); });
    });
  }

  async function sign() {
    if (submitting) return;
    submitting = true;
    showError('');
    setButton(tsInteractive ? 'Tick "Verify you are human" above' : "Verifying you're human…", false);
    try {
      const token = await waitForToken(180000);
      if (!token) throw Object.assign(new Error(), { userMsg: `We couldn't verify you're human. Please refresh and try again.${tsErr ? ` (code ${tsErr})` : ''}` });
      setButton('Signing…', false);
      const r = await fetch('/api/sign', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, consent: true, reason: $('reason').value.slice(0, 280) }),
      });
      tsToken = null; // single-use
      let d = {};
      try { d = await r.json(); } catch (_) {}
      if (r.ok && d.ok) {
        try { localStorage.setItem(LS_KEY, '1'); } catch (_) {}
        const where = nameOf(d.country);
        showSigned(`You're signature #${fmt.format(d.number)}${where ? ` from ${where}` : ''}. Watch the map light up.`);
        if (d.country) focusCountry(d.country);
        refreshStats();
        return;
      }
      if (d.error === 'already_signed') {
        try { localStorage.setItem(LS_KEY, '1'); } catch (_) {}
        showSigned('You already signed from this browser.');
        return;
      }
      throw Object.assign(new Error(), { userMsg: d.message || 'Something went wrong. Please try again.' });
    } catch (e) {
      showError(e.userMsg || 'Network error. Please check your connection and try again.');
      if (window.turnstile && tsWidget !== null) window.turnstile.reset(tsWidget);
      setButton('Sign the petition', true);
    } finally {
      submitting = false;
    }
  }

  // ---------- boot ----------
  async function boot() {
    $('reason').addEventListener('input', (e) => { $('reason-count').textContent = String([...e.target.value].length); });
    $('sign-btn').addEventListener('click', sign);

    const [cRes, gRes] = await Promise.all([fetch('countries.json'), fetch('countries.geojson')]);
    countries = await cRes.json();
    features = (await gRes.json()).features;

    try { initGlobe(); } catch (_) {
      $('globe').hidden = true;
      document.querySelector('.legend').hidden = true;
      $('globe-fallback').hidden = false;
    }

    const s = await refreshStats();
    if (s && s.you) {
      mine = typeof s.you.country === 'string' && nameOf(s.you.country) ? s.you.country : null;
      $('where').textContent = mine ? nameOf(mine) : 'an undetected location';
      if (mine) { focusCountry(mine, 1800); refreshGlobe(); }
      if (s.you.signed) showSigned('You already signed from this browser. Thank you!');
    } else {
      $('where').textContent = 'your location';
    }
    if (s && typeof s.sitekey === 'string' && /^[0-9A-Za-z_-]{10,64}$/.test(s.sitekey)) {
      sitekey = s.sitekey;
      renderTurnstile();
    } else if (!s) {
      setButton('Temporarily unavailable', false);
      showError('The petition server is unreachable right now. Please try again shortly.');
    }
    startLive();
  }

  boot();
})();
