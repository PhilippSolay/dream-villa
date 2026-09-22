// SPEC §7 — canonical areas, rough centroids, nearest beach points.
// Centroids are approximate and only used when pin_source = 'centroid'.
//
// Three levels, the way the listings themselves talk (SPEC §7 "Region › Area › Banjar"):
//   group  — Center / West Coast / South, the region
//   area   — the key of this table, roughly a desa: Ubud, Pererenan, Canggu
//   banjar — the hamlet inside it, kept in `sub_area`: Nyuh Kuning, Tumbak Bayuh, Berawa
// Listed north to south inside each group, which is the order the filter drawer shows.

export const AREA_GROUPS = [
  { id: 'center', label: 'Center' },
  { id: 'west_coast', label: 'West Coast' },
  { id: 'south', label: 'South' },
];

export const AREAS = {
  // Center — around Ubud. Inland: ~30 km from the nearest beach we track, so the beach
  // score is 0 by construction rather than by a missing value.
  ubud:          { label: 'Ubud',              group: 'center',     centroid: [-8.507, 115.263], beach: { name: 'Berawa Beach',      lat: -8.6725, lng: 115.1400 } },

  // West Coast — north to south, Tabanan down to the Kerobokan edge.
  mengwi:        { label: 'Mengwi',            group: 'west_coast', centroid: [-8.545, 115.170], beach: { name: 'Seseh Beach',        lat: -8.6315, lng: 115.0975 } },
  buwit:         { label: 'Buwit',             group: 'west_coast', centroid: [-8.583, 115.100], beach: { name: 'Nyanyi Beach',       lat: -8.6125, lng: 115.0765 } },
  kedungu:       { label: 'Kedungu',           group: 'west_coast', centroid: [-8.597, 115.064], beach: { name: 'Kedungu Beach',      lat: -8.6005, lng: 115.0605 } },
  nyanyi:        { label: 'Nyanyi',            group: 'west_coast', centroid: [-8.608, 115.080], beach: { name: 'Nyanyi Beach',       lat: -8.6125, lng: 115.0765 } },
  tanah_lot:     { label: 'Tanah Lot area',    group: 'west_coast', centroid: [-8.615, 115.090], beach: { name: 'Tanah Lot',          lat: -8.6215, lng: 115.0865 } },
  munggu:        { label: 'Munggu',            group: 'west_coast', centroid: [-8.617, 115.094], beach: { name: 'Munggu Beach',       lat: -8.6215, lng: 115.0905 } },
  cemagi:        { label: 'Cemagi',            group: 'west_coast', centroid: [-8.619, 115.103], beach: { name: 'Cemagi/Mengening',   lat: -8.6255, lng: 115.0995 } },
  seseh:         { label: 'Seseh',             group: 'west_coast', centroid: [-8.628, 115.099], beach: { name: 'Seseh Beach',        lat: -8.6315, lng: 115.0975 } },
  pererenan:     { label: 'Pererenan',         group: 'west_coast', centroid: [-8.640, 115.121], beach: { name: 'Pererenan Beach',    lat: -8.6475, lng: 115.1185 } },
  padonan:       { label: 'Padonan',           group: 'west_coast', centroid: [-8.645, 115.148], beach: { name: 'Berawa Beach',       lat: -8.6725, lng: 115.1400 } },
  canggu:        { label: 'Canggu',            group: 'west_coast', centroid: [-8.652, 115.130], beach: { name: 'Batu Bolong / Echo', lat: -8.6565, lng: 115.1265 } },
  tibubeneng:    { label: 'Tibubeneng',        group: 'west_coast', centroid: [-8.653, 115.151], beach: { name: 'Berawa Beach',       lat: -8.6725, lng: 115.1400 } },
  babakan:       { label: 'Babakan',           group: 'west_coast', centroid: [-8.657, 115.139], beach: { name: 'Batu Bolong / Echo', lat: -8.6565, lng: 115.1265 } },
  berawa:        { label: 'Berawa',            group: 'west_coast', centroid: [-8.666, 115.143], beach: { name: 'Berawa Beach',       lat: -8.6725, lng: 115.1400 } },
  umalas:        { label: 'Umalas',            group: 'west_coast', centroid: [-8.670, 115.157], beach: { name: 'Berawa Beach',       lat: -8.6725, lng: 115.1400 } },

  // South — the Bukit, north to south.
  balangan:      { label: 'Balangan',          group: 'south',      centroid: [-8.792, 115.124], beach: { name: 'Balangan Beach',     lat: -8.7915, lng: 115.1215 } },
  bingin:        { label: 'Bingin',            group: 'south',      centroid: [-8.806, 115.113], beach: { name: 'Bingin Beach',       lat: -8.8075, lng: 115.1095 } },
  padang_padang: { label: 'Padang Padang',     group: 'south',      centroid: [-8.811, 115.106], beach: { name: 'Padang Padang',      lat: -8.8115, lng: 115.1035 } },
  uluwatu:       { label: 'Uluwatu / Pecatu',  group: 'south',      centroid: [-8.829, 115.098], beach: { name: 'Suluban',            lat: -8.8145, lng: 115.0885 } },
  ungasan:       { label: 'Ungasan',           group: 'south',      centroid: [-8.833, 115.160], beach: { name: 'Melasti',            lat: -8.8475, lng: 115.1555 } },
  pandawa:       { label: 'Pandawa / Kutuh',   group: 'south',      centroid: [-8.842, 115.190], beach: { name: 'Pandawa Beach',      lat: -8.8455, lng: 115.1875 } },
};

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
  // Center — the banjars around Ubud are specific; bare "Ubud" waits at the bottom.
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

/** Canonical area ids in the target list (everything else is 'other'). */
export const TARGET_AREAS = Object.keys(AREAS);

/** Distinct beach points (deduped by name) for haversine nearest-beach lookups. */
export const BEACHES = Object.values(
  Object.fromEntries(Object.values(AREAS).map((a) => [a.beach.name, a.beach]))
);

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
