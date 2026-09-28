// Re-read the rent of every stored Facebook post with parseRent (2026-09-28). The old
// reader took the first price-shaped words, so "Available: 28 September 2026" became a
// 2 026 IDR rent, "IDR 55 Million" was not read at all, and a deposit, a pool fee, a
// sale price or a USD figure stood in for the rent. Price is a listing fact the import
// owns (never a person field), so the stored text is re-read and the facts replaced.
// A row from any other source only has a missing price filled from its text.

import { parseRent, normalisePrice } from './normalise.js';

/** History entries that held the old price now hold the new one; repeats collapse. */
function rewriteHistory(raw, oldMonth, newMonth) {
  let history;
  try {
    history = JSON.parse(raw || '[]');
  } catch {
    history = [];
  }
  if (!Array.isArray(history)) history = [];
  const out = [];
  for (const h of history) {
    const price = h && h.price_month_idr === oldMonth ? newMonth : h && h.price_month_idr;
    if (price == null) continue;
    if (out.length && out[out.length - 1].price_month_idr === price) continue;
    out.push({ ...h, price_month_idr: price });
  }
  return out;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} [config] run config (`usd_idr`)
 * @returns {{checked:number, changed:number}}
 */
export function repricePosts(db, config = {}) {
  const rows = db
    .prepare(
      `SELECT id, source, description, price_month_idr, price_year_idr, term, price_history, last_seen FROM properties
       WHERE source = 'fb' OR (price_month_idr IS NULL AND price_year_idr IS NULL)`
    )
    .all();
  const update = db.prepare(
    'UPDATE properties SET price_month_idr = ?, price_year_idr = ?, term = ?, price_history = ? WHERE id = ?'
  );
  let changed = 0;
  for (const row of rows) {
    const rent = parseRent(row.description, config);
    if (!rent && row.source !== 'fb') continue; // only a post's own reader may take a price away
    const { price_month_idr, price_year_idr } = normalisePrice({
      price_month_idr: rent?.price_month_idr ?? null,
      price_year_idr: rent?.price_year_idr ?? null,
    });
    const term = rent ? rent.term : null;
    if (price_month_idr === row.price_month_idr && price_year_idr === row.price_year_idr && term === row.term) continue;
    const history =
      row.price_month_idr == null && price_month_idr != null
        ? [{ date: String(row.last_seen).slice(0, 10), price_month_idr }]
        : rewriteHistory(row.price_history, row.price_month_idr, price_month_idr);
    update.run(price_month_idr, price_year_idr, term, JSON.stringify(history), row.id);
    changed += 1;
  }
  return { checked: rows.length, changed };
}

export default { repricePosts };
