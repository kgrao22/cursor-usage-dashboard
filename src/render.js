/**
 * Server-rendered HTML. Charts are inline SVG built here — no chart library, no
 * CDN, no build step. A dashboard that has to work in front of the CX team on a
 * Monday morning should not depend on a script tag resolving.
 *
 * Colour carries one meaning throughout, and only one:
 *   blue   = on-demand   (billed on top of the subscription — the invoice line)
 *   orange = included    (absorbed by the Business pool)
 * Validated for CVD separation and surface contrast in both light and dark
 * (worst adjacent pair ΔE 24.7 protan / 33.6 normal, both well clear of gates).
 * Status colours are reserved for alerts and always ship with an icon + label,
 * never colour alone.
 */

import { istShort, istLabel } from './time.js';
import { config } from './config.js';

const money = (cents, dp = 2) =>
  '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const money0 = (cents) => money(cents, 0);
const pct = (f) => (f * 100).toFixed(0) + '%';
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ICON = {
  critical: '&#9679;',
  warning: '&#9650;',
  serious: '&#9650;',
  info: '&#9432;',
  ok: '&#10003;',
};

// ── SVG chart helpers ────────────────────────────────────────────────────

/**
 * Stacked columns, on-demand over included.
 * Part-to-whole over time, two series — a stacked bar is the right form and two
 * adjacent categorical slots are inside every gate.
 */
function stackedColumns(series, { height = 200, label = '' } = {}) {
  if (!series.length) return '<p class="empty">No data in this window.</p>';

  const n = series.length;
  // Fixed viewBox width. Sizing the viewBox to the bar count instead makes the
  // browser scale the whole drawing to fit the container, which blows axis type
  // up several times over on a short series and shrinks it on a long one.
  const W = 1000;
  const LEFT = 52;
  const RIGHT = 10;
  const plotW = W - LEFT - RIGHT;
  const gap = n > 45 ? 1 : n > 14 ? 2 : 4;
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(46, slot - gap));
  const H = height;
  const top = 14;
  const bottom = H - 26;
  const plotH = bottom - top;

  const max = Math.max(...series.map((d) => d.chargedCents), 1);
  const { step, max: niceMax } = niceScale(max, 4);
  const y = (v) => bottom - (v / niceMax) * plotH;

  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const grid = ticks
    .map(
      (t) =>
        `<line x1="${LEFT - 4}" x2="${W - RIGHT}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="grid"/>` +
        `<text x="${LEFT - 10}" y="${(y(t) + 4).toFixed(1)}" class="tick" text-anchor="end">${money0(t)}</text>`
    )
    .join('');

  const bars = series
    .map((d, i) => {
      const x = LEFT + i * slot + (slot - barW) / 2;
      const incH = (d.includedCents / niceMax) * plotH;
      const odH = (d.onDemandCents / niceMax) * plotH;
      const r = Math.min(4, barW / 2);
      // 2px surface gap between stacked segments so they read as separate marks.
      const incY = bottom - incH;
      const odY = incY - odH - (odH > 0 && incH > 0 ? 2 : 0);
      const title =
        `${d.date}\nOn-demand ${money(d.onDemandCents)}\nIncluded ${money(d.includedCents)}\n${d.events} calls`;

      let out = `<g class="col" tabindex="0"><title>${esc(title)}</title>`;
      if (incH > 0.4)
        out += `<rect x="${x}" y="${incY.toFixed(1)}" width="${barW}" height="${incH.toFixed(1)}" fill="var(--series-2)" rx="${odH > 0.4 ? 0 : r}"/>`;
      if (odH > 0.4)
        out += `<rect x="${x}" y="${odY.toFixed(1)}" width="${barW}" height="${odH.toFixed(1)}" fill="var(--series-1)" rx="${r}"/>`;
      out += `<rect x="${x}" y="${top}" width="${barW}" height="${plotH}" fill="transparent" class="hit"/></g>`;
      return out;
    })
    .join('');

  // Space labels so they never collide: ~64px of viewBox per label.
  const every = Math.max(1, Math.ceil(n / Math.floor(plotW / 64)));
  const xlabels = series
    .map((d, i) =>
      i % every === 0 || i === n - 1
        ? `<text x="${(LEFT + i * slot + slot / 2).toFixed(1)}" y="${H - 8}" class="tick" text-anchor="middle">${esc(istShort(d.date))}</text>`
        : ''
    )
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">
    ${grid}<line x1="${LEFT - 4}" x2="${W - RIGHT}" y1="${bottom}" y2="${bottom}" class="axis"/>${bars}${xlabels}
  </svg>`;
}

/** Horizontal stacked bars for ranked entities with long names. */
function rankedBars(rows, { max, showIncluded = true } = {}) {
  if (!rows.length) return '<p class="empty">No activity.</p>';
  const top = max ?? Math.max(...rows.map((r) => r.chargedCents), 1);
  return `<div class="ranked">${rows
    .map((r) => {
      const od = (r.onDemandCents / top) * 100;
      const inc = showIncluded ? (r.includedCents / top) * 100 : 0;
      return `<div class="rank-row">
        <div class="rank-label" title="${esc(r.key)}">${esc(r.name ?? r.key)}${
          r.badge ? ` <span class="pill">${esc(r.badge)}</span>` : ''
        }</div>
        <div class="rank-track">
          <div class="rank-bar rank-od" style="width:${od.toFixed(2)}%"></div>
          ${inc > 0 ? `<div class="rank-bar rank-inc" style="width:${inc.toFixed(2)}%"></div>` : ''}
        </div>
        <div class="rank-val">
          <strong>${money(r.onDemandCents)}</strong>
          ${showIncluded ? `<span class="muted"> / ${money(r.chargedCents)}</span>` : ''}
        </div>
      </div>`;
    })
    .join('')}</div>`;
}

function meter(label, valueCents, budgetCents, projectedCents) {
  const used = Math.min(1, valueCents / budgetCents);
  const proj = Math.min(1, (projectedCents ?? 0) / budgetCents);
  const over = (projectedCents ?? 0) > budgetCents;
  return `<div class="meter">
    <div class="meter-head"><span>${esc(label)}</span>
      <span class="meter-num"><strong>${money(valueCents)}</strong> <span class="muted">of ${money0(budgetCents)}</span></span></div>
    <div class="meter-track">
      <div class="meter-fill" style="width:${(used * 100).toFixed(2)}%"></div>
      ${proj > used ? `<div class="meter-proj ${over ? 'over' : ''}" style="left:${(proj * 100).toFixed(2)}%"></div>` : ''}
    </div>
    <div class="meter-foot">
      <span class="muted">${pct(used)} used</span>
      ${projectedCents != null ? `<span class="${over ? 'bad' : 'muted'}">projected ${money0(projectedCents)}</span>` : ''}
    </div>
  </div>`;
}

/**
 * Axis steps a person can read at a glance.
 *
 * Dividing a rounded maximum into quarters produces ticks like $8 / $15 / $23,
 * which are technically correct and cognitively useless. Rounding the STEP
 * instead — to 1, 2, 2.5 or 5 times a power of ten — yields $10 / $20 / $30.
 */
function niceScale(max, tickCount = 4) {
  const raw = max / tickCount;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { step, max: step * tickCount };
}

function statTile(label, value, sub, tone = '') {
  return `<div class="tile">
    <div class="tile-label">${esc(label)}</div>
    <div class="tile-value ${tone}">${value}</div>
    ${sub ? `<div class="tile-sub">${sub}</div>` : ''}
  </div>`;
}

function deltaText(cents) {
  if (cents === 0) return '<span class="muted">no change vs yesterday</span>';
  const up = cents > 0;
  return `<span class="${up ? 'bad' : 'good'}">${up ? '&#9650;' : '&#9660;'} ${money(Math.abs(cents))}</span> <span class="muted">vs yesterday</span>`;
}

// ── Page ─────────────────────────────────────────────────────────────────

export function renderDashboard(d, { reconciliation, meta } = {}) {
  const t = d.totals;
  const topUsers = d.byUser.slice(0, 12);
  const userMax = Math.max(...topUsers.map((r) => r.chargedCents), 1);

  const critical = d.alerts.filter((a) => a.level === 'critical').length;
  const lastRefresh = meta?.lastRefreshAt ? Number(meta.lastRefreshAt) : d.generatedAt;

  return `<!doctype html>
<html lang="en" data-theme-auto>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cursor Spend</title>
<style>
:root{
  color-scheme:light;
  --plane:#f9f9f7; --surface:#fcfcfb;
  --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --series-1:#2a78d6; --series-2:#eb6834;
  --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
  --good-text:#006300;
}
@media (prefers-color-scheme:dark){
  :root:where(:not([data-theme="light"])){
    color-scheme:dark;
    --plane:#0d0d0d; --surface:#1a1a19;
    --ink:#fff; --ink-2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
    --series-1:#3987e5; --series-2:#d95926;
    --good-text:#0ca30c;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
.wrap{max-width:1180px;margin:0 auto}
h1{font-size:20px;margin:0;font-weight:650;letter-spacing:-.01em}
h2{font-size:14px;margin:0 0 14px;font-weight:600;color:var(--ink-2);
  text-transform:uppercase;letter-spacing:.06em}
header{display:flex;justify-content:space-between;align-items:flex-end;
  gap:16px;flex-wrap:wrap;margin-bottom:20px}
.sub{color:var(--muted);font-size:13px;margin-top:4px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;
  padding:18px 20px;margin-bottom:16px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
@media(max-width:860px){.grid2,.grid3{grid-template-columns:1fr}}

.hero{display:flex;gap:32px;align-items:flex-start;flex-wrap:wrap}
.hero-fig{flex:0 0 auto}
.hero-label{font-size:13px;color:var(--ink-2);font-weight:600}
.hero-num{font-size:52px;line-height:1.05;font-weight:660;letter-spacing:-.025em;margin:6px 0 2px}
.hero-note{font-size:13px;color:var(--muted);max-width:340px}
.hero-meters{flex:1 1 340px;min-width:280px;display:flex;flex-direction:column;gap:14px}

.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
@media(max-width:860px){.tiles{grid-template-columns:repeat(2,1fr)}}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.tile-label{font-size:12px;color:var(--muted);font-weight:600;
  text-transform:uppercase;letter-spacing:.05em}
.tile-value{font-size:26px;font-weight:640;letter-spacing:-.02em;margin:6px 0 2px}
.tile-sub{font-size:12.5px;color:var(--ink-2)}

.meter-head{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px}
.meter-num strong{font-weight:640}
.meter-track{position:relative;height:10px;background:var(--grid);border-radius:5px;overflow:visible}
.meter-fill{height:100%;background:var(--series-1);border-radius:5px}
.meter-proj{position:absolute;top:-3px;width:2px;height:16px;background:var(--ink-2);border-radius:1px}
.meter-proj.over{background:var(--critical)}
.meter-foot{display:flex;justify-content:space-between;font-size:12px;margin-top:5px}

.chart{width:100%;max-width:1000px;height:auto;display:block;margin:0 auto;overflow:visible}
.grid{stroke:var(--grid);stroke-width:1}
.axis{stroke:var(--axis);stroke-width:1}
.tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.col:hover rect:not(.hit),.col:focus rect:not(.hit){opacity:.82}
.col{outline:none}
.hit{cursor:default}

.legend{display:flex;gap:18px;font-size:12.5px;color:var(--ink-2);margin-bottom:12px;flex-wrap:wrap}
.swatch{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}

.ranked{display:flex;flex-direction:column;gap:9px}
.rank-row{display:grid;grid-template-columns:170px 1fr 148px;gap:12px;align-items:center;font-size:13px}
@media(max-width:700px){.rank-row{grid-template-columns:110px 1fr 108px;font-size:12px}}
.rank-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-2)}
.rank-track{display:flex;gap:2px;height:16px;align-items:center}
.rank-bar{height:16px;border-radius:4px;min-width:0}
.rank-od{background:var(--series-1)}
.rank-inc{background:var(--series-2)}
.rank-val{text-align:right;font-variant-numeric:tabular-nums}

table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--muted);font-size:11.5px;
  text-transform:uppercase;letter-spacing:.05em;padding:0 10px 8px 0;border-bottom:1px solid var(--border)}
td{padding:8px 10px 8px 0;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}
td.name,th.name{font-variant-numeric:normal}
tr:last-child td{border-bottom:0}
.num{text-align:right}

.alerts{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
.alert{display:flex;gap:11px;align-items:flex-start;padding:11px 14px;border-radius:10px;
  border:1px solid var(--border);background:var(--surface);font-size:13.5px}
.alert .ico{font-size:14px;line-height:1.4;flex:0 0 auto}
.alert.critical{border-left:3px solid var(--critical)} .alert.critical .ico{color:var(--critical)}
.alert.warning{border-left:3px solid var(--warning)} .alert.warning .ico{color:var(--warning)}
.alert.info{border-left:3px solid var(--series-1)} .alert.info .ico{color:var(--series-1)}
.alert.ok{border-left:3px solid var(--good)} .alert.ok .ico{color:var(--good)}
.alert strong{font-weight:620}
.alert .detail{color:var(--ink-2)}

.muted{color:var(--muted)}
.bad{color:var(--critical)}
.good{color:var(--good-text)}
.pill{display:inline-block;font-size:11px;padding:2px 7px;border-radius:99px;
  background:var(--grid);color:var(--ink-2);font-weight:600}
.empty{color:var(--muted);font-size:13px;margin:8px 0}
footer{color:var(--muted);font-size:12px;margin-top:28px;line-height:1.7}
footer code{background:var(--grid);padding:1px 5px;border-radius:4px}
</style>
</head>
<body>
<div class="wrap">

<header>
  <div>
    <h1>Cursor Spend</h1>
    <div class="sub">
      Billing cycle ${esc(d.cycle.startLabel)} &rarr; ${esc(d.cycle.endLabel)} &middot;
      day ${d.cycle.elapsedDays.toFixed(1)} of ${d.cycle.totalDays} &middot;
      ${Math.floor(d.cycle.daysRemaining)} days remaining
    </div>
  </div>
  <div class="sub" style="text-align:right">
    Updated ${esc(istLabel(lastRefresh))}<br/>
    ${d.totals.events.toLocaleString()} calls this cycle
    ${critical ? `&middot; <span class="bad">${critical} needing attention</span>` : ''}
  </div>
</header>

<div class="alerts">
${d.alerts
  .map(
    (a) => `<div class="alert ${a.level}">
    <span class="ico" aria-hidden="true">${ICON[a.level] ?? ICON.info}</span>
    <div><strong>${esc(a.title)}</strong> <span class="detail">&mdash; ${esc(a.detail)}</span></div>
  </div>`
  )
  .join('')}
</div>

<div class="card">
  <div class="hero">
    <div class="hero-fig">
      <div class="hero-label">On-demand spend this cycle</div>
      <div class="hero-num">${money(t.onDemandCents)}</div>
      <div class="hero-note">
        What bills on top of the subscription. This is the number that lands on the invoice.
      </div>
    </div>
    <div class="hero-meters">
      ${meter('On-demand budget', t.onDemandCents, t.onDemandBudgetCents, d.projected.recent)}
      ${meter('Total consumption vs monthly budget', t.chargedCents, t.monthlyBudgetCents, d.projectedTotal.recent)}
    </div>
  </div>
</div>

<div class="tiles" style="margin-bottom:16px">
  ${statTile('Included pool used', money(t.includedCents), `absorbed by the subscription, not billed`)}
  ${statTile('Total consumed', money(t.chargedCents), `on-demand + included`)}
  ${statTile(
    'Today',
    money(d.today.chargedCents),
    `${deltaText(d.today.deltaCharged)}`
  )}
  ${statTile(
    'Projected on-demand',
    money0(d.projected.recent),
    `at the trailing 7-day rate &middot; <span class="muted">cycle-average says ${money0(d.projected.linear)}</span>`,
    d.projected.recent > t.onDemandBudgetCents ? 'bad' : ''
  )}
</div>

<div class="card">
  <h2>Daily spend this cycle</h2>
  <div class="legend">
    <span><span class="swatch" style="background:var(--series-1)"></span>On-demand (billed)</span>
    <span><span class="swatch" style="background:var(--series-2)"></span>Included (absorbed by pool)</span>
  </div>
  ${stackedColumns(d.series, { height: 210, label: 'Daily spend for the current billing cycle' })}
</div>

<div class="card">
  <h2>Last 90 days</h2>
  <div class="legend">
    <span><span class="swatch" style="background:var(--series-1)"></span>On-demand</span>
    <span><span class="swatch" style="background:var(--series-2)"></span>Included</span>
  </div>
  ${stackedColumns(d.history, { height: 190, label: 'Daily spend over the last 90 days' })}
</div>

<div class="grid2">
  <div class="card">
    <h2>By person &mdash; this cycle</h2>
    <div class="legend">
      <span><span class="swatch" style="background:var(--series-1)"></span>On-demand</span>
      <span><span class="swatch" style="background:var(--series-2)"></span>Included</span>
    </div>
    ${rankedBars(topUsers, { max: userMax })}
    <p class="sub" style="margin-top:14px">
      Bold figure is on-demand; the second is total consumption. Someone can sit at
      $0.00 on-demand while being the largest consumer on the team &mdash; that is the
      pool filling up, and it is where the next overage comes from.
    </p>
  </div>

  <div class="card">
    <h2>By model family</h2>
    ${rankedBars(
      d.byFamily.slice(0, 8).map((f) => ({ ...f, name: f.key, badge: f.premium ? 'premium' : null })),
      {}
    )}
    <p class="sub" style="margin-top:14px">
      Cursor reports one model under several names &mdash; Opus alone appears as at least
      four. Grouped, a family&rsquo;s real cost is visible; ungrouped, no single row looks
      large enough to ask about.
    </p>
  </div>
</div>

<div class="grid2">
  <div class="card">
    <h2>Included pool &mdash; how full</h2>
    ${
      d.pool.available
        ? `<table><thead><tr><th class="name">Member</th><th class="num">Total</th><th class="num">Auto</th><th class="num">API</th></tr></thead><tbody>
      ${d.pool.rows
        .slice(0, 15)
        .map(
          (r) => `<tr><td class="name">${esc(r.email)}</td>
        <td class="num ${r.total >= 80 ? 'bad' : ''}">${r.total?.toFixed(1) ?? '—'}%</td>
        <td class="num muted">${r.auto?.toFixed(1) ?? '—'}%</td>
        <td class="num muted">${r.api?.toFixed(1) ?? '—'}%</td></tr>`
        )
        .join('')}
    </tbody></table>
    <p class="sub" style="margin-top:12px">Everything past 100% bills as on-demand.</p>`
        : '<p class="empty">Pool percentages are not exposed for this team.</p>'
    }
  </div>

  <div class="card">
    <h2>Most expensive individual calls</h2>
    ${
      d.expensiveCalls.length
        ? `<table><thead><tr><th class="name">Date</th><th class="name">Who</th><th class="name">Model</th><th class="num">Cost</th></tr></thead><tbody>
      ${d.expensiveCalls
        .slice(0, 10)
        .map(
          (c) => `<tr><td class="name muted">${esc(c.date)}</td>
        <td class="name">${esc(c.user ?? '—')}${c.isNonHuman ? ' <span class="pill">agent</span>' : ''}</td>
        <td class="name muted">${esc(c.model)}</td>
        <td class="num">${money(c.chargedCents)}</td></tr>`
        )
        .join('')}
    </tbody></table>`
        : `<p class="empty">No single call above ${money0(config.expensiveCallUsd * 100)} this cycle.</p>`
    }
  </div>
</div>

<div class="grid2">
  <div class="card">
    <h2>Background agents &amp; automations</h2>
    ${
      d.nonHuman.events
        ? `<p style="margin:0 0 12px">
      <strong>${d.nonHuman.events}</strong> automated call${d.nonHuman.events === 1 ? '' : 's'} costing
      <strong>${money(d.nonHuman.chargedCents)}</strong>
      <span class="muted">(${pct(d.nonHuman.chargedCents / (t.chargedCents || 1))} of the cycle)</span>
    </p>
    ${rankedBars(d.nonHuman.byUser.map((u) => ({ ...u, name: u.key })), {})}
    <p class="sub" style="margin-top:12px">
      Rare but individually expensive &mdash; these run without anyone watching, so they
      are the easiest spend to forget exists.
    </p>`
        : '<p class="empty">No automated usage this cycle.</p>'
    }
  </div>

  <div class="card">
    <h2>Seats with no activity this cycle</h2>
    ${
      d.idle.length
        ? `<p style="margin:0 0 10px"><strong>${d.idle.length}</strong> of ${d.idle.length + d.byUser.length} seats unused</p>
       <p class="sub">${d.idle.map((m) => esc(m.email)).join(', ')}</p>`
        : '<p class="empty">Every seat was used this cycle.</p>'
    }
    ${
      d.limitsConfigured
        ? ''
        : `<p class="sub" style="margin-top:14px">
      <span class="pill">note</span> No per-user spend limits are currently set in Cursor.
      Nothing caps an individual&rsquo;s on-demand usage except the team total.</p>`
    }
  </div>
</div>

<footer>
  ${
    reconciliation
      ? reconciliation.ok
        ? `Reconciled against Cursor&rsquo;s own spend endpoint: on-demand differs by ${money(Math.abs(reconciliation.deltaOnDemandCents))}, included by ${money(Math.abs(reconciliation.deltaIncludedCents))}. Small residuals are expected &mdash; the two are read at different instants.`
        : `<span class="bad">Reconciliation warning:</span> event-derived on-demand differs from Cursor&rsquo;s spend endpoint by ${money(Math.abs(reconciliation.deltaOnDemandCents))}. Treat the headline figure with caution and re-run a refresh.`
      : 'No spend snapshot available to reconcile against.'
  }
  <br/>
  Figures are cycle-relative, not calendar-month &mdash; the cycle starts ${esc(d.cycle.startLabel)}, so calendar-month totals will not match.
  Days are IST. Cursor revises recent data, so today and yesterday can move.
  <br/>
  Source: Cursor Admin API <code>/teams/spend</code> and <code>/teams/filtered-usage-events</code>.
</footer>

</div>
</body>
</html>`;
}
