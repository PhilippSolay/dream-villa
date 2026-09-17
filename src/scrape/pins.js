// SPEC §6 "Pins" — pure helpers. Nothing here touches the database or the network.

import { AREAS, nearestBeach } from '../areas.js';

function isCoord(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

export function mapUrl(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

/**
 * Priority: keep a real pin (`lat`/`lng` already present); else fall back to the
 * area centroid (§7); area `'other'` has no centroid and is left unchanged.
 */
export function assignPin(row) {
  const out = { ...row };

  if (isCoord(out.lat) && isCoord(out.lng)) {
    if (!out.pin_source) out.pin_source = 'listing_map';
  } else if (AREAS[out.area]) {
    const [lat, lng] = AREAS[out.area].centroid;
    out.lat = lat;
    out.lng = lng;
    out.pin_source = 'centroid';
  }

  if (isCoord(out.lat) && isCoord(out.lng)) {
    out.map_url = mapUrl(out.lat, out.lng);
  }

  return out;
}

/**
 * Fills `beach_km`/`beach_name`/`beach_source='computed'` from the pin when the
 * listing text didn't give a distance. A `listing_text` source is authoritative
 * and is never overwritten (SPEC §7: text-derived distances win over computed).
 */
export function computeBeach(row) {
  const out = { ...row };
  if (out.beach_source === 'listing_text') return out;
  if (out.beach_km == null && isCoord(out.lat) && isCoord(out.lng)) {
    const nearest = nearestBeach(Number(out.lat), Number(out.lng));
    if (nearest) {
      out.beach_km = nearest.km;
      out.beach_name = nearest.name;
      out.beach_source = 'computed';
    }
  }
  return out;
}

export function placePins(row) {
  return computeBeach(assignPin(row));
}

export default { mapUrl, assignPin, computeBeach, placePins };
