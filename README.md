# Free Jensen: a petition to reinstate Jensen Huang as CEO of NVIDIA

**Live page: https://0xsero.github.io/free-jensen/**

> **Independent and fan-run.** This project is not affiliated with, endorsed by, or sponsored by NVIDIA Corporation, its board, or Jensen Huang. "NVIDIA" is a trademark of NVIDIA Corporation and is used here only to identify the company. Signatures are collected for **public sentiment analysis** only and carry no legal, shareholder, or corporate weight.

## How signing works

1. Pick your country on the page and click **Sign with GitHub**.
2. Submit the prefilled issue form.
3. The `Petition` workflow validates the signature, counts it, replies, closes and locks the issue, and redeploys the heatmap.

## Integrity rules

| Rule | How it's enforced |
| --- | --- |
| One signature per person | Keyed on the immutable numeric GitHub user ID, so renaming an account doesn't allow a second signature |
| Processed one at a time | The workflow `concurrency: petition` group runs at most one job at a time. Each run sweeps every open signature issue, so a dropped queued run loses nothing |
| No bots or throwaways | Bot and organization accounts and accounts younger than 7 days are rejected |
| Never "counted" unless saved | Validation, then commit, then reply. If the commit fails, no one is told their signature was counted |
| Untrusted input stays inert | Issue bodies are parsed in linear time in JS and never reach a shell. Actions are pinned to commit SHAs, and the token is least-privilege |
| Page can't be scripted | Strict CSP (`script-src 'self'`), vendored libraries and fonts, no third-party requests, and stats are type-checked against the country allowlist |

Country is self-reported. Counts reflect GitHub users who chose to sign, not a scientific sample.

## Data

- `data/signers.json`: `{ "<github user id>": { "c": "<ISO country>", "i": <issue #> } }`
- `stats.json` on the site: per-country aggregate counts
- The optional "why" text stays in the public signature issues, for sentiment analysis.

## Layout

```
site/                     static page (GitHub Pages)
.github/ISSUE_TEMPLATE/   the signature form
.github/workflows/        petition.yml: process, then commit, then reply, then deploy
.github/scripts/          process.js: validation and counting
```

Globe: [globe.gl](https://github.com/vasturiano/globe.gl) (MIT). Country shapes: Natural Earth (public domain). Font: Barlow (SIL OFL).
