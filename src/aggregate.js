/**
 * Every number the dashboard shows is computed here, once.
 *
 * The organising idea: Cursor charges you in two different ways and only one
 * of them lands on the invoice. `chargedCents` is the gross value of a call;
 * `kind` decides whether the Business pool absorbed it ("Included in Business")
 * or it billed on top ("Usage-based"). Verified against /teams/spend to within
 * $1.77 on a $604 cycle.
 *
 * Showing only on-demand hides where the next bill shock is being built. In the
 * observed cycle, the single largest consumer of value showed $0.00 of
 * on-demand spend — invisible on a spend-ranked table while quietly filling
 * the pool. So every user-facing cut carries both figures.
 */

import { config, modelFamily, PREMIUM_FAMILIES } from './config.js';
import { billingCycle, istDateRange, istDate, forecast, toEpochMs } from './time.js';

const usd = (cents) => cents / 100;

function sum(events, field) {
  let t = 0;
  for (const e of events) t += e[field] ?? 0;
  return t;
}

function groupBy(events, keyFn) {
  const m = new Map();
  for (const e of events) {
    const k = keyFn(e) ?? 'unknown';
    if (!m.has(k)) {
      m.set(k, { key: k, events: 0, onDemandCents: 0, includedCents: 0, chargedCents: 0 });
    }
    const g = m.get(k);
    g.events++;
    g.onDemandCents += e.onDemandCents ?? 0;
    g.includedCents += e.includedCents ?? 0;
    g.chargedCents += e.chargedCents ?? 0;
  }
  return [...m.values()].sort((a, b) => b.chargedCents - a.chargedCents);
}

/** Per-IST-day totals, zero-filled so charts have no invisible gaps. */
export function dailySeries(events, startMs, endMs) {
  const byDay = new Map();
  for (const e of events) {
    if (!byDay.has(e.istDate)) {
      byDay.set(e.istDate, { date: e.istDate, events: 0, onDemandCents: 0, includedCents: 0, chargedCents: 0 });
    }
    const d = byDay.get(e.istDate);
    d.events++;
    d.onDemandCents += e.onDemandCents ?? 0;
    d.includedCents += e.includedCents ?? 0;
    d.chargedCents += e.chargedCents ?? 0;
  }
  return istDateRange(startMs, endMs).map(
    (date) => byDay.get(date) ?? { date, events: 0, onDemandCents: 0, includedCents: 0, chargedCents: 0 }
  );
}

/**
 * Alerts, in severity order.
 *
 * Each one is a question a finance lead actually asks, turned into something
 * a machine checks every six hours instead of a person noticing ten days late.
 */
function buildAlerts({ cycle, cycleEvents, onDemandCents, projected, byUser, series, nonHuman, pool }) {
  const alerts = [];
  const budgetOnDemand = config.onDemandBudgetUsd * 100;
  const budgetTotal = config.monthlyBudgetUsd * 100;

  // Already over.
  if (onDemandCents > budgetOnDemand) {
    alerts.push({
      level: 'critical',
      title: 'On-demand budget exceeded',
      detail: `$${usd(onDemandCents).toFixed(2)} spent against a $${config.onDemandBudgetUsd} cap, with ${Math.floor(cycle.daysRemaining)} days left in the cycle.`,
    });
  } else if (projected.recent > budgetOnDemand * config.warnAtProjectedFraction) {
    // Pacing toward over, judged on the recent rate rather than the cycle
    // average — the average is what let the July spike hide.
    alerts.push({
      level: projected.recent > budgetOnDemand ? 'critical' : 'warning',
      title: 'Pacing past the on-demand budget',
      detail: `Trailing 7-day rate projects $${usd(projected.recent).toFixed(0)} by ${cycle.endLabel}, against a $${config.onDemandBudgetUsd} cap.`,
    });
  }

  if (projected.recent > budgetTotal * config.warnAtProjectedFraction) {
    alerts.push({
      level: 'warning',
      title: 'Pacing past the total monthly budget',
      detail: `Projected $${usd(projected.recent).toFixed(0)} against $${config.monthlyBudgetUsd}.`,
    });
  }

  // One person carrying the bill. A single user was 97% of on-demand spend
  // in the observed data, which no aggregate total would have revealed.
  const top = byUser[0];
  if (top && onDemandCents > 0) {
    const share = top.onDemandCents / onDemandCents;
    if (share >= config.concentrationAlertFraction) {
      alerts.push({
        level: 'warning',
        title: 'On-demand spend is concentrated in one person',
        detail: `${top.key} is $${usd(top.onDemandCents).toFixed(2)} of $${usd(onDemandCents).toFixed(2)} — ${(share * 100).toFixed(0)}% of all on-demand spend.`,
      });
    }
  }

  // Day-over-day spike against the trailing mean.
  const withData = series.filter((d) => d.events > 0);
  if (withData.length >= 3) {
    const latest = withData[withData.length - 1];
    const prior = withData.slice(-8, -1);
    const mean = prior.length ? prior.reduce((a, d) => a + d.chargedCents, 0) / prior.length : 0;
    if (mean > 0 && latest.chargedCents > mean * config.spikeMultiple) {
      alerts.push({
        level: 'warning',
        title: `Spend spike on ${latest.date}`,
        detail: `$${usd(latest.chargedCents).toFixed(2)} against a trailing average of $${usd(mean).toFixed(2)} — ${(latest.chargedCents / mean).toFixed(1)}x.`,
      });
    }
  }

  // The included pool is where the next overage is quietly assembled.
  if (pool.maxPercentUsed != null && pool.maxPercentUsed >= 80) {
    alerts.push({
      level: pool.maxPercentUsed >= 95 ? 'critical' : 'warning',
      title: 'Included pool nearly exhausted',
      detail: `${pool.atRisk.length} member(s) above 80% of their included usage. Everything past the pool bills as on-demand.`,
    });
  }

  // Background agents: rare, individually expensive, easy to forget exist.
  if (nonHuman.chargedCents > 0) {
    const share = nonHuman.chargedCents / (sum(cycleEvents, 'chargedCents') || 1);
    if (share > 0.1) {
      alerts.push({
        level: 'info',
        title: 'Background agents are a material share of spend',
        detail: `${nonHuman.events} automated call(s) cost $${usd(nonHuman.chargedCents).toFixed(2)} — ${(share * 100).toFixed(0)}% of the cycle.`,
      });
    }
  }

  if (!alerts.length) {
    alerts.push({
      level: 'ok',
      title: 'Nothing needs attention',
      detail: `On-demand at $${usd(onDemandCents).toFixed(2)} of $${config.onDemandBudgetUsd}, pacing to $${usd(projected.recent).toFixed(0)}.`,
    });
  }
  return alerts;
}

/**
 * Build the whole view model.
 *
 * @param cycleEvents  events inside the current billing cycle
 * @param historyEvents  a longer window (default 90d) for trend context
 * @param spend  latest /teams/spend snapshot
 * @param members  roster, so departed staff still resolve to a name
 */
export function buildDashboard({ cycleEvents, historyEvents, spend, members = [], now = Date.now() }) {
  const cycle = billingCycle(now, spend?.cycleStart);

  const onDemandCents = sum(cycleEvents, 'onDemandCents');
  const includedCents = sum(cycleEvents, 'includedCents');
  const chargedCents = sum(cycleEvents, 'chargedCents');

  const series = dailySeries(cycleEvents, cycle.start, Math.min(now, cycle.end));
  const today = istDate(now);
  const yesterday = istDate(now - 86_400_000);
  const todayRow = series.find((d) => d.date === today);
  const yesterdayRow = series.find((d) => d.date === yesterday);

  // Trailing 7 days of *complete* days — today is partial and would drag the
  // rate down, making the forecast look better than it is.
  const complete = series.filter((d) => d.date !== today);
  const last7 = complete.slice(-7);
  const recentDailyOnDemand = last7.length
    ? last7.reduce((a, d) => a + d.onDemandCents, 0) / last7.length
    : 0;

  const projected = forecast(onDemandCents, recentDailyOnDemand, cycle);
  const projectedTotal = forecast(
    chargedCents,
    last7.length ? last7.reduce((a, d) => a + d.chargedCents, 0) / last7.length : 0,
    cycle
  );

  const nameOf = new Map(members.map((m) => [m.email, m.name || m.email]));

  const byUser = groupBy(cycleEvents, (e) => e.userEmail).map((g) => ({
    ...g,
    name: nameOf.get(g.key) ?? g.key,
  }));
  const byModel = groupBy(cycleEvents, (e) => e.model);
  const byFamily = groupBy(cycleEvents, (e) => modelFamily(e.model)).map((g) => ({
    ...g,
    premium: PREMIUM_FAMILIES.has(g.key),
  }));

  const nonHumanEvents = cycleEvents.filter((e) => e.isNonHuman);
  const nonHuman = {
    events: nonHumanEvents.length,
    chargedCents: sum(nonHumanEvents, 'chargedCents'),
    onDemandCents: sum(nonHumanEvents, 'onDemandCents'),
    agents: groupBy(nonHumanEvents, (e) => e.cloudAgentId ?? e.automationId ?? 'headless').slice(0, 10),
    byUser: groupBy(nonHumanEvents, (e) => e.userEmail).slice(0, 5),
  };

  const expensiveCalls = cycleEvents
    .filter((e) => e.chargedCents >= config.expensiveCallUsd * 100)
    .sort((a, b) => b.chargedCents - a.chargedCents)
    .slice(0, 15)
    .map((e) => ({
      date: e.istDate,
      user: e.userEmail,
      model: e.model,
      kind: e.kind,
      chargedCents: e.chargedCents,
      cacheReadTokens: e.cacheReadTokens,
      isNonHuman: e.isNonHuman,
    }));

  // Pool status from the spend snapshot's undocumented percent fields.
  const poolRows = (spend?.rows ?? []).filter((r) => r.totalPercentUsed != null);
  const pool = {
    available: poolRows.length > 0,
    maxPercentUsed: poolRows.length ? Math.max(...poolRows.map((r) => r.totalPercentUsed)) : null,
    atRisk: poolRows
      .filter((r) => r.totalPercentUsed >= 80)
      .sort((a, b) => b.totalPercentUsed - a.totalPercentUsed)
      .map((r) => ({ email: r.email, percent: r.totalPercentUsed })),
    rows: poolRows
      .sort((a, b) => b.totalPercentUsed - a.totalPercentUsed)
      .map((r) => ({
        email: r.email,
        total: r.totalPercentUsed,
        auto: r.autoPercentUsed,
        api: r.apiPercentUsed,
        tier: r.billingTier,
      })),
  };

  const historyStart = historyEvents.length ? historyEvents[0].tsMs : cycle.start;
  const history = dailySeries(historyEvents, historyStart, now);

  // Members with zero activity this cycle — seats that may not need paying for.
  const active = new Set(cycleEvents.map((e) => e.userEmail));
  const idle = members
    .filter((m) => !m.isRemoved && !active.has(m.email))
    .map((m) => ({ email: m.email, name: m.name || m.email }));

  const alerts = buildAlerts({
    cycle, cycleEvents, onDemandCents, projected, byUser, series, nonHuman, pool,
  });

  return {
    generatedAt: now,
    cycle,
    limitsConfigured: (spend?.rows ?? []).some((r) => r.monthlyLimitDollars != null),
    totals: {
      onDemandCents,
      includedCents,
      chargedCents,
      events: cycleEvents.length,
      onDemandBudgetCents: config.onDemandBudgetUsd * 100,
      monthlyBudgetCents: config.monthlyBudgetUsd * 100,
      onDemandBudgetUsed: onDemandCents / (config.onDemandBudgetUsd * 100),
      monthlyBudgetUsed: chargedCents / (config.monthlyBudgetUsd * 100),
    },
    today: {
      date: today,
      onDemandCents: todayRow?.onDemandCents ?? 0,
      chargedCents: todayRow?.chargedCents ?? 0,
      events: todayRow?.events ?? 0,
      deltaOnDemand: (todayRow?.onDemandCents ?? 0) - (yesterdayRow?.onDemandCents ?? 0),
      deltaCharged: (todayRow?.chargedCents ?? 0) - (yesterdayRow?.chargedCents ?? 0),
      yesterdayCharged: yesterdayRow?.chargedCents ?? 0,
    },
    projected,
    projectedTotal,
    recentDailyOnDemand,
    series,
    history,
    byUser,
    byModel,
    byFamily,
    nonHuman,
    expensiveCalls,
    pool,
    idle,
    alerts,
    spendSnapshot: spend
      ? {
          capturedAt: spend.capturedAt,
          totalSpendCents: (spend.rows ?? []).reduce((a, r) => a + r.spendCents, 0),
          totalIncludedCents: (spend.rows ?? []).reduce((a, r) => a + r.includedSpendCents, 0),
          limitedUsersCount: spend.limitedUsersCount,
        }
      : null,
  };
}

/**
 * Cross-check the event-derived on-demand total against /teams/spend.
 *
 * These come from different endpoints and will never match to the cent — the
 * snapshot is taken at a different instant to the event pull. A small residual
 * is expected and healthy; a large one means the `kind` mapping has drifted and
 * the headline number is no longer trustworthy. Better to say so on the page
 * than to be corrected in the meeting.
 */
export function reconcile(dashboard, spend) {
  if (!spend?.rows?.length) return null;
  const apiOnDemand = spend.rows.reduce((a, r) => a + r.spendCents, 0);
  const apiIncluded = spend.rows.reduce((a, r) => a + r.includedSpendCents, 0);
  const d1 = dashboard.totals.onDemandCents - apiOnDemand;
  const d2 = dashboard.totals.includedCents - apiIncluded;
  const tolerance = Math.max(500, apiOnDemand * 0.05);
  return {
    apiOnDemandCents: apiOnDemand,
    apiIncludedCents: apiIncluded,
    deltaOnDemandCents: d1,
    deltaIncludedCents: d2,
    ok: Math.abs(d1) <= tolerance && Math.abs(d2) <= tolerance,
    capturedAt: toEpochMs(spend.capturedAt),
  };
}
