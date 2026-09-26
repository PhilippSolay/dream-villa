// Rumah123 — SPEC §6 adapter (list + detail), the one portal of §6 item 3 that is
// reachable without a login or a bot challenge (OLX: Akamai, Lamudi: 401, 99.co:
// Cloudflare — see adapters/*.md).
//
// Everything we need is server-rendered: index cards carry `data-test-id` attributes,
// detail pages carry a JSON-LD `@graph` with the full description, images, geo, price
// and term. Verified 2026-09-18, all of it written up in adapters/rumah123.md.

import * as cheerio from 'cheerio';
import { AREAS } from '../../areas.js';
import { parsePrice, parseMinMonths } from '../normalise.js';

const BASE = 'https://www.rumah123.com';

/**
 * Safety stop per area × type; the walk itself ends where the portal stops linking
 * `rel="next"`. 20 cards a page, ordered by relevance (not by date), so a cap cuts a
 * random slice rather than the stale tail. The old cap of 3 reached 60 of the 402
 * villas under Pererenan, 60 of 372 under Ungasan and 60 of 363 under Ubud
 * (2026-09-26). Canggu's 1 183 villas (60 pages) is the biggest slug; 80 pages leaves
 * a third of headroom and warns if it is ever reached.
 */
export const MAX_PAGES = 80;

const MAX_IMAGES = 20;

/** Property-type segments worth crawling — villas are listed under both. */
const TYPES = ['villa', 'rumah'];

/**
 * Search slugs verified 200 on 2026-09-18 (adapters/rumah123.md "URL scheme").
 * `area` is the canonical §7 area the slug is expected to yield; `resolveArea`
 * still gets the last word from the card's own location string and title.
 */
export const TARGET_SLUGS = [
  { path: 'badung/seseh', area: 'seseh' },
  { path: 'badung/cemagi', area: 'cemagi' },
  { path: 'badung/munggu', area: 'munggu' },
  { path: 'badung/pererenan', area: 'pererenan' },
  { path: 'badung/mengwi', area: 'mengwi' },
  { path: 'badung/nyanyi', area: 'nyanyi' },
  { path: 'badung/pecatu', area: 'uluwatu' },
  { path: 'badung/uluwatu', area: 'uluwatu' },
  { path: 'badung/ungasan', area: 'ungasan' },
  { path: 'badung/kutuh', area: 'pandawa' },
  { path: 'badung/balangan', area: 'balangan' },
  // The Canggu belt (2026-09-26), verified 200 the same day — villa results: canggu
  // 1 174, umalas 421, tibubeneng 169. `berawa`, `babakan` and `padonan` 404: they are
  // banjars and turn up under canggu/tibubeneng, where the card title names them.
  { path: 'badung/canggu', area: 'canggu' },
  { path: 'badung/tibubeneng', area: 'tibubeneng' },
  { path: 'badung/umalas', area: 'umalas' },
  { path: 'badung/kuta-selatan', area: null },
  { path: 'tabanan/kediri', area: 'tanah_lot' },
  { path: 'tabanan/tanah-lot', area: 'tanah_lot' },
  { path: 'tabanan/kedungu', area: 'kedungu' },
  { path: 'tabanan/buwit', area: 'buwit' },
  { path: 'tabanan/kerambitan', area: 'buwit' },
  // Center (2026-09-26), verified 200 the same day — villa results: ubud 364,
  // sukawati 17, tegallalang 8, payangan 3, tampaksiring 3. Gianyar's kecamatan are
  // the §7 areas here; `resolveArea` still lets the card's own desa have the last word.
  { path: 'gianyar/ubud', area: 'ubud' },
  { path: 'gianyar/tegallalang', area: 'tegallalang' },
  { path: 'gianyar/payangan', area: 'payangan' },
  { path: 'gianyar/tampaksiring', area: 'pejeng' },
  { path: 'gianyar/sukawati', area: null },
];

// ---------------------------------------------------------------------------
// Area mapping (adapters/rumah123.md "Area mapping")
// ---------------------------------------------------------------------------

/**
 * Village / beach keywords → canonical §7 area. Order matters: the finest name that
 * matches wins, so `melasti` must be tested before `ungasan` is ever needed and the
 * kecamatan names (mengwi, kediri) are not in this table at all.
 */
const VILLAGE_AREA = [
  [/\bseseh\b/i, 'seseh'],
  [/\bcemagi\b/i, 'cemagi'],
  [/\bmengening\b/i, 'cemagi'],
  [/\bmunggu\b/i, 'munggu'],
  [/\bperer?enan\b|tumbak\s*bayuh|\bbuduk\b|tiying\s*tutul/i, 'pererenan'],
  [/\bnyanyi\b/i, 'nyanyi'],
  [/\bkedungu\b/i, 'kedungu'],
  [/\bbelalang\b/i, 'kedungu'],
  [/\bbuwit\b/i, 'buwit'],
  [/tanah\s*lot/i, 'tanah_lot'],
  [/\bberaban\b/i, 'tanah_lot'],
  [/kaba[-\s]?kaba/i, 'tanah_lot'],
  [/\bbingin\b/i, 'bingin'],
  [/padang[-\s]?padang/i, 'padang_padang'],
  [/\bbalangan\b/i, 'balangan'],
  [/\bmelasti\b/i, 'ungasan'],
  [/\bungasan\b/i, 'ungasan'],
  [/\bpandawa\b/i, 'pandawa'],
  [/\bkutuh\b/i, 'pandawa'],
  [/\bpecatu\b/i, 'uluwatu'],
  [/\buluwatu\b/i, 'uluwatu'],
  [/\bsuluban\b/i, 'uluwatu'],
  // The Canggu belt's banjars. The desa names themselves (Canggu, Tibubeneng) are NOT
  // here: a card under `Tibubeneng, Badung` titled "…in Berawa" is in Berawa, so the
  // desa only answers through the slug or the kecamatan table below.
  [/\bberawa\b|\bbrawa\b/i, 'berawa'],
  [/\bbabakan\b/i, 'babakan'],
  [/\bpadonan\b/i, 'padonan'],
  [/\bumalas\b/i, 'umalas'],
  [/\bpelambingan\b|\bumasari\b|\bsemat\b/i, 'tibubeneng'],
  [/batu\s*bolong|echo\s*beach|kayu\s*tulang|padang\s*linjong|tegal\s*gundul/i, 'canggu'],
  // Center — the desa around Ubud, then Ubud's own banjars. "Mas" only counts beside
  // Ubud or spelled out: on its own it is the honorific (src/areas.js says the same).
  [/tegal+alang|\bkeliki\b|kenderan|\bsebatu\b|\bpujung\b/i, 'tegallalang'],
  [/payangan|melinggih|\bbuahan\b|\bkelusa\b/i, 'payangan'],
  [/\bpejeng\b|\bbedulu\b|tampaksiring/i, 'pejeng'],
  [/lodtunduh|singakerta|\bkemenuh\b|\bmas[,\s]+ubud\b|\bubud[,\s]+mas\b|desa\s+mas\b/i, 'lodtunduh'],
  [/nyuh\s*kuning|penestanan|\bsayan\b|campuhan|padang\s*tegal|pengosekan|kedewatan|peliatan/i, 'ubud'],
];

/**
 * Kecamatan → the area to assume when no village name appears anywhere.
 * SPEC is silent on this; the choices are argued in adapters/rumah123.md.
 * `Kuta Selatan` deliberately has no default (it also holds Jimbaran/Benoa/Nusa Dua).
 */
const KECAMATAN_AREA = [
  [/\bmengwi\b/i, 'mengwi'],
  [/\bkerambitan\b/i, 'buwit'],
  [/\btibubeneng\b/i, 'tibubeneng'],
  [/\bcanggu\b/i, 'canggu'],
  [/\bkediri\b/i, 'tanah_lot'],
  [/tegal+alang/i, 'tegallalang'],
  [/\bpayangan\b/i, 'payangan'],
  [/tampaksiring/i, 'pejeng'],
  [/\bubud\b/i, 'ubud'],
];

function firstMatch(table, text) {
  if (!text) return null;
  for (const [re, area] of table) if (re.test(text)) return area;
  return null;
}

/**
 * Canonical §7 area for one portal card.
 * Order: village name in the location string → village name in the title →
 * the search slug's own area → kecamatan default. Null means "not a target area".
 *
 * @param {{location?:string, title?:string, slugArea?:string|null}} input
 * @returns {string|null}
 */
export function resolveArea({ location = '', title = '', slugArea = null } = {}) {
  return (
    firstMatch(VILLAGE_AREA, location) ||
    firstMatch(VILLAGE_AREA, title) ||
    slugArea ||
    firstMatch(KECAMATAN_AREA, location) ||
    null
  );
}

/** `"Seseh, Badung"` → `"Seseh"` — the portal's own village or kecamatan name. */
export function subAreaOf(location) {
  const head = String(location || '').split(',')[0].trim();
  return head || null;
}

// ---------------------------------------------------------------------------
// Noise filter
// ---------------------------------------------------------------------------

/** Not a long-term house or villa: kost, apartments, commercial, land, nightly stays. */
const NOISE_RE =
  /\b(kost?s?|kos[-\s]?kosan|apartemen|apartment|condotel|ruko|rukan|kantor|office|gudang|warehouse|tanah|kavling|lahan|hotel|homestay|guest\s?house|resort|per\s?malam|per\s?hari|harian|nightly|daily)\b/i;

/** Daily-rate cards slip through as `/hari`; `parsePrice` has no 'day' period. */
const DAILY_RE = /\/\s*(hari|malam|night|day)\b/i;

/** `Rp 165 Juta Total /tahun` → 'year'. Only the trailing period field is trusted. */
export function periodFromText(priceText) {
  const m = /\/\s*(bulan|tahun|month|year)\b/i.exec(String(priceText || ''));
  if (!m) return null;
  return /tahun|year/i.test(m[1]) ? 'year' : 'month';
}

export function isNoise({ title = '', url = '', priceText = '' } = {}) {
  if (DAILY_RE.test(priceText)) return true;
  // The URL slug repeats the title, so one test over both catches mislabelled cards.
  return NOISE_RE.test(`${title} ${url}`);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `/properti/badung-seseh/3-bedroom-villa-…-vlr349347/` → `vlr349347`. */
export function refFromUrl(url) {
  const m = /\/properti\/[^/]+\/([^/?#]+)/.exec(String(url || ''));
  if (!m) return null;
  const slug = m[1];
  const last = slug.split('-').pop();
  return /^[a-z]{2,4}\d{3,}$/i.test(last) ? last.toLowerCase() : null;
}

/**
 * Card thumbnails come through Next.js' image proxy
 * (`/portal-img/_next/image/?url=<encoded>&w=…`); unwrap it to the original CDN file.
 */
export function cleanImageUrl(href) {
  const abs = absolute(href);
  if (!abs) return null;
  try {
    const inner = new URL(abs).searchParams.get('url');
    return inner ? absolute(inner) : abs;
  } catch {
    return abs;
  }
}

function absolute(href) {
  if (!href) return null;
  try {
    return new URL(href, BASE).href;
  } catch {
    return null;
  }
}

function text($el) {
  const s = $el && $el.length ? $el.text().replace(/\s+/g, ' ').trim() : '';
  return s || null;
}

function intFrom(value) {
  if (value == null) return null;
  const m = /(\d[\d.,]*)/.exec(String(value));
  if (!m) return null;
  const n = Number(m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Haversine in km — only used to sanity-check a portal pin against its area centroid. */
function km(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Rumah123 pins are agent-placed; beyond this from the §7 centroid we prefer ours. */
const PIN_MAX_KM = 6;

export function plausiblePin(area, lat, lng) {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const a = AREAS[area];
  if (!a) return false;
  return km(a.centroid[0], a.centroid[1], lat, lng) <= PIN_MAX_KM;
}

/** `#bedroom-icon` → the number printed next to it inside the card. */
function iconNumber($, $card, icon) {
  let value = null;
  $card.find('use').each((_, el) => {
    if (value != null) return;
    const href = $(el).attr('xlink:href') || $(el).attr('href') || '';
    if (!href.includes(icon)) return;
    const owner = $(el).closest('span, p, div');
    value = intFrom(owner.text());
  });
  return value;
}

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

export function searchUrl(path, type, page = 1) {
  const base = `${BASE}/sewa/${path}/${type}/`;
  return page > 1 ? `${base}?page=${page}` : base;
}

/**
 * Every card of one search page. Cards are located the way `bhi` does it: from each
 * title link, walk up to the smallest ancestor that also holds a price element and
 * exactly one title link.
 *
 * @param {string} html
 * @param {{slugArea?:string|null, category?:string}} [ctxInfo]
 * @returns {{cards:object[], hasNext:boolean}}
 */
export function extractCards(html, { slugArea = null, category = '' } = {}) {
  const $ = cheerio.load(html);
  const seen = new Map();

  $('a[data-test-id="srp-card-listing-title-link"]').each((_, a) => {
    const url = absolute($(a).attr('href'));
    const ref = refFromUrl(url);
    if (!ref || seen.has(ref)) return;

    let $card = null;
    let el = a;
    for (let i = 0; i < 8 && el; i++) {
      const $el = $(el);
      if ($el.find('[data-test-id="srp-card-listing-price-main"]').length) {
        if ($el.find('a[data-test-id="srp-card-listing-title-link"]').length <= 1) $card = $el;
        break; // two cards in this ancestor → the walk went too far, drop the link
      }
      el = $el.parent()[0];
    }
    if (!$card) return;

    // The smallest price-bearing ancestor stops below the image carousel and the agent
    // footer, so climb back out for as long as the ancestor still holds this one card.
    for (let i = 0; i < 4; i++) {
      const $up = $card.parent();
      if (!$up.length || $up.is('body, html')) break;
      if ($up.find('a[data-test-id="srp-card-listing-title-link"]').length !== 1) break;
      $card = $up;
    }

    const title = text($card.find('[data-test-id="srp-card-listing-title"]').first()) ||
      $(a).attr('title') || null;
    const priceText = text($card.find('[data-test-id="srp-card-listing-price-main"]').first());
    const location = text($card.find('[data-test-id="srp-card-listing-location"]').first());
    const note = text($card.find('[data-test-id="srp-card-listing-description"]').first());

    if (!title || !priceText) return;
    if (isNoise({ title, url, priceText })) return;

    const price = parsePrice(priceText);
    if (!price) return;
    // `Rp 165 Juta Total /tahun` — the agent's "Total" label sits between the amount and
    // the period, so parsePrice loses the period. The suffix is the site's own field.
    const per = price.per || periodFromText(priceText);
    if (!per) return; // no period → not a rental we can normalise

    const bedrooms = iconNumber($, $card, '#bedroom-icon');
    if (bedrooms == null) return;

    const area = resolveArea({ location: location || '', title, slugArea });
    if (!area) return; // not one of the §7 areas — the band check would drop it anyway

    const img = $card.find('img[src*="rumah123.com"], img[data-src*="rumah123.com"]').first();

    seen.set(ref, {
      source: 'rumah123',
      ref,
      url,
      title,
      // `normaliseListing` honours a canonical §7 `area` on the partial, so the adapter
      // states it outright; the portal's own wording travels as `source_location` and
      // lands in `raw` (rumah123.md "Area mapping").
      source_location: location,
      area,
      sub_area: subAreaOf(location),
      category,
      note,
      bedrooms,
      bathrooms: iconNumber($, $card, '#bathroom-icon'),
      price_month_idr: per === 'month' ? price.amount : null,
      price_year_idr: per === 'year' ? price.amount : null,
      term: per === 'year' ? 'yearly' : 'monthly',
      price_text: priceText,
      thumb: cleanImageUrl(img.attr('src') || img.attr('data-src')),
      agent_name: text($card.find('[data-test-id="srp-card-agent-name"]').first()),
    });
  });

  // The last page still renders a "Next page" arrow with rel="next" — disabled, no
  // href (seen on /sewa/badung/canggu/villa/?page=60, 2026-09-26). Only a live link counts.
  const hasNext = $('a[rel="next"][href]').filter((_, a) => $(a).attr('aria-disabled') !== 'true').length > 0;
  return { cards: [...seen.values()], hasNext };
}

/**
 * SPEC §6 `list`: one partial per card across area × property type × page.
 * A ref seen under two areas is yielded once.
 */
async function* list(ctx, { slugs = TARGET_SLUGS, types = TYPES, maxPages = MAX_PAGES } = {}) {
  const seen = new Set();

  for (const slug of slugs) {
    for (const type of types) {
      for (let page = 1; page <= maxPages; page++) {
        const url = searchUrl(slug.path, type, page);
        const res = await ctx.fetchHtml(url, { ttlHours: 24 });
        if (!res || !res.html) break;

        const { cards, hasNext } = extractCards(res.html, {
          slugArea: slug.area,
          category: `${slug.path}/${type}`,
        });

        for (const card of cards) {
          if (seen.has(card.ref)) continue;
          seen.add(card.ref);
          yield card;
        }

        if (!hasNext) break;
        if (page === maxPages && ctx.log && ctx.log.warn) {
          ctx.log.warn(`[rumah123] ${slug.path}/${type}: stopped at MAX_PAGES=${maxPages} with more pages linked`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// detail()
// ---------------------------------------------------------------------------

const GONE_RE = /sudah\s+(disewa|terjual|laku)|tidak\s+tersedia|iklan\s+tidak\s+ditemukan|listing\s+not\s+available/i;

/** Every `application/ld+json` block on the page, parsed, bad ones skipped. */
export function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      /* a malformed block is not a reason to lose the page */
    }
  }
  return out;
}

/** The `Accommodation`/`Product` node of the detail page's `@graph`. */
export function mainEntityOf(blocks) {
  for (const b of blocks) {
    const graph = b && Array.isArray(b['@graph']) ? b['@graph'] : [b];
    for (const node of graph) {
      if (node && node.mainEntity && node.mainEntity.name) return node.mainEntity;
    }
  }
  return null;
}

/** `datePosted` off the `WebPage`/`RealEstateListing` node. */
function postedAt(blocks) {
  for (const b of blocks) {
    const graph = b && Array.isArray(b['@graph']) ? b['@graph'] : [b];
    for (const node of graph) if (node && node.datePosted) return String(node.datePosted);
  }
  return null;
}

/** The `Person`/`RealEstateAgent` node, when the page carries one. */
function agentOf(blocks) {
  for (const b of blocks) {
    const graph = b && Array.isArray(b['@graph']) ? b['@graph'] : [b];
    for (const node of graph) {
      const types = [].concat((node && node['@type']) || []);
      if (types.includes('RealEstateAgent') && node.name) return node;
    }
  }
  return null;
}

/**
 * The page's visible text. `$('body').text()` would include every `<script>` — and the
 * Next.js payload carries a translation table with "Sudah terjual/tersewa" in it, which
 * would mark every live listing `gone`.
 */
function visibleText($) {
  const $body = $('body').clone();
  $body.find('script, style, noscript, template').remove();
  return $body.text();
}

/** The label/value `<p>` pairs of the "Spesifikasi" block, keyed by lower-case label. */
export function specPairs($) {
  const out = {};
  $('p').each((_, el) => {
    const $p = $(el);
    const label = text($p);
    if (!label || label.length > 32) return;
    const $next = $p.next('p');
    if (!$next.length) return;
    const value = text($next);
    if (!value || value.length > 64) return;
    const key = label.toLowerCase();
    if (!(key in out)) out[key] = value;
  });
  return out;
}

/** Facility icon ids (`pool`, `garden`, `ac`, `kitchen-set`) plus their printed labels. */
export function facilityIds($) {
  const ids = new Set();
  const labels = [];
  $('use').each((_, el) => {
    const href = $(el).attr('xlink:href') || $(el).attr('href') || '';
    const m = /ListingPageIcons\.svg#([\w-]+)/.exec(href);
    if (!m) return;
    ids.add(m[1]);
    const label = text($(el).closest('p'));
    if (label) labels.push(label);
  });
  return { ids, labels };
}

/** "Furnished" / "Full Furnished" / "Semi Furnished" → 1, "Unfurnished"/"Kosongan" → 0. */
export function furnishedFrom(value) {
  if (!value) return null;
  const s = String(value).toLowerCase();
  if (/unfurnished|non[\s-]?furnished|kosongan|tanpa\s+perabot/.test(s)) return 0;
  if (/furnished|perabotan\s+lengkap|berperabot/.test(s)) return 1;
  return null;
}

/** "Luas Tanah: 150 m²" anywhere in the description. */
function m2FromText(text_, label) {
  const re = new RegExp(`${label}\\s*[:\\-]?\\s*(\\d[\\d.,]*)\\s*m`, 'i');
  const m = re.exec(String(text_ || ''));
  return m ? intFrom(m[1]) : null;
}

/**
 * SPEC §6 `detail`: one listing's facts. Returns `{gone:true}` on a 404 or a page that
 * says the listing is taken, and `null` when the page is there but unparseable (a
 * scraper error, never a delisting — SPEC §6 "Recheck").
 */
async function detail(ctx, url, { force = false } = {}) {
  const res = await ctx.fetchHtml(url, { ttlHours: 24, force });
  if (!res) return null;
  if (res.status === 404 || res.status === 410) return { gone: true };
  if (!res.html) return null;
  return detailFromHtml(res.html, url);
}

/** The pure half of `detail()` — everything but the fetch. Exported for tests. */
export function detailFromHtml(html, url) {
  const $ = cheerio.load(html);
  const blocks = jsonLdBlocks(html);
  const me = mainEntityOf(blocks);
  if (!me) return null;

  const spec = specPairs($);
  const { ids, labels } = facilityIds($);
  const description = me.description || null;
  const haystack = [description, labels.join(' '), Object.values(spec).join(' ')]
    .filter(Boolean)
    .join(' . ');

  // --- price and term -------------------------------------------------------
  const offer = me.offers && me.offers.priceSpecification ? me.offers.priceSpecification : null;
  const unit = offer && offer.referenceQuantity ? String(offer.referenceQuantity.unitCode || '') : '';
  const amount = offer ? intFrom(offer.price) : null;
  const price_year_idr = unit === 'ANN' ? amount : null;
  const price_month_idr = unit === 'MON' ? amount : null;

  // --- location -------------------------------------------------------------
  const locality = (me.address && me.address.addressLocality) || null;
  const area = resolveArea({ location: locality || '', title: me.name || '' });
  const sub_area = subAreaOf(locality);

  // --- pin ------------------------------------------------------------------
  // Agent-placed, sometimes kilometres off (rumah123.md "Coordinates"): never
  // `listing_map`, and dropped when it lands outside the resolved area.
  const lat = me.geo && Number.isFinite(Number(me.geo.latitude)) ? Number(me.geo.latitude) : null;
  const lng = me.geo && Number.isFinite(Number(me.geo.longitude)) ? Number(me.geo.longitude) : null;
  const pinOk = plausiblePin(area, lat, lng);

  // --- facts ----------------------------------------------------------------
  const bedrooms = me.numberOfBedrooms != null ? intFrom(me.numberOfBedrooms) : intFrom(spec['kamar tidur']);
  const bathrooms =
    me.numberOfBathroomsTotal != null ? intFrom(me.numberOfBathroomsTotal) : intFrom(spec['kamar mandi']);
  const land_m2 = intFrom(spec['luas tanah']) ?? m2FromText(description, 'luas tanah');
  const build_m2 = intFrom(spec['luas bangunan']) ?? m2FromText(description, 'luas bangunan');

  const furnished =
    furnishedFrom(spec['kondisi perabotan']) ??
    furnishedFrom(spec['perabotan']) ??
    furnishedFrom(description);

  const pool = ids.has('pool') || /kolam\s+renang|swimming\s+pool/i.test(haystack) ? 1 : null;
  const garden = ids.has('garden') || /\btaman\b|\bgarden\b/i.test(haystack) ? 1 : null;
  const aircon = ids.has('ac') || /\bAC\b|air\s+conditioner|pendingin\s+ruangan/i.test(haystack) ? 1 : null;
  const kitchen_full = ids.has('kitchen-set') || /kitchen\s?set|dapur\s+lengkap/i.test(haystack) ? 1 : null;

  const min_months = parseMinMonths(haystack) ?? parseMinMonths(`minimal sewa ${spec['tipe sewa'] || ''}`);

  // --- images ---------------------------------------------------------------
  const images = []
    .concat(me.image || [])
    .map((i) => (typeof i === 'string' ? i : i && i.contentUrl))
    .filter(Boolean)
    .slice(0, MAX_IMAGES)
    .map((src_url) => ({ src_url }));

  // --- contact --------------------------------------------------------------
  // Phones are masked portal-side ("+62821******"); the one wa.me link is Rumah123's
  // own line, not the agent's, so it is labelled as such (rumah123.md "Contact").
  const agent = agentOf(blocks);
  const contacts = [];
  if (agent) {
    contacts.push({
      role: 'agent',
      name: agent.name,
      url: agent.url || null,
      phone: agent.telephone || null,
      phone_masked: /\*/.test(String(agent.telephone || '')) || undefined,
      agency: (agent.worksFor && agent.worksFor.name) || null,
    });
  }
  const wa = $('a[href*="wa.me"]').first().attr('href');
  if (wa) contacts.push({ role: 'portal', name: 'Rumah123', whatsapp: wa.split('/').pop() });

  // --- gone -----------------------------------------------------------------
  const availability = String((me.offers && me.offers.availability) || '');
  const gone =
    (availability && !/InStock|LimitedAvailability|PreOrder/i.test(availability)) ||
    GONE_RE.test(visibleText($));

  return {
    ref: me.sku || refFromUrl(url),
    url: me.url || url,
    title: me.name || null,
    description,
    source_location: locality,
    area,
    sub_area,
    bedrooms,
    bathrooms,
    land_m2,
    build_m2,
    price_month_idr,
    price_year_idr,
    term: price_year_idr != null ? 'yearly' : price_month_idr != null ? 'monthly' : null,
    min_months,
    furnished,
    pool,
    garden,
    aircon,
    kitchen_full,
    property_type: spec['tipe properti'] || null,
    view_text: spec['pemandangan'] || null,
    posted_at: postedAt(blocks),
    lat: pinOk ? lat : null,
    lng: pinOk ? lng : null,
    pin_source: pinOk ? 'geocode' : null,
    images,
    contacts,
    facilities: labels,
    gone: gone || undefined,
  };
}

// ---------------------------------------------------------------------------
// applyDetail
// ---------------------------------------------------------------------------

/** Facts the detail page states outright and `normaliseListing` cannot infer. */
const ASSERTED = [
  'bathrooms', 'land_m2', 'build_m2', 'furnished', 'pool', 'garden', 'aircon', 'kitchen_full',
];

/**
 * `ingest.js` hands us the normalised row plus the detail payload. The card already
 * carried a canonical area; the detail page resolves it again from its own locality and
 * title, so a card that only had the search slug to go on gets the better answer here.
 */
export function applyDetail(row, d) {
  if (!d) return row;
  const out = { ...row };

  if (d.area) {
    out.area = d.area;
    if (d.sub_area) out.sub_area = d.sub_area;
  }

  for (const k of ASSERTED) {
    if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  }

  if (out.min_months == null && d.min_months != null) out.min_months = d.min_months;

  if (d.lat != null && d.lng != null) {
    out.lat = d.lat;
    out.lng = d.lng;
    out.pin_source = d.pin_source || 'geocode';
  }

  if (Array.isArray(d.images) && d.images.length) out.images = d.images;
  if (Array.isArray(d.facilities) && d.facilities.length) out.inclusions = JSON.stringify(d.facilities);
  if (d.gone) out.availability = 'gone';
  return out;
}

export default {
  id: 'rumah123',
  name: 'Rumah123',
  base: BASE,
  areas: TARGET_SLUGS.map((s) => s.path),
  list,
  detail,
  applyDetail,
  // exposed for the seed / tests
  extractCards,
  detailFromHtml,
  resolveArea,
  subAreaOf,
  refFromUrl,
  searchUrl,
};
