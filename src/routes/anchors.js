// Anchors (SPEC §14): the two people's own places — a gym, a school, a co-working — with a
// distance on every listing and a "within X km of" filter. GET/POST/DELETE /api/anchors.

import { nowIso } from '../db.js';
import { notFound, badRequest, strictSchemas, withByName } from './_common.js';

const EARTH_KM = 6371;
const NAME_MAX = 60;

/** Great-circle distance in km. */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
const PAIR = `${NUM}\\s*(?:,|%2C)\\s*${NUM}`;
const PATTERNS = [
  new RegExp(`@${PAIR}`), // google.com/maps/place/…/@-8.64,115.12,17z
  new RegExp(`[?&](?:q|query|ll|center|destination)=${PAIR}`, 'i'), // ?q=lat,lng · ?api=1&query=lat%2Clng
  new RegExp(`^\\s*${PAIR}\\s*$`), // plain "lat, lng"
];

/** "lat, lng", or a Google Maps link carrying one → {lat, lng}; anything else → null. */
export function parseLocation(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return null;
}

/** Every anchor, oldest first, with the creator's name. */
export function listAnchors(db) {
  return withByName(db, db.prepare('SELECT * FROM anchors ORDER BY id').all());
}

/** Distances from one listing to every anchor, rounded to 0.1 km; null when the listing has no pin. */
export function anchorDistances(row, anchors) {
  const hasPin = row.lat != null && row.lng != null;
  return anchors.map((a) => ({
    id: a.id,
    name: a.name,
    km: hasPin ? Math.round(haversineKm(row.lat, row.lng, a.lat, a.lng) * 10) / 10 : null,
  }));
}

export default async function anchorsRoutes(app, opts) {
  const { db } = opts;
  const auth = { onRequest: app.requireUser };
  strictSchemas(app);

  app.get('/api/anchors', auth, async () => listAnchors(db));

  app.post(
    '/api/anchors',
    {
      ...auth,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: NAME_MAX },
            location: { type: 'string', maxLength: 2000 },
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lng: { type: 'number', minimum: -180, maximum: 180 },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, location, lat, lng } = request.body;
      const trimmed = String(name).trim();
      if (!trimmed) return badRequest(reply, 'name is required');
      const point = lat != null && lng != null ? { lat, lng } : parseLocation(location);
      if (!point) return badRequest(reply, 'location must be "lat, lng" or a Google Maps link with coordinates');
      const info = db
        .prepare('INSERT INTO anchors (name, lat, lng, by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(trimmed, point.lat, point.lng, request.user.id, nowIso());
      return withByName(db, [db.prepare('SELECT * FROM anchors WHERE id = ?').get(info.lastInsertRowid)])[0];
    }
  );

  app.delete(
    '/api/anchors/:id',
    { ...auth, schema: { params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } },
    async (request, reply) => {
      const info = db.prepare('DELETE FROM anchors WHERE id = ?').run(request.params.id);
      if (!info.changes) return notFound(reply);
      return { ok: true };
    }
  );
}
