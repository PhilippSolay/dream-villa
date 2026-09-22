// SPEC §7 — canonical areas, rough centroids, nearest beach points.
// Centroids are approximate and only used when pin_source = 'centroid'.

export const AREAS = {
  seseh:         { label: 'Seseh',            group: 'west',  centroid: [-8.628, 115.099], beach: { name: 'Seseh Beach',        lat: -8.6315, lng: 115.0975 } },
  cemagi:        { label: 'Cemagi',           group: 'west',  centroid: [-8.619, 115.103], beach: { name: 'Cemagi/Mengening',   lat: -8.6255, lng: 115.0995 } },
  munggu:        { label: 'Munggu',           group: 'west',  centroid: [-8.617, 115.094], beach: { name: 'Munggu Beach',       lat: -8.6215, lng: 115.0905 } },
  pererenan:     { label: 'Pererenan',        group: 'west',  centroid: [-8.640, 115.121], beach: { name: 'Pererenan Beach',    lat: -8.6475, lng: 115.1185 } },
  nyanyi:        { label: 'Nyanyi',           group: 'west',  centroid: [-8.608, 115.080], beach: { name: 'Nyanyi Beach',       lat: -8.6125, lng: 115.0765 } },
  kedungu:       { label: 'Kedungu',          group: 'west',  centroid: [-8.597, 115.064], beach: { name: 'Kedungu Beach',      lat: -8.6005, lng: 115.0605 } },
  tanah_lot:     { label: 'Tanah Lot area',   group: 'west',  centroid: [-8.615, 115.090], beach: { name: 'Tanah Lot',          lat: -8.6215, lng: 115.0865 } },
  buwit:         { label: 'Buwit',            group: 'west',  centroid: [-8.583, 115.100], beach: { name: 'Nyanyi Beach',       lat: -8.6125, lng: 115.0765 } },
  mengwi:        { label: 'Mengwi',           group: 'west',  centroid: [-8.545, 115.170], beach: { name: 'Seseh Beach',        lat: -8.6315, lng: 115.0975 } },
  canggu:        { label: 'Canggu',            group: 'canggu', centroid: [-8.652, 115.130], beach: { name: 'Batu Bolong / Echo', lat: -8.6565, lng: 115.1265 } },
  babakan:       { label: 'Babakan',           group: 'canggu', centroid: [-8.657, 115.139], beach: { name: 'Batu Bolong / Echo', lat: -8.6565, lng: 115.1265 } },
  berawa:        { label: 'Berawa',            group: 'canggu', centroid: [-8.666, 115.143], beach: { name: 'Berawa Beach',      lat: -8.6725, lng: 115.1400 } },
  padonan:       { label: 'Padonan',           group: 'canggu', centroid: [-8.645, 115.148], beach: { name: 'Berawa Beach',      lat: -8.6725, lng: 115.1400 } },
  tibubeneng:    { label: 'Tibubeneng',        group: 'canggu', centroid: [-8.653, 115.151], beach: { name: 'Berawa Beach',      lat: -8.6725, lng: 115.1400 } },
  umalas:        { label: 'Umalas',            group: 'canggu', centroid: [-8.670, 115.157], beach: { name: 'Berawa Beach',      lat: -8.6725, lng: 115.1400 } },
  bingin:        { label: 'Bingin',           group: 'bukit', centroid: [-8.806, 115.113], beach: { name: 'Bingin Beach',       lat: -8.8075, lng: 115.1095 } },
  padang_padang: { label: 'Padang Padang',    group: 'bukit', centroid: [-8.811, 115.106], beach: { name: 'Padang Padang',      lat: -8.8115, lng: 115.1035 } },
  uluwatu:       { label: 'Uluwatu / Pecatu', group: 'bukit', centroid: [-8.829, 115.098], beach: { name: 'Suluban',            lat: -8.8145, lng: 115.0885 } },
  balangan:      { label: 'Balangan',         group: 'bukit', centroid: [-8.792, 115.124], beach: { name: 'Balangan Beach',     lat: -8.7915, lng: 115.1215 } },
  ungasan:       { label: 'Ungasan',          group: 'bukit', centroid: [-8.833, 115.160], beach: { name: 'Melasti',            lat: -8.8475, lng: 115.1555 } },
  pandawa:       { label: 'Pandawa / Kutuh',  group: 'bukit', centroid: [-8.842, 115.190], beach: { name: 'Pandawa Beach',      lat: -8.8455, lng: 115.1875 } },
};

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
