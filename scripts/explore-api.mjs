#!/usr/bin/env node
/**
 * Cursor Admin API explorer.
 *
 * Purpose: discover what the API ACTUALLY returns for this team before we
 * design a schema around it. Cursor's public docs are known to be wrong in
 * places (overallSpendCents is documented but not returned; includedSpendCents,
 * billingTier, autoPercentUsed, apiPercentUsed, totalPercentUsed are returned
 * but undocumented), so we trust observed responses over the docs.
 *
 * Also answers the question that decides Monday's demo: how far back does
 * /teams/filtered-usage-events actually return data?
 *
 * Usage:  CURSOR_API_KEY=... node scripts/explore-api.mjs
 * Never prints the key.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://api.cursor.com';
const OUT = join(process.cwd(), 'probe-output');

// Load .env.local automatically so this is a one-command run.
if (!process.env.CURSOR_API_KEY) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    /* fall through to the check below */
  }
}
const KEY = process.env.CURSOR_API_KEY?.trim();

if (!KEY) {
  console.error(
    'CURSOR_API_KEY not found.\n' +
      'Run this from the project root with .env.local present, or:\n' +
      '  CURSOR_API_KEY=crsr_... node scripts/explore-api.mjs'
  );
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const AUTH = 'Basic ' + Buffer.from(`${KEY}:`).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Admin API is 20 req/min on most endpoints, 60 req/min on filtered-usage-events.
// 3.2s between calls keeps us under the strictest limit with room to spare.
const THROTTLE_MS = 3200;

let callCount = 0;

async function call(method, path, body) {
  if (callCount > 0) await sleep(THROTTLE_MS);
  callCount++;

  const started = Date.now();
  let res, text;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: AUTH,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (err) {
    return { ok: false, status: 0, error: String(err), ms: Date.now() - started };
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw text */
  }

  return {
    ok: res.ok,
    status: res.status,
    json,
    raw: json ? null : text.slice(0, 500),
    ms: Date.now() - started,
  };
}

/** Field names present on the first element of an array, with observed types. */
function shapeOf(sample) {
  if (sample === null || sample === undefined) return null;
  if (Array.isArray(sample)) return sample.length ? shapeOf(sample[0]) : '(empty array)';
  if (typeof sample !== 'object') return typeof sample;
  const out = {};
  for (const [k, v] of Object.entries(sample)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = shapeOf(v);
    else if (Array.isArray(v)) out[k] = `array[${v.length}]`;
    else out[k] = v === null ? 'null' : typeof v;
  }
  return out;
}

function save(name, data) {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, null, 2));
}

function banner(title) {
  console.log('\n' + '─'.repeat(70));
  console.log(title);
  console.log('─'.repeat(70));
}

const results = {};

// ── 1. Auth check + team roster ──────────────────────────────────────────
banner('1. GET /teams/members  (auth check)');
const members = await call('GET', '/teams/members');
results.members = members;
console.log(`HTTP ${members.status} in ${members.ms}ms`);

if (!members.ok) {
  console.error('\nFailed. Response:');
  console.error(JSON.stringify(members.json ?? members.raw, null, 2));
  if (members.status === 401) {
    console.error(
      '\n401 = the key is still a User API Key (scope "Admin") rather than a\n' +
        'Team Admin API key. Those are different things; the scope label is\n' +
        'what makes this confusing.'
    );
  }
  save('01-members-FAILED', members);
  process.exit(1);
}

const memberList = members.json?.teamMembers ?? members.json?.members ?? members.json;
const memberCount = Array.isArray(memberList) ? memberList.length : '?';
console.log(`Members returned: ${memberCount}`);
console.log('Top-level keys:', Object.keys(members.json ?? {}));
console.log('Member shape:', JSON.stringify(shapeOf(memberList), null, 2));
save('01-members', members.json);

// ── 2. Current cycle spend ───────────────────────────────────────────────
banner('2. POST /teams/spend  (current billing cycle only)');
const spend = await call('POST', '/teams/spend', { page: 1, pageSize: 100 });
results.spend = spend;
console.log(`HTTP ${spend.status} in ${spend.ms}ms`);
if (spend.ok) {
  console.log('Top-level keys:', Object.keys(spend.json ?? {}));
  const rows = spend.json?.teamMemberSpend ?? spend.json?.spend ?? spend.json;
  console.log('Row shape:', JSON.stringify(shapeOf(rows), null, 2));

  if (Array.isArray(rows) && rows.length) {
    const documented = ['overallSpendCents'];
    const undocumented = [
      'includedSpendCents',
      'billingTier',
      'autoPercentUsed',
      'apiPercentUsed',
      'totalPercentUsed',
    ];
    const present = new Set(Object.keys(rows[0]));
    console.log('\nField reality check:');
    for (const f of documented) {
      console.log(`  ${present.has(f) ? 'PRESENT' : 'MISSING'}  ${f}  (documented)`);
    }
    for (const f of undocumented) {
      console.log(`  ${present.has(f) ? 'PRESENT' : 'absent '}  ${f}  (undocumented)`);
    }

    const totalCents = rows.reduce((s, r) => s + (r.spendCents ?? 0), 0);
    console.log(`\nSum of spendCents across ${rows.length} rows: $${(totalCents / 100).toFixed(2)}`);
  }
  save('02-spend', spend.json);
} else {
  console.log('Failed:', JSON.stringify(spend.json ?? spend.raw));
  save('02-spend-FAILED', spend);
}

// ── 3. Usage events (the real cost-control source) ───────────────────────
banner('3. POST /teams/filtered-usage-events  (last 3 days)');
const now = Date.now();
const day = 86_400_000;
const events = await call('POST', '/teams/filtered-usage-events', {
  startDate: now - 3 * day,
  endDate: now,
  page: 1,
  pageSize: 50,
});
results.events = events;
console.log(`HTTP ${events.status} in ${events.ms}ms`);
if (events.ok) {
  console.log('Top-level keys:', Object.keys(events.json ?? {}));
  const evs = events.json?.usageEvents ?? events.json?.events ?? events.json;
  console.log(`Events in page: ${Array.isArray(evs) ? evs.length : '?'}`);
  console.log('totalUsageEventsCount:', events.json?.totalUsageEventsCount ?? '(not present)');
  console.log('Pagination block:', JSON.stringify(events.json?.pagination ?? '(none)'));
  console.log('Event shape:', JSON.stringify(shapeOf(evs), null, 2));

  if (Array.isArray(evs) && evs.length) {
    const models = {};
    const kinds = {};
    let charged = 0;
    let nonHuman = 0;
    for (const e of evs) {
      models[e.model ?? 'unknown'] = (models[e.model ?? 'unknown'] ?? 0) + 1;
      kinds[e.kind ?? 'unknown'] = (kinds[e.kind ?? 'unknown'] ?? 0) + 1;
      charged += e.chargedCents ?? 0;
      if (e.serviceAccountId || e.cloudAgentId || e.automationId || e.isHeadless) nonHuman++;
    }
    console.log('\nModels in sample:', models);
    console.log('Kinds in sample:', kinds);
    console.log(`Charged in sample: $${(charged / 100).toFixed(2)}`);
    console.log(`Non-human events in sample: ${nonHuman}/${evs.length}`);
  }
  save('03-events', events.json);
} else {
  console.log('Failed:', JSON.stringify(events.json ?? events.raw));
  save('03-events-FAILED', events);
}

// ── 4. Backfill depth: how far back is data actually available? ──────────
banner('4. Backfill depth probe  (decides whether Monday shows a real trend)');
const probes = [7, 30, 60, 90, 180, 365];
const depth = [];
for (const daysBack of probes) {
  // 24h window ending `daysBack` days ago
  const end = now - daysBack * day;
  const start = end - day;
  const r = await call('POST', '/teams/filtered-usage-events', {
    startDate: start,
    endDate: end,
    page: 1,
    pageSize: 1,
  });
  const total = r.json?.totalUsageEventsCount ?? null;
  const arr = r.json?.usageEvents ?? r.json?.events ?? [];
  const count = Array.isArray(arr) ? arr.length : 0;
  const label = new Date(start).toISOString().slice(0, 10);
  depth.push({ daysBack, date: label, status: r.status, total, returned: count });
  console.log(
    `  ${String(daysBack).padStart(3)}d ago (${label})  HTTP ${r.status}  ` +
      `total=${total ?? '?'}  returned=${count}`
  );
}
results.depth = depth;
save('04-backfill-depth', depth);

// ── 5. Daily usage data (productivity metrics) ───────────────────────────
banner('5. POST /teams/daily-usage-data  (last 7 days)');
const daily = await call('POST', '/teams/daily-usage-data', {
  startDate: now - 7 * day,
  endDate: now,
});
results.daily = daily;
console.log(`HTTP ${daily.status} in ${daily.ms}ms`);
if (daily.ok) {
  console.log('Top-level keys:', Object.keys(daily.json ?? {}));
  const rows = daily.json?.data ?? daily.json;
  console.log(`Rows: ${Array.isArray(rows) ? rows.length : '?'}`);
  console.log('Row shape:', JSON.stringify(shapeOf(rows), null, 2));
  save('05-daily-usage', daily.json);
} else {
  console.log('Failed:', JSON.stringify(daily.json ?? daily.raw));
  save('05-daily-usage-FAILED', daily);
}

// ── 6. Billing groups (free team rollups if configured) ──────────────────
banner('6. GET /teams/groups  (billing groups)');
const groups = await call('GET', '/teams/groups');
results.groups = groups;
console.log(`HTTP ${groups.status} in ${groups.ms}ms`);
if (groups.ok) {
  console.log('Response:', JSON.stringify(groups.json, null, 2).slice(0, 1500));
  save('06-groups', groups.json);
} else {
  console.log('Not available:', JSON.stringify(groups.json ?? groups.raw));
  save('06-groups-FAILED', groups);
}

// ── Summary ──────────────────────────────────────────────────────────────
banner('SUMMARY');
console.log(`Total API calls: ${callCount}`);
console.log(`members:              HTTP ${results.members.status}`);
console.log(`spend:                HTTP ${results.spend.status}`);
console.log(`filtered-usage-events HTTP ${results.events.status}`);
console.log(`daily-usage-data:     HTTP ${results.daily.status}`);
console.log(`groups:               HTTP ${results.groups.status}`);
const deepest = [...depth].reverse().find((d) => (d.total ?? 0) > 0 || d.returned > 0);
console.log(
  `\nDeepest window with data: ${deepest ? `${deepest.daysBack} days back (${deepest.date})` : 'none found'}`
);
console.log(`\nRaw samples written to: ${OUT}`);
