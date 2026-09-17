// SPEC §6 "Adapters to build" item 5 (`inbox`) + §4 `POST /api/inbox` — the daily pass
// that turns pending `inbox` rows (a URL someone pasted, or the cloud agent queued via
// GET /api/agent/inbox) into stored properties: match the URL's hostname against a
// known adapter's `base`, else fall through to the generic extractor.
//
// An inbox URL was chosen by a person (or the agent), so — unlike the daily per-source
// crawl — it must always be stored, never silently dropped for landing outside the
// aggregation band (SPEC §2). `ingestDetail` (the same "fold an already-fetched detail
// payload into the store" helper recheck.js uses) never applies the band check at all,
// and SPEC §2's normal scoring (hardFilters) is strictly narrower than the band, so an
// out-of-band listing lands in scope='market' on its own — no separate override needed.

import { nowIso, getConfig } from '../db.js';
import { adapters as registry } from './adapters/index.js';
import generic from './adapters/generic.js';
import { ingestDetail } from './ingest.js';

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/** The pool adapter whose `base` hostname matches the URL, else the generic extractor. */
export function pickAdapter(url, pool) {
  const host = hostnameOf(url);
  if (host) {
    for (const adapter of pool) {
      if (adapter && adapter.base && hostnameOf(adapter.base) === host) return adapter;
    }
  }
  return generic;
}

/** ctx carries the run's config; a bare ctx (or none) falls back to the db (ingest.js's own rule). */
function configFrom(db, ctx) {
  const c = ctx && ctx.config;
  if (c && typeof c === 'object' && Object.keys(c).length) return c;
  return getConfig(db);
}

function appendNote(existing, addition) {
  return existing ? `${existing} | ${addition}` : addition;
}

function markInbox(db, id, status, note) {
  db.prepare('UPDATE inbox SET status = ?, note = ? WHERE id = ?').run(status, note, id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} ctx createCtx() result (fetchHtml, config, log)
 * @param {{limit?:number, adapters?:object[]|null, log?:Function}} [opts]
 *   `adapters`: pool to match against instead of the registry (tests) — the generic
 *   fallback is always available regardless of what's passed.
 * @returns {Promise<{processed:number, done:number, failed:number, skipped:number, items:object[]}>}
 */
export async function processInbox(db, ctx, { limit = 50, adapters: adapterList = null, log = null } = {}) {
  const pool = adapterList && adapterList.length ? adapterList : Object.values(registry);
  const config = configFrom(db, ctx);
  const now = nowIso();

  const rows = db.prepare("SELECT * FROM inbox WHERE status = 'pending' ORDER BY id ASC LIMIT ?").all(limit);
  const out = { processed: 0, done: 0, failed: 0, skipped: 0, items: [] };

  for (const row of rows) {
    out.processed += 1;
    const adapter = pickAdapter(row.url, pool);

    try {
      const d = await adapter.detail(ctx, row.url);

      if (!d) {
        markInbox(db, row.id, 'failed', appendNote(row.note, 'no listing data (404 or unparseable)'));
        out.failed += 1;
        out.items.push({ id: row.id, url: row.url, result: 'failed' });
        log?.(`[inbox] ${row.url} -> failed (no data, adapter=${adapter.id})`);
        continue;
      }

      // Inbox items are stored under whatever key the detail payload asserts (matching
      // adapter or the generic hostname:sha1 scheme) — the partial is just a seed for
      // fields the payload itself leaves null.
      const partial = { source: d.source || adapter.id, ref: d.ref || null, url: row.url };
      const res = ingestDetail(db, { partial, detail: d, adapter, config, now });

      markInbox(db, row.id, 'done', appendNote(row.note, `→ #${res.id}`));
      out.done += 1;
      out.items.push({ id: row.id, url: row.url, result: res.action, property_id: res.id });
      log?.(`[inbox] ${row.url} -> #${res.id} (${res.action}, adapter=${adapter.id})`);
    } catch (err) {
      const msg = String((err && err.message) || err);
      markInbox(db, row.id, 'failed', appendNote(row.note, msg));
      out.failed += 1;
      out.items.push({ id: row.id, url: row.url, result: 'failed', error: msg });
      log?.(`[inbox] ${row.url} -> failed (${msg})`);
    }
  }

  return out;
}

export default { processInbox, pickAdapter };
