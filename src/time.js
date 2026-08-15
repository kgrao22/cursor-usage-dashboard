/**
 * Time and billing-cycle helpers.
 *
 * Two things this file exists to get right, because both quietly produce wrong
 * numbers in a spend dashboard:
 *
 *  1. Cursor timestamps are UTC epoch milliseconds ENCODED AS STRINGS
 *     ("1786764606294"). The team reads the dashboard in IST (UTC+5:30). Naive
 *     date handling puts everything between 00:00 and 05:30 IST on the wrong
 *     day, which breaks "spend today" and every day-over-day delta. IST has no
 *     DST, so a fixed offset is exact.
 *
 *  2. The billing cycle runs 10th to 10th and does NOT start at midnight — the
 *     observed subscriptionCycleStart is 2026-08-10T15:30:51 IST. "Month to
 *     date" is the wrong frame entirely: calendar August showed $1073 on-demand
 *     while the actual cycle showed $146, because Aug 1-9 belongs to the
 *     previous cycle.
 */

/** IST is UTC+5:30 year-round. No DST, so a fixed offset is safe. */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Fallback cycle anchor. Always prefer subscriptionCycleStart from the API —
 * this exists only for rendering before that call resolves.
 */
export const CYCLE_START_DAY = 10;

const DAY_MS = 86_400_000;

/**
 * Cursor sends epoch ms as a string. Number() on an ISO string yields NaN and
 * new Date(NaN).toISOString() throws, so every timestamp goes through here.
 */
export function toEpochMs(ts) {
  if (typeof ts === 'number') return ts;
  const n = Number(ts);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** 'YYYY-MM-DD' for the IST calendar day a UTC instant falls on. */
export function istDate(d) {
  const ms = toEpochMs(d);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** '15 Aug 2026, 19:03 IST' */
export function istLabel(d) {
  const ms = toEpochMs(d);
  if (!Number.isFinite(ms)) return '—';
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms)) + ' IST'
  );
}

/** '12 Aug' — compact axis label. */
export function istShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(d);
}

function istMidnightUtc(year, monthIndex, day) {
  return Date.UTC(year, monthIndex, day, 0, 0, 0, 0) - IST_OFFSET_MS;
}

/**
 * The billing cycle containing `now`.
 *
 * Pass cycleStartMs from the API's subscriptionCycleStart whenever available —
 * it carries the real time-of-day boundary. Cycle length varies (28-31 days),
 * so pacing must use totalDays, never a hardcoded 30.
 */
export function billingCycle(now = Date.now(), cycleStartMs) {
  let start;
  let end;

  const anchor = toEpochMs(cycleStartMs);
  if (Number.isFinite(anchor) && anchor > 0) {
    // Walk the anchor forward in whole months until it brackets `now`. The
    // anchor the API returns is the CURRENT cycle start, but this keeps the
    // function correct if it is ever handed an older one.
    const a = new Date(anchor + IST_OFFSET_MS);
    let months = 0;
    const at = (k) =>
      Date.UTC(
        a.getUTCFullYear(),
        a.getUTCMonth() + k,
        a.getUTCDate(),
        a.getUTCHours(),
        a.getUTCMinutes(),
        a.getUTCSeconds()
      ) - IST_OFFSET_MS;
    while (at(months + 1) <= now) months++;
    while (at(months) > now) months--;
    start = at(months);
    end = at(months + 1);
  } else {
    const ist = new Date(now + IST_OFFSET_MS);
    const y = ist.getUTCFullYear();
    const m = ist.getUTCMonth();
    const offset = ist.getUTCDate() >= CYCLE_START_DAY ? 0 : -1;
    start = istMidnightUtc(y, m + offset, CYCLE_START_DAY);
    end = istMidnightUtc(y, m + offset + 1, CYCLE_START_DAY);
  }

  const totalDays = Math.round((end - start) / DAY_MS);
  const elapsedDays = Math.max(0, Math.min(totalDays, (now - start) / DAY_MS));

  return {
    start,
    end,
    startLabel: istDate(start),
    endLabel: istDate(end),
    totalDays,
    elapsedDays,
    daysRemaining: Math.max(0, totalDays - elapsedDays),
    progress: totalDays > 0 ? Math.min(1, elapsedDays / totalDays) : 0,
  };
}

/** The cycle immediately before the one containing `now`. Used for deltas. */
export function previousCycle(now = Date.now(), cycleStartMs) {
  const current = billingCycle(now, cycleStartMs);
  return billingCycle(current.start - 1, cycleStartMs);
}

/** Every IST date string in [start, end], oldest first. Zero-fills chart gaps. */
export function istDateRange(start, end) {
  const out = [];
  let cursor = new Date(start + IST_OFFSET_MS).setUTCHours(0, 0, 0, 0) - IST_OFFSET_MS;
  while (cursor <= end) {
    out.push(istDate(cursor));
    cursor += DAY_MS;
  }
  return out;
}

/**
 * Project cycle-end spend, two ways, deliberately.
 *
 *  - `linear` extrapolates the whole-cycle average. Stable, but early in a
 *    cycle it is dominated by whatever happened on day one.
 *  - `recent` extrapolates the trailing-7-day rate. Reacts to a spike like the
 *    July Opus incident, which is the failure mode this dashboard exists for.
 *
 * Show both. When they diverge sharply, that divergence IS the signal.
 */
export function forecast(spentCents, recentDailyCents, cycle) {
  const c = cycle ?? billingCycle();
  const linearRate = c.elapsedDays > 0 ? spentCents / c.elapsedDays : 0;
  return {
    linear: Math.round(spentCents + linearRate * c.daysRemaining),
    recent: Math.round(spentCents + recentDailyCents * c.daysRemaining),
    daysRemaining: c.daysRemaining,
  };
}
