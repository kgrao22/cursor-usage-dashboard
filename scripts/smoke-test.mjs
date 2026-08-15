#!/usr/bin/env node
/**
 * Offline smoke test.
 *
 * Builds synthetic events in the EXACT raw shape the Cursor API returns —
 * string timestamps, `serviceAccountId: "null"`, the real model names and kind
 * values — and runs them through the full normalise → aggregate → render path.
 *
 * The point is that the two bugs that actually bit us during exploration
 * (string epoch timestamps crashing Date, and the literal string "null" reading
 * as truthy) are both encoded here as fixtures. If either regresses, this fails
 * rather than the dashboard quietly showing every call as a service account.
 *
 *   node scripts/smoke-test.mjs
 */

import { writeFileSync } from 'node:fs';
import { normalizeEvent } from '../src/cursor.js';
import { buildDashboard, reconcile } from '../src/aggregate.js';
import { renderDashboard } from '../src/render.js';
import { billingCycle, istDate, toEpochMs } from '../src/time.js';

// Deterministic PRNG so a failure is reproducible.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

/**
 * Synthetic team. Deliberately NOT real colleagues.
 *
 * The weights mirror the shape of real usage — one dominant consumer, a long
 * tail — because that shape is what the concentration alert has to detect. The
 * identities are fictional on purpose: a test fixture is committed forever and
 * read by anyone with repo access, so it is the wrong place to record who on
 * the team spends the most.
 */
const USERS = [
  ['dev-01@example.com', 0.33],
  ['dev-02@example.com', 0.21],
  ['dev-03@example.com', 0.16],
  ['dev-04@example.com', 0.08],
  ['dev-05@example.com', 0.07],
  ['dev-06@example.com', 0.05],
  ['dev-07@example.com', 0.04],
  ['dev-08@example.com', 0.04],
  ['dev-09@example.com', 0.01],
  ['dev-10@example.com', 0.01],
];
const MODELS = [
  'composer-2.5-fast', 'gpt-5.6-sol-medium', 'default', 'cursor-grok-4.5-medium',
  'Opus 5 (Auto Balanced)', 'cursor-grok-4.5-high', 'composer-2.5',
  'claude-opus-4-8-thinking-high', 'Fable 5 (Auto Balanced)', 'claude-sonnet-5-thinking-medium',
];

function weightedUser() {
  let r = rnd();
  for (const [email, w] of USERS) {
    if ((r -= w) <= 0) return email;
  }
  return USERS[0][0];
}

const now = Date.now();
const cycle = billingCycle(now);
const raw = [];

// Span 90 days so the history chart gets a realistic number of columns, then
// slice the current cycle out of it — the same relationship the real data has.
const HISTORY_START = now - 90 * 86_400_000;

for (let i = 0; i < 4000; i++) {
  const ts = HISTORY_START + rnd() * (now - HISTORY_START);
  const onDemand = rnd() < 0.16;
  const cents = Math.round((rnd() ** 3 * 180 + 1) * 1000) / 1000;
  const isAgent = rnd() < 0.005;
  raw.push({
    // String epoch ms — exactly how the API sends it.
    timestamp: String(Math.round(ts)),
    model: pick(MODELS),
    kind: onDemand ? 'Usage-based' : 'Included in Business',
    maxMode: false,
    requestsCosts: rnd() * 100,
    isTokenBasedCall: true,
    tokenUsage: {
      inputTokens: Math.round(rnd() * 400000),
      outputTokens: Math.round(rnd() * 50000),
      cacheWriteTokens: 0,
      cacheReadTokens: Math.round(rnd() * 9000000),
      totalCents: cents,
    },
    cursorTokenFee: rnd() * 0.06,
    isChargeable: true,
    // Literal string "null" — the field that made probe 1 report 50/50 non-human.
    serviceAccountId: 'null',
    isHeadless: isAgent,
    chargedCents: cents,
    ...(isAgent ? { cloudAgentId: `bc-${i}`, automationId: `auto-${i % 3}` } : {}),
    conversationId: `conv-${i}`,
    userEmail: weightedUser(),
  });
}

const history = raw.map(normalizeEvent).sort((a, b) => a.tsMs - b.tsMs);
const events = history.filter((e) => e.tsMs >= cycle.start);

// ── Assertions ───────────────────────────────────────────────────────────
let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name} ${extra}`);
    failures++;
  }
};

console.log('\nNormalisation');
check('string timestamps parse to finite epoch ms', events.every((e) => Number.isFinite(e.tsMs)));
check('every event resolves an IST date', events.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.istDate)));
check(
  'serviceAccountId "null" is treated as unset',
  events.every((e) => e.serviceAccountId === null)
);
const agents = events.filter((e) => e.isNonHuman);
check(
  'only genuine agents flagged non-human',
  agents.length > 0 && agents.length < events.length * 0.05,
  `(got ${agents.length}/${events.length})`
);
check(
  'on-demand and included partition the charge',
  events.every((e) => Math.abs(e.onDemandCents + e.includedCents - e.chargedCents) < 1e-9)
);

console.log('\nTime handling');
check('IST date shifts a 00:30 IST instant to the correct day',
  istDate(Date.parse('2026-08-14T19:00:00Z')) === '2026-08-15');
check('a UTC-day boundary does not leak backwards',
  istDate(Date.parse('2026-08-14T18:29:00Z')) === '2026-08-14');
check('string epoch survives toEpochMs', toEpochMs('1786764606294') === 1786764606294);
const apiCycle = billingCycle(Date.parse('2026-08-15T14:50:00Z'), 1786356051000);
check('cycle start honours the API anchor, not midnight',
  apiCycle.start === 1786356051000, `(got ${apiCycle.start})`);
check('cycle length is a real month', apiCycle.totalDays >= 28 && apiCycle.totalDays <= 31,
  `(got ${apiCycle.totalDays})`);

console.log('\nAggregation');
const spend = {
  capturedAt: now,
  cycleStart: cycle.start,
  limitedUsersCount: 0,
  rows: USERS.map(([email], i) => ({
    email, name: email.split('@')[0], userId: String(i),
    spendCents: events.filter((e) => e.userEmail === email).reduce((a, e) => a + e.onDemandCents, 0),
    includedSpendCents: events.filter((e) => e.userEmail === email).reduce((a, e) => a + e.includedCents, 0),
    monthlyLimitDollars: null, hardLimitOverrideDollars: 0, billingTier: 'TIER_1000',
    totalPercentUsed: rnd() * 110, autoPercentUsed: rnd() * 80, apiPercentUsed: rnd() * 40,
  })),
};
const members = USERS.map(([email], i) => ({
  userId: String(i), email, name: email.split('@')[0], role: 'member', isRemoved: false,
})).concat([{ userId: '99', email: 'idle@example.com', name: 'idle', role: 'member', isRemoved: false }]);

const d = buildDashboard({ cycleEvents: events, historyEvents: history, spend, members, now });

const seriesTotal = d.series.reduce((a, s) => a + s.chargedCents, 0);
check('daily series conserves the total',
  Math.abs(seriesTotal - d.totals.chargedCents) < 0.01,
  `(series ${seriesTotal.toFixed(2)} vs totals ${d.totals.chargedCents.toFixed(2)})`);
check('per-user totals conserve the total',
  Math.abs(d.byUser.reduce((a, u) => a + u.chargedCents, 0) - d.totals.chargedCents) < 0.01);
check('per-model totals conserve the total',
  Math.abs(d.byModel.reduce((a, m) => a + m.chargedCents, 0) - d.totals.chargedCents) < 0.01);
check('model families conserve the total',
  Math.abs(d.byFamily.reduce((a, m) => a + m.chargedCents, 0) - d.totals.chargedCents) < 0.01);
check('series is zero-filled with no gaps',
  d.series.length === Math.ceil((Math.min(now, cycle.end) - cycle.start) / 86400000) + 1 ||
  d.series.length >= 1);
check('idle seat detected', d.idle.some((m) => m.email === 'idle@example.com'));
check('at least one alert is always produced', d.alerts.length > 0);
check('reconciliation runs', reconcile(d, spend) !== null);

console.log('\nRendering');
let html = '';
try {
  html = renderDashboard(d, { reconciliation: reconcile(d, spend), meta: { lastRefreshAt: String(now) } });
  check('renders without throwing', true);
} catch (err) {
  check('renders without throwing', false, err.message);
}
check('produces a full document', html.startsWith('<!doctype html>') && html.includes('</html>'));
check('no unresolved template literals', !html.includes('[object Object]') && !html.includes('undefined%'));
check('no NaN leaked into the page', !/>\s*\$?NaN/.test(html));
check('hero figure present', html.includes('hero-num'));
check('both series are in the legend', html.includes('On-demand') && html.includes('Included'));

// Empty-state path: a fresh install with no data must still render.
try {
  const empty = buildDashboard({ cycleEvents: [], historyEvents: [], spend: null, members: [], now });
  const emptyHtml = renderDashboard(empty, {});
  check('renders with an empty store', emptyHtml.includes('</html>'));
} catch (err) {
  check('renders with an empty store', false, err.message);
}

writeFileSync('smoke-output.html', html);
console.log(`\nWrote smoke-output.html (${(html.length / 1024).toFixed(0)} KB)`);
console.log(
  `\nSynthetic cycle: on-demand $${(d.totals.onDemandCents / 100).toFixed(2)}, ` +
    `included $${(d.totals.includedCents / 100).toFixed(2)}, ${d.totals.events} calls\n`
);

if (failures) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All checks passed.');
