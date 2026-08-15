/**
 * Cursor Admin API client.
 *
 * Everything here is written against OBSERVED responses, not the published
 * docs, because the two disagree in ways that matter:
 *
 *  - `overallSpendCents` is documented but never returned. Do not use it.
 *  - `includedSpendCents`, `billingTier`, `autoPercentUsed`, `apiPercentUsed`
 *    and `totalPercentUsed` are returned but undocumented. They only populate
 *    for tiered self-serve teams (billingTier e.g. TIER_1000).
 *  - `timestamp` is epoch milliseconds encoded as a string.
 *  - `serviceAccountId` is the literal string "null" when unset, not null.
 *  - `chargedCents` is NOT reliably tokenUsage.totalCents + cursorTokenFee.
 *    That identity held for 953 of 1208 sampled events and broke for 255, with
 *    deltas up to 1.88 cents. So `chargedCents` is treated as authoritative and
 *    never recomputed.
 *  - `kind` splits gross charge into "Usage-based" (on-demand, the invoice
 *    line) and "Included in Business" (drawn from the prepaid pool). Verified
 *    against /teams/spend to within $1.77 on a $604 cycle.
 */

import { config } from './config.js';
import { toEpochMs, istDate } from './time.js';

const BASE = config.cursor.baseUrl;

/** Observed limits: 60/min on filtered-usage-events, 20/min elsewhere. */
const RATE = {
  '/teams/filtered-usage-events': 60,
  default: 20,
};

const lastCallAt = new Map();

async function throttle(path) {
  const perMin = RATE[path] ?? RATE.default;
  // 15% headroom — bursting right at the documented ceiling earns 429s.
  const minGap = (60_000 / perMin) * 1.15;
  const last = lastCallAt.get(path) ?? 0;
  const wait = last + minGap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(path, Date.now());
}

function authHeader() {
  const key = config.cursor.apiKey?.trim();
  if (!key) throw new Error('CURSOR_API_KEY is not set');
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

async function request(method, path, body, attempt = 0) {
  await throttle(path);

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      return request(method, path, body, attempt + 1);
    }
    throw new Error(`${method} ${path} failed: ${err.message}`);
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt < 4) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 2000;
      await new Promise((r) => setTimeout(r, delay));
      return request(method, path, body, attempt + 1);
    }
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/** Team roster. Includes departed members flagged isRemoved. */
export async function fetchMembers() {
  const json = await request('GET', '/teams/members');
  return (json.teamMembers ?? []).map((m) => ({
    userId: String(m.id ?? ''),
    email: m.email ?? '',
    name: m.name ?? '',
    role: m.role ?? '',
    isRemoved: Boolean(m.isRemoved),
  }));
}

/**
 * Current-cycle spend. This endpoint has no history and no date parameters —
 * it is a point-in-time snapshot, which is exactly why we persist it every run.
 * Also the only place subscriptionCycleStart is exposed.
 */
export async function fetchSpend() {
  const json = await request('POST', '/teams/spend', { page: 1, pageSize: 500 });
  const rows = (json.teamMemberSpend ?? []).map((r) => ({
    userId: String(r.userId ?? ''),
    email: r.email ?? '',
    name: r.name ?? '',
    role: r.role ?? '',
    spendCents: r.spendCents ?? 0,
    includedSpendCents: r.includedSpendCents ?? 0,
    fastPremiumRequests: r.fastPremiumRequests ?? 0,
    monthlyLimitDollars: r.monthlyLimitDollars ?? null,
    hardLimitOverrideDollars: r.hardLimitOverrideDollars ?? 0,
    billingTier: r.billingTier ?? null,
    autoPercentUsed: r.autoPercentUsed ?? null,
    apiPercentUsed: r.apiPercentUsed ?? null,
    totalPercentUsed: r.totalPercentUsed ?? null,
  }));

  return {
    rows,
    cycleStart: toEpochMs(json.subscriptionCycleStart),
    totalMembers: json.totalMembers ?? rows.length,
    limitedUsersCount: json.limitedUsersCount ?? 0,
    maxUserSpendCents: json.maxUserSpendCents ?? 0,
    capturedAt: Date.now(),
  };
}

const UNSET = new Set(['null', 'undefined', '', 'none']);
const clean = (v) => (v == null || UNSET.has(String(v).toLowerCase()) ? null : String(v));

/** Canonical event shape. All downstream code reads this, never the raw payload. */
export function normalizeEvent(e) {
  const ms = toEpochMs(e.timestamp);
  const kind = e.kind ?? 'unknown';
  const charged = e.chargedCents ?? 0;
  const onDemand = /usage.based|on.demand/i.test(kind);

  const serviceAccountId = clean(e.serviceAccountId);
  const cloudAgentId = clean(e.cloudAgentId);
  const automationId = clean(e.automationId);

  return {
    tsMs: ms,
    istDate: istDate(ms),
    userEmail: e.userEmail ?? null,
    model: e.model ?? 'unknown',
    kind,
    /** True when this call bills on top of the subscription. The invoice line. */
    isOnDemand: onDemand,
    onDemandCents: onDemand ? charged : 0,
    includedCents: onDemand ? 0 : charged,
    chargedCents: charged,
    maxMode: Boolean(e.maxMode),
    requestsCosts: e.requestsCosts ?? 0,
    isChargeable: Boolean(e.isChargeable),
    isTokenBasedCall: Boolean(e.isTokenBasedCall),
    cursorTokenFee: e.cursorTokenFee ?? 0,
    inputTokens: e.tokenUsage?.inputTokens ?? 0,
    outputTokens: e.tokenUsage?.outputTokens ?? 0,
    cacheWriteTokens: e.tokenUsage?.cacheWriteTokens ?? 0,
    cacheReadTokens: e.tokenUsage?.cacheReadTokens ?? 0,
    tokenCents: e.tokenUsage?.totalCents ?? 0,
    serviceAccountId,
    cloudAgentId,
    automationId,
    conversationId: clean(e.conversationId),
    isHeadless: Boolean(e.isHeadless),
    /** Anything not driven by a human at a keyboard. */
    isNonHuman: Boolean(serviceAccountId || cloudAgentId || automationId || e.isHeadless),
  };
}

/**
 * All usage events in [startMs, endMs], paginated.
 *
 * `onPage` is called with each normalized batch so callers can stream a large
 * backfill to storage instead of holding ~35k events in memory.
 */
export async function fetchUsageEvents(startMs, endMs, onPage) {
  const out = [];
  let page = 1;
  let numPages = 1;
  let total = null;

  while (page <= numPages) {
    const json = await request('POST', '/teams/filtered-usage-events', {
      startDate: startMs,
      endDate: endMs,
      page,
      pageSize: 1000,
    });

    total ??= json.totalUsageEventsCount ?? 0;
    const batch = (json.usageEvents ?? [])
      .map(normalizeEvent)
      .filter((e) => Number.isFinite(e.tsMs));

    if (onPage) await onPage(batch, { page, numPages, total });
    else out.push(...batch);

    numPages = json.pagination?.numPages ?? 1;
    if (!json.pagination?.hasNextPage) break;
    page++;

    // Runaway guard: 1000/page * 200 pages is far beyond any real window.
    if (page > 200) break;
  }

  return { events: out, total };
}

/**
 * Productivity metrics. Hard 30-day cap per request, so longer ranges are
 * chunked. Not used by the cost-control view; kept for the adoption question
 * that finance always asks second ("are we getting value for this?").
 */
export async function fetchDailyUsage(startMs, endMs) {
  const CHUNK = 29 * 86_400_000;
  const rows = [];
  for (let s = startMs; s < endMs; s += CHUNK) {
    const e = Math.min(s + CHUNK, endMs);
    const json = await request('POST', '/teams/daily-usage-data', { startDate: s, endDate: e });
    for (const r of json.data ?? []) {
      rows.push({
        istDate: istDate(r.date),
        userId: String(r.userId ?? ''),
        email: r.email ?? '',
        isActive: Boolean(r.isActive),
        acceptedLinesAdded: r.acceptedLinesAdded ?? 0,
        totalLinesAdded: r.totalLinesAdded ?? 0,
        totalAccepts: r.totalAccepts ?? 0,
        totalRejects: r.totalRejects ?? 0,
        totalTabsAccepted: r.totalTabsAccepted ?? 0,
        agentRequests: r.agentRequests ?? 0,
        chatRequests: r.chatRequests ?? 0,
        composerRequests: r.composerRequests ?? 0,
        usageBasedReqs: r.usageBasedReqs ?? 0,
        mostUsedModel: r.mostUsedModel ?? null,
      });
    }
  }
  return rows;
}
