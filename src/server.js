/**
 * Read-only dashboard server.
 *
 * Deliberately does NOT ingest on a timer. Ingestion runs as a separate Cloud
 * Run Job on a Cloud Scheduler trigger, because IAP intercepts inbound requests
 * and replaces the caller's identity — a scheduler calling an IAP-protected
 * service is a fight you lose. The job has no ingress at all, the service has
 * no write path, and the two only meet in BigQuery.
 */

import { createServer } from 'node:http';
import { config } from './config.js';
import { loadDashboardData, refresh } from './ingest.js';
import { buildDashboard, reconcile } from './aggregate.js';
import { renderDashboard } from './render.js';

const CACHE_MS = 60_000;
let cache = { at: 0, html: null, json: null };

async function build() {
  const now = Date.now();
  if (cache.html && now - cache.at < CACHE_MS) return cache;

  const data = await loadDashboardData({ now });
  const dashboard = buildDashboard({
    cycleEvents: data.cycleEvents,
    historyEvents: data.historyEvents,
    spend: data.spend,
    members: data.members,
    now,
  });
  const reconciliation = reconcile(dashboard, data.spend);

  cache = {
    at: now,
    html: renderDashboard(dashboard, { reconciliation, meta: data.meta }),
    json: { ...dashboard, reconciliation, meta: data.meta },
  };
  return cache;
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * A refresh may be triggered by a signed-in human behind IAP, or by a shared
 * token for local use. Never anonymously.
 */
function mayRefresh(req) {
  const iapUser = req.headers['x-goog-authenticated-user-email'];
  if (iapUser) return true;
  if (!config.refreshToken) return config.storage.driver === 'file'; // local dev only
  const presented = req.headers['x-refresh-token'];
  return presented && presented === config.refreshToken;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');

    if (url.pathname === '/api/data') {
      const { json } = await build();
      return send(res, 200, JSON.stringify(json, null, 2), 'application/json');
    }

    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      if (!mayRefresh(req)) return send(res, 403, 'forbidden', 'text/plain');
      const result = await refresh({ log: () => {} });
      cache = { at: 0, html: null, json: null };
      return send(res, 200, JSON.stringify(result), 'application/json');
    }

    if (url.pathname === '/') {
      const { html } = await build();
      return send(res, 200, html);
    }

    return send(res, 404, 'not found', 'text/plain');
  } catch (err) {
    console.error(err);
    return send(
      res,
      500,
      `<!doctype html><meta charset="utf-8"><style>body{font:15px system-ui;padding:40px;max-width:760px;margin:0 auto;color:#0b0b0b}code{background:#eee;padding:2px 6px;border-radius:4px}</style>
       <h1>Dashboard error</h1><p>${String(err.message).replace(/[<>&]/g, '')}</p>
       <p>If this is a fresh install, the store may be empty — run <code>npm run backfill</code> first.</p>`
    );
  }
});

server.listen(config.port, () => {
  console.log(`Cursor spend dashboard on http://localhost:${config.port}`);
  console.log(`  storage: ${config.storage.driver}`);
  console.log(`  budgets: $${config.onDemandBudgetUsd} on-demand / $${config.monthlyBudgetUsd} total`);
});
