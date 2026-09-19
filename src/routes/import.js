// Bulk import for Facebook group posts (SPEC §6 item 4: Facebook is covered by
// Philipp's Chrome sessions — an orchestrator harvests posts through a browser and
// POSTs them here in batches). This file owns the FB-specific shaping only; the
// listing pipeline itself is normaliseListing -> placePins -> scoreRow ->
// upsertProperty, reused as-is (finishRow from ingest.js already chains the middle
// two steps the same way the daily scraper does).
//
// CLAUDE.md: the scraper (and this import) only ever touches listing facts — a
// person's rating/status/note is never written here. Never delete a listing.

import { getConfig, nowIso } from '../db.js';
import { parsePrice, parseBedrooms, normaliseListing, titleCase } from '../scrape/normalise.js';
import { finishRow } from '../scrape/ingest.js';
import { upsertProperty, startRun, finishRun } from '../scrape/store.js';
import { dedupeAll } from '../scrape/dedupe.js';
import { strictSchemas, saveImage, imagesDirFor, jsonArray } from './_common.js';

const MAX_POSTS = 200;
// A 200-post batch with an embedded gallery (up to 8 images) per post can run large;
// Fastify's global bodyLimit is much smaller, so this route gets its own (route-level
// only — every other route keeps the default).
const IMPORT_BODY_LIMIT = 60 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Skip classification (task step 1). Priority: wanted > offtopic > no_signal,
// so an unambiguous "for sale" / "kost" / "per night" / land post reads as
// offtopic even when it also carries no price, and a "looking for" post reads
// as wanted even when it happens to quote a budget.
// ---------------------------------------------------------------------------

const WANTED_RE = /\b(?:looking for|wanted|dicari|mencari)\b/i;
// A rent WORD in the text is one rent signal; the other is a price that itself
// carries a period ("IDR 40.000.000/month") — parsePrice already tells us that,
// so classifySkip ORs the two rather than requiring the word every time (a
// harvested post routinely says "/month" with no other rent vocabulary at all).
const RENT_SIGNAL_RE = /\b(?:rent|rental|lease|sewa|disewakan|kontrak|monthly|yearly|bulan|tahun)\b|\/mo\b|\/yr\b/i;
const SALE_ONLY_RE = /\bfor sale\b/i;
const ROOM_KOST_APT_RE = /\b(?:kost|kos-kosan|room only|apartment|apartemen)\b/i;
const DAILY_NIGHTLY_RE = /\b(?:per night|nightly|harian)\b|\/night\b/i;

/**
 * Land offers slip through the checks above: a per-are land post rarely says
 * "for sale" and can otherwise look like a rental at a glance ("50 juta/are/
 * year"). Offtopic when the text talks about land and never mentions a villa/
 * house/bedroom word, or when the only price given is per-are.
 */
const LAND_RE = /\b(?:land|tanah|are\b|\/are\b|per are|sqm land only)\b/i;
const VILLA_HOUSE_RE = /\b(?:villa|house|home|rumah|bedroom|kamar|br\b)\b/i;
const PER_ARE_PRICE_RE = /\/\s?are\s?\/\s?(?:year|tahun|month|bulan)\b/i;

/** @returns {'wanted'|'offtopic'|'no_signal'|null} null = on-topic, proceed to import. */
function classifySkip(text) {
  if (WANTED_RE.test(text)) return 'wanted';

  const priceInfo = parsePrice(text);
  const qualifyingPrice = Boolean(priceInfo) && (priceInfo.amount >= 1_000_000 || priceInfo.per === 'month' || priceInfo.per === 'year');
  // A price with an explicit period (parsePrice's `per`) is itself a rent signal —
  // a villa quoted at "X/month" or "X/year" is being offered as a rental, whatever
  // vocabulary surrounds it.
  const hasRentSignal = RENT_SIGNAL_RE.test(text) || (priceInfo && priceInfo.per != null);

  const saleOnly = SALE_ONLY_RE.test(text) && !hasRentSignal;
  const landOnly = LAND_RE.test(text) && !VILLA_HOUSE_RE.test(text);
  if (saleOnly || ROOM_KOST_APT_RE.test(text) || DAILY_NIGHTLY_RE.test(text) || landOnly || PER_ARE_PRICE_RE.test(text)) {
    return 'offtopic';
  }
  if (!(qualifyingPrice && hasRentSignal)) return 'no_signal';
  return null;
}

// ---------------------------------------------------------------------------
// Area — SPEC §7 keyword scan, first match (in this list's order) wins.
//
// Bug (2026-09, first real import: "SESEH CEMAGI KEDUNGU VILLA & LAND", 892
// posts): the old group-name fallback tagged every post whose group's own NAME
// happened to mention an area word, regardless of what the post itself said —
// 72 posts wrongly landed on 'seseh'. Dropped entirely; a post that names no
// target area is 'other', full stop — no group-name fallback.
//
// A second failure mode: a Canggu-based post routinely says "10 minutes to
// Pererenan" — that is a distance reference, not the villa's own location, so a
// target-area word only counts when it is not immediately preceded by a
// proximity phrase ("to/from/minutes/min/mins/drive/near/close to/dekat").
// ---------------------------------------------------------------------------

/** Areas we don't track. A post naming one of these and no (non-proximity)
 *  target-area word reads as 'other' — see detectArea. Cepaka is deliberately
 *  NOT here: it is itself a §7 target keyword (-> tanah_lot), not an exclusion. */
const OUT_OF_TARGET_RE =
  /\b(?:canggu|berawa|batu\s+bolong|babakan|padonan|umalas|kerobokan|seminyak|sanur|ubud|jimbaran|nusa\s+dua|denpasar|tibubeneng)\b/i;

const PROXIMITY_RE = /\b(?:to|from|minutes?|mins?|drive|near|close to|dekat)\b/i;
const PROXIMITY_WINDOW_CHARS = 25;

const AREA_KEYWORDS = [
  [/\bseseh\b/i, 'seseh'],
  [/\bcemagi\b/i, 'cemagi'],
  [/\bmunggu\b/i, 'munggu'],
  [/\bpererenan\b/i, 'pererenan'],
  [/tumbak\s*bayuh/i, 'pererenan'], // SPEC §7: inland north-Pererenan pocket
  [/\bnyanyi\b/i, 'nyanyi'],
  [/\bkedungu\b/i, 'kedungu'],
  [/tanah\s*lot/i, 'tanah_lot'],
  [/\bcepaka\b/i, 'tanah_lot'],
  [/\bbuwit\b/i, 'buwit'],
  [/\bmengwi\b/i, 'mengwi'],
  [/kaba[-\s]?kaba/i, 'tanah_lot'],
  [/\bbingin\b/i, 'bingin'],
  [/padang\s*padang/i, 'padang_padang'],
  [/\buluwatu\b/i, 'uluwatu'],
  [/\bpecatu\b/i, 'uluwatu'],
  [/nyang\s*nyang/i, 'uluwatu'],
  [/\bbalangan\b/i, 'balangan'],
  [/\bungasan\b/i, 'ungasan'],
  [/\bmelasti\b/i, 'ungasan'],
  [/\bpandawa\b/i, 'pandawa'],
  [/\bkutuh\b/i, 'pandawa'],
];

/** True when a proximity phrase sits in the ~25 chars right before this match —
 *  "10 minutes to Pererenan" is a distance reference, not the villa's location. */
function isProximityMention(text, matchIndex) {
  const start = Math.max(0, matchIndex - PROXIMITY_WINDOW_CHARS);
  return PROXIMITY_RE.test(text.slice(start, matchIndex));
}

/** First keyword (in list order) with at least one non-proximity occurrence. */
function areaFromKeywords(text) {
  const s = String(text || '');
  for (const [re, area] of AREA_KEYWORDS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = global.exec(s))) {
      if (!isProximityMention(s, m.index)) return area;
      if (global.lastIndex === m.index) global.lastIndex += 1; // guard against zero-length matches
    }
  }
  return null;
}

/** (a) an out-of-target place with no target word at all -> 'other'; (b) the
 *  target-area scan (first match) as normal; (c) otherwise 'other'. No
 *  group-name fallback (see the bug note above). */
function detectArea(text) {
  const s = String(text || '');
  const target = areaFromKeywords(s);
  if (!target && OUT_OF_TARGET_RE.test(s)) return 'other';
  return target || 'other';
}

// ---------------------------------------------------------------------------
// Bedrooms — parseBedrooms (English "2 bedrooms"/"2BR") plus the Indonesian
// "2 kamar tidur" / "2 KT" phrasing it doesn't know about.
// ---------------------------------------------------------------------------

const ID_BEDROOM_RE = /(\d+)\s*(?:kamar\s*tidur|KT|BR|bed)\b/i;

function detectBedrooms(text) {
  const viaNormalise = parseBedrooms(text);
  if (viaNormalise != null) return viaNormalise;
  const m = ID_BEDROOM_RE.exec(text);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Price — parsePrice already returns the first amount-with-a-period found in the
// text, falling back to a bare Rp/IDR amount with no period at all. A bare amount
// is ambiguous, so this guesses from the Bali long-term rental market: villas in
// the aggregation band (SPEC §2) run roughly 8-80 M/month, so a bare amount under
// 100 M reads as monthly and 100 M or over reads as yearly.
// ---------------------------------------------------------------------------

const BARE_YEARLY_THRESHOLD = 100_000_000;

function priceFieldsFrom(priceInfo) {
  if (!priceInfo) return {};
  if (priceInfo.per === 'month') return { price_month_idr: priceInfo.amount, term: 'monthly' };
  if (priceInfo.per === 'year') return { price_year_idr: priceInfo.amount, term: 'yearly' };
  if (priceInfo.amount >= BARE_YEARLY_THRESHOLD) return { price_year_idr: priceInfo.amount, term: 'yearly' };
  return { price_month_idr: priceInfo.amount, term: 'monthly' };
}

// ---------------------------------------------------------------------------
// Title — harvested FB text routinely carries repost-header noise ahead of the
// real first line ("Villa Inbali", "3d", "posted to", the group's own name,
// "· Follow") and junk at the tail ("See less", "Comment as …", a lone number).
// Strip both, then take the first remaining line >= 12 chars; short/junk-only
// text falls back to the first 90 chars of the raw post. A SHOUTY result gets
// run through normalise's titleCase (idempotent — normaliseListing title-cases
// whatever title it is given regardless, for every source, not just FB).
// ---------------------------------------------------------------------------

const HEADER_TIMESTAMP_RE = /^\d+\s?[mhdw]$/i;
const HEADER_PHRASE_RE = /^(?:posted to|· ?Follow|Follow)$/i;
const TRAILING_SEE_LESS_RE = /^see less$/i;
const TRAILING_COMMENT_AS_RE = /^comment as\b/i;
const LONE_NUMBER_RE = /^\d+$/;
const MIN_TITLE_LENGTH = 12;
const MAX_TITLE_LENGTH = 90;

function isLeadingHeaderLine(line, posterName, groupName) {
  const t = line.trim();
  if (t.length < 4) return true;
  if (posterName && t === String(posterName).trim()) return true;
  if (groupName && t === String(groupName).trim()) return true;
  if (HEADER_TIMESTAMP_RE.test(t)) return true;
  if (HEADER_PHRASE_RE.test(t)) return true;
  return false;
}

function isTrailingJunkLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (TRAILING_SEE_LESS_RE.test(t)) return true;
  if (TRAILING_COMMENT_AS_RE.test(t)) return true;
  if (LONE_NUMBER_RE.test(t)) return true;
  return false;
}

function isAllCaps(s) {
  const letters = s.replace(/[^A-Za-z]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
}

function clip90(s) {
  const t = String(s || '').trim();
  return t.length > MAX_TITLE_LENGTH ? t.slice(0, MAX_TITLE_LENGTH).trim() : t;
}

function buildTitle(text, posterName, groupName) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);

  let start = 0;
  while (start < lines.length && isLeadingHeaderLine(lines[start], posterName, groupName)) start += 1;
  let end = lines.length;
  while (end > start && isTrailingJunkLine(lines[end - 1])) end -= 1;

  let candidate = null;
  for (let i = start; i < end; i += 1) {
    const line = lines[i].trim();
    if (line.length >= MIN_TITLE_LENGTH) {
      candidate = line;
      break;
    }
  }
  if (!candidate) candidate = clip90(raw);
  candidate = clip90(candidate);

  // Never let the title equal poster_name (a stray header line long enough to
  // otherwise qualify, e.g. a long display name).
  if (posterName && candidate === String(posterName).trim()) candidate = clip90(raw);

  return isAllCaps(candidate) ? titleCase(candidate) : candidate;
}

// ---------------------------------------------------------------------------
// Facebook collapses a long post behind "… See more" and adds "See translation"
// under foreign-language text. A harvester that fails to expand the post ships
// both verbatim; neither is the poster's words. The collapsed tail becomes a
// plain ellipsis and `truncated` tells the UI to point at the original post.
// ---------------------------------------------------------------------------

const SEE_MORE_RE = /\s*(?:…|\.{3})?\s*\bSee more\b/gi;
const SEE_TRANSLATION_LINE_RE = /^\s*See translation\s*$/i;

/**
 * @param {unknown} input the harvested post text
 * @returns {{ text: string, truncated: boolean }}
 */
export function cleanPostText(input) {
  const kept = String(input || '')
    .split(/\r?\n/)
    .filter((line) => !SEE_TRANSLATION_LINE_RE.test(line))
    .join('\n')
    .trim();
  const truncated = /\bSee more\s*$/i.test(kept);
  const text = kept.replace(SEE_MORE_RE, '…').trim();
  return { text, truncated };
}

// ---------------------------------------------------------------------------
// Contact — an Indonesian mobile found in the text, or the post's own
// whatsapp/phone field; either way it is normalised to +62… and is the identity
// key contacts are found-or-created by (same convention as POST
// /api/properties/:id/contacts: the unique index on whatsapp is the identity rule).
// ---------------------------------------------------------------------------

const ID_MOBILE_RE = /(\+62|62|0)[\s.-]*8[\s.-]?\d(?:[\s.-]?\d){6,10}/g;
const OWNER_RE = /\b(?:owner|pemilik|no agent|tanpa perantara)\b/i;
const INSTAGRAM_RE = /@([A-Za-z0-9._]{2,30})/;

/** Any digits, with an Indonesian trunk prefix normalised to 62 → "+62…", or null. */
function normaliseIdPhone(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  if (!digits) return null;
  let rest = digits;
  if (rest.startsWith('0')) rest = `62${rest.slice(1)}`;
  else if (!rest.startsWith('62')) rest = `62${rest}`;
  return /^628\d{7,11}$/.test(rest) ? `+${rest}` : null;
}

function extractIdMobile(text) {
  const s = String(text || '');
  ID_MOBILE_RE.lastIndex = 0;
  let m;
  while ((m = ID_MOBILE_RE.exec(s))) {
    const normalised = normaliseIdPhone(m[0]);
    if (normalised) return normalised;
  }
  return null;
}

function findOrCreateContact(db, { whatsapp, name, role, instagram, notes }) {
  const existing = db.prepare('SELECT * FROM contacts WHERE whatsapp = ?').get(whatsapp);
  if (existing) return existing;
  const info = db
    .prepare(
      `INSERT INTO contacts (name, role, phone, whatsapp, email, agency, instagram, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name || null, role, null, whatsapp, null, null, instagram || null, notes || null, nowIso());
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(info.lastInsertRowid));
}

// ---------------------------------------------------------------------------
// Gallery images — the harvester sometimes captures a post's images directly
// (base64 JPEG/PNG) because signed CDN urls would otherwise get redacted.
// `images_b64` (up to MAX_GALLERY_IMAGES) is the current shape; the legacy
// single `image` field is treated as images_b64: [image] by the caller.
//
// Each accepted image is decoded through the same resizeToJpeg used by the
// daily scraper's own image step and written to
// <IMAGES_DIR>/<id>/1.jpg … <id>/N.jpg, in order, overwriting any file already
// at that index (re-import keeps it simple: no cleanup of a now-unused higher
// index left over from a previous, larger gallery). The stored `images` JSON
// for the row is replaced with exactly this gallery — any previous embedded
// entries (file-backed, src_url null) are dropped, while entries with a real
// src_url (from another source) are kept alongside it. hero_file is only set
// when it was null.
//
// Never throws: an invalid or oversized entry is simply skipped and counted,
// while every other entry (and the post itself) still imports.
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 600 * 1024;
const MAX_GALLERY_IMAGES = 15;

/** @returns {Buffer|null} the decoded buffer, or null when the entry is missing/invalid/oversized. */
function decodeGalleryImage(image) {
  if (!image || typeof image.data_base64 !== 'string' || !image.data_base64) return null;
  let buffer;
  try {
    buffer = Buffer.from(image.data_base64, 'base64');
  } catch {
    return null;
  }
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
  return buffer;
}

/** @returns {Promise<{ attached: number, skipped: number }>} */
async function attachGalleryImages(db, imagesDir, propertyId, images) {
  const candidates = (Array.isArray(images) ? images : []).slice(0, MAX_GALLERY_IMAGES);

  let skipped = 0;
  const buffers = [];
  for (const candidate of candidates) {
    const buffer = decodeGalleryImage(candidate);
    if (buffer) buffers.push(buffer);
    else skipped += 1;
  }

  const saved = [];
  for (const buffer of buffers) {
    // Name by how many have actually been saved so far, not by position in
    // `buffers` — a decode failure partway through must not leave a gap
    // (1.jpg, 3.jpg): the written files are always a dense 1..N run.
    try {
      saved.push(await saveImage(imagesDir, propertyId, `${saved.length + 1}.jpg`, buffer));
    } catch {
      skipped += 1; // not a decodable image
    }
  }

  if (saved.length) {
    const existing = db.prepare('SELECT images FROM properties WHERE id = ?').get(propertyId);
    // Drop any previous embedded (file-backed) entries — this gallery replaces them —
    // but keep entries that carry a real src_url from another source.
    const kept = jsonArray(existing?.images).filter((im) => im && im.src_url != null);
    const gallery = saved.map((s) => ({ src_url: null, file: s.file, w: s.w, h: s.h }));
    const imagesJson = [...gallery, ...kept];

    db.prepare('UPDATE properties SET images = ?, hero_file = COALESCE(hero_file, ?) WHERE id = ?')
      .run(JSON.stringify(imagesJson), gallery[0].file, propertyId);
  }

  return { attached: saved.length, skipped };
}

// ---------------------------------------------------------------------------
// One post -> one property row.
// ---------------------------------------------------------------------------

async function upsertPost(db, config, groupId, post, imagesDir) {
  const { text, truncated } = cleanPostText(post.text);
  const partial = {
    source: 'fb',
    ref: post.post_id,
    url: post.url,
    title: buildTitle(text, post.poster_name, post.group_name),
    description: text,
    note: post.group_name || null,
    area: detectArea(text),
    bedrooms: detectBedrooms(text),
    ...priceFieldsFrom(parsePrice(text)),
  };

  // normaliseListing -> placePins -> scoreRow (finishRow chains the latter two,
  // ingest.js's own pipeline). title/area/price/bedrooms are listing facts, so a
  // later re-import with corrected text overwrites them via upsertProperty's
  // UPDATE_FACT_COLUMNS — never the person fields.
  const { row } = normaliseListing(partial, config);
  // first_seen/last_seen = posted_at so a backfilled batch gives a real time series,
  // not "today" for every post (CLAUDE.md: the scraper only ever touches listing facts;
  // first_seen here plays that same "when did we first see this" role).
  row.first_seen = post.posted_at;
  row.last_seen = post.posted_at;
  // Image URLs are frequently absent (signed CDN URLs get redacted by the harvesting
  // tool) — leave row.images unset in that case so hero_file/heroUrl stay null rather
  // than pointing at nothing. (A separate post.image — a base64 cover photo — is
  // handled below, after the row has an id.)
  if (Array.isArray(post.images) && post.images.length) {
    row.images = post.images.map((src_url) => ({ src_url }));
  }
  row.raw = JSON.stringify({
    post_id: post.post_id,
    group_id: groupId,
    group_name: post.group_name || null,
    poster_name: post.poster_name || null,
    poster_url: post.poster_url || null,
    posted_at: post.posted_at,
    text_len: text.length,
    truncated,
  });

  const finished = finishRow(row, config);
  const result = upsertProperty(db, finished, { now: nowIso() });

  const candidate = post.whatsapp || post.phone || extractIdMobile(text);
  const whatsapp = candidate ? normaliseIdPhone(candidate) : null;
  if (whatsapp) {
    const igMatch = INSTAGRAM_RE.exec(text);
    const contact = findOrCreateContact(db, {
      whatsapp,
      name: post.poster_name || null,
      role: OWNER_RE.test(text) ? 'owner' : 'agent',
      instagram: igMatch ? `@${igMatch[1]}` : null,
      notes: post.poster_url || null,
    });
    db.prepare('INSERT OR IGNORE INTO property_contacts (property_id, contact_id) VALUES (?, ?)').run(result.id, contact.id);
  }

  const embeddedImages = Array.isArray(post.images_b64) && post.images_b64.length
    ? post.images_b64
    : post.image ? [post.image] : [];
  let skippedImages = 0;
  if (embeddedImages.length) {
    ({ skipped: skippedImages } = await attachGalleryImages(db, imagesDir, result.id, embeddedImages));
  }

  return { ...result, skippedImages };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function importRoutes(app, opts) {
  const { db, env = process.env } = opts;
  const imagesDir = imagesDirFor(env);
  const auth = { onRequest: app.requireUser };

  strictSchemas(app);

  app.post(
    '/api/import/posts',
    {
      ...auth,
      bodyLimit: IMPORT_BODY_LIMIT,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'group_id', 'posts'],
          properties: {
            source: { type: 'string', enum: ['fb'] },
            // The tracker's own source id for the group (config.sources), e.g.
            // 'seseh-pererenan-villas' — not required to already exist as a source:
            // this is intake metadata, and a group can post before anyone has
            // registered it on the Agent page.
            group_id: { type: 'string', minLength: 1, maxLength: 120 },
            posts: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_POSTS,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['post_id', 'url', 'posted_at', 'text'],
                properties: {
                  post_id: { type: 'string', minLength: 1, maxLength: 200 },
                  url: { type: 'string', minLength: 4, maxLength: 2000 },
                  posted_at: { type: 'string', minLength: 4, maxLength: 40 },
                  text: { type: 'string', minLength: 1, maxLength: 8000 },
                  poster_name: { type: ['string', 'null'], maxLength: 200 },
                  poster_url: { type: ['string', 'null'], maxLength: 2000 },
                  images: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 2000 } },
                  // The harvester's own captured cover photo — legacy single-image shape,
                  // treated as images_b64: [image] when images_b64 itself is absent/empty.
                  image: {
                    type: ['object', 'null'],
                    additionalProperties: false,
                    properties: {
                      data_base64: { type: 'string', minLength: 1, maxLength: 1_500_000 },
                      w: { type: ['integer', 'null'] },
                      h: { type: ['integer', 'null'] },
                    },
                  },
                  // The harvester's own captured gallery — up to MAX_GALLERY_IMAGES embedded
                  // photos, same per-entry validation as `image` above (each ≤ 600 KB decoded).
                  images_b64: {
                    type: 'array',
                    maxItems: 15,
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
                  phone: { type: ['string', 'null'], maxLength: 60 },
                  whatsapp: { type: ['string', 'null'], maxLength: 60 },
                  group_name: { type: ['string', 'null'], maxLength: 200 },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { group_id: groupId, posts } = request.body;
      const config = getConfig(db);

      const skipped = { no_signal: 0, offtopic: 0, wanted: 0 };
      const ids = [];
      let newCount = 0;
      let updatedCount = 0;
      let skippedImages = 0;

      for (const post of posts) {
        const skip = classifySkip(post.text);
        if (skip) {
          skipped[skip] += 1;
          continue;
        }
        const result = await upsertPost(db, config, groupId, post, imagesDir);
        ids.push(result.id);
        // A re-import of an already-seen post_id is "updated" for this summary
        // whether or not any listing fact actually changed (upsertProperty may
        // report 'unchanged' for a byte-identical repost) — from the caller's
        // point of view it is not a new listing either way.
        if (result.action === 'inserted') newCount += 1;
        else updatedCount += 1;
        skippedImages += result.skippedImages;
      }

      // SPEC §6 dedupe: fb cross-posts of the same villa share an image or a
      // description prefix. Run once over the whole table after the batch —
      // never dedupe.js's own rule; only the imported rows are freshly scored,
      // so rescoreAll is not needed here.
      const { merged } = dedupeAll(db);

      const notes = [
        `skipped_no_signal=${skipped.no_signal}`,
        `skipped_offtopic=${skipped.offtopic}`,
        `skipped_wanted=${skipped.wanted}`,
        `skipped_images=${skippedImages}`,
      ];
      for (const m of merged) notes.push(`kept #${m.kept_id} <- merged #${m.merged_id} (${m.reason})`);

      const runId = startRun(db, 'scrape', [`fb:${groupId}`]);
      finishRun(db, runId, { seen: posts.length, new: newCount, updated: updatedCount, notes });

      return {
        ok: true,
        run_id: runId,
        seen: posts.length,
        imported: newCount + updatedCount,
        new: newCount,
        updated: updatedCount,
        skipped,
        skipped_images: skippedImages,
        merged: merged.length,
        ids,
      };
    }
  );

  app.get(
    '/api/import/status',
    {
      ...auth,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { source: { type: 'string', maxLength: 40 } },
        },
      },
    },
    async (request) => {
      const source = request.query.source || 'fb';
      const by_group = db
        .prepare(
          `SELECT json_extract(raw, '$.group_id') AS group_id, COUNT(*) AS n,
                  MIN(first_seen) AS min_first_seen, MAX(first_seen) AS max_first_seen
             FROM properties WHERE source = ? GROUP BY group_id ORDER BY n DESC`
        )
        .all(source);
      const total = by_group.reduce((sum, r) => sum + r.n, 0);
      return { by_group, total };
    }
  );
}
