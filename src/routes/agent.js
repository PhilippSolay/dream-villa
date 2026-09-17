// SPEC §4 "Agent API" — GET-only endpoints for the cloud morning session.
// CLAUDE.md: AGENT_TOKEN can only write agent_notes and inbox URLs, everything else
// here is read-only. All responses are text/plain bodies containing JSON (so a
// summarising fetch tool reads them whole) and must never echo the token back.

import crypto from 'node:crypto';
import { nowIso, getConfig, setConfig } from '../db.js';
import { WEIGHT_KEYS, ACTIVE_STATUSES } from '../defaults.js';
import { parseRow, rescoreAll, countsSummary } from '../scrape/store.js';
import { reasonsFor } from '../scrape/score.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_ROWS = 40;
const MAX_DIGEST_BYTES = 40 * 1024;
const MAX_ERRORS_CHARS = 2000;
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const CONTENT_TYPE = 'text/plain; charset=utf-8';

/** Constant-time token compare — same approach as auth.js's safeEqual (hash first so
 *  unequal lengths don't leak via timing, then a fixed-time compare). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * In-memory sliding-window rate limiter, N requests per windowMs, keyed by whatever
 * string the caller passes (here: the presented token). Exported so tests can build
 * one with a small limit/window instead of waiting an hour.
 */
export function createRateLimiter({ limit = DEFAULT_RATE_LIMIT, windowMs = DEFAULT_RATE_WINDOW_MS } = {}) {
  const hits = new Map(); // key -> timestamps[]
  return function check(key) {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      const retryAfterMs = windowMs - (now - recent[0]);
      return { limited: true, retry_after_s: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    recent.push(now);
    hits.set(key, recent);
    return { limited: false };
  };
}

function tokenFromRequest(request) {
  const q = request.query?.token;
  if (typeof q === 'string' && q) return q;
  const header = request.headers?.authorization || '';
  if (header.startsWith('Bearer ')) {
    const bearer = header.slice('Bearer '.length).trim();
    if (bearer) return bearer;
  }
  return null;
}

function isLoopback(request) {
  const ip = request.ip || request.socket?.remoteAddress || '';
  return LOOPBACK_IPS.has(ip);
}

function isSecureEnough(request, env) {
  if (request.protocol === 'https') return true;
  if (env.NODE_ENV !== 'production') return true;
  if (isLoopback(request)) return true;
  return false;
}

function sendText(reply, code, body) {
  reply.code(code).type(CONTENT_TYPE);
  return JSON.stringify(body);
}

/** Fastify preHandler enforcing SPEC §4's agent-API contract: token, HTTPS, rate limit. */
function buildGate(env, limiter) {
  return async function agentGate(request, reply) {
    if (!env.AGENT_TOKEN) {
      reply.code(503).type(CONTENT_TYPE).send(JSON.stringify({ error: 'agent_api_disabled' }));
      return;
    }
    const presented = tokenFromRequest(request);
    if (!presented || !safeEqual(presented, env.AGENT_TOKEN)) {
      reply.code(401).type(CONTENT_TYPE).send(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (!isSecureEnough(request, env)) {
      reply.code(403).type(CONTENT_TYPE).send(JSON.stringify({ error: 'https_required' }));
      return;
    }
    const rl = limiter(presented);
    if (rl.limited) {
      reply
        .code(429)
        .type(CONTENT_TYPE)
        .send(JSON.stringify({ error: 'rate_limited', retry_after_s: rl.retry_after_s }));
      return;
    }
  };
}

function truncate(str, n) {
  if (typeof str !== 'string' || str.length <= n) return str;
  return `${str.slice(0, n)}…`;
}

function byteSize(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/** Shrink the digest, in stages, until it's under the SPEC's 40 KB cap. */
function trimToBudget(payload, maxBytes = MAX_DIGEST_BYTES) {
  if (byteSize(payload) < maxBytes) return payload;

  for (const key of ['new', 'flagged']) {
    for (const row of payload[key] || []) {
      row.title = truncate(row.title, 60);
      if (Array.isArray(row.reasons)) row.reasons = row.reasons.slice(0, 4);
    }
  }
  if (byteSize(payload) < maxBytes) return payload;

  for (const row of payload.changes || []) row.title = truncate(row.title, 40);
  for (const row of payload.feedback || []) {
    row.title = truncate(row.title, 40);
    row.text = truncate(row.text, 200);
  }
  for (const row of payload.viewings || []) {
    row.title = truncate(row.title, 40);
    row.notes = truncate(row.notes, 200);
  }
  if (byteSize(payload) < maxBytes) return payload;

  for (const key of ['new', 'flagged']) {
    while (payload[key].length > 5 && byteSize(payload) >= maxBytes) payload[key].pop();
  }
  return payload;
}

function toDigestRow(row) {
  const r = parseRow(row);
  return {
    id: r.id,
    ref: r.ref,
    title: r.title,
    area: r.area,
    sub_area: r.sub_area,
    price_month_idr: r.price_month_idr,
    term: r.term,
    beach_km: r.beach_km,
    bedrooms: r.bedrooms,
    fit_score: r.fit_score,
    flagged: r.flagged,
    status: r.status,
    url: r.url,
    hero_url: r.hero_file ? `/images/${r.hero_file}` : null,
    reasons: reasonsFor(r),
  };
}

function safeJsonParse(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Parsed `runs` row, dropping the raw `errors` blob for a count when it's large (SPEC §4). */
function parseRun(row) {
  if (!row) return null;
  const errors = safeJsonParse(row.errors, []);
  const errorsJson = JSON.stringify(errors);
  return {
    id: row.id,
    kind: row.kind,
    started_at: row.started_at,
    finished_at: row.finished_at,
    sources: safeJsonParse(row.sources, []),
    seen: row.seen,
    new: row.new,
    updated: row.updated,
    gone: row.gone,
    flagged: row.flagged,
    weight_changes: safeJsonParse(row.weight_changes, null),
    notes: safeJsonParse(row.notes, []),
    errors: errorsJson.length > MAX_ERRORS_CHARS ? { count: Array.isArray(errors) ? errors.length : 0, truncated: true } : errors,
  };
}

function isValidHttpUrl(str) {
  if (typeof str !== 'string' || !str || str.length > 1000) return false;
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export default async function agentRoutes(app, { db, env = process.env, rateLimiter } = {}) {
  const limiter = rateLimiter || createRateLimiter();
  // Scoped to this plugin instance only — properties.js/market.js/admin.js routes
  // (registered as sibling plugins in server.js) are unaffected by this hook.
  app.addHook('preHandler', buildGate(env, limiter));

  app.get('/api/agent/digest', async (request, reply) => {
    const config = getConfig(db);
    const now = nowIso();
    const since = config.last_digest_at || new Date(Date.now() - DAY_MS).toISOString();
    const sinceDay = since.slice(0, 10);

    const newRows = db
      .prepare(
        `SELECT * FROM properties
         WHERE first_seen > ? AND (availability IS NULL OR availability != 'gone')
         ORDER BY CASE WHEN scope = 'in_filter' THEN 0 ELSE 1 END, first_seen DESC
         LIMIT ${MAX_ROWS}`
      )
      .all(since);

    const flaggedRows = db
      .prepare(`SELECT * FROM properties WHERE flagged = 1 ORDER BY first_seen DESC LIMIT ${MAX_ROWS}`)
      .all();

    // changes: price history entries dated after `since` (day granularity — price_history
    // only ever records a date, not a time), gone transitions, and status changes.
    const changes = [];

    const withHistory = db
      .prepare("SELECT id, ref, title, price_history FROM properties WHERE price_history IS NOT NULL AND price_history != '[]'")
      .all();
    for (const row of withHistory) {
      const history = safeJsonParse(row.price_history, []);
      if (!Array.isArray(history)) continue;
      for (let i = 1; i < history.length; i += 1) {
        if (history[i].date > sinceDay) {
          changes.push({
            id: row.id,
            ref: row.ref,
            title: row.title,
            what: 'price',
            from: history[i - 1].price_month_idr,
            to: history[i].price_month_idr,
          });
        }
      }
    }

    const goneRows = db.prepare("SELECT id, ref, title FROM properties WHERE availability = 'gone' AND last_seen > ?").all(since);
    for (const row of goneRows) changes.push({ id: row.id, ref: row.ref, title: row.title, what: 'gone' });

    const statusRows = db
      .prepare(
        `SELECT p.id AS id, p.ref AS ref, p.title AS title, p.status AS status, u.name AS by_name
         FROM properties p LEFT JOIN users u ON u.id = p.status_by
         WHERE p.status_at > ?`
      )
      .all(since);
    for (const row of statusRows) {
      changes.push({ id: row.id, ref: row.ref, title: row.title, what: 'status', to: row.status, by_name: row.by_name || null });
    }

    const feedback = db
      .prepare(
        `SELECT f.id AS id, f.property_id AS property_id, p.title AS title, u.name AS by_name,
                f.text AS text, f.created_at AS created_at, f.applied AS applied
         FROM feedback f
         LEFT JOIN properties p ON p.id = f.property_id
         LEFT JOIN users u ON u.id = f.by
         WHERE f.created_at > ?
         ORDER BY f.created_at DESC`
      )
      .all(since);

    const viewings = db
      .prepare(
        `SELECT v.property_id AS property_id, p.title AS title, u.name AS by_name,
                v.date AS date, v.verdict AS verdict, v.quiet AS quiet, v.privacy AS privacy, v.notes AS notes
         FROM viewings v
         LEFT JOIN properties p ON p.id = v.property_id
         LEFT JOIN users u ON u.id = v.by
         WHERE v.created_at > ?
         ORDER BY v.created_at DESC`
      )
      .all(since);

    const lastRun = db.prepare("SELECT * FROM runs WHERE kind = 'scrape' ORDER BY id DESC LIMIT 1").get();

    const counts = countsSummary(db);
    const shortlistPlaceholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const shortlist = db
      .prepare(`SELECT COUNT(*) AS n FROM properties WHERE status IN (${shortlistPlaceholders})`)
      .get(...ACTIVE_STATUSES).n;

    let payload = {
      since,
      now,
      new: newRows.map(toDigestRow),
      flagged: flaggedRows.map(toDigestRow),
      changes,
      feedback,
      viewings,
      run: parseRun(lastRun),
      weights: config.weights,
      counts: { in_filter: counts.in_filter, market: counts.market, flagged: counts.flagged, shortlist },
    };
    payload = trimToBudget(payload);

    // Advance the watermark only after the response is built from it.
    setConfig(db, 'last_digest_at', now);

    return sendText(reply, 200, payload);
  });

  app.get('/api/agent/note', async (request, reply) => {
    const text = typeof request.query.text === 'string' ? request.query.text : '';
    if (text.length < 1 || text.length > 2000) {
      return sendText(reply, 400, { error: 'invalid_text', reason: 'text must be 1-2000 characters' });
    }
    const today = nowIso().slice(0, 10);
    const info = db.prepare('INSERT INTO agent_notes (date, text) VALUES (?, ?)').run(today, text);
    return sendText(reply, 200, { ok: true, id: Number(info.lastInsertRowid) });
  });

  app.get('/api/agent/inbox', async (request, reply) => {
    const url = typeof request.query.url === 'string' ? request.query.url.trim() : '';
    const note = typeof request.query.note === 'string' ? request.query.note : null;
    if (!isValidHttpUrl(url)) {
      return sendText(reply, 400, { error: 'invalid_url' });
    }
    const existing = db.prepare('SELECT id FROM inbox WHERE url = ?').get(url);
    if (existing) {
      return sendText(reply, 200, { ok: true, id: existing.id, existing: true });
    }
    const info = db.prepare('INSERT INTO inbox (url, by, note, status) VALUES (?, ?, ?, ?)').run(url, 'agent', note, 'pending');
    return sendText(reply, 200, { ok: true, id: Number(info.lastInsertRowid) });
  });

  app.get('/api/agent/weights', async (request, reply) => {
    const config = getConfig(db);
    const currentWeights = { ...config.weights };
    const raw = request.query.set;

    if (raw === undefined) {
      return sendText(reply, 200, { ok: true, weights: currentWeights });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendText(reply, 400, { error: 'invalid_json' });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return sendText(reply, 400, { error: 'invalid_weights', reason: 'expected a JSON object' });
    }

    for (const key of Object.keys(parsed)) {
      if (!WEIGHT_KEYS.includes(key)) {
        return sendText(reply, 400, { error: 'invalid_key', key });
      }
      const val = parsed[key];
      if (!Number.isInteger(val) || val < 0 || val > 20) {
        return sendText(reply, 400, { error: 'invalid_value', key, reason: 'must be an integer 0-20' });
      }
    }

    const nextWeights = { ...currentWeights };
    const weightChanges = [];
    for (const key of Object.keys(parsed)) {
      const from = currentWeights[key];
      const to = parsed[key];
      if (from !== to) {
        weightChanges.push({ feature: key, from, to, because: 'agent' });
        nextWeights[key] = to;
      }
    }

    setConfig(db, 'weights', nextWeights);
    rescoreAll(db, { ...config, weights: nextWeights });

    const runNow = nowIso();
    db.prepare('INSERT INTO runs (started_at, finished_at, kind, weight_changes) VALUES (?, ?, ?, ?)').run(
      runNow,
      runNow,
      'learn',
      JSON.stringify(weightChanges)
    );

    return sendText(reply, 200, { ok: true, weights: nextWeights });
  });

  app.get('/api/agent/feedback-applied', async (request, reply) => {
    const id = Number(request.query.id);
    const note = typeof request.query.note === 'string' ? request.query.note : null;
    if (!Number.isInteger(id) || id <= 0) {
      return sendText(reply, 400, { error: 'invalid_id' });
    }
    const existing = db.prepare('SELECT id FROM feedback WHERE id = ?').get(id);
    if (!existing) {
      return sendText(reply, 404, { error: 'not_found' });
    }
    db.prepare('UPDATE feedback SET applied = 1, applied_note = ? WHERE id = ?').run(note, id);
    return sendText(reply, 200, { ok: true });
  });
}
