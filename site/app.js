(() => {
  'use strict';

  const REPO = '0xSero/free-jensen';
  const POLL_MS = 60_000;

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat('en');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let countries = {};          // code -> name
  let stats = { total: 0, countries: Object.create(null), updated: null };
  let features = [];
  let globe = null;
  let hovered = null;
  let selected = null;

  $('repo-link').href = `https://github.com/${REPO}`;

  // ---------- colour scale: more signatures = more green ----------
  const STOPS = [
    [0.00, [43, 67, 0]],     // deep olive
    [0.55, [118, 185, 0]],   // brand green
    [1.00, [200, 255, 74]],  // electric lime
  ];
  const ZERO = '#262626';
  function heat(n, max) {
    if (!n) return ZERO;
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

  // ---------- country picker + sign link ----------
  function guessCountry() {
    const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    for (const l of langs) {
      const m = /[-_]([A-Za-z]{2})$/.exec(l);
      if (m && countries[m[1].toUpperCase()]) return m[1].toUpperCase();
    }
    return '';
  }

  function updateSignLink() {
    const code = $('country').value;
    const btn = $('sign-btn');
    if (!code) {
      btn.setAttribute('aria-disabled', 'true');
      btn.href = '#';
      return;
    }
    btn.removeAttribute('aria-disabled');
    const p = new URLSearchParams({ template: 'sign.yml', title: 'Signature', country: code });
    btn.href = `https://github.com/${REPO}/issues/new?${p}`;
  }

  function buildPicker() {
    const sel = $('country');
    const ph = new Option('Select your country…', '');
    ph.disabled = true;
    sel.add(ph);
    for (const [code, name] of Object.entries(countries)) sel.add(new Option(name, code));
    const g = guessCountry();
    sel.value = g;
    if (!g) ph.selected = true;
    sel.addEventListener('change', () => {
      updateSignLink();
      focusCountry(sel.value);
    });
    $('sign-form').addEventListener('submit', (e) => e.preventDefault());
    updateSignLink();
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

  function focusCountry(code) {
    selected = code || null;
    if (!globe) return;
    const f = features.find((ft) => ft.properties.c === code);
    if (f) {
      globe.controls().autoRotate = false;
      globe.pointOfView({ ...centroid(f), altitude: 1.9 }, 1200);
    }
    refreshGlobe();
  }

  function capColor(f) {
    const code = f.properties.c;
    if (f === hovered) return '#e8ffb8';
    return heat(countOf(code), maxCount());
  }
  function altitude(f) {
    const n = countOf(f.properties.c);
    const max = maxCount();
    const t = n && max ? Math.log1p(n) / Math.log1p(max) : 0;
    let a = 0.008 + t * 0.07;
    if (f === hovered) a += 0.012;
    return a;
  }

  function refreshGlobe() {
    if (!globe) return;
    globe
      .polygonCapColor(capColor)
      .polygonAltitude(altitude)
      .polygonStrokeColor((f) => (f.properties.c === selected ? '#ffffff' : '#000000'));
  }

  function initGlobe() {
    const el = $('globe');
    if (typeof window.Globe !== 'function') throw new Error('globe library missing');
    globe = window.Globe()(el)
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true)
      .atmosphereColor('#76b900')
      .atmosphereAltitude(0.2)
      .showGraticules(true)
      .polygonsData(features)
      .polygonSideColor(() => 'rgba(118,185,0,0.22)')
      .polygonsTransitionDuration(600)
      .polygonLabel((f) => {
        const n = countOf(f.properties.c);
        const name = countries[f.properties.c] || f.properties.n;
        return `<div class="globe-tip"><b>${esc(name)}</b><span>${fmt.format(n)}</span> signature${n === 1 ? '' : 's'}</div>`;
      })
      .onPolygonHover((f) => {
        hovered = f || null;
        el.style.cursor = f ? 'pointer' : '';
        refreshGlobe();
      })
      .onPolygonClick((f) => {
        const code = f.properties.c;
        if (countries[code]) {
          $('country').value = code;
          updateSignLink();
          focusCountry(code);
        }
      });

    const mat = globe.globeMaterial();
    mat.color.set('#070707');
    if (mat.emissive) mat.emissive.set('#050805');
    if ('shininess' in mat) mat.shininess = 6;

    const c = globe.controls();
    c.autoRotate = true;
    c.autoRotateSpeed = 0.45;
    c.enableZoom = true;
    c.minDistance = 160;
    c.maxDistance = 520;
    globe.pointOfView({ lat: 25, lng: -30, altitude: 2.3 }, 0);

    const size = () => {
      const w = el.clientWidth;
      const h = el.clientHeight || w;
      globe.width(w).height(h);
    };
    size();
    new ResizeObserver(size).observe(el);
    refreshGlobe();
  }

  // ---------- stats ----------
  function renderStats() {
    $('total').textContent = fmt.format(stats.total || 0);
    const entries = Object.entries(stats.countries).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    $('ncountries').textContent = fmt.format(entries.length);
    if (stats.updated) {
      const d = new Date(stats.updated);
      $('updated').textContent = `Count last updated ${d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
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
        const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = String(i + 1).padStart(2, '0');
        const name = document.createElement('span'); name.className = 'name'; name.textContent = countries[code] || code;
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

  async function loadStats() {
    try {
      const bucket = Math.floor(Date.now() / POLL_MS);
      const r = await fetch(`stats.json?v=${bucket}`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      const s = await r.json();
      if (s && Number.isSafeInteger(s.total) && s.total >= 0 && s.countries && typeof s.countries === 'object') {
        // Accept only known ISO codes with non-negative integer counts.
        const clean = Object.create(null);
        for (const [code, n] of Object.entries(s.countries)) {
          if (Object.prototype.hasOwnProperty.call(countries, code) && Number.isSafeInteger(n) && n > 0) clean[code] = n;
        }
        const updated = typeof s.updated === 'string' && !Number.isNaN(Date.parse(s.updated)) ? s.updated : null;
        stats = { total: s.total, countries: clean, updated };
        renderStats();
      }
    } catch (e) {
      if (!stats.updated) $('updated').textContent = 'Live count unavailable right now.';
    }
  }

  // ---------- boot ----------
  async function boot() {
    const [cRes, gRes] = await Promise.all([fetch('countries.json'), fetch('countries.geojson')]);
    countries = await cRes.json();
    features = (await gRes.json()).features;
    buildPicker();
    try {
      initGlobe();
    } catch (e) {
      $('globe').hidden = true;
      document.querySelector('.legend').hidden = true;
      $('globe-fallback').hidden = false;
    }
    await loadStats();
    setInterval(() => { if (!document.hidden) loadStats(); }, POLL_MS);
  }

  boot();
})();
