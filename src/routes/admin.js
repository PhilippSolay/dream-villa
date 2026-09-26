// SPEC §4 "Config / agent page" and "Scraper controls" — the Agent page's API.

import { getConfig, setConfig, nowIso } from '../db.js';
import { AREAS } from '../areas.js';
import { DEFAULT_WEIGHTS, WEIGHT_KEYS } from '../defaults.js';
import { rescoreAll, startRun, finishRun } from '../scrape/store.js';
import { badRequest, notFound, safeJson, str, strictSchemas } from './_common.js';
import { isOwner, sameTeamSql } from '../teams.js';
import {
  SOURCE_KINDS, sourcesWithStats, getSource, upsertSource, setSourceEnabled,
  noteWithSource,
} from '../sources.js';

/** Keys the Agent page reads back (SPEC §3 config keys + last_digest_at). */
const CONFIG_KEYS = [
  'weights', 'flag_threshold', 'budget_min', 'budget_max', 'beach_km_max',
  'band', 'areas', 'red_flag_keywords', 'low_priority_pockets', 'last_digest_at',
];

const MAX_WEIGHT = 20;

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
  // `jobs` (src/jobs) runs the scraper in a worker, and holds the one-scrape-at-a-time
  // guard the cron shares.
  const { db, env = process.env, jobs } = opts;
  // onRequest: auth must answer before schema validation (see properties.js).
  const auth = { onRequest: app.requireUser };
  // SPEC §17: the scraper/brief/agent controls are the owners' — a friend's tap never
  // runs the scraper, edits the brief or reads the agent's private notes.
  const ownerAuth = { onRequest: app.requireOwner };

  strictSchemas(app);

  // --- areas ---------------------------------------------------------------
  // SPEC §7 as data, so the UI never hard-codes labels, groups or beach points. Shared
  // (everyone signed in reads it — the filter panel needs it too).
  app.get('/api/areas', auth, async () => ({
    areas: Object.entries(AREAS).map(([id, a]) => ({
      id, label: a.label, group: a.group, centroid: a.centroid, beach: a.beach,
    })),
  }));

  // --- config --------------------------------------------------------------
  // GET stays open (read-only, shared brief); PATCH edits it — owners only.
  app.get('/api/config', auth, async () => publicConfig(db));

  app.patch(
    '/api/config',
    {
      ...ownerAuth,
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

  // Everyone's Home says "Updated 06:12", so friends get the when; what a run found and
  // changed (weight edits by name, notes, errors) is the owners' (SPEC §17).
  app.get('/api/runs', { ...auth, schema: { querystring: limitSchema } }, async (request) => {
    const limit = request.query.limit ?? 14;
    const runs = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit).map(parseRun);
    if (isOwner(request.user)) return runs;
    return runs.map(({ id, kind, started_at, finished_at }) => ({ id, kind, started_at, finished_at }));
  });

  // The agent's private notes (SPEC §17) — owners only.
  app.get('/api/notes', { ...ownerAuth, schema: { querystring: limitSchema } }, async (request) => {
    const limit = request.query.limit ?? 14;
    return db.prepare('SELECT * FROM agent_notes ORDER BY id DESC LIMIT ?').all(limit);
  });

  // --- scraper controls ----------------------------------------------------
  app.post(
    '/api/scrape',
    {
      ...ownerAuth,
      schema: {
        body: {
          type: ['object', 'null'], additionalProperties: false,
          properties: { source: { type: 'string', maxLength: 40 } },
        },
      },
    },
    async (request, reply) => {
      if (jobs.busy('scrape')) return reply.code(409).send({ error: 'already_running' });
      const source = str(request.body?.source);

      // Fire and forget: a full run takes minutes to hours (SPEC §11), far longer than a request.
      jobs.run('scrape', { sources: source ? [source] : null }).catch((err) => app.log.error({ err }, 'scrape failed'));

      return reply.code(202).send({ started: true, source: source || null });
    }
  );

  // --- inbox -----------------------------------------------------------------
  // Adding/reading candidate URLs is scraper intake — SPEC §17 lists "inbox writes" as
  // owner-only explicitly; the read stays with everyone signed in (below).
  app.post(
    '/api/inbox',
    {
      ...ownerAuth,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['url'],
          properties: {
            url: { type: 'string', minLength: 4, maxLength: 2000 },
            note: { type: ['string', 'null'], maxLength: 2000 },
            // Which intake channel this URL came from; stored as the `[src:<id>]`
            // prefix on `note` (src/sources.js), which is how the Agent page counts
            // what a Facebook or WhatsApp group has actually produced.
            source_id: { type: ['string', 'null'], maxLength: 60 },
          },
        },
      },
    },
    async (request, reply) => {
      const url = request.body.url.trim();
      const sourceId = str(request.body.source_id);
      if (sourceId && !getSource(db, sourceId)) return badRequest(reply, `unknown source: ${sourceId}`);
      const note = noteWithSource(str(request.body.note), sourceId);
      const existing = db.prepare('SELECT id FROM inbox WHERE url = ?').get(url);
      if (existing) return { ok: true, id: existing.id, existing: true };
      const info = db
        .prepare('INSERT INTO inbox (url, by, note, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(url, request.user.name, note, 'pending', nowIso());
      return { ok: true, id: Number(info.lastInsertRowid), source_id: sourceId || null };
    }
  );

  // The inbox and the intake channels are the owners' agent desk (who pasted what, notes
  // on agencies and groups); only the Agent page reads them, and friends do not have it.
  app.get(
    '/api/inbox',
    {
      ...ownerAuth,
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

  // --- sources (intake channels) -------------------------------------------
  // SPEC is silent here; the shape and the `[src:<id>]` inbox convention live in
  // src/sources.js. No DELETE on purpose (CLAUDE.md never deletes): disable a source,
  // or PATCH `archived: true` to drop it out of the list.
  const sourceBody = {
    kind: { type: 'string', enum: SOURCE_KINDS },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    url: { type: ['string', 'null'], maxLength: 500 },
    notes: { type: ['string', 'null'], maxLength: 2000 },
    enabled: { type: 'boolean' },
    contact_id: { type: ['integer', 'null'] },
    archived: { type: 'boolean' },
  };

  app.get(
    '/api/sources',
    {
      ...ownerAuth,
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { archived: { type: 'boolean' } },
        },
      },
    },
    async (request) => ({ sources: sourcesWithStats(db, { includeArchived: request.query.archived === true }) })
  );

  app.post(
    '/api/sources',
    {
      ...ownerAuth,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['kind'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 60 }, ...sourceBody },
        },
      },
    },
    async (request, reply) => {
      try {
        return upsertSource(db, request.body, request.user);
      } catch (err) {
        return badRequest(reply, String((err && err.message) || err));
      }
    }
  );

  app.patch(
    '/api/sources/:id',
    {
      ...ownerAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 60 } } },
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            name: sourceBody.name, url: sourceBody.url, notes: sourceBody.notes,
            enabled: sourceBody.enabled, contact_id: sourceBody.contact_id, archived: sourceBody.archived,
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!getSource(db, id)) return notFound(reply);
      try {
        const body = request.body || {};
        if (Object.keys(body).length === 1 && body.enabled !== undefined) {
          return setSourceEnabled(db, id, body.enabled, request.user);
        }
        return upsertSource(db, { ...body, id }, request.user);
      } catch (err) {
        return badRequest(reply, String((err && err.message) || err));
      }
    }
  );

  // --- feedback --------------------------------------------------------------
  // Marking feedback applied is part of the learning loop (src/scrape/learn.js reads
  // only home-team feedback anyway) — an owner action.
  app.post(
    '/api/feedback/:id/applied',
    {
      ...ownerAuth,
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
      // Only the caller's team's feedback: another team's note is not there to read or mark.
      const row = db.prepare(`SELECT * FROM feedback WHERE id = ? AND ${sameTeamSql(request.user)}`).get(id);
      if (!row) return notFound(reply);
      db.prepare('UPDATE feedback SET applied = 1, applied_note = ? WHERE id = ?').run(request.body.note, id);
      return db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
    }
  );

  void env;
}
