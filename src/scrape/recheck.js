// SPEC §6 "Recheck" — refetch every listing we actually care about, daily:
// anything in the pipeline (shortlist … offer) and anything flagged.
//
// A price change appends to `price_history` (upsertProperty does that) and is
// reported; a 404, an empty payload or an adapter's `gone: true` marks the row
// `availability='gone'`. Never a delete (CLAUDE.md).

import { nowIso, getConfig } from '../db.js';
import { ACTIVE_STATUSES } from '../defaults.js';
import { markGone } from './store.js';
import { ingestDetail, stripNulls } from './ingest.js';

const STATUS_PLACEHOLDERS = ACTIVE_STATUSES.map(() => '?').join(', ');

const SELECT_SQL = `
  SELECT * FROM properties
   WHERE (status IN (${STATUS_PLACEHOLDERS}) OR flagged = 1)
     AND (availability IS NULL OR availability <> 'gone')
   ORDER BY id`;

/**
 * A ctx whose fetches always bypass the 24 h page cache — a recheck wants today's page —
 * and which remembers the HTTP status of every page it fetched, so the caller can tell a
 * real 404 from an adapter that simply failed to parse a page that was served fine.
 */
export function forceCtx(ctx) {
  if (!ctx || typeof ctx.fetchHtml !== 'function') return ctx;
  const statuses = new Map();
  return {
    ...ctx,
    statuses,
    async fetchHtml(url, opts = {}) {
      const res = await ctx.fetchHtml(url, { ...opts, force: true });
      statuses.set(url, res && res.status);
      return res;
    },
  };
}

const GONE_STATUS = new Set([404, 410]);

/** The stored row, shaped back into the partial `normaliseListing` expects. */
function partialFromRow(row) {
  return {
    source: row.source,
    ref: row.ref,
    url: row.url,
    title: row.title,
    location: [row.area, row.sub_area].filter(Boolean).join(' - '),
    bedrooms: row.bedrooms,
    price_month_idr: row.price_month_idr,
    price_year_idr: row.price_year_idr,
    term: row.term,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} ctx createCtx() result
 * @param {Record<string, object>} adaptersById source id → adapter
 * @param {{now?:string, limit?:number|null, config?:object}} [opts]
 * @returns {Promise<{checked:number, price_changes:object[], gone:number[], errors:string[]}>}
 */
export async function recheckAll(db, ctx, adaptersById = {}, { now = nowIso(), limit = null, config: cfgIn = null } = {}) {
  const config = cfgIn || (ctx && ctx.config && Object.keys(ctx.config).length ? ctx.config : getConfig(db));

  let rows = db.prepare(SELECT_SQL).all(...ACTIVE_STATUSES);
  if (limit != null) rows = rows.slice(0, limit);

  const out = { checked: 0, price_changes: [], gone: [], errors: [] };
  const fctx = forceCtx(ctx);

  for (const row of rows) {
    const adapter = adaptersById[row.source];
    if (!adapter || typeof adapter.detail !== 'function') {
      out.errors.push(`${row.ref || row.id}: no adapter for source '${row.source}'`);
      continue;
    }

    out.checked += 1;
    try {
      const d = await adapter.detail(fctx, row.url, { force: true });

      // SPEC §6: gone means the listing is gone — a 404/410, or the adapter saying so
      // (Bali Home Immo's `is_archived`). A null from a page that was served 200 is a
      // parse failure, and marking every tracked villa gone because a site changed its
      // markup would be far worse than a missed update, so that is an error instead.
      if (d && d.gone) {
        markGone(db, row.id, now);
        out.gone.push(row.id);
        continue;
      }
      if (!d) {
        const status = fctx.statuses ? fctx.statuses.get(row.url) : undefined;
        if (GONE_STATUS.has(status)) {
          markGone(db, row.id, now);
          out.gone.push(row.id);
        } else {
          out.errors.push(`${row.ref || row.id}: no listing data in a ${status ?? 'n/a'} response — left as is`);
        }
        continue;
      }

      const partial = { ...partialFromRow(row), ...stripNulls(d), source: row.source, ref: row.ref, url: row.url };
      const res = ingestDetail(db, { partial, detail: d, adapter, config, now });

      for (const change of res.changes || []) {
        if (change.what === 'price') {
          out.price_changes.push({ id: row.id, ref: row.ref, from: change.from, to: change.to });
        }
      }
      if (res.row && res.row.availability === 'gone') out.gone.push(row.id);
    } catch (err) {
      const msg = String((err && err.message) || err);
      out.errors.push(`${row.ref || row.id}: ${msg}`);
      if (msg.startsWith('blocked:')) break; // the host is turning us away — stop asking
    }
  }

  return out;
}

export default { recheckAll, forceCtx };
