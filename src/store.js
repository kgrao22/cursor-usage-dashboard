/**
 * Storage. Two drivers behind one interface.
 *
 *  - FileStore     local JSONL. Phase 1, and a working fallback if GCP is
 *                  having a day when you are standing in front of the CX team.
 *  - BigQueryStore Cloud Run. Survives restarts, and lets finance run their own
 *                  SQL later instead of asking for a new chart every week.
 *
 * Both return RAW events and all aggregation happens in aggregate.js, so there
 * is exactly one implementation of every metric. A SQL version of the same
 * maths would be a second place for the numbers to disagree.
 *
 * Idempotency is by whole-day replacement, not row-level dedup — Cursor's usage
 * events carry no stable event ID, so any synthetic key would be a guess. Days
 * are replaced wholesale, which means re-running a backfill is always safe and
 * revised upstream data self-corrects.
 */

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from './config.js';

const EVENT_FIELDS = [
  'tsMs', 'istDate', 'userEmail', 'model', 'kind', 'isOnDemand', 'onDemandCents',
  'includedCents', 'chargedCents', 'maxMode', 'requestsCosts', 'isChargeable',
  'isTokenBasedCall', 'cursorTokenFee', 'inputTokens', 'outputTokens',
  'cacheWriteTokens', 'cacheReadTokens', 'tokenCents', 'serviceAccountId',
  'cloudAgentId', 'automationId', 'conversationId', 'isHeadless', 'isNonHuman',
];

// ─────────────────────────────────────────────────────────────────────────
// File driver
// ─────────────────────────────────────────────────────────────────────────

class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.eventsDir = join(dir, 'events');
  }

  async init() {
    await mkdir(this.eventsDir, { recursive: true });
  }

  #monthFile(month) {
    return join(this.eventsDir, `${month}.jsonl`);
  }

  async #readMonth(month) {
    const f = this.#monthFile(month);
    if (!existsSync(f)) return [];
    const text = await readFile(f, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /** Replaces every day present in `events`, leaving other days untouched. */
  async saveEvents(events) {
    if (!events.length) return 0;
    const days = new Set(events.map((e) => e.istDate));
    const months = new Set([...days].map((d) => d.slice(0, 7)));

    for (const month of months) {
      const existing = await this.#readMonth(month);
      const kept = existing.filter((e) => !days.has(e.istDate));
      const incoming = events.filter((e) => e.istDate.slice(0, 7) === month);
      const merged = [...kept, ...incoming].sort((a, b) => a.tsMs - b.tsMs);
      await writeFile(
        this.#monthFile(month),
        merged.map((e) => JSON.stringify(e)).join('\n') + '\n'
      );
    }
    return events.length;
  }

  async getEvents(startDate, endDate) {
    if (!existsSync(this.eventsDir)) return [];
    const files = (await readdir(this.eventsDir)).filter((f) => f.endsWith('.jsonl'));
    const wanted = files.filter((f) => {
      const m = f.replace('.jsonl', '');
      return m >= startDate.slice(0, 7) && m <= endDate.slice(0, 7);
    });
    const out = [];
    for (const f of wanted) {
      for (const e of await this.#readMonth(f.replace('.jsonl', ''))) {
        if (e.istDate >= startDate && e.istDate <= endDate) out.push(e);
      }
    }
    return out.sort((a, b) => a.tsMs - b.tsMs);
  }

  async saveSpendSnapshot(snap) {
    const f = join(this.dir, 'snapshots.jsonl');
    const line = JSON.stringify(snap) + '\n';
    const prev = existsSync(f) ? await readFile(f, 'utf8') : '';
    await writeFile(f, prev + line);
  }

  async getSpendSnapshots(sinceMs = 0) {
    const f = join(this.dir, 'snapshots.jsonl');
    if (!existsSync(f)) return [];
    return (await readFile(f, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((s) => s && s.capturedAt >= sinceMs)
      .sort((a, b) => a.capturedAt - b.capturedAt);
  }

  async saveMembers(members) {
    await writeFile(join(this.dir, 'members.json'), JSON.stringify(members, null, 2));
  }

  async getMembers() {
    const f = join(this.dir, 'members.json');
    if (!existsSync(f)) return [];
    return JSON.parse(await readFile(f, 'utf8'));
  }

  async setMeta(meta) {
    const current = await this.getMeta();
    await writeFile(join(this.dir, 'meta.json'), JSON.stringify({ ...current, ...meta }, null, 2));
  }

  async getMeta() {
    const f = join(this.dir, 'meta.json');
    if (!existsSync(f)) return {};
    try {
      return JSON.parse(await readFile(f, 'utf8'));
    } catch {
      return {};
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// BigQuery driver
// ─────────────────────────────────────────────────────────────────────────

const EVENT_SCHEMA = [
  { name: 'tsMs', type: 'INT64' },
  { name: 'istDate', type: 'DATE' },
  { name: 'userEmail', type: 'STRING' },
  { name: 'model', type: 'STRING' },
  { name: 'kind', type: 'STRING' },
  { name: 'isOnDemand', type: 'BOOL' },
  { name: 'onDemandCents', type: 'FLOAT64' },
  { name: 'includedCents', type: 'FLOAT64' },
  { name: 'chargedCents', type: 'FLOAT64' },
  { name: 'maxMode', type: 'BOOL' },
  { name: 'requestsCosts', type: 'FLOAT64' },
  { name: 'isChargeable', type: 'BOOL' },
  { name: 'isTokenBasedCall', type: 'BOOL' },
  { name: 'cursorTokenFee', type: 'FLOAT64' },
  { name: 'inputTokens', type: 'INT64' },
  { name: 'outputTokens', type: 'INT64' },
  { name: 'cacheWriteTokens', type: 'INT64' },
  { name: 'cacheReadTokens', type: 'INT64' },
  { name: 'tokenCents', type: 'FLOAT64' },
  { name: 'serviceAccountId', type: 'STRING' },
  { name: 'cloudAgentId', type: 'STRING' },
  { name: 'automationId', type: 'STRING' },
  { name: 'conversationId', type: 'STRING' },
  { name: 'isHeadless', type: 'BOOL' },
  { name: 'isNonHuman', type: 'BOOL' },
];

class BigQueryStore {
  constructor(opts) {
    this.opts = opts;
    this.bq = null;
  }

  async init() {
    // Imported lazily so the file driver never needs this dependency present.
    let BigQuery;
    try {
      ({ BigQuery } = await import('@google-cloud/bigquery'));
    } catch {
      throw new Error(
        'STORAGE_DRIVER=bigquery but @google-cloud/bigquery is not installed. ' +
          'Run `npm install`, or set STORAGE_DRIVER=file to use local storage.'
      );
    }
    if (!this.opts.projectId) {
      throw new Error('STORAGE_DRIVER=bigquery requires GCP_PROJECT_ID.');
    }
    this.bq = new BigQuery({ projectId: this.opts.projectId });
    const dataset = this.bq.dataset(this.opts.datasetId);
    const [exists] = await dataset.exists();
    if (!exists) await dataset.create({ location: this.opts.location });

    await this.#ensureTable('usage_events', EVENT_SCHEMA, {
      timePartitioning: { type: 'DAY', field: 'istDate' },
      clustering: { fields: ['userEmail', 'model'] },
    });
    await this.#ensureTable('spend_snapshots', [
      { name: 'capturedAt', type: 'INT64' },
      { name: 'capturedDate', type: 'DATE' },
      { name: 'cycleStart', type: 'INT64' },
      { name: 'payload', type: 'JSON' },
    ], { timePartitioning: { type: 'DAY', field: 'capturedDate' } });
    await this.#ensureTable('members', [
      { name: 'userId', type: 'STRING' },
      { name: 'email', type: 'STRING' },
      { name: 'name', type: 'STRING' },
      { name: 'role', type: 'STRING' },
      { name: 'isRemoved', type: 'BOOL' },
    ]);
    await this.#ensureTable('meta', [
      { name: 'k', type: 'STRING' },
      { name: 'v', type: 'STRING' },
    ]);
  }

  async #ensureTable(name, schema, extra = {}) {
    const table = this.bq.dataset(this.opts.datasetId).table(name);
    const [exists] = await table.exists();
    if (!exists) await table.create({ schema, location: this.opts.location, ...extra });
  }

  /**
   * Load one partition at a time with WRITE_TRUNCATE.
   *
   * Deliberately a load job rather than a streaming insert: streamed rows sit
   * in a buffer where they cannot be deleted or overwritten for up to 90
   * minutes, which would make a re-run silently double-count. Load jobs into a
   * partition decorator are atomic and repeatable.
   */
  async saveEvents(events) {
    if (!events.length) return 0;
    const byDay = new Map();
    for (const e of events) {
      if (!byDay.has(e.istDate)) byDay.set(e.istDate, []);
      byDay.get(e.istDate).push(e);
    }

    const table = this.bq.dataset(this.opts.datasetId).table('usage_events');
    for (const [day, rows] of byDay) {
      const ndjson = rows
        .map((r) => JSON.stringify(Object.fromEntries(EVENT_FIELDS.map((f) => [f, r[f] ?? null]))))
        .join('\n');
      const tmp = join(tmpdir(), `cursor-events-${day}-${process.pid}.ndjson`);
      await writeFile(tmp, ndjson);
      try {
        await this.bq
          .dataset(this.opts.datasetId)
          .table(`usage_events$${day.replaceAll('-', '')}`)
          .load(tmp, {
            sourceFormat: 'NEWLINE_DELIMITED_JSON',
            writeDisposition: 'WRITE_TRUNCATE',
            schema: { fields: EVENT_SCHEMA },
            location: this.opts.location,
          });
      } finally {
        await rm(tmp, { force: true });
      }
    }
    void table;
    return events.length;
  }

  async getEvents(startDate, endDate) {
    const [rows] = await this.bq.query({
      query: `SELECT * FROM \`${this.opts.datasetId}.usage_events\`
              WHERE istDate BETWEEN @start AND @end
              ORDER BY tsMs`,
      params: { start: startDate, end: endDate },
      location: this.opts.location,
    });
    return rows.map((r) => ({ ...r, istDate: r.istDate?.value ?? r.istDate }));
  }

  async saveSpendSnapshot(snap) {
    await this.bq
      .dataset(this.opts.datasetId)
      .table('spend_snapshots')
      .insert([{
        capturedAt: snap.capturedAt,
        capturedDate: new Date(snap.capturedAt).toISOString().slice(0, 10),
        cycleStart: snap.cycleStart ?? null,
        payload: JSON.stringify(snap),
      }]);
  }

  async getSpendSnapshots(sinceMs = 0) {
    const [rows] = await this.bq.query({
      query: `SELECT payload FROM \`${this.opts.datasetId}.spend_snapshots\`
              WHERE capturedAt >= @since ORDER BY capturedAt`,
      params: { since: sinceMs },
      location: this.opts.location,
    });
    return rows.map((r) => JSON.parse(r.payload));
  }

  async saveMembers(members) {
    const table = this.bq.dataset(this.opts.datasetId).table('members');
    const ndjson = members.map((m) => JSON.stringify(m)).join('\n');
    const tmp = join(tmpdir(), `cursor-members-${process.pid}.ndjson`);
    await writeFile(tmp, ndjson);
    try {
      await table.load(tmp, {
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_TRUNCATE',
        location: this.opts.location,
      });
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async getMembers() {
    const [rows] = await this.bq.query({
      query: `SELECT * FROM \`${this.opts.datasetId}.members\``,
      location: this.opts.location,
    });
    return rows;
  }

  async setMeta(meta) {
    for (const [k, v] of Object.entries(meta)) {
      await this.bq.query({
        query: `MERGE \`${this.opts.datasetId}.meta\` T
                USING (SELECT @k AS k, @v AS v) S ON T.k = S.k
                WHEN MATCHED THEN UPDATE SET v = S.v
                WHEN NOT MATCHED THEN INSERT (k, v) VALUES (S.k, S.v)`,
        params: { k, v: String(v) },
        location: this.opts.location,
      });
    }
  }

  async getMeta() {
    try {
      const [rows] = await this.bq.query({
        query: `SELECT k, v FROM \`${this.opts.datasetId}.meta\``,
        location: this.opts.location,
      });
      return Object.fromEntries(rows.map((r) => [r.k, r.v]));
    } catch {
      return {};
    }
  }
}

let cached = null;

export async function getStore() {
  if (cached) return cached;
  const s = config.storage;
  cached = s.driver === 'bigquery' ? new BigQueryStore(s.bigquery) : new FileStore(s.dataDir);
  await cached.init();
  return cached;
}

export { FileStore, BigQueryStore, EVENT_FIELDS };
