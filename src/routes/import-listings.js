// Generic listings import (CLAUDE.md adapters/*.md; SPEC §6). Some sites (first:
// balivillahub.com, source id `balivillahub`) block the server's own fetches but
// load fine in Philipp's own browser — a browser-side harvester assembles
// adapter-style partials there and POSTs them here in batches, same shape as
// /api/import/posts (src/routes/import.js) but for a site that already hands us
// structured fields instead of a raw FB post's free text.
//
// Pipeline (SPEC §6, same one the daily scraper and the FB importer both use):
//   normaliseListing -> explicit-facts overlay -> placePins -> scoreRow -> upsertProperty
// (finishRow from ingest.js chains the last two.) The overlay step exists because
// normaliseListing derives furnished/pool/garden/view from free text ONLY — it never
// reads those fields off its input at all — and drops lat/lng/pin_source entirely
// (placePins expects them straight on the row). A harvester that already read the
// listing's own facts off the page must have those win over a keyword guess from
// the description, the same way bhi.js's applyDetail lets a detail page's stated
// facts win over the card-level guess.
//
// CLAUDE.md: the scraper (and this import) only ever touches listing facts — a
// person's rating/status/note is never written here. Never delete a listing.

import { getConfig, nowIso } from '../db.js';
import { normaliseListing } from '../scrape/normalise.js';
import { finishRow } from '../scrape/ingest.js';
import { upsertProperty, startRun, finishRun } from '../scrape/store.js';
import { processImages } from '../scrape/images.js';
import { createCtx as createFetchCtx } from '../scrape/fetch.js';
import { AREAS } from '../areas.js';
import { strictSchemas, saveImage, imagesDirFor, jsonArray } from './_common.js';

const MAX_LISTINGS = 200;
const MAX_IMAGE_URLS = 20;
const MAX_EMBEDDED_IMAGES = 15;
// A 200-listing batch with up to 15 embedded images each can run large; Fastify's
// global bodyLimit is much smaller, so (like /api/import/posts) this route gets
// its own — route-level only, every other route keeps the default.
const IMPORT_BODY_LIMIT = 60 * 1024 * 1024;
const MAX_EMBEDDED_IMAGE_BYTES = 600 * 1024; // decoded, same ceiling as import.js's gallery path

// ---------------------------------------------------------------------------
// Explicit-facts overlay — SPEC §6 "keyword rules fill the gaps", never the reverse.
// ---------------------------------------------------------------------------

// bedrooms/bathrooms/land_m2/build_m2 already pass straight through normaliseListing
// (it reads them off `src` before ever falling back to a keyword parse), and the price
// fields are normalised from whatever `price_month_idr`/`price_year_idr` the partial
// carries — so none of those need re-overlaying here. furnished/pool/garden/view are
// the real gap: normaliseListing's row builder always uses detectFeatures(text) for
// them and never even looks at `src.furnished` etc. This list is exactly bhi.js's
// ASSERTED set, minus the fields normaliseListing already gets right unassisted.
const OVERLAY_FIELDS = ['furnished', 'pool', 'garden', 'view'];

const asIntish = (v) => (v === true ? 1 : v === false ? 0 : v == null ? null : Number(v));

/**
 * Overlay the body's stated facts on top of normaliseListing's output — the same
 * "asserted facts win" pattern as bhi.js's applyDetail. Also folds in lat/lng, which
 * normaliseListing's row builder doesn't carry at all (placePins reads them straight
 * off the row it's given), defaulting pin_source to 'listing_map' per spec.
 */
function applyExplicitFacts(row, listing) {
  const out = { ...row };
  for (const key of OVERLAY_FIELDS) {
    const v = listing[key];
    if (v === undefined || v === null) continue;
    out[key] = key === 'view' ? v : asIntish(v);
  }
  if (listing.lat != null && listing.lng != null) {
    out.lat = listing.lat;
    out.lng = listing.lng;
    out.pin_source = 'listing_map';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contact — whatsapp/phone, +62 normalisation (same convention as import.js and
// POST /api/properties/:id/contacts: the unique index on `whatsapp` is the identity).
// ---------------------------------------------------------------------------

function normaliseIdPhone(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  if (!digits) return null;
  let rest = digits;
  if (rest.startsWith('0')) rest = `62${rest.slice(1)}`;
  else if (!rest.startsWith('62')) rest = `62${rest}`;
  return /^628\d{7,11}$/.test(rest) ? `+${rest}` : null;
}

function findOrCreateContact(db, { whatsapp, name, role }) {
  const existing = db.prepare('SELECT * FROM contacts WHERE whatsapp = ?').get(whatsapp);
  if (existing) return existing;
  const info = db
    .prepare(
      `INSERT INTO contacts (name, role, phone, whatsapp, email, agency, instagram, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name || null, role, null, whatsapp, null, null, null, null, nowIso());
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(info.lastInsertRowid));
}

function linkContact(db, propertyId, listing) {
  const candidate = listing.whatsapp || listing.phone;
  const whatsapp = candidate ? normaliseIdPhone(candidate) : null;
  if (!whatsapp) return false;
  const contact = findOrCreateContact(db, { whatsapp, name: listing.contact_name || null, role: 'agent' });
  db.prepare('INSERT OR IGNORE INTO property_contacts (property_id, contact_id) VALUES (?, ?)').run(
    propertyId,
    contact.id
  );
  return true;
}

// ---------------------------------------------------------------------------
// Embedded gallery images — same shape and limits as import.js's attachGalleryImages,
// reusing _common.js's saveImage (resizeToJpeg + write to <id>/n.jpg) so a harvester
// that captured images directly (signed CDN urls the server can't reach unauthenticated)
// still gets a gallery. Never throws: a bad entry is skipped and counted.
// ---------------------------------------------------------------------------

function decodeEmbeddedImage(image) {
  if (!image || typeof image.data_base64 !== 'string' || !image.data_base64) return null;
  let buffer;
  try {
    buffer = Buffer.from(image.data_base64, 'base64');
  } catch {
    return null;
  }
  if (!buffer.length || buffer.length > MAX_EMBEDDED_IMAGE_BYTES) return null;
  return buffer;
}

/** @returns {Promise<{ attached: number, failed: number }>} */
async function attachEmbeddedImages(db, imagesDir, propertyId, images) {
  const candidates = (Array.isArray(images) ? images : []).slice(0, MAX_EMBEDDED_IMAGES);

  let failed = 0;
  const buffers = [];
  for (const candidate of candidates) {
    const buffer = decodeEmbeddedImage(candidate);
    if (buffer) buffers.push(buffer);
    else failed += 1;
  }

  const saved = [];
  for (const buffer of buffers) {
    // Name by how many actually saved so far, not position in `buffers` — a decode
    // failure partway through must not leave a gap (1.jpg, 3.jpg).
    try {
      saved.push(await saveImage(imagesDir, propertyId, `${saved.length + 1}.jpg`, buffer));
    } catch {
      failed += 1;
    }
  }

  if (saved.length) {
    const existing = db.prepare('SELECT images FROM properties WHERE id = ?').get(propertyId);
    // Keep any src_url-backed entries (the images[] URL list below) alongside the
    // embedded gallery; drop only previous file-backed entries this replaces.
    const kept = jsonArray(existing?.images).filter((im) => im && im.src_url != null);
    const gallery = saved.map((s) => ({ src_url: null, file: s.file, w: s.w, h: s.h }));
    const imagesJson = [...gallery, ...kept];

    db.prepare('UPDATE properties SET images = ?, hero_file = COALESCE(hero_file, ?) WHERE id = ?').run(
      JSON.stringify(imagesJson),
      gallery[0].file,
      propertyId
    );
  }

  return { attached: saved.length, failed };
}

// ---------------------------------------------------------------------------
// One harvested listing -> one stored property.
// ---------------------------------------------------------------------------

function upsertListing(db, config, source, listing, now) {
  const validArea = listing.area && AREAS[listing.area] ? listing.area : undefined;

  const partial = {
    source,
    ref: listing.ref,
    url: listing.url,
    title: listing.title,
    description: listing.description ?? null,
    // `note` feeds normaliseListing's text blob (feature/style/red-flag keywords) and
    // is the description fallback; `location` is what mapArea's own §7 location-string
    // table actually reads. The harvester's own area text is the same string either
    // way — both pipelines need to see it for "location text -> canonical area" to work.
    note: listing.location ?? null,
    location: listing.location ?? null,
    area: validArea,
    sub_area: listing.sub_area ?? null,
    bedrooms: listing.bedrooms ?? null,
    bathrooms: listing.bathrooms ?? null,
    land_m2: listing.land_m2 ?? null,
    build_m2: listing.build_m2 ?? null,
    price_month_idr: listing.price_month_idr ?? null,
    price_year_idr: listing.price_year_idr ?? null,
    term: listing.term ?? null,
    min_months: listing.min_months ?? null,
    available_from: listing.available_from ?? null,
  };

  const { row } = normaliseListing(partial, config);
  row.first_seen = listing.first_seen || now;
  row.last_seen = row.first_seen;

  if (Array.isArray(listing.images) && listing.images.length) {
    row.images = listing.images.slice(0, MAX_IMAGE_URLS).map((src_url) => ({ src_url }));
  }

  row.raw = JSON.stringify(listing.raw ?? { imported_from: source, ref: listing.ref });

  const withFacts = applyExplicitFacts(row, listing);
  const finished = finishRow(withFacts, config);
  const result = upsertProperty(db, finished, { now });

  const hadContact = linkContact(db, result.id, listing);

  return { ...result, hadContact };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ref', 'url', 'title'],
  properties: {
    ref: { type: 'string', minLength: 1, maxLength: 200 },
    url: { type: 'string', minLength: 4, maxLength: 2000 },
    title: { type: 'string', minLength: 1, maxLength: 300 },
    description: { type: ['string', 'null'], maxLength: 20000 },
    area: { type: ['string', 'null'], maxLength: 40 },
    location: { type: ['string', 'null'], maxLength: 300 },
    sub_area: { type: ['string', 'null'], maxLength: 120 },
    bedrooms: { type: ['integer', 'null'], minimum: 0, maximum: 50 },
    bathrooms: { type: ['integer', 'null'], minimum: 0, maximum: 50 },
    land_m2: { type: ['number', 'null'], minimum: 0 },
    build_m2: { type: ['number', 'null'], minimum: 0 },
    price_month_idr: { type: ['integer', 'null'], minimum: 0 },
    price_year_idr: { type: ['integer', 'null'], minimum: 0 },
    term: { type: ['string', 'null'], enum: ['monthly', 'yearly', 'both', null] },
    min_months: { type: ['integer', 'null'], minimum: 0 },
    available_from: { type: ['string', 'null'], maxLength: 40 },
    first_seen: { type: ['string', 'null'], maxLength: 40 },
    furnished: { type: ['integer', 'null'], enum: [0, 1, null] },
    pool: { anyOf: [{ type: 'boolean' }, { type: 'integer' }, { type: 'null' }] },
    garden: { anyOf: [{ type: 'boolean' }, { type: 'integer' }, { type: 'null' }] },
    view: { type: ['string', 'null'], maxLength: 40 },
    lat: { type: ['number', 'null'] },
    lng: { type: ['number', 'null'] },
    images: { type: 'array', maxItems: MAX_IMAGE_URLS, items: { type: 'string', maxLength: 2000 } },
    images_b64: {
      type: 'array',
      maxItems: MAX_EMBEDDED_IMAGES,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data_base64: { type: 'string', minLength: 1, maxLength: 1_500_000 },
          w: { type: ['integer', 'null'] },
          h: { type: ['integer', 'null'] },
        },
      },
    },
    whatsapp: { type: ['string', 'null'], maxLength: 60 },
    phone: { type: ['string', 'null'], maxLength: 60 },
    contact_name: { type: ['string', 'null'], maxLength: 200 },
    raw: { type: ['object', 'null'] },
  },
};

export default async function importListingsRoutes(app, opts) {
  const { db, env = process.env, createCtx = createFetchCtx } = opts;
  const imagesDir = imagesDirFor(env);
  const auth = { onRequest: app.requireUser };

  strictSchemas(app);

  app.post(
    '/api/import/listings',
    {
      ...auth,
      bodyLimit: IMPORT_BODY_LIMIT,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'listings'],
          properties: {
            source: { type: 'string', minLength: 1, maxLength: 60 },
            listings: { type: 'array', minItems: 1, maxItems: MAX_LISTINGS, items: listingSchema },
          },
        },
      },
    },
    async (request) => {
      const { source, listings } = request.body;
      const config = getConfig(db);
      const now = nowIso();

      const ids = [];
      let newCount = 0;
      let updatedCount = 0;
      let contactsLinked = 0;
      let embeddedFailed = 0;

      for (const listing of listings) {
        const result = upsertListing(db, config, source, listing, now);
        ids.push(result.id);
        if (result.action === 'inserted') newCount += 1;
        else updatedCount += 1;
        if (result.hadContact) contactsLinked += 1;

        if (Array.isArray(listing.images_b64) && listing.images_b64.length) {
          const { failed } = await attachEmbeddedImages(db, imagesDir, result.id, listing.images_b64);
          embeddedFailed += failed;
        }
      }

      // Download every images[].src_url entry still missing a file (cloudfront-style CDN
      // urls are expected to be reachable even though the listing page itself was not;
      // a failure just leaves that entry without a file, counted below, not thrown).
      // Runs in the background: a batch of 50 listings can mean 500 downloads at one per second,
      // far longer than the proxy's request timeout. The response reports the queued count.
      const ctx = createCtx({ db, config, log: app.log });
      const queuedIds = ids.slice();
      setImmediate(() => {
        processImages(db, ctx, { ids: queuedIds, imagesDir })
          .then((r) => app.log.info({ source, ...r }, 'import-listings: background image download done'))
          .catch((err) => app.log.error({ err, source }, 'import-listings: background image download failed'));
      });
      const downloaded = 0;
      const imagesFailed = embeddedFailed;

      const notes = [
        `contacts_linked=${contactsLinked}`,
        `images_downloaded=${downloaded}`,
        `images_queued=${queuedIds.length}`,
        `images_failed=${imagesFailed}`,
      ];

      const runId = startRun(db, 'scrape', [source]);
      finishRun(db, runId, { seen: listings.length, new: newCount, updated: updatedCount, notes });

      return {
        ok: true,
        run_id: runId,
        seen: listings.length,
        new: newCount,
        updated: updatedCount,
        images_downloaded: downloaded,
        images_queued: queuedIds.length,
        images_failed: imagesFailed,
        ids,
      };
    }
  );

  app.get(
    '/api/import/listings/status',
    {
      ...auth,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['source'],
          properties: { source: { type: 'string', minLength: 1, maxLength: 60 } },
        },
      },
    },
    async (request) => {
      const { source } = request.query;
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n, MIN(first_seen) AS min_first_seen, MAX(first_seen) AS max_first_seen
             FROM properties WHERE source = ?`
        )
        .get(source);
      return { n: row.n, min_first_seen: row.min_first_seen, max_first_seen: row.max_first_seen };
    }
  );
}
