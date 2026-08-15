#!/usr/bin/env node
/**
 * Reconciliation probe.
 *
 * Settles the one question the whole dashboard rests on: which number is the
 * bill? /teams/spend reports one cycle-to-date figure, but summing chargedCents
 * over the same window gives a much larger one. Both cannot be the invoice.
 *
 * Hypothesis under test: `chargedCents` is the gross value of every call, and
 * `kind` splits it into what the Business pool absorbed vs what spills into
 * on-demand billing. If each side sums to its matching field on /teams/spend,
 * the model is confirmed and the headline figure is settled.
 *
 * Quirks this encodes, each of which produced a wrong answer first:
 *  - `timestamp` is epoch milliseconds AS A STRING ("1786764606294"), so it
 *    needs Number() before Date(). Passing it straight to Date() throws.
 *  - `serviceAccountId` is the literal string "null", not a null value, so a
 *    truthiness test reports 100% of events as service accounts.
 *  - The billing cycle does NOT start at midnight — it starts at whatever time
 *    of day the subscription was created. A midnight-anchored window silently
 *    pulls hours of the previous cycle into every total, so the boundary comes
 *    from subscriptionCycleStart.
 *
 * Usage: node scripts/reconcile-api.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://api.cursor.com';
const OUT = join(process.cwd(), 'probe-output');
const IST = 5.5 * 3600e3;

if (!process.env.CURSOR_API_KEY) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    /* handled below */
  }
}
const KEY = process.env.CURSOR_API_KEY?.trim();
if (!KEY) {
  console.error('CURSOR_API_KEY not found. Run from the project root.');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const AUTH = 'Basic ' + Buffer.from(`${KEY}:`).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (c) => '$' + (c / 100).toFixed(2);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const istDay = (epochMs) => new Date(epochMs + IST).toISOString().slice(0, 10);

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, json, raw: text.slice(0, 300) };
}

const banner = (t) => {
  console.log('\n' + '═'.repeat(76));
  console.log(t);
  console.log('═'.repeat(76));
};

// ── Anchor the window on the real cycle boundary ─────────────────────────
const spend = await call('POST', '/teams/spend', { page: 1, pageSize: 200 });
if (!spend.ok) {
  console.error('spend failed:', spend.json ?? spend.raw);
  process.exit(1);
}
const rows = spend.json.teamMemberSpend ?? [];
const sumSpend = rows.reduce((a, r) => a + (r.spendCents ?? 0), 0);
const sumIncluded = rows.reduce((a, r) => a + (r.includedSpendCents ?? 0), 0);
const cycleStart = Number(spend.json.subscriptionCycleStart);
const nowMs = Date.now();

banner('Window');
console.log('cycleStart (API) :', new Date(cycleStart).toISOString(), '=', istDay(cycleStart), 'IST');
console.log('now              :', new Date(nowMs).toISOString());
console.log('spend.spendCents :', money(sumSpend));
console.log('spend.includedCents:', money(sumIncluded));

// ── Pull the full cycle ──────────────────────────────────────────────────
const all = [];
let page = 1;
let numPages = 1;
while (page <= numPages && page <= 30) {
  const r = await call('POST', '/teams/filtered-usage-events', {
    startDate: cycleStart,
    endDate: nowMs,
    page,
    pageSize: 1000,
  });
  if (!r.ok) {
    console.error(`page ${page} failed:`, r.json ?? r.raw);
    break;
  }
  all.push(...(r.json?.usageEvents ?? []));
  numPages = r.json?.pagination?.numPages ?? 1;
  page++;
  if (page <= numPages) await sleep(1100);
}
console.log(`events pulled    : ${all.length}`);
writeFileSync(join(OUT, '20-cycle-events.json'), JSON.stringify(all, null, 2));

// ── D1. Does chargedCents = tokenUsage.totalCents + cursorTokenFee? ──────
banner('D1. chargedCents arithmetic');
let arithmeticOk = 0;
let arithmeticOff = 0;
let worstDelta = 0;
for (const e of all) {
  const expected = (e.tokenUsage?.totalCents ?? 0) + (e.cursorTokenFee ?? 0);
  const delta = Math.abs((e.chargedCents ?? 0) - expected);
  if (delta < 0.0001) arithmeticOk++;
  else {
    arithmeticOff++;
    worstDelta = Math.max(worstDelta, delta);
  }
}
console.log(`chargedCents == totalCents + cursorTokenFee : ${arithmeticOk}/${all.length}`);
if (arithmeticOff) console.log(`  mismatches: ${arithmeticOff}, worst delta ${worstDelta.toFixed(6)} cents`);

// ── D2. THE RECONCILIATION ───────────────────────────────────────────────
banner('D2. Reconciliation by kind  <- the answer we came for');
const byKind = {};
for (const e of all) {
  const k = e.kind ?? 'unknown';
  byKind[k] = byKind[k] ?? { n: 0, charged: 0, chargeable: 0, nonChargeable: 0 };
  byKind[k].n++;
  byKind[k].charged += e.chargedCents ?? 0;
  if (e.isChargeable) byKind[k].chargeable += e.chargedCents ?? 0;
  else byKind[k].nonChargeable += e.chargedCents ?? 0;
}
console.log(pad('kind', 30) + padL('n', 6) + padL('charged', 12) + padL('isChargeable', 14));
console.log('─'.repeat(62));
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1].charged - a[1].charged)) {
  console.log(pad(k, 30) + padL(v.n, 6) + padL(money(v.charged), 12) + padL(money(v.chargeable), 14));
}
const usageBased = Object.entries(byKind)
  .filter(([k]) => /usage.based|on.demand/i.test(k))
  .reduce((a, [, v]) => a + v.charged, 0);
const included = Object.entries(byKind)
  .filter(([k]) => /included/i.test(k))
  .reduce((a, [, v]) => a + v.charged, 0);

console.log('\nVERDICT');
console.log(`  usage-based events charged : ${padL(money(usageBased), 12)}   vs /teams/spend spendCents    ${money(sumSpend)}`);
console.log(`  included  events charged : ${padL(money(included), 12)}   vs /teams/spend includedCents ${money(sumIncluded)}`);
const m1 = Math.abs(usageBased - sumSpend);
const m2 = Math.abs(included - sumIncluded);
console.log(`  deltas: usage-based ${money(m1)}, included ${money(m2)}`);
console.log(
  m1 < 200 && m2 < 200
    ? '  => CONFIRMED. kind splits gross charge into on-demand vs included pool.'
    : '  => NOT confirmed. The split is something else; see per-kind table above.'
);

// ── D3. Non-human, detected correctly this time ──────────────────────────
banner('D3. Non-human spend  (serviceAccountId is the STRING "null" when unset)');
const isNonHuman = (e) =>
  (e.serviceAccountId && e.serviceAccountId !== 'null') ||
  e.cloudAgentId !== undefined ||
  e.automationId !== undefined ||
  e.isHeadless === true;
const nh = all.filter(isNonHuman);
const nhCents = nh.reduce((a, e) => a + (e.chargedCents ?? 0), 0);
const totalCents = all.reduce((a, e) => a + (e.chargedCents ?? 0), 0);
console.log(`non-human events : ${nh.length}/${all.length}`);
console.log(`non-human charged: ${money(nhCents)} of ${money(totalCents)} (${((nhCents / totalCents) * 100).toFixed(1)}%)`);
if (nh.length) {
  console.log('\n' + pad('user', 30) + pad('kind', 24) + padL('charged', 11) + '  agent/automation');
  for (const e of nh.sort((a, b) => (b.chargedCents ?? 0) - (a.chargedCents ?? 0)).slice(0, 15)) {
    console.log(
      pad(e.userEmail ?? '-', 30) +
        pad(e.kind ?? '-', 24) +
        padL(money(e.chargedCents ?? 0), 11) +
        '  ' + (e.cloudAgentId ?? e.automationId ?? 'headless')
    );
  }
}

// ── D4. Cuts we will actually put on the dashboard ───────────────────────
const agg = (keyFn) => {
  const m = {};
  for (const e of all) {
    const k = keyFn(e) ?? 'unknown';
    m[k] = m[k] ?? { n: 0, charged: 0, onDemand: 0, maxMode: 0 };
    m[k].n++;
    m[k].charged += e.chargedCents ?? 0;
    if (/usage.based|on.demand/i.test(e.kind ?? '')) m[k].onDemand += e.chargedCents ?? 0;
    if (e.maxMode) m[k].maxMode++;
  }
  return Object.entries(m).sort((a, b) => b[1].charged - a[1].charged);
};

banner('D4. By model');
console.log(pad('model', 30) + padL('n', 6) + padL('charged', 12) + padL('on-demand', 12) + padL('maxMode', 9));
for (const [k, v] of agg((e) => e.model))
  console.log(pad(k, 30) + padL(v.n, 6) + padL(money(v.charged), 12) + padL(money(v.onDemand), 12) + padL(v.maxMode, 9));

banner('D5. By user');
console.log(pad('user', 30) + padL('n', 6) + padL('charged', 12) + padL('on-demand', 12));
for (const [k, v] of agg((e) => e.userEmail))
  console.log(pad(k, 30) + padL(v.n, 6) + padL(money(v.charged), 12) + padL(money(v.onDemand), 12));

banner('D6. By IST day');
const byDay = {};
for (const e of all) {
  const d = istDay(Number(e.timestamp));
  byDay[d] = byDay[d] ?? { n: 0, charged: 0, onDemand: 0 };
  byDay[d].n++;
  byDay[d].charged += e.chargedCents ?? 0;
  if (/usage.based|on.demand/i.test(e.kind ?? '')) byDay[d].onDemand += e.chargedCents ?? 0;
}
console.log(pad('day (IST)', 14) + padL('n', 6) + padL('charged', 12) + padL('on-demand', 12));
for (const [k, v] of Object.entries(byDay).sort())
  console.log(pad(k, 14) + padL(v.n, 6) + padL(money(v.charged), 12) + padL(money(v.onDemand), 12));

// ── E. How far back does history go? ─────────────────────────────────────
banner('E. Monthly history — retention boundary and the six-month trend');
const istNow = new Date(nowMs + IST);
console.log(pad('month', 10) + padL('events', 9) + padL('charged', 12) + padL('on-demand', 12));
const monthly = [];
for (let i = 0; i < 14; i++) {
  const y = istNow.getUTCFullYear();
  const mo = istNow.getUTCMonth() - i;
  const start = Date.UTC(y, mo, 1) - IST;
  const end = Date.UTC(y, mo + 1, 1) - IST;
  await sleep(1100);
  const head = await call('POST', '/teams/filtered-usage-events', {
    startDate: start,
    endDate: end,
    page: 1,
    pageSize: 1,
  });
  const total = head.json?.totalUsageEventsCount ?? 0;
  const label = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);

  // For months with data, pull it all so we get real dollars, not just counts.
  let charged = 0;
  let onDemand = 0;
  if (total > 0 && total <= 5000) {
    let p = 1;
    let np = 1;
    while (p <= np && p <= 6) {
      await sleep(1100);
      const r = await call('POST', '/teams/filtered-usage-events', {
        startDate: start,
        endDate: end,
        page: p,
        pageSize: 1000,
      });
      if (!r.ok) break;
      for (const e of r.json?.usageEvents ?? []) {
        charged += e.chargedCents ?? 0;
        if (/usage.based|on.demand/i.test(e.kind ?? '')) onDemand += e.chargedCents ?? 0;
      }
      np = r.json?.pagination?.numPages ?? 1;
      p++;
    }
  }
  monthly.push({ month: label, events: total, charged, onDemand });
  console.log(
    pad(label, 10) + padL(total, 9) + padL(money(charged), 12) + padL(money(onDemand), 12) +
      (total > 5000 ? '  (too many to sum here)' : '')
  );
  if (total === 0 && i > 6) break;
}
writeFileSync(join(OUT, '21-monthly.json'), JSON.stringify(monthly, null, 2));

console.log(`\nRaw output written to ${OUT}`);
