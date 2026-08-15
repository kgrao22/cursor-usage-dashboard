/**
 * Pull from Cursor, write to the store.
 *
 * Refresh re-pulls a trailing window rather than only what is new. Cursor
 * revises recent data for a day or two, and whole-day replacement means
 * re-fetching is free of consequence. A strictly incremental "everything after the last timestamp"
 * design would bake those provisional numbers in permanently.
 */

import { fetchMembers, fetchSpend, fetchUsageEvents } from './cursor.js';
import { getStore } from './store.js';
import { billingCycle, istDate } from './time.js';
import { config } from './config.js';

const DAY = 86_400_000;

/**
 * Routine refresh. Default 4-day trailing window comfortably covers the 6-hour
 * schedule plus any upstream revision.
 */
export async function refresh({ days = 4, log = console.log } = {}) {
  const started = Date.now();
  const store = await getStore();

  log('Fetching spend snapshot...');
  const spend = await fetchSpend();
  await store.saveSpendSnapshot(spend);
  const cycle = billingCycle(started, spend.cycleStart);
  log(`  cycle ${cycle.startLabel} -> ${cycle.endLabel}, day ${cycle.elapsedDays.toFixed(1)}/${cycle.totalDays}`);

  log('Fetching members...');
  const members = await fetchMembers();
  await store.saveMembers(members);
  log(`  ${members.length} members (${members.filter((m) => m.isRemoved).length} removed)`);

  // Always cover at least the whole cycle so cycle-to-date is never partial
  // after a gap in the schedule.
  const windowStart = Math.min(started - days * DAY, cycle.start);
  log(`Fetching events from ${istDate(windowStart)}...`);

  let saved = 0;
  await fetchUsageEvents(windowStart, started, async (batch, meta) => {
    saved += await store.saveEvents(batch);
    log(`  page ${meta.page}/${meta.numPages} — ${saved}/${meta.total} events`);
  });

  await store.setMeta({
    lastRefreshAt: String(started),
    lastRefreshDurationMs: String(Date.now() - started),
    lastRefreshEvents: String(saved),
  });

  log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${saved} events`);
  return { events: saved, members: members.length, durationMs: Date.now() - started };
}

/**
 * One-time historical load, month by month.
 *
 * Chunked monthly rather than one giant range because a single 10-month pull
 * would be ~35k events across ~35 pages, and any failure would lose the lot.
 * Per-month chunks are individually resumable.
 */
export async function backfill({ fromMonth = config.earliestDataMonth, log = console.log } = {}) {
  const store = await getStore();
  const started = Date.now();

  const [fy, fm] = fromMonth.split('-').map(Number);
  const first = Date.UTC(fy, fm - 1, 1);
  const now = new Date();
  const months = [];
  for (let d = new Date(first); d <= now; d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.push(new Date(d));
  }

  let grand = 0;
  for (const m of months) {
    const start = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1) - 5.5 * 3600e3;
    const end = Math.min(
      Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1) - 5.5 * 3600e3,
      Date.now()
    );
    const label = m.toISOString().slice(0, 7);

    let count = 0;
    try {
      await fetchUsageEvents(start, end, async (batch) => {
        count += await store.saveEvents(batch);
      });
    } catch (err) {
      log(`  ${label}: FAILED — ${err.message}`);
      continue;
    }
    grand += count;
    log(`  ${label}: ${count} events`);
  }

  // Roster and a spend snapshot, so a fresh install has something to render.
  await store.saveMembers(await fetchMembers());
  await store.saveSpendSnapshot(await fetchSpend());
  await store.setMeta({
    backfilledAt: String(started),
    backfillEvents: String(grand),
  });

  log(`Backfill complete — ${grand} events in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  return { events: grand };
}

/** Everything the dashboard needs, read back out of the store. */
export async function loadDashboardData({ historyDays = 90, now = Date.now() } = {}) {
  const store = await getStore();
  const snapshots = await store.getSpendSnapshots(now - 40 * DAY);
  const spend = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const members = await store.getMembers();
  const cycle = billingCycle(now, spend?.cycleStart);

  const cycleEvents = await store.getEvents(istDate(cycle.start), istDate(now));
  const historyEvents = await store.getEvents(istDate(now - historyDays * DAY), istDate(now));
  const meta = await store.getMeta();

  return { cycleEvents, historyEvents, spend, members, snapshots, meta, cycle };
}
