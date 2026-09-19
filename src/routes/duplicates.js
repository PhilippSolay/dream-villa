// The duplicate checker's API (SPEC §6, manual half). Scoring lives in
// src/scrape/duplicates.js, merging in src/scrape/dedupe.js; this file is routing,
// auth, validation and the property summaries the two UI sections render.
//
// A merge is hard to undo, so the person picks the keeper (`keep_id`) — unlike the
// automatic pass, where the older row always wins. A dismissal is reversible.

import { nowIso } from '../db.js';
import { mergeInto } from '../scrape/dedupe.js';
import { allCandidates, candidatesFor, loadContext } from '../scrape/duplicates.js';
import { parseRow } from '../scrape/store.js';
import { badRequest, getProperty, heroUrl, notFound, placeholders, strictSchemas } from './_common.js';
import { publicRow } from './properties.js';

const idSchema = { type: 'integer', minimum: 1 };
const pairBody = {
  type: 'object', additionalProperties: false, required: ['a', 'b'],
  properties: { a: idSchema, b: idSchema },
};

/** The card both UI sections draw: enough to recognise the villa, nothing more. */
function summary(row) {
  const parsed = parseRow(row);
  return {
    id: parsed.id,
    title: parsed.title,
    source: parsed.source,
    ref: parsed.ref,
    area: parsed.area,
    sub_area: parsed.sub_area,
    price_month_idr: parsed.price_month_idr,
    bedrooms: parsed.bedrooms,
    hero_url: heroUrl(parsed),
    url: parsed.url,
    status: parsed.status,
  };
}

/** id → summary for every id in `ids`, in one query. */
function summariesFor(db, ids) {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const rows = db.prepare(`SELECT * FROM properties WHERE id IN (${placeholders(list)})`).all(...list);
  return new Map(rows.map((r) => [r.id, summary(r)]));
}

/** Dismissals are stored with the smaller id first so a pair is one row either way. */
function ordered(a, b) {
  return a < b ? [a, b] : [b, a];
}

export default async function duplicatesRoutes(app, opts) {
  const { db } = opts;
  // onRequest, not preHandler: an anonymous caller must get the 401, not a schema 400.
  const auth = { onRequest: app.requireUser };

  strictSchemas(app);

  // --- candidates for one listing (detail page) ----------------------------
  app.get(
    '/api/properties/:id/duplicates',
    {
      ...auth,
      schema: {
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            min_score: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!getProperty(db, id)) return notFound(reply);

      const pairs = candidatesFor(db, id, {
        limit: request.query.limit ?? 10,
        minScore: request.query.min_score ?? 0.6,
      });
      const summaries = summariesFor(db, pairs.map((p) => p.b));

      return {
        candidates: pairs
          .filter((p) => summaries.has(p.b))
          .map((p) => ({ property: summaries.get(p.b), score: p.score, reasons: p.reasons })),
      };
    }
  );

  // --- every candidate pair (Agent page) -----------------------------------
  app.get(
    '/api/duplicates',
    {
      ...auth,
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            min_score: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
    async (request) => {
      const pairs = allCandidates(db, {
        limit: request.query.limit ?? 100,
        minScore: request.query.min_score ?? 0.6,
      });
      const summaries = summariesFor(db, pairs.flatMap((p) => [p.a, p.b]));

      return {
        pairs: pairs
          .filter((p) => summaries.has(p.a) && summaries.has(p.b))
          .map((p) => ({
            a: summaries.get(p.a),
            b: summaries.get(p.b),
            score: p.score,
            reasons: p.reasons,
          })),
      };
    }
  );

  // --- merge ---------------------------------------------------------------
  app.post(
    '/api/duplicates/merge',
    {
      ...auth,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['keep_id', 'merge_id'],
          properties: { keep_id: idSchema, merge_id: idSchema },
        },
      },
    },
    async (request, reply) => {
      const { keep_id: keepId, merge_id: mergeId } = request.body;
      if (keepId === mergeId) return badRequest(reply, 'keep_id and merge_id must differ');
      if (!getProperty(db, keepId) || !getProperty(db, mergeId)) return notFound(reply);

      const result = mergeInto(db, keepId, mergeId, {
        by: request.user.id,
        reason: `merged by hand by ${request.user.name}`,
      });
      if (result.error === 'already_gone') return badRequest(reply, 'that listing is already merged or gone');
      if (result.error) return badRequest(reply, result.error);

      // The pair is settled; a stale dismissal would only confuse a later pass.
      const [a, b] = ordered(keepId, mergeId);
      db.prepare('DELETE FROM duplicate_dismissals WHERE property_a = ? AND property_b = ?').run(a, b);

      return { ok: true, merged: result, property: publicRow(getProperty(db, keepId)) };
    }
  );

  // --- dismiss / undismiss (reversible; nothing is ever deleted) -----------
  app.post('/api/duplicates/dismiss', { ...auth, schema: { body: pairBody } }, async (request, reply) => {
    const [a, b] = ordered(request.body.a, request.body.b);
    if (a === b) return badRequest(reply, 'a and b must differ');
    if (!getProperty(db, a) || !getProperty(db, b)) return notFound(reply);

    db.prepare(
      `INSERT INTO duplicate_dismissals (property_a, property_b, by, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(property_a, property_b) DO NOTHING`
    ).run(a, b, request.user.id, nowIso());

    return { ok: true, a, b };
  });

  app.post('/api/duplicates/undismiss', { ...auth, schema: { body: pairBody } }, async (request, reply) => {
    const [a, b] = ordered(request.body.a, request.body.b);
    if (a === b) return badRequest(reply, 'a and b must differ');
    const info = db
      .prepare('DELETE FROM duplicate_dismissals WHERE property_a = ? AND property_b = ?')
      .run(a, b);
    return reply.send({ ok: true, a, b, removed: info.changes });
  });
}
