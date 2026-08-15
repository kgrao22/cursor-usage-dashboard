/**
 * Everything tunable, in one file.
 *
 * Budgets are placeholders — set MONTHLY_BUDGET_USD and ON_DEMAND_BUDGET_USD
 * for your own team. Everything is env-overridable so nobody has to redeploy to
 * change a number before a board meeting.
 */

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  /** Team-wide ceiling for the billing cycle, USD. */
  monthlyBudgetUsd: num(process.env.MONTHLY_BUDGET_USD, 1000),

  /** How much of that ceiling may be spent on-demand (beyond the included pool), USD. */
  onDemandBudgetUsd: num(process.env.ON_DEMAND_BUDGET_USD, 500),

  /** Warn when cycle pacing projects past this fraction of budget. */
  warnAtProjectedFraction: num(process.env.WARN_AT_PROJECTED, 0.9),

  /** Flag a single user who accounts for more than this share of on-demand spend. */
  concentrationAlertFraction: num(process.env.CONCENTRATION_ALERT, 0.5),

  /** Flag a day whose on-demand spend exceeds the trailing-7-day mean by this multiple. */
  spikeMultiple: num(process.env.SPIKE_MULTIPLE, 2.5),

  /** Individual call cost that earns a callout, USD. Background agents hit this. */
  expensiveCallUsd: num(process.env.EXPENSIVE_CALL_USD, 2),

  /**
   * How far back to backfill. Cursor's retention varies by team — run
   * `npm run explore` to find your own boundary, then set this.
   */
  earliestDataMonth: process.env.EARLIEST_DATA_MONTH || '2025-10',

  storage: {
    /** 'file' for local phase 1, 'bigquery' for Cloud Run. */
    driver: process.env.STORAGE_DRIVER || 'file',
    dataDir: process.env.DATA_DIR || './data',
    bigquery: {
      projectId: process.env.GCP_PROJECT_ID,
      datasetId: process.env.BQ_DATASET || 'cursor_usage',
      location: process.env.BQ_LOCATION || 'US',
    },
  },

  cursor: {
    apiKey: process.env.CURSOR_API_KEY,
    baseUrl: 'https://api.cursor.com',
  },

  /** Shared secret Cloud Scheduler presents to /api/refresh. */
  refreshToken: process.env.REFRESH_TOKEN || '',

  port: num(process.env.PORT, 8080),
};

/**
 * Model family grouping.
 *
 * Cursor reports the same underlying model under several names — "Opus 5
 * (Auto Balanced)", "claude-opus-4-8-thinking-high", "Opus 4.8 (Auto
 * Balanced)" are all Opus. Ungrouped, the cost of a family is scattered across
 * rows and no single line looks alarming, which is precisely how the July
 * spike stayed invisible for ten days.
 */
export function modelFamily(model) {
  const m = String(model ?? '').toLowerCase();
  if (m.includes('opus')) return 'Claude Opus';
  if (m.includes('sonnet')) return 'Claude Sonnet';
  if (m.includes('fable')) return 'Claude Fable';
  if (m.includes('haiku')) return 'Claude Haiku';
  if (m.includes('composer')) return 'Composer';
  if (m.includes('grok')) return 'Grok';
  if (m.includes('gpt') || m.includes('sol')) return 'GPT';
  if (m.includes('gemini')) return 'Gemini';
  if (m === 'default') return 'Default';
  return 'Other';
}

/** Families that cost materially more per call and deserve their own scrutiny. */
export const PREMIUM_FAMILIES = new Set(['Claude Opus', 'Claude Fable']);
