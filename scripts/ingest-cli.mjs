#!/usr/bin/env node
/**
 * Routine refresh. This is what the Cloud Run Job runs every 6 hours, and what
 * you run locally when you want fresh numbers now.
 *
 *   node scripts/ingest-cli.mjs            # trailing 4 days + whole cycle
 *   node scripts/ingest-cli.mjs --days 14
 */
import { refresh } from '../src/ingest.js';

if (!process.env.CURSOR_API_KEY) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    /* fall through */
  }
}

const argv = process.argv.slice(2);
const daysIdx = argv.indexOf('--days');
const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 4;

try {
  await refresh({ days });
  process.exit(0);
} catch (err) {
  console.error('Refresh failed:', err.message);
  process.exit(1);
}
