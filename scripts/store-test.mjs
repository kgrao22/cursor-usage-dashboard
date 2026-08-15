import { FileStore } from '../src/store.js';
import { normalizeEvent } from '../src/cursor.js';
import { rm } from 'node:fs/promises';

const DIR = '/tmp/store-test-data';
await rm(DIR, { recursive: true, force: true });
const s = new FileStore(DIR);
await s.init();

const mk = (tsMs, cents, kind = 'Usage-based') => normalizeEvent({
  timestamp: String(tsMs), model: 'composer-2.5', kind, chargedCents: cents,
  tokenUsage: { totalCents: cents }, serviceAccountId: 'null', userEmail: 'a@example.com',
});

const D1 = Date.parse('2026-08-12T06:00:00Z');
const D2 = Date.parse('2026-08-13T06:00:00Z');
let fails = 0;
const check = (n, c, x='') => { console.log(`  ${c?'PASS':'FAIL'}  ${n} ${x}`); if(!c) fails++; };

// First write
await s.saveEvents([mk(D1, 100), mk(D1, 200), mk(D2, 50)]);
let all = await s.getEvents('2026-08-01', '2026-08-31');
check('writes then reads back', all.length === 3, `(got ${all.length})`);

// Re-running the SAME day must replace, not append — this is the whole
// idempotency guarantee that makes a re-run safe.
await s.saveEvents([mk(D1, 100), mk(D1, 200)]);
all = await s.getEvents('2026-08-01', '2026-08-31');
check('re-ingesting a day replaces it', all.length === 3, `(got ${all.length}, expected 3)`);

// A day that shrinks upstream must shrink here too.
await s.saveEvents([mk(D1, 999)]);
all = await s.getEvents('2026-08-01', '2026-08-31');
check('a revised day overwrites wholesale', all.length === 2, `(got ${all.length}, expected 2)`);
check('untouched day survives', all.some(e => e.istDate === '2026-08-13'));
check('revised value present', all.some(e => e.chargedCents === 999));

// Range filtering
const narrow = await s.getEvents('2026-08-13', '2026-08-13');
check('date range filters', narrow.length === 1, `(got ${narrow.length})`);

// Cross-month
await s.saveEvents([mk(Date.parse('2026-07-20T06:00:00Z'), 42)]);
check('cross-month write lands in its own file',
  (await s.getEvents('2026-07-01', '2026-07-31')).length === 1);
check('cross-month read spans files',
  (await s.getEvents('2026-07-01', '2026-08-31')).length === 3);

// Snapshots + meta
await s.saveSpendSnapshot({ capturedAt: 1000, rows: [] });
await s.saveSpendSnapshot({ capturedAt: 2000, rows: [] });
const snaps = await s.getSpendSnapshots(0);
check('snapshots append and order', snaps.length === 2 && snaps[1].capturedAt === 2000);
check('snapshot since-filter works', (await s.getSpendSnapshots(1500)).length === 1);
await s.setMeta({ a: '1' }); await s.setMeta({ b: '2' });
const meta = await s.getMeta();
check('meta merges rather than clobbers', meta.a === '1' && meta.b === '2');

await rm(DIR, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nFileStore OK');
process.exit(fails ? 1 : 0);
