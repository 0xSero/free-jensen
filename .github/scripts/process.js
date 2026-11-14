// Signature processor. Runs inside the `petition` workflow, whose concurrency
// group guarantees only ONE run executes at a time, so signatures are counted
// strictly in sequence.
//
// Two phases, so a signer is never told "counted" unless the count is saved:
//   decide(): read-only against GitHub. Validates every open signature issue,
//             updates data/signers.json + site/stats.json, writes decisions.
//   (workflow commits & pushes data/signers.json; the job stops if that fails)
//   apply():  comments on and closes each issue according to the decisions.
// If apply() is interrupted, the issues stay open and the next run re-decides
// them. Each signer record stores its issue number, so a re-run of a counted
// issue gets the same "counted" reply instead of "duplicate".
//
// Security:
//  - Issue content is untrusted. It is parsed here with linear-time,
//    line-based code, never with a backtracking regex over the whole body,
//    and never interpolated into a shell command or workflow expression.
//  - Identity is the immutable numeric GitHub user id, so renaming an account
//    doesn't give it a second signature.
//  - Bots, organizations, and accounts younger than MIN_ACCOUNT_AGE_DAYS are rejected.

const fs = require('fs');

const MIN_ACCOUNT_AGE_DAYS = 7;
const MAX_PER_RUN = 150;        // keeps a run well inside GITHUB_TOKEN API limits
const MAX_BODY = 20000;         // form bodies are tiny; anything bigger is junk
const SIGNERS_PATH = 'data/signers.json';
const STATS_PATH = 'site/stats.json';
const COUNTRY_HEADING = '### Country code';
const CONFIRM_TEXT = 'I am signing once, on my own behalf';

const isFormIssue = (issue) =>
  !issue.pull_request && typeof issue.body === 'string' && issue.body.includes(COUNTRY_HEADING);

// Returns the first non-empty line after the "### Country code" heading.
function parseCountry(body) {
  const lines = body.slice(0, MAX_BODY).split('\n');
  const h = lines.findIndex((l) => l.trim() === COUNTRY_HEADING);
  if (h === -1) return null;
  for (let i = h + 1; i < lines.length && i < h + 6; i++) {
    const v = lines[i].trim();
    if (!v) continue;
    if (v.startsWith('###')) return null;
    return /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
  }
  return null;
}

function isConfirmed(body) {
  return body.slice(0, MAX_BODY).split('\n').some((l) => {
    const t = l.trim();
    return (t.startsWith('- [X]') || t.startsWith('- [x]')) && t.includes(CONFIRM_TEXT);
  });
}

function writeStats(signers) {
  const countries = {};
  for (const s of Object.values(signers)) countries[s.c] = (countries[s.c] || 0) + 1;
  const stats = { total: Object.keys(signers).length, countries, updated: new Date().toISOString() };
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats));
  return stats;
}

async function decide({ github, context, core, decisionsPath }) {
  const { owner, repo } = context.repo;
  const COUNTRIES = JSON.parse(fs.readFileSync('site/countries.json', 'utf8'));
  const signers = JSON.parse(fs.readFileSync(SIGNERS_PATH, 'utf8'));
  const pageUrl = `https://${owner.toLowerCase()}.github.io/${repo}/`;

  const open = await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, state: 'open', sort: 'created', direction: 'asc', per_page: 100,
  });
  const pending = open.filter(isFormIssue).slice(0, MAX_PER_RUN);
  core.info(`${pending.length} pending signature issue(s)`);

  const decisions = [];
  let added = 0;
  const reject = (issue, message, label = 'rejected') =>
    decisions.push({ number: issue.number, label, reason: 'not_planned', message });

  try {
    for (const issue of pending) {
      const user = issue.user;
      const body = issue.body;

      if (!user || user.type !== 'User') {
        reject(issue, 'Only personal GitHub accounts can sign. Bots and organizations cannot.');
        continue;
      }

      const existing = signers[String(user.id)];
      if (existing) {
        if (existing.i === issue.number) {
          // Counted in an earlier run whose replies didn't finish. Re-send the same result.
          decisions.push({ number: issue.number, label: 'counted', reason: 'completed',
            message: `✅ Thank you @${user.login}! Your signature from **${COUNTRIES[existing.c]}** is counted.\n\n${pageUrl}` });
        } else {
          reject(issue, `@${user.login}, your signature is already counted. Each account can sign once. Thank you!`, 'duplicate');
        }
        continue;
      }

      const code = parseCountry(body);
      if (!code || !COUNTRIES[code]) {
        reject(issue, 'The country code was not recognised. Please sign again from the petition page and pick your country from the list: ' + pageUrl);
        continue;
      }
      if (!isConfirmed(body)) {
        reject(issue, 'The confirmation box was not ticked. Please sign again from the petition page: ' + pageUrl);
        continue;
      }

      // Look up by immutable id. A deleted account gets a 404, which rejects that
      // issue only, so it can't block the queue. Other errors (rate limits) stop the run.
      let profile;
      try {
        ({ data: profile } = await github.request('GET /user/{account_id}', { account_id: user.id }));
      } catch (err) {
        if (err.status === 404) { reject(issue, 'This GitHub account could not be verified.'); continue; }
        throw err;
      }
      const ageDays = (Date.now() - Date.parse(profile.created_at)) / 86400000;
      if (!(ageDays >= MIN_ACCOUNT_AGE_DAYS)) {
        reject(issue, `Sorry @${user.login}, accounts must be at least ${MIN_ACCOUNT_AGE_DAYS} days old to sign. This helps prevent fake signatures.`);
        continue;
      }

      signers[String(user.id)] = { c: code, i: issue.number };
      added++;
      decisions.push({ number: issue.number, label: 'counted', reason: 'completed',
        message: `✅ Thank you @${user.login}! Your signature from **${COUNTRIES[code]}** is counted. Signature #${Object.keys(signers).length}.\n\nThe heatmap updates in about a minute: ${pageUrl}` });
    }
  } catch (err) {
    // A rate limit or API error stops this run early. Anything not yet decided
    // stays open and is picked up by the next run.
    core.warning(`Stopped early: ${err.message}`);
  }

  if (added > 0) fs.writeFileSync(SIGNERS_PATH, JSON.stringify(signers) + '\n');
  const stats = writeStats(signers);
  fs.writeFileSync(decisionsPath, JSON.stringify(decisions));
  core.info(`decided=${decisions.length} added=${added} total=${stats.total}`);
  core.setOutput('added', String(added));
  core.setOutput('decided', String(decisions.length));
}

async function apply({ github, context, core, decisionsPath }) {
  const { owner, repo } = context.repo;
  const decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  let done = 0;
  for (const d of decisions) {
    try {
      await github.rest.issues.createComment({ owner, repo, issue_number: d.number, body: d.message });
      await github.rest.issues.update({
        owner, repo, issue_number: d.number,
        state: 'closed', state_reason: d.reason, labels: ['signature', d.label],
      });
      await github.rest.issues.lock({ owner, repo, issue_number: d.number, lock_reason: 'resolved' }).catch(() => {});
      done++;
    } catch (err) {
      core.warning(`#${d.number}: ${err.message}. It stays open and the next run retries it.`);
      if (err.status === 403 || err.status === 429) break; // rate limited: stop now
    }
  }
  core.info(`applied ${done}/${decisions.length}`);
}

module.exports = { decide, apply, parseCountry, isConfirmed };
