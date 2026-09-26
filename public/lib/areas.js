// SPEC §7 — the canonical area table: regions, areas, rough centroids, beach points.
//
// This is the single copy. It lives under public/lib/ because both halves of the app
// need it verbatim: the browser imports it directly (map rings, area labels, the filter
// drawer's regions) and src/areas.js re-exports it to the scraper, the scoring and
// GET /api/areas. It was three hand-kept copies until 2026-09-22, when the two frontend
// ones were found a week stale — still on the pre-Canggu-belt 15 areas and the old
// west/bukit groups. Add an area here and every reader has it.
//
// Browser-safe on purpose: data and two derived lists, no imports, no Node built-ins.
// The distance maths and the place-name regexes stay server-side in src/areas.js.
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
  // Center — Ubud and the desa around it, north to south. Inland: ~30 km from the
  // nearest beach we track, so the beach score is 0 by construction rather than by a
  // missing value. Ubud's own banjars (Penestanan, Sayan, Nyuh Kuning …) stay in
  // `sub_area`; a neighbouring desa with a market of its own is an area (2026-09-26).
  tegallalang:   { label: 'Tegallalang',       group: 'center',     centroid: [-8.436, 115.279], beach: { name: 'Berawa Beach',      lat: -8.6725, lng: 115.1400 } },
  payangan:      { label: 'Payangan',          group: 'center',     centroid: [-8.444, 115.223], beach: { name: 'Berawa Beach',      lat: -8.6725, lng: 115.1400 } },
  ubud:          { label: 'Ubud',              group: 'center',     centroid: [-8.507, 115.263], beach: { name: 'Berawa Beach',      lat: -8.6725, lng: 115.1400 } },
  pejeng:        { label: 'Pejeng / Bedulu',   group: 'center',     centroid: [-8.518, 115.290], beach: { name: 'Berawa Beach',      lat: -8.6725, lng: 115.1400 } },
  lodtunduh:     { label: 'Lodtunduh / Mas',   group: 'center',     centroid: [-8.542, 115.264], beach: { name: 'Berawa Beach',      lat: -8.6725, lng: 115.1400 } },

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

/** Canonical area ids in the target list (everything else is 'other'). */
export const TARGET_AREAS = Object.keys(AREAS);

/** Distinct beach points (deduped by name) for haversine nearest-beach lookups. */
export const BEACHES = Object.values(
  Object.fromEntries(Object.values(AREAS).map((a) => [a.beach.name, a.beach]))
);
