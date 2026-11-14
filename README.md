# Free Jensen: a petition to reinstate Jensen Huang as CEO of NVIDIA

**Live: https://free-jensen.pages.dev/**

> **Independent and fan-run.** This project is not affiliated with, endorsed by, or sponsored by NVIDIA Corporation, its board, or Jensen Huang. "NVIDIA" is a trademark of NVIDIA Corporation and is used here only to identify the company. Signatures are collected for **public sentiment analysis** only and carry no legal, shareholder, or corporate weight.

## How it works

One click, no account. Visitors press **Sign the petition** and a Cloudflare Turnstile check runs, usually invisibly. Their country is read from Cloudflare's network geolocation. The globe and counters update live for every open page.

| Concern | How it's handled |
| --- | --- |
| Bots | Every signature needs a server-verified Turnstile token. Each token is single-use and must match the hostname and action |
| Repeat signing | Each browser gets a signed, HttpOnly cookie, so it signs once. Each network (IPv4 address or IPv6 /64) is capped at 3 signatures per 24 h |
| Signatures processed one at a time | The rate check and the insert are one atomic SQL statement. A database trigger updates the country tally in the same transaction |
| Privacy | No name, email, or phone is ever requested. Raw IPs are never stored or logged, only `HMAC(secret, network)`. The optional comment is private |
| Live updates | `/api/live` is a Server-Sent Events stream that pushes new counts within about 2.5 s |
| Web hardening | Strict CSP (`script-src 'self'` plus Turnstile), `frame-ancestors 'none'`, HSTS, nosniff, COOP, same-origin and JSON-only POSTs, 4 KB body limit, and stats validated against an allowlist |
| Misconfiguration | The API fails closed with a 503 if any secret or binding is missing |

## Layout

```
site/                 static page + _worker.js (Cloudflare Pages advanced mode)
cloudflare/schema.sql D1 schema (signatures, country_counts, meta, trigger)
wrangler.toml         Pages project config (D1 binding, public Turnstile sitekey)
redirect/             old github.io address, which redirects to pages.dev
archive/              the earlier GitHub-Issues-based version (retired)
```

## Operating it

Secrets are set on the Pages project and never committed: `TURNSTILE_SECRET` and `HASH_KEY`.

```bash
# deploy
npx wrangler@4.156.0 pages deploy site --project-name free-jensen --branch main

# sentiment export (private)
npx wrangler@4.156.0 d1 execute free-jensen --remote --json \
  --command "SELECT country, reason, created_at FROM signatures WHERE reason IS NOT NULL"
```

Globe: [globe.gl](https://github.com/vasturiano/globe.gl) (MIT). Country shapes: Natural Earth (public domain). Font: Barlow (SIL OFL).
