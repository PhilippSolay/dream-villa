// SPEC §6 "Pins" — Nominatim geocoding for rows with a street/banjar `address` but no real
// pin yet. Rate-limited (1 req/s) and cached via ctx.fetchHtml; nothing here touches the
// network directly.

import { AREAS, nearestBeach } from '../areas.js';
import { mapUrl } from './pins.js';

const BALI_BBOX = { latMin: -9.2, latMax: -8.0, lngMin: 114.4, lngMax: 115.8 };
const NOMINATIM_TTL_HOURS = 24 * 30;

function inBaliBbox(lat, lng) {
  return lat >= BALI_BBOX.latMin && lat <= BALI_BBOX.latMax && lng >= BALI_BBOX.lngMin && lng <= BALI_BBOX.lngMax;
}

/**
 * One Nominatim lookup. Returns {lat, lng, display_name} on a sane hit inside Bali, else null
 * (no address, no results, bad JSON, network error, or a result outside Bali's bbox).
 */
export async function geocodeOne(ctx, { address, sub_area, area, email }) {
  if (!address) return null;

  const label = AREAS[area]?.label || area;
  const q = [address, sub_area, label, 'Bali'].filter((part) => part != null && String(part).trim() !== '').join(', ');
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=id&q=${encodeURIComponent(
    q
  )}&email=${encodeURIComponent(email || '')}`;

  let res;
  try {
    res = await ctx.fetchHtml(url, { ttlHours: NOMINATIM_TTL_HOURS });
  } catch {
    return null;
  }
  if (!res || res.html == null) return null;

  let data;
  try {
    data = JSON.parse(res.html);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || !data.length) return null;

  const first = data[0];
  const lat = Number(first.lat);
  const lng = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!inBaliBbox(lat, lng)) return null;

  return { lat, lng, display_name: first.display_name || null };
}

/**
 * Geocode every row with pin_source IS NULL or 'centroid'. Rows without a non-empty address
 * are skipped (nothing to query); with no NOMINATIM_EMAIL configured the whole batch is
 * skipped (Nominatim's usage policy requires a contact address).
 * @returns {{attempted:number, resolved:number, skipped:number}}
 */
export async function geocodeMissing(db, ctx, { limit = null, email = process.env.NOMINATIM_EMAIL, log = ctx.log } = {}) {
  let sql = "SELECT * FROM properties WHERE (pin_source IS NULL OR pin_source = 'centroid')";
  if (limit != null) sql += ` LIMIT ${Number(limit)}`;
  const rows = db.prepare(sql).all();

  if (!email) {
    log?.warn?.('[geocode] NOMINATIM_EMAIL not set — skipping geocoding');
    return { attempted: 0, resolved: 0, skipped: rows.length };
  }

  let attempted = 0;
  let resolved = 0;
  let skipped = 0;

  const update = db.prepare(
    `UPDATE properties
       SET lat = ?, lng = ?, pin_source = 'geocode', map_url = ?, beach_km = ?, beach_name = ?, beach_source = ?
     WHERE id = ?`
  );

  for (const row of rows) {
    const address = row.address && String(row.address).trim();
    if (!address) {
      skipped++;
      continue;
    }
    attempted++;

    const result = await geocodeOne(ctx, { address, sub_area: row.sub_area, area: row.area, email });
    if (!result) continue;

    let beach_km = row.beach_km;
    let beach_name = row.beach_name;
    let beach_source = row.beach_source;
    if (row.beach_source !== 'listing_text') {
      const nearest = nearestBeach(result.lat, result.lng);
      if (nearest) {
        beach_km = nearest.km;
        beach_name = nearest.name;
        beach_source = 'computed';
      }
    }

    update.run(result.lat, result.lng, mapUrl(result.lat, result.lng), beach_km, beach_name, beach_source, row.id);
    resolved++;
  }

  return { attempted, resolved, skipped };
}

export default { geocodeMissing, geocodeOne };
