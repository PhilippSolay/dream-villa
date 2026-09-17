// SPEC §4 "Config / agent page" and "Scraper controls" — the Agent page's API.

import { getConfig, setConfig, nowIso } from '../db.js';
import { DEFAULT_WEIGHTS, WEIGHT_KEYS } from '../defaults.js';
import { rescoreAll, startRun, finishRun } from '../scrape/store.js';
import { badRequest, notFound, safeJson, str, strictSchemas } from './_common.js';

/** Keys the Agent page reads back (SPEC §3 config keys + last_digest_at). */
const CONFIG_KEYS = [
  'weights', 'flag_threshold', 'budget_min', 'budget_max', 'beach_km_max',
  'band', 'areas', 'red_flag_keywords', 'low_priority_pockets', 'last_digest_at',
];

const MAX_WEIGHT = 20;

/**
 * One scrape at a time per process. `src/scrape/index.js` has a `running` flag of its own,
 * but it is private to the cron scheduler, so the API keeps its own module-level lock.
 */
let scrapeRunning = false;

/** Exposed for tests and for anything that wants to know before POSTing. */
export function isScrapeRunning() {
  return scrapeRunning;
}

export function publicConfig(db) {
  const cfg = getConfig(db);
  const out = {};
  for (const key of CONFIG_KEYS) out[key] = cfg[key] ?? null;
  return out;
}

/** @returns {{error:string}|{weights?:object, flag_threshold?:number}} */
export function validateConfigPatch(body) {
  const out = {};

  if (body.weights !== undefined) {
    const w = body.weights;
    if (!w || typeof w !== 'object' || Array.isArray(w)) return { error: 'weights must be an object' };
    const bad = Object.keys(w).filter((k) => !WEIGHT_KEYS.includes(k));
    if (bad.length) return { error: `unknown weight: ${bad.join(', ')}` };
    for (const [k, v] of Object.entries(w)) {
      if (!Number.isInteger(v) || v < 0 || v > MAX_WEIGHT) return { error: `weight ${k} must be an integer 0–${MAX_WEIGHT}` };
    }
    out.weights = w;
  }

  if (body.flag_threshold !== undefined) {
    const t = body.flag_threshold;
    if (!Number.isInteger(t) || t < 0 || t > 100) return { error: 'flag_threshold must be an integer 0–100' };
    out.flag_threshold = t;
  }

  if (Object.keys(out).length === 0) return { error: 'nothing to change' };
  return out;
}

function parseRun(row) {
  return {
    ...row,
    sources: safeJson(row.sources),
    weight_changes: safeJson(row.weight_changes),
    notes: safeJson(row.notes),
    errors: safeJson(row.errors),
  };
}

export default async function adminRoutes(app, opts) {
  const { db, env = process.env } = opts;
  // Injected by tests; production loads the real scraper lazily — a static import here
  // would close the cycle src/index.js → server.js → admin.js → scrape/index.js → src/index.js.
  const runScrape = opts.runScrape || (async (args) => (await import('../scrape/index.js')).runScrape(args));
  // onRequest: auth must answer before schema validation (see properties.js).
  const auth = { onRequest: app.requireUser };

  strictSchemas(app);

  // --- config --------------------------------------------------------------
  app.get('/api/config', auth, async () => publicConfig(db));

  app.patch(
    '/api/config',
    {
      ...auth,
      schema: {
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            weights: { type: 'object' },
            flag_threshold: { type: 'integer', minimum: 0, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const checked = validateConfigPatch(request.body || {});
      if (checked.error) return badRequest(reply, checked.error);

      const before = getConfig(db);
      const oldWeights = { ...DEFAULT_WEIGHTS, ...(before.weights || {}) };
      const weight_changes = [];

      if (checked.weights) {
        // A partial object edits the named weights and leaves the rest alone.
        const merged = { ...oldWeights, ...checked.weights };
        for (const key of WEIGHT_KEYS) {
          if (merged[key] !== oldWeights[key]) {
            weight_changes.push({ feature: key, from: oldWeights[key], to: merged[key], because: `edited by ${request.user.name}` });
          }
        }
        setConfig(db, 'weights', merged);
      }

      if (checked.flag_threshold !== undefined && checked.flag_threshold !== before.flag_threshold) {
        setConfig(db, 'flag_threshold', checked.flag_threshold);
      }

      const summary = rescoreAll(db);

      const notes = [];
      if (weight_changes.length) notes.push(`${weight_changes.length} weight(s) edited by ${request.user.name}`);
      if (checked.flag_threshold !== undefined) notes.push(`flag_threshold → ${checked.flag_threshold} (${request.user.name})`);
      notes.push(`rescored ${summary.total}: ${summary.in_filter} in filter, ${summary.flagged} flagged`);

      const runId = startRun(db, 'learn', []);
      finishRun(db, runId, { seen: summary.total, flagged: summary.flagged, weight_changes, notes });

      return { ...publicConfig(db), run_id: runId, weight_changes, rescored: summary };
    }
  );

  // --- runs / notes --------------------------------------------------------
  const limitSchema = {
    type: 'object', additionalProperties: false,
    properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
  };

  app.get('/api/runs', { ...auth, schema: { querystring: limitSchema } }, async (request) => {
    const limit = request.query.limit ?? 14;
    return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit).map(parseRun);
  });

  app.get('/api/notes', { ...auth, schema: { querystring: limitSchema } }, async (request) => {
    const limit = request.query.limit ?? 14;
    return db.prepare('SELECT * FROM agent_notes ORDER BY id DESC LIMIT ?').all(limit);
  });

  // --- scraper controls ----------------------------------------------------
  app.post(
    '/api/scrape',
    {
      ...auth,
      schema: {
        body: {
          type: ['object', 'null'], additionalProperties: false,
          properties: { source: { type: 'string', maxLength: 40 } },
        },
      },
    },
    async (request, reply) => {
      if (scrapeRunning) return reply.code(409).send({ error: 'already_running' });
      const source = str(request.body?.source);
      scrapeRunning = true;

      // Fire and forget: a full run takes minutes (SPEC §11), far longer than a request.
      Promise.resolve()
        .then(() => runScrape({ db, sources: source ? [source] : null, log: (...a) => request.log?.info?.(a.join(' ')) }))
        .catch((err) => request.log?.error?.({ err }, 'scrape failed'))
        .finally(() => {
          scrapeRunning = false;
        });

      return reply.code(202).send({ started: true, source: source || null });
    }
  );

  // --- inbox ---------------------------------------------------------------
  app.post(
    '/api/inbox',
    {
      ...auth,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['url'],
          properties: {
            url: { type: 'string', minLength: 4, maxLength: 2000 },
            note: { type: ['string', 'null'], maxLength: 2000 },
          },
        },
      },
    },
    async (request) => {
      const url = request.body.url.trim();
      const existing = db.prepare('SELECT id FROM inbox WHERE url = ?').get(url);
      if (existing) return { ok: true, id: existing.id, existing: true };
      const info = db
        .prepare('INSERT INTO inbox (url, by, note, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(url, request.user.name, str(request.body.note), 'pending', nowIso());
      return { ok: true, id: Number(info.lastInsertRowid) };
    }
  );

  app.get(
    '/api/inbox',
    {
      ...auth,
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['pending', 'done', 'failed', 'all'] },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
          },
        },
      },
    },
    async (request) => {
      const status = request.query.status || 'pending';
      const limit = request.query.limit ?? 200;
      if (status === 'all') return db.prepare('SELECT * FROM inbox ORDER BY id DESC LIMIT ?').all(limit);
      return db.prepare('SELECT * FROM inbox WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit);
    }
  );

  // --- feedback ------------------------------------------------------------
  app.post(
    '/api/feedback/:id/applied',
    {
      ...auth,
      schema: {
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        body: {
          type: 'object', additionalProperties: false, required: ['note'],
          properties: { note: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
      if (!row) return notFound(reply);
      db.prepare('UPDATE feedback SET applied = 1, applied_note = ? WHERE id = ?').run(request.body.note, id);
      return db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
    }
  );

  void env;
}
