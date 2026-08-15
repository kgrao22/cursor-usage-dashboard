#!/usr/bin/env node
/**
 * One-time historical load.
 *
 * Cursor's retention window varies by team — in one observed account it
 * reached back about ten months, roughly 35,000 events. Small enough to hold
 * entirely, long enough to make the trend chart worth looking at. Run
 * `npm run explore` to find your own boundary.
 *
 *   node scripts/backfill.mjs
 *   node scripts/backfill.mjs --from 2026-01
 *
 * Safe to re-run: ingestion replaces whole days rather than appending.
 */
import { backfill } from '../src/ingest.js';
import { config } from '../src/config.js';

if (!process.env.CURSOR_API_KEY) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    /* fall through */
  }
}

const argv = process.argv.slice(2);
const fromIdx = argv.indexOf('--from');
const fromMonth = fromIdx >= 0 ? argv[fromIdx + 1] : config.earliestDataMonth;

console.log(`Backfilling from ${fromMonth} to now. This takes a few minutes.\n`);

try {
  await backfill({ fromMonth });
  process.exit(0);
} catch (err) {
  console.error('Backfill failed:', err.message);
  process.exit(1);
}
