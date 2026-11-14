// Free Jensen petition: Cloudflare Pages advanced-mode worker.
//
//   POST /api/sign   Turnstile-verified, rate-limited, atomic signature insert
//   GET  /api/stats  Current counts, plus the viewer's detected country and signed state
//   GET  /api/live   Server-Sent Events stream that pushes new counts within ~2.5 s
//   everything else  Static assets
//
// Privacy: we never ask for name, email or phone. Raw IPs are never stored or
// logged; only HMAC(secret, ip or IPv6 /64) is kept, for rate limiting.
// Country comes from Cloudflare's edge geolocation, not from the user.

const RATE_LIMIT_PER_DAY = 3;          // signatures per network per 24h (shared NAT, households)
const MAX_BODY_BYTES = 4096;
const MAX_REASON_CHARS = 280;
const LIVE_SECONDS = 120;              // each SSE connection lives 2 min, then the browser reconnects
const LIVE_TICK_MS = 2500;
const COOKIE = 'fj_s';

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// ---------- helpers ----------
const enc = new TextEncoder();

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}
const fail = (status, error, message, extra) => json({ ok: false, error, message }, status, extra);

function withSecurityHeaders(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  return r;
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(enc.encode(a), enc.encode(b));
}

// IPv4 -> as-is. IPv6 -> its /64 network, since one subscriber usually controls a whole /64.
function networkKey(ip) {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  let [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const full = t === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return full.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}

function getCookie(req, name) {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function hasValidSignedCookie(req, env) {
  const c = getCookie(req, COOKIE);
  if (!c) return false;
  const [id, sig] = c.split('.');
  if (!id || !sig || !/^[0-9a-f]{32}$/.test(id)) return false;
  return safeEqual(sig, await hmacHex(env.HASH_KEY, 'cookie:' + id));
}

function viewerCountry(req) {
  const c = req.cf && req.cf.country;
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

function cleanReason(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s ? [...s].slice(0, MAX_REASON_CHARS).join('') : null;
}

// ---------- stats (memoised per isolate by version) ----------
let memo = { version: -1, data: null };
async function readStats(env) {
  const m = await env.DB.prepare('SELECT total, version, updated_at FROM meta WHERE id = 1').first();
  if (!m) return { total: 0, countries: {}, updated: null, version: 0 };
  if (m.version !== memo.version) {
    const { results } = await env.DB.prepare('SELECT country, n FROM country_counts').all();
    memo = {
      version: m.version,
      data: {
        total: m.total,
        countries: Object.fromEntries(results.map((r) => [r.country, r.n])),
        updated: m.updated_at ? new Date(m.updated_at * 1000).toISOString() : null,
        version: m.version,
      },
    };
  }
  return memo.data;
}

// ---------- handlers ----------
async function handleStats(req, env) {
  const stats = await readStats(env);
  return json({
    ...stats,
    you: { country: viewerCountry(req), signed: await hasValidSignedCookie(req, env) },
    sitekey: env.TURNSTILE_SITEKEY,
  });
}

function handleLive(req, env) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const send = (s) => w.write(enc.encode(s));

  (async () => {
    let last = -1;
    const deadline = Date.now() + LIVE_SECONDS * 1000;
    try {
      await send('retry: 1500\n\n');
      while (Date.now() < deadline) {
        const m = await env.DB.prepare('SELECT version FROM meta WHERE id = 1').first();
        if (m && m.version !== last) {
          last = m.version;
          await send(`data: ${JSON.stringify(await readStats(env))}\n\n`);
        } else {
          await send(': ping\n\n'); // keeps proxies from closing the stream; throws once the client is gone
        }
        await new Promise((r) => setTimeout(r, LIVE_TICK_MS));
      }
    } catch (_) {
      // client disconnected
    } finally {
      try { await w.close(); } catch (_) {}
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

async function verifyTurnstile(token, ip, env, hostname) {
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body, signal: AbortSignal.timeout(8000),
  });
  const d = await r.json();
  if (!d.success) return { ok: false, codes: d['error-codes'] || [] };
  // Test keys (local dev) report hostname "example.com" and no action; production must match.
  if (!env.TURNSTILE_TEST_MODE) {
    if (d.hostname !== hostname) return { ok: false, codes: ['hostname-mismatch'] };
    if (d.action !== 'sign') return { ok: false, codes: ['action-mismatch'] };
  }
  return { ok: true };
}

async function handleSign(req, env) {
  const url = new URL(req.url);

  // CSRF: only our own pages may post here.
  if (req.headers.get('Origin') !== url.origin) return fail(403, 'bad_origin', 'Request blocked.');
  if (!(req.headers.get('Content-Type') || '').startsWith('application/json')) return fail(415, 'bad_type', 'Unsupported request.');
  const len = Number(req.headers.get('Content-Length'));
  if (!Number.isFinite(len) || len <= 0 || len > MAX_BODY_BYTES) return fail(413, 'too_large', 'Request too large.');

  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return fail(413, 'too_large', 'Request too large.');
    body = JSON.parse(text);
  } catch (_) {
    return fail(400, 'bad_json', 'Malformed request.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_json', 'Malformed request.');
  if (body.consent !== true) return fail(400, 'no_consent', 'Please confirm before signing.');
  if (typeof body.token !== 'string' || body.token.length < 10 || body.token.length > 2048) {
    return fail(400, 'no_token', 'Human verification missing. Please try again.');
  }

  if (await hasValidSignedCookie(req, env)) return fail(409, 'already_signed', 'You have already signed from this browser. Thank you!');

  const ip = req.headers.get('CF-Connecting-IP') || '';
  const ts = await verifyTurnstile(body.token, ip, env, url.hostname);
  if (!ts.ok) return fail(403, 'verification_failed', 'Human verification failed. Please refresh and try again.');

  const ipHash = await hmacHex(env.HASH_KEY, 'ip:' + networkKey(ip));
  const country = viewerCountry(req) || 'ZZ'; // ZZ = unknown, counted in the total but not on the map
  const reason = cleanReason(body.reason);
  const now = Math.floor(Date.now() / 1000);

  // Rate check and insert happen in ONE statement, which D1 runs atomically,
  // so concurrent requests can't slip past the limit together.
  const res = await env.DB.prepare(
    `INSERT INTO signatures (ip_hash, country, reason, created_at)
     SELECT ?1, ?2, ?3, ?4
     WHERE (SELECT COUNT(*) FROM signatures WHERE ip_hash = ?1 AND created_at > ?5) < ?6
     RETURNING id`
  ).bind(ipHash, country, reason, now, now - 86400, RATE_LIMIT_PER_DAY).first();

  // RETURNING yields a row only if the insert actually happened.
  if (!res || !Number.isSafeInteger(res.id)) {
    return fail(429, 'rate_limited', 'Too many signatures from your network today. Please try again tomorrow.');
  }

  const number = res.id;
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const cookie = `${COOKIE}=${id}.${await hmacHex(env.HASH_KEY, 'cookie:' + id)}; Max-Age=63072000; Path=/; Secure; HttpOnly; SameSite=Strict`;
  return json({ ok: true, number, country: country === 'ZZ' ? null : country }, 200, { 'Set-Cookie': cookie });
}

// Fail closed: never run the API with missing or weak secrets.
function configOk(env) {
  return env.DB && typeof env.HASH_KEY === 'string' && env.HASH_KEY.length >= 32
    && typeof env.TURNSTILE_SECRET === 'string' && env.TURNSTILE_SECRET.length >= 20
    && typeof env.TURNSTILE_SITEKEY === 'string';
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    let res;
    try {
      if (pathname.startsWith('/api/') && !configOk(env)) {
        console.error('misconfigured: missing secrets or bindings');
        res = fail(503, 'unavailable', 'Signing is temporarily unavailable.');
      } else if (pathname === '/api/sign') {
        res = req.method === 'POST' ? await handleSign(req, env) : fail(405, 'method', 'Method not allowed.', { Allow: 'POST' });
      } else if (pathname === '/api/stats') {
        res = req.method === 'GET' ? await handleStats(req, env) : fail(405, 'method', 'Method not allowed.', { Allow: 'GET' });
      } else if (pathname === '/api/live') {
        res = req.method === 'GET' ? handleLive(req, env) : fail(405, 'method', 'Method not allowed.', { Allow: 'GET' });
      } else if (pathname.startsWith('/api/')) {
        res = fail(404, 'not_found', 'Not found.');
      } else {
        res = await env.ASSETS.fetch(req);
      }
    } catch (err) {
      console.error('handler error', err && err.message); // never logs request data
      res = fail(500, 'server_error', 'Something went wrong. Please try again.');
    }
    return withSecurityHeaders(res);
  },
};
