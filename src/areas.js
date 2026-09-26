// SPEC §7 — the server's half of the area table: place-name matching and the
// beach-distance maths.
//
// The table itself (regions, areas, centroids, beach points) lives in
// public/lib/areas.js — the one copy the browser imports too — and is re-exported
// here, so every existing `import { AREAS } from '../areas.js'` still reads the
// same object. There is nothing to keep in sync: test/areas-single-source.test.js
// fails if a second copy of the table appears anywhere.

import { AREA_GROUPS, AREAS, TARGET_AREAS, BEACHES } from '../public/lib/areas.js';

export { AREA_GROUPS, AREAS, TARGET_AREAS, BEACHES };

/**
 * Place name → area, most specific first. The one table every reader shares: the BHI
 * mapper (normalise.js), the other adapters (_shared.js) and the Facebook importer
 * (routes/import.js). Banjar and street names belong here — a listing that says
 * "Nyuh Kuning" or "Kayu Tulang" is in Ubud and Canggu respectively, and without the
 * name it falls through to `other` and is never stored.
 *
 * Order is the rule, not a formality: a string naming two places resolves to the first
 * match, so villages come before the regions that contain them, and the Canggu belt
 * comes last — "Pererenan, Canggu" is Pererenan.
 */
export const PLACE_WORDS = [
  // Center — the desa around Ubud first, then Ubud's own banjars; bare "Ubud" waits at
  // the bottom. "Mas" is the Indonesian honorific as often as it is the village
  // ("hubungi mas Wayan"), so it only counts beside Ubud or spelled out as a place.
  [/tegal+alang|\bkeliki\b|kenderan|\bsebatu\b|\bpujung\b/i, 'tegallalang'],
  [/payangan|melinggih|\bbuahan\b|\bkelusa\b|\bbresela\b/i, 'payangan'],
  [/\bpejeng\b|\bbedulu\b|tampaksiring|goa\s*gajah/i, 'pejeng'],
  [/lodtunduh|singakerta|\bkemenuh\b|\bmas[,\s]+ubud\b|\bubud[,\s]+mas\b|desa\s+mas\b|banjar\s+mas\b/i, 'lodtunduh'],
  [/nyuh\s*kuning|penestanan|\bsayan\b|campuhan|padang\s*tegal|padangtegal|pengosekan|kedewatan|peliatan|tebesaya/i, 'ubud'],

  // West Coast — west to east, villages before the regions that swallow them
  [/\bseseh\b/i, 'seseh'],
  [/\bcemagi\b|\bmengening\b/i, 'cemagi'],
  [/\bmunggu\b/i, 'munggu'],
  [/\bpererenan\b|tumbak\s*bayuh|\btumbak\b|\bbuduk\b|tiying\s*tutul/i, 'pererenan'],
  [/\bnyanyi\b/i, 'nyanyi'],
  [/\bkedungu\b/i, 'kedungu'],
  [/\bbuwit\b/i, 'buwit'],
  [/kaba[-\s]?kaba|tanah\s*lot|\bcepaka\b|\bbelalang\b/i, 'tanah_lot'],
  [/\bmengwi\b/i, 'mengwi'],

  // South
  [/\bbingin\b|impossibles/i, 'bingin'],
  [/padang\s*padang|labuan\s*sait/i, 'padang_padang'],
  [/\bbalangan\b/i, 'balangan'],
  [/\bpandawa\b|\bkutuh\b/i, 'pandawa'],
  [/\bungasan\b|\bmelasti\b/i, 'ungasan'],
  [/\buluwatu\b|\bpecatu\b|\bsuluban\b|nyang\s*nyang|karang\s*boma/i, 'uluwatu'],

  // Tabanan is the regency around Tanah Lot; SPEC §7 maps its "North side" there.
  [/\btabanan\b/i, 'tanah_lot'],

  // The Canggu belt last, its banjars before the desa that contains them.
  [/\bumalas\b/i, 'umalas'],
  [/\bbabakan\b/i, 'babakan'],
  [/\bpadonan\b/i, 'padonan'],
  [/\bpelambingan\b|\bumasari\b|\btibubeneng\b/i, 'tibubeneng'],
  [/\bberawa\b|\bbrawa\b/i, 'berawa'],
  [/kayu\s*tulang|padang\s*linjong|tegal\s*gundul|batu\s*bolong|echo\s*beach|batu\s*mejan|pantai\s*nelayan|\bcanggu\b/i, 'canggu'],

  // The two broad names agents reach for last of all: a villa "in Pererenan with Ubud
  // vibes" is in Pererenan, and every more specific name above has already had its turn.
  [/\bubud\b/i, 'ubud'],
];

export const ROAD_FACTOR = 1.3;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Nearest beach point to a pin → { name, km } with the §7 road factor applied. */
export function nearestBeach(lat, lng) {
  let best = null;
  for (const b of BEACHES) {
    const km = haversineKm(lat, lng, b.lat, b.lng) * ROAD_FACTOR;
    if (!best || km < best.km) best = { name: b.name, km: Math.round(km * 100) / 100 };
  }
  return best;
}
