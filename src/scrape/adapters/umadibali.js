// Uma di Bali Properties — an agency added 2026-09-26 at Philipp's request.
// WordPress, server-rendered: `/search/?type=<yearly|monthly>_rental&loc[]=<slug>` returns
// cards in the HTML, and the location filter is a plain query parameter, so the walk asks
// only for the SPEC §7 villages instead of the whole 2 000-card index. The site keeps its
// rented villas listed (well over half the index), so a rented card is only passed on when
// it would retire a row we are already tracking. See adapters/umadibali.md.

import * as cheerio from 'cheerio';
import { MAX_PAGES, MAX_IMAGES, absUrl, textOf, numberIn } from './_shared.js';
import { moneyIdr, areaFromText, subAreaFrom, beachHint, termFor } from './_shared.js';
import { AREAS } from '../../areas.js';

const BASE = 'https://umadibali.com';
const SOURCE = 'umadibali';
const NAME = 'Uma di Bali Properties';

/** Cards per index page. The site's own default is 12; 48 keeps Umalas (≈400 yearly
 * cards) inside MAX_PAGES and costs the site a quarter of the requests. */
export const PER_PAGE = 48;

/** Both rental indexes. "Bali House For Rent" houses appear in `yearly_rental` too. */
export const TYPES = ['yearly_rental', 'monthly_rental'];

/**
 * The site's `loc[]` slugs that can hold a SPEC §7 area, with the label the search form
 * shows (which `areaFromText` maps). Villages first, the broad names last, so a villa
 * tagged both "Pererenan" and "Canggu" is first met — and placed — in Pererenan.
 * `munggu` is the parent term and already includes its children (`munggu-munggu`,
 * `cepaka-munggu`). Not walked: Kerobokan, Tegal Cupek, Seminyak, Jimbaran, Nusa Dua,
 * the east coast (not §7 areas) and `beraban` (no listings, and not a §7 place word).
 */
export const LOCATIONS = [
  ['tanah-lot', 'Tanah Lot'],
  ['kaba-kaba', 'Kaba-Kaba'],
  ['cepaka', 'Cepaka'],
  ['munggu', 'Munggu'],
  ['cemagi', 'Cemagi'],
  ['cemagi-other-area', 'Cemagi'],
  ['seseh', 'Seseh'],
  ['seseh-other-area', 'Seseh'],
  ['nyanyi', 'Nyanyi'],
  ['buduk', 'Buduk'],
  ['pererenan', 'Pererenan'],
  ['padonan', 'Padonan'],
  ['babakan', 'Babakan'],
  ['echo-beach', 'Echo Beach'],
  ['berawa', 'Berawa'],
  ['umalas', 'Umalas'],
  ['canggu', 'Canggu'],
  ['tabanan', 'Tabanan'],
  ['ubud', 'Ubud'],
  ['bingin', 'Bingin'],
  ['uluwatu', 'Uluwatu'],
  ['ungasan', 'Ungasan'],
  ['bukit', 'Bukit'],
];

export function searchUrl(type, slug, page = 1) {
  const q = [
    `type=${encodeURIComponent(type)}`,
    `loc%5B%5D=${encodeURIComponent(slug)}`,
    'curr=idr',
    `paging=${page}`,
    `ppp=${PER_PAGE}`,
    'sort-by=latest',
    'view=grid',
  ];
  return `${BASE}/search/?${q.join('&')}`;
}

// ---------------------------------------------------------------------------
// The code line: ref, and what the agent wrote after it
// ---------------------------------------------------------------------------

/**
 * `IP 874 - Avail Oct 30, 2026` → `{ref:'IP-874', code:'IP 874', suffix:'Avail Oct 30, 2026'}`.
 * The ref is the site's code with its space made a hyphen, so the store key
 * (`umadibali:IP-874`) has no whitespace; digits are kept exactly as printed
 * (`AR 18` stays `AR-18`, `IP 036` stays `IP-036`).
 */
export function parseCode(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').replace(/^\s*code\s*:?\s*/i, '').trim();
  const m = /^([A-Za-z]{1,5})\s*[-.]?\s*(\d{1,5})([A-Za-z]?)\b\s*(?:[-–—:|]+\s*)?(.*)$/.exec(s);
  if (!m) return { ref: null, code: null, suffix: null };
  const letters = m[1].toUpperCase();
  const digits = m[2] + m[3].toUpperCase();
  return { ref: `${letters}-${digits}`, code: `${letters} ${digits}`, suffix: m[4] ? m[4].trim() || null : null };
}

/** `…-villa-sani-umalas-ip-874/` → `IP-874`; the fallback when a code line is missing. */
function refFromUrl(url) {
  const m = /-([a-z]{1,5})-(\d{1,5}[a-z]?)\/?(?:[?#]|$)/i.exec(String(url || ''));
  return m ? `${m[1].toUpperCase()}-${m[2].toUpperCase()}` : null;
}

const MONTH_RE =
  /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthOf = (word) => (MONTH_RE.test(String(word || '')) ? MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1 : null);
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The first date in an agent's note, as ISO `YYYY-MM-DD` (the 1st when no day is
 * given). Reads `Avail Oct 30, 2026`, `Avail 5 Sept 2025`, `Av April 2025`,
 * `RENTED until June 2020`, `Avail Nov 2026`. Null when there is no such date.
 */
export function availDateFrom(text) {
  const s = String(text ?? '');
  const found = [];
  // day month year — "5 Sept 2025"
  for (const m of s.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) {
    found.push({ at: m.index, day: Number(m[1]), month: monthOf(m[2]), year: Number(m[3]) });
  }
  // month [day,] year — "Oct 30, 2026", "Nov 2026"
  for (const m of s.matchAll(/\b([A-Za-z]{3,9})\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})\b/g)) {
    found.push({ at: m.index, day: m[2] ? Number(m[2]) : 1, month: monthOf(m[1]), year: Number(m[3]) });
  }
  const first = found
    .filter((f) => f.month && f.day >= 1 && f.day <= 31 && f.year >= 2000)
    .sort((a, b) => a.at - b.at)[0];
  return first ? `${first.year}-${pad2(first.month)}-${pad2(first.day)}` : null;
}

const TAKEN_RE = /\b(rented|sold)\b/i;

/**
 * How far ahead a rented villa's "Avail <date>" still counts as coming onto the market:
 * this month and the next three. The site states dates as far out as 2043 (multi-year
 * leases); a villa that frees up in 2028 is not one Philipp can move into. SPEC is silent.
 */
export const UPCOMING_MONTHS = 3;

/** Whole calendar months from `now` to an ISO date (0 = this month, negative = past). */
function monthsAhead(iso, now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  const base = Number.isNaN(d.getTime()) ? new Date() : d;
  return (Number(iso.slice(0, 4)) - base.getUTCFullYear()) * 12 + (Number(iso.slice(5, 7)) - 1 - base.getUTCMonth());
}

/**
 * The availability rule (adapters/umadibali.md "Rented, and Avail <date>"):
 *
 * - any taken marker — the card's `Availability : Rented`, `RENTED OUT` in the code line,
 *   a "Rented Out" / "SOLD OUT" banner — means taken;
 * - taken with a date in the code line within `UPCOMING_MONTHS` (this month included)
 *   means it frees up then: `available_from` is that date and the listing is not gone;
 *   a date further out, or one that has passed, leaves it gone;
 * - not taken, with a date still to come: available from that date;
 * - a date that has passed on a listing that is not taken is stale and ignored.
 *
 * @returns {{gone:boolean, rented:boolean, available_from:string|null}}
 */
export function statusFrom({ availability = null, suffix = null, banner = null } = {}, now = new Date()) {
  const rented = [availability, suffix, banner].some((t) => t && TAKEN_RE.test(t));
  const date = availDateFrom(suffix) || availDateFrom(availability);
  const ahead = date ? monthsAhead(date, now) : null;
  if (rented) {
    const soon = ahead != null && ahead >= 0 && ahead <= UPCOMING_MONTHS;
    return { gone: !soon, rented, available_from: soon ? date : null };
  }
  return { gone: false, rented, available_from: ahead != null && ahead >= 0 ? date : null };
}

// ---------------------------------------------------------------------------
// Shared card / detail pieces
// ---------------------------------------------------------------------------

/**
 * `.property-price` panes: a `<label>` (YEARLY RENTAL / MONTHLY RENTAL / FOR SALE /
 * FOR LEASE / DAILY RENTAL) and `.property-price-text` (`Rp. 130.000.000 / year`).
 * Only the two long-term rental labels count; `Rp. 0` is "not quoted".
 */
function pricesFrom($, $scope, config) {
  let price_month_idr = null;
  let price_year_idr = null;
  let currency = null;
  const labels = [];
  $scope.find('.property-price').each((_, el) => {
    const $el = $(el);
    const label = (textOf($el.find('label').first()) || '').toUpperCase();
    labels.push(label);
    const money = moneyIdr(textOf($el.find('.property-price-text').first()) || '', config);
    if (!money || !(money.amount > 0)) return;
    if (/YEARLY/.test(label) && price_year_idr == null) price_year_idr = money.amount;
    else if (/MONTHLY/.test(label) && price_month_idr == null) price_month_idr = money.amount;
    else return;
    currency = money.currency;
  });
  return { price_month_idr, price_year_idr, currency, labels };
}

/**
 * The icon row (card `.property-icon`, detail `.single-property-icon`), keyed by the
 * icon class: `icon-bedroom`, `icon-bathroom`, `icon-land-size`, `icon-open-livingroom`
 * / `icon-enclosed-livingroom`, `icon-{fully,semi,un}-furnished`, `icon-garden`, …
 * A greyed-out `li.not-active` ("Land size not defined") says nothing.
 */
function iconStats($, $scope) {
  const out = { features: [] };
  $scope.find('li').each((_, el) => {
    const $el = $(el);
    if ($el.hasClass('not-active')) return;
    const icon = ($el.find('i').attr('class') || '').split(/\s+/).find((c) => c.startsWith('icon-')) || '';
    const value = textOf($el.find('span').first());
    const title = $el.attr('title') || '';
    if (icon === 'icon-bedroom') out.bedrooms = numberIn(value);
    else if (icon === 'icon-bathroom') out.bathrooms = numberIn(value);
    else if (icon === 'icon-land-size') out.land_m2 = numberIn(value);
    else if (icon === 'icon-open-livingroom') out.living_open = 1;
    else if (icon === 'icon-enclosed-livingroom') out.living_open = 0;
    else if (icon === 'icon-un-furnished') out.furnished = 0;
    else if (/^icon-(fully|semi)-furnished$/.test(icon)) out.furnished = 1;
    else if (icon === 'icon-garden') out.garden = 1;
    if (title && !/bedroom|bathroom|land size/i.test(title)) out.features.push(title);
  });
  return out;
}

/** `Prime<br>Location` → `Prime Location`. */
function bannerOf($, $scope) {
  const $p = $scope.find('.property-thumb-banner').first();
  if (!$p.length) return null;
  $p.find('br').replaceWith(' ');
  return textOf($p);
}

/**
 * The title names the village more often than not ("Villa La Luna Pererenan") and wins;
 * the search location the card was found under fills in when it does not ("Rumah Dalco"
 * under Umalas). Detail pages carry no location at all, so they can only ever read the
 * title — putting the title first keeps the card and its detail page in agreement.
 */
function placeOf(title, location) {
  const byTitle = areaFromText(title);
  const byLocation = areaFromText(location);
  const area = byTitle || byLocation || null;
  const sub_area = area && byLocation === area ? subAreaFrom(location, area) : null;
  return { area, sub_area };
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/**
 * One `.property-item-wrapper` → a SPEC §6 partial (`area` null when off-target).
 * @param {{location?:string|null, now?:Date|string}} [opts] the search location label
 *   the card was listed under, and "today" for the availability rule
 */
export function cardFrom($, el, config = {}, { location = null, now = new Date() } = {}) {
  const $card = $(el);
  const url = absUrl($card.find('.property-footer a').filter((_, a) => /details/i.test($(a).text())).first().attr('href'), BASE);
  if (!url) return null;

  const title = $card.find('h3[title]').first().attr('title') || textOf($card.find('h3').first());
  const codeLine = textOf($card.find('.show-in-list-view p').first()) || textOf($card.find('.show-in-grid-view p').first());
  const { ref: coded, code, suffix } = parseCode((/Code\s*:\s*(.*?)(?:\s*\|\s*Availability|$)/i.exec(codeLine || '') || [])[1]);
  const ref = coded || refFromUrl(url);
  if (!ref) return null;

  const availability = (/Availability\s*:\s*(.+)$/i.exec(codeLine || '') || [])[1] || null;
  const banner = bannerOf($, $card);
  const status = statusFrom({ availability, suffix, banner }, now);

  const { area, sub_area } = placeOf(title, location);
  const { price_month_idr, price_year_idr, currency, labels } = pricesFrom($, $card.find('.price-wrapper').first(), config);
  const stats = iconStats($, $card.find('.property-icon').first());

  // The list-view carousel carries the full gallery at full size; the first is the hero.
  const thumb =
    absUrl($card.find('.list-view-img[data-bg]').first().attr('data-bg'), BASE) ||
    absUrl($card.find('img.grid-thumb').first().attr('data-src'), BASE);

  return {
    source: SOURCE,
    ref,
    url,
    title,
    area,
    sub_area,
    beach_km_hint: beachHint(area, location, title),
    location,
    // The banner ("Rice-field View", "Brand New") and the agent's note after the code
    // ("Minim 2 years lease") are the card's only prose — normaliseListing reads both.
    note: [banner, suffix].filter(Boolean).join(' · ') || null,
    bedrooms: stats.bedrooms ?? null,
    bathrooms: stats.bathrooms ?? null,
    land_m2: stats.land_m2 ?? null,
    build_m2: null,
    price_month_idr,
    price_year_idr,
    term: termFor(price_month_idr, price_year_idr),
    available_from: status.available_from,
    thumb,
    gone: status.gone,
    raw: {
      code,
      code_suffix: suffix,
      site_availability: availability,
      banner,
      site_location: location,
      price_labels: labels,
      price_currency: currency,
      post_id: $card.find('[data-id]').first().attr('data-id') || null,
    },
  };
}

/**
 * Every card of one search page. `all: true` also keeps the cards whose `area` is null,
 * which `list()` needs to tell "nothing new" from "nothing in a §7 area".
 */
export function cardsFrom(html, config = {}, { all = false, location = null, now = new Date() } = {}) {
  const $ = cheerio.load(html);
  const out = [];
  // Scoped to the results grid: the header, the footer and a detail page's "Similar
  // villas" row use the same card markup.
  $('.property-wrapper .property-item-wrapper').each((_, el) => {
    const card = cardFrom($, el, config, { location, now });
    if (!card) return;
    if (!all && !card.area) return;
    out.push(card);
  });
  return out;
}

/** `Page 1 of 34` → 34; else the highest `data-page`; null when there is no paginator. */
export function lastPageOf(html) {
  const s = String(html || '');
  const m = /Page\s+\d+\s+of\s+(\d+)/i.exec(s);
  if (m) return Number(m[1]);
  const pages = [...s.matchAll(/button-pagination[^>]*data-page="(\d+)"/g)].map((x) => Number(x[1]));
  return pages.length ? Math.max(...pages) : null;
}

/** A live (not gone, not unlisted) row we already hold for this ref. */
function tracking(ctx, ref) {
  const db = ctx && ctx.db;
  if (!db || typeof db.prepare !== 'function') return false;
  try {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM properties WHERE key = ?
             AND (availability IS NULL OR availability NOT IN ('gone', 'unlisted'))`
        )
        .get(`${SOURCE}:${ref}`)
    );
  } catch {
    return false;
  }
}

/** "Today" for the availability rule — `ctx.now` when a caller pins it (tests), else now. */
const todayOf = (ctx) => (ctx && ctx.now) || new Date();

async function* list(ctx, { locations = LOCATIONS, types = TYPES, now = todayOf(ctx) } = {}) {
  const seen = new Set();
  const tally = { cards: 0, yielded: 0, off_target: 0, rented_skipped: 0 };

  for (const [slug, label] of locations) {
    for (const type of types) {
      let lastPage = null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await ctx.fetchHtml(searchUrl(type, slug, page), { ttlHours: 24 });
        if (!res || !res.html) break;

        const cards = cardsFrom(res.html, ctx.config, { all: true, location: label, now });
        if (page === 1) lastPage = lastPageOf(res.html);
        if (!cards.length) break;

        let fresh = 0;
        for (const card of cards) {
          if (seen.has(card.ref)) continue;
          seen.add(card.ref);
          fresh++;
          tally.cards++;
          if (!card.area) {
            tally.off_target++;
            continue;
          }
          // Rented and never seen by us: the site's archive, not a villa that left the
          // market on our watch. Rented and tracked: pass it on, so the row goes gone today.
          if (card.gone && !tracking(ctx, card.ref)) {
            tally.rented_skipped++;
            continue;
          }
          tally.yielded++;
          yield card;
        }
        // Nothing new on a page means the walk has wrapped; a missing paginator means
        // there was only one page.
        if (fresh === 0) break;
        if (lastPage == null || page >= lastPage) break;
      }
    }
  }

  if (ctx.log && typeof ctx.log.info === 'function') {
    ctx.log.info(
      `[umadibali] ${tally.cards} cards, ${tally.yielded} passed on, ` +
        `${tally.rented_skipped} rented (untracked) skipped, ${tally.off_target} off-target`
    );
  }
}

// ---------------------------------------------------------------------------
// detail()
// ---------------------------------------------------------------------------

/** `085238086442` / `6285238086442` → `+6285238086442`. */
function waNumber(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return null;
  return `+${d.startsWith('0') ? `62${d.slice(1)}` : d}`;
}

/** Rough Bali bounding box — a pin outside it is a typo, not a villa. */
const inBali = (lat, lng) => lat > -9.0 && lat < -8.0 && lng > 114.4 && lng < 115.8;

/** The pure half of `detail()`. Exported for tests. */
export function detailFrom(html, url, config = {}, { now = new Date() } = {}) {
  const $ = cheerio.load(html);
  const $highlights = $('#highlights');
  if (!$highlights.length) return null;

  const title = textOf($('h1.page-title').first()) || $('.property-title-hidden').attr('value') || null;
  const { ref: coded, code, suffix } = parseCode(textOf($('.page-title-inline h2').first()));
  const ref = coded || refFromUrl(url);
  if (!ref) return null;

  const $gallery = $('#photo-gallery');
  const banner = bannerOf($, $gallery);
  // The detail page has no "Availability :" field of its own — only the code line and
  // the banner. A rented marker there is decisive; its absence is not (the card decides).
  const status = statusFrom({ suffix, banner }, now);

  const stats = iconStats($, $('.single-property-icon').first());
  const { price_month_idr, price_year_idr, currency, labels } = pricesFrom($, $highlights, config);

  // "Villa Information" / "House Information": one or two <ul>s of short facts.
  const info = $highlights
    .find('.item-list li')
    .map((_, el) => textOf($(el)))
    .get()
    .filter(Boolean);
  const prose = textOf($highlights.find('.property-desc'));
  const description = [prose, info.join('\n')].filter(Boolean).join('\n\n') || null;

  // Facilities: `<strong>Heading</strong><div class="item-list"><ul><li>…`, three columns.
  const facilities = {};
  $('#facilities strong').each((_, el) => {
    const heading = textOf($(el));
    const items = $(el)
      .next('.item-list')
      .find('li')
      .map((__, li) => textOf($(li)))
      .get()
      .filter(Boolean);
    if (heading && items.length) facilities[heading] = items;
  });
  const services = $('#villa-services li')
    .map((_, el) => textOf($(el)))
    .get()
    .filter(Boolean);
  const allFacilities = Object.values(facilities).flat();
  const has = (...res) => ([...allFacilities, ...info].some((f) => res.some((re) => re.test(f))) ? 1 : null);
  const kitchen = facilities.Kitchen || [];

  const { area, sub_area } = placeOf(title, null);

  const images = [];
  $gallery.find('.full-image img').each((_, el) => {
    const abs = absUrl($(el).attr('data-src') || $(el).attr('src'), BASE);
    if (!abs || /-10x10\./.test(abs)) return; // the blur-up placeholder
    if (!images.some((i) => i.src_url === abs) && images.length < MAX_IMAGES) images.push({ src_url: abs });
  });

  // `#map[data-lat][data-lng]` is per listing (two listings checked 2026-09-26 carry two
  // different pins, each in its own village). Houses often have no map section at all.
  const $map = $('#location #map').first();
  const lat = Number($map.attr('data-lat'));
  const lng = Number($map.attr('data-lng'));
  const hasPin = $map.length > 0 && Number.isFinite(lat) && Number.isFinite(lng) && inBali(lat, lng);

  const wa = /api\.whatsapp\.com\/send\?phone=(\d+)/.exec(html);
  const whatsapp = wa ? waNumber(wa[1]) : null;

  const terms =
    [
      allFacilities.length ? `Facilities: ${allFacilities.join(', ')}` : null,
      services.length ? `Services: ${services.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' | ') || null;

  return {
    source: SOURCE,
    ref,
    url: url || null,
    title,
    description,
    terms,
    note: [banner, suffix].filter(Boolean).join(' · ') || null,
    // null when the title names no §7 place: the card's search location then stands.
    area,
    sub_area,
    beach_km_hint: beachHint(area, title),
    location: null,

    bedrooms: stats.bedrooms ?? null,
    bathrooms: stats.bathrooms ?? null,
    land_m2: stats.land_m2 ?? null,
    build_m2: null,
    price_month_idr,
    price_year_idr,
    term: termFor(price_month_idr, price_year_idr),
    furnished: stats.furnished ?? null,
    living_open: stats.living_open ?? null,
    garden: stats.garden ?? has(/garden/i),
    pool: has(/swimming\s*pool|\bpool\b/i),
    aircon: has(/\bair\s*-?con/i, /\bAC\b/),
    kitchen_full: kitchen.some((k) => /equipped/i.test(k) && !/semi/i.test(k)) ? 1 : null,
    images,
    lat: hasPin ? lat : null,
    lng: hasPin ? lng : null,
    pin_source: hasPin ? 'listing_map' : null,
    available_from: status.available_from,

    contacts: whatsapp ? [{ role: 'agency', name: NAME, whatsapp }] : [],
    gone: status.gone ? true : null,
    raw: { code, code_suffix: suffix, banner, info, facilities, services, icons: stats.features, price_labels: labels, price_currency: currency },
  };
}

async function detail(ctx, url) {
  const res = await ctx.fetchHtml(url, { ttlHours: 24 });
  if (!res || res.status === 404 || res.status === 410 || !res.html) return null;
  return detailFrom(res.html, url, ctx.config, { now: todayOf(ctx) });
}

/** Facts the page states outright beat normaliseListing's keyword guesses. */
const ASSERTED = ['bathrooms', 'land_m2', 'furnished', 'pool', 'garden', 'kitchen_full', 'aircon', 'living_open'];

function rawOf(row) {
  try {
    return typeof row.raw === 'string' ? JSON.parse(row.raw || '{}') : row.raw || {};
  } catch {
    return {};
  }
}

export function applyDetail(row, d) {
  if (!d) return row;
  const out = { ...row };
  for (const k of ASSERTED) if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  if (d.lat != null && d.lng != null) {
    out.lat = d.lat;
    out.lng = d.lng;
    out.pin_source = d.pin_source || 'listing_map';
  }
  if (Array.isArray(d.images) && d.images.length) out.images = d.images;

  // `normaliseListing` stored the merged partial in `row.raw`: the card's verdict (the
  // only place the site prints "Availability : Rented") survives there.
  const merged = rawOf(row);
  if (d.gone || merged.gone === true) out.availability = 'gone';

  // The recheck rebuilds its partial from the stored row as `location: "<area> - <sub>"`
  // and a detail page carries no location, so a villa whose title names no village
  // would fall to `other` there. The canonical head of that string is the row's own area.
  if (!out.area || out.area === 'other') {
    const head = String(merged.location || '').split(' - ')[0].trim();
    if (head !== 'other' && Object.hasOwn(AREAS, head)) out.area = head;
  }
  return out;
}

export default {
  id: SOURCE,
  name: NAME,
  base: BASE,
  locations: LOCATIONS,
  list, detail, applyDetail, cardsFrom, detailFrom, lastPageOf, parseCode, statusFrom,
};
