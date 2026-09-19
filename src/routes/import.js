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
import { strictSchemas } from './_common.js';

const MAX_POSTS = 200;

// ---------------------------------------------------------------------------
// Skip classification (task step 1). Priority: wanted > offtopic > no_signal,
// so an unambiguous "for sale" / "kost" / "per night" post reads as offtopic
// even when it also carries no price, and a "looking for" post reads as wanted
// even when it happens to quote a budget.
// ---------------------------------------------------------------------------

const WANTED_RE = /\b(?:looking for|wanted|dicari|mencari)\b/i;
const RENT_SIGNAL_RE = /\b(?:rent|rental|lease|sewa|disewakan|kontrak|monthly|yearly|bulan|tahun)\b|\/mo\b|\/yr\b/i;
const SALE_ONLY_RE = /\bfor sale\b/i;
const ROOM_KOST_APT_RE = /\b(?:kost|kos-kosan|room only|apartment|apartemen)\b/i;
const DAILY_NIGHTLY_RE = /\b(?:per night|nightly|harian)\b|\/night\b/i;

function hasQualifyingPrice(text) {
  const p = parsePrice(text);
  return Boolean(p) && (p.amount >= 1_000_000 || p.per === 'month' || p.per === 'year');
}

/** @returns {'wanted'|'offtopic'|'no_signal'|null} null = on-topic, proceed to import. */
function classifySkip(text) {
  if (WANTED_RE.test(text)) return 'wanted';
  const hasRentSignal = RENT_SIGNAL_RE.test(text);
  const saleOnly = SALE_ONLY_RE.test(text) && !hasRentSignal;
  if (saleOnly || ROOM_KOST_APT_RE.test(text) || DAILY_NIGHTLY_RE.test(text)) return 'offtopic';
  if (!(hasQualifyingPrice(text) && hasRentSignal)) return 'no_signal';
  return null;
}

// ---------------------------------------------------------------------------
// Area — SPEC §7 keyword scan, first match (in this list's order) wins; a group's
// own name is the fallback when the post text names no area at all.
// ---------------------------------------------------------------------------

const AREA_KEYWORDS = [
  [/\bseseh\b/i, 'seseh'],
  [/\bcemagi\b/i, 'cemagi'],
  [/\bmunggu\b/i, 'munggu'],
  [/\bpererenan\b/i, 'pererenan'],
  [/tumbak\s*bayuh/i, 'pererenan'], // SPEC §7: inland north-Pererenan pocket
  [/\bnyanyi\b/i, 'nyanyi'],
  [/\bkedungu\b/i, 'kedungu'],
  [/tanah\s*lot/i, 'tanah_lot'],
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

function areaFromKeywords(text) {
  for (const [re, area] of AREA_KEYWORDS) if (re.test(text)) return area;
  return null;
}

function detectArea(text, groupName) {
  return areaFromKeywords(text) || (groupName && areaFromKeywords(groupName)) || 'other';
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
// Title — first sentence/line of the post, trimmed to 90 chars. A SHOUTY line
// gets run through normalise's titleCase before it goes in; note that
// normaliseListing title-cases whatever title it is given regardless (it does
// this for every source, not just FB), so this mainly documents the intent —
// titleCase is idempotent, so pre-casing an all-caps line changes nothing later.
// ---------------------------------------------------------------------------

function firstSentenceOrLine(text) {
  const line = String(text || '').trim().split(/\r?\n/)[0].trim();
  const sentence = /^[^.!?\n]+[.!?]?/.exec(line);
  return (sentence ? sentence[0] : line).trim();
}

function isAllCaps(s) {
  const letters = s.replace(/[^A-Za-z]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
}

function buildTitle(text) {
  let candidate = firstSentenceOrLine(text);
  if (candidate.length > 90) candidate = candidate.slice(0, 90).trim();
  return isAllCaps(candidate) ? titleCase(candidate) : candidate;
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
// One post -> one property row.
// ---------------------------------------------------------------------------

function upsertPost(db, config, groupId, post) {
  const text = post.text;
  const partial = {
    source: 'fb',
    ref: post.post_id,
    url: post.url,
    title: buildTitle(text),
    description: text,
    note: post.group_name || null,
    area: detectArea(text, post.group_name),
    bedrooms: detectBedrooms(text),
    ...priceFieldsFrom(parsePrice(text)),
  };

  const { row } = normaliseListing(partial, config);
  // first_seen/last_seen = posted_at so a backfilled batch gives a real time series,
  // not "today" for every post (CLAUDE.md: the scraper only ever touches listing facts;
  // first_seen here plays that same "when did we first see this" role).
  row.first_seen = post.posted_at;
  row.last_seen = post.posted_at;
  // Image URLs are frequently absent (signed CDN URLs get redacted by the harvesting
  // tool) — leave row.images unset in that case so hero_file/heroUrl stay null rather
  // than pointing at nothing.
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

  return result;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function importRoutes(app, opts) {
  const { db, env = process.env } = opts;
  void env;
  const auth = { onRequest: app.requireUser };

  strictSchemas(app);

  app.post(
    '/api/import/posts',
    {
      ...auth,
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

      for (const post of posts) {
        const skip = classifySkip(post.text);
        if (skip) {
          skipped[skip] += 1;
          continue;
        }
        const result = upsertPost(db, config, groupId, post);
        ids.push(result.id);
        // A re-import of an already-seen post_id is "updated" for this summary
        // whether or not any listing fact actually changed (upsertProperty may
        // report 'unchanged' for a byte-identical repost) — from the caller's
        // point of view it is not a new listing either way.
        if (result.action === 'inserted') newCount += 1;
        else updatedCount += 1;
      }

      // SPEC §6 dedupe: fb cross-posts of the same villa share an image or a
      // description prefix. Run once over the whole table after the batch —
      // never over dedupe.js's own rule, only the imported rows are freshly
      // scored, so rescoreAll is not needed here.
      const { merged } = dedupeAll(db);

      const notes = [
        `skipped_no_signal=${skipped.no_signal}`,
        `skipped_offtopic=${skipped.offtopic}`,
        `skipped_wanted=${skipped.wanted}`,
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
