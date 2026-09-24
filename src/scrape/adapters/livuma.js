// Livuma — a Bali rental/sale portal (Blazor Server). See adapters/livuma.md.
//
// There is no crawlable index: `/homes` and the area landing pages server-render the
// first 24 cards and load the rest over the `_blazor` SignalR channel, which robots.txt
// disallows. `sitemap.xml` lists every live listing (`/s/<id>/<slug>` + `<lastmod>`), so
// `list()` walks the sitemap and reads each detail page's JSON-LD `RealEstateListing`.
// Detail pages are cached for a week and refetched early when the sitemap's `lastmod`
// says the listing changed, so a daily run only touches new and edited listings.

import * as cheerio from 'cheerio';
import { MAX_IMAGES, textOf, numberIn, areToM2, usdRate } from './_shared.js';
import { areaFromText, beachHint, termFor, pickJsonLd } from './_shared.js';
import { AREAS, haversineKm } from '../../areas.js';

const BASE = 'https://livuma.com';
const SITEMAP_URL = `${BASE}/sitemap.xml`;

/** A detail page is refetched after a week, or sooner when the sitemap's lastmod moves. */
export const DETAIL_TTL_HOURS = 24 * 7;

/**
 * Documented default when `config.eur_idr` is absent. Some hosts quote in euro; like
 * `DEFAULT_USD_IDR` it only gates the band check — the euro amount travels verbatim in
 * `raw.offers`.
 */
export const DEFAULT_EUR_IDR = 18_500;

/** A listing pin within this many km of a §7 centroid names that area, as a last resort. */
const GEO_AREA_KM = 2;

const LISTING_PATH_RE = /^https:\/\/livuma\.com\/s\/(\d+)\/([^/?#]+)\/?$/;

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

/**
 * Every listing URL in `sitemap.xml`, newest id first.
 * @returns {{url:string, id:string, slug:string, lastmod:string|null}[]}
 */
export function parseSitemap(xml) {
  const out = [];
  const seen = new Set();
  for (const m of String(xml || '').matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = (/<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1]) || [])[1];
    const hit = LISTING_PATH_RE.exec(loc || '');
    if (!hit || seen.has(hit[1])) continue;
    seen.add(hit[1]);
    const lastmod = (/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(m[1]) || [])[1] || null;
    out.push({ url: loc, id: hit[1], slug: hit[2], lastmod });
  }
  return out.sort((a, b) => Number(b.id) - Number(a.id));
}

/**
 * Slugs that plainly name a sale or a plot are not worth a request. Deliberately
 * conservative: anything that also says rent/lease-per-term is still fetched, and
 * the JSON-LD `businessFunction` has the final word on everything that is.
 */
const SALE_SLUG_RE = /(?:^|-)(?:for-sale|sale|dijual|freehold|free-hold|leasehold|land|plot|tanah)(?:-|$)/;
const RENT_SLUG_RE = /(?:^|-)(?:rent|rental|rentals|monthly|yearly|sewa)(?:-|$)/;
export function slugLooksNonRental(slug) {
  const s = String(slug || '').toLowerCase();
  return SALE_SLUG_RE.test(s) && !RENT_SLUG_RE.test(s);
}

// ---------------------------------------------------------------------------
// Area
// ---------------------------------------------------------------------------

/** "Villa in Pererenan, 5 min to Canggu" → "Villa in Pererenan, " — a boast is not an address. */
const PROXIMITY_RE =
  /\b(?:\d+\s*(?:min(?:ute)?s?|m|km)\.?\s*(?:walk\s*|drive\s*|ride\s*)?(?:to|from)|near(?:by)?|close\s+to|next\s+to|walk(?:ing)?\s+(?:distance\s+)?to)\s+[a-z]+(?:[\s-]+[a-z]+)?/gi;
export function stripProximity(s) {
  return String(s ?? '').replace(PROXIMITY_RE, ' ');
}

/** "Long-Term Rentals in Seseh" + `/long-term-rentals/seseh` → "Seseh" (null for the bare index). */
export function crumbPlace(breadcrumb) {
  const items = (breadcrumb && breadcrumb.itemListElement) || [];
  const section = items.find((i) => Number(i.position) === 2) || items[1];
  if (!section) return null;
  const name = /\bin\s+(.+)$/i.exec(String(section.name || ''));
  return name ? name[1].trim() : null;
}

function nearestArea(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = null;
  for (const [id, a] of Object.entries(AREAS)) {
    const km = haversineKm(lat, lng, a.centroid[0], a.centroid[1]);
    if (!best || km < best.km) best = { id, km };
  }
  return best && best.km <= GEO_AREA_KM ? best.id : null;
}

/**
 * §7 area for a listing: the title (proximity phrases removed), then the breadcrumb's
 * area page, then the pin, then the address. The address is last and never says
 * Mengwi on its own authority: `80351, Mengwi` is the postcode district that holds
 * Pererenan, Seseh, Cemagi and Munggu, not the inland town §7 calls Mengwi.
 * @returns {{area:string|null, from:string|null}}
 */
export function areaFor({ title, crumb, lat, lng, address }) {
  const byTitle = areaFromText(stripProximity(title));
  if (byTitle) return { area: byTitle, from: 'title' };
  const byCrumb = areaFromText(crumb);
  if (byCrumb) return { area: byCrumb, from: 'breadcrumb' };
  const byGeo = nearestArea(lat, lng);
  if (byGeo) return { area: byGeo, from: 'geo' };
  const byAddress = areaFromText(address);
  if (byAddress && byAddress !== 'mengwi') return { area: byAddress, from: 'address' };
  return { area: null, from: null };
}

// ---------------------------------------------------------------------------
// detail()
// ---------------------------------------------------------------------------

const PAUSED_RE = /currently unavailable|temporarily paused this listing/i;

/** Offer price → IDR. USD/EUR converted at the config rate; any other currency is left null. */
export function offerIdr(offer, config = {}) {
  const amount = Number(offer && offer.price);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cur = String((offer && offer.priceCurrency) || 'IDR').toUpperCase();
  if (cur === 'IDR') return Math.round(amount);
  if (cur === 'USD') return Math.round(amount * usdRate(config));
  if (cur === 'EUR') {
    const n = Number(config && config.eur_idr);
    return Math.round(amount * (Number.isFinite(n) && n > 0 ? n : DEFAULT_EUR_IDR));
  }
  return null;
}

/** `offers[]` → monthly / yearly IDR. Only a lease of exactly one month or one year counts. */
export function pricesFrom(offers, config = {}) {
  let month = null;
  let year = null;
  for (const o of Array.isArray(offers) ? offers : offers ? [offers] : []) {
    if (!/LeaseOut/i.test(String(o.businessFunction || 'LeaseOut'))) continue;
    const len = o.leaseLength || {};
    if (Number(len.value ?? 1) !== 1) continue;
    const idr = offerIdr(o, config);
    if (idr == null) continue;
    const unit = String(len.unitText || '').toLowerCase();
    if (unit.startsWith('month') && month == null) month = idr;
    else if (unit.startsWith('year') && year == null) year = idr;
  }
  return { price_month_idr: month, price_year_idr: year };
}

/** `.amenity-tag` chips: on → true, `amenity-tag--off` → false. */
function amenityTags($) {
  const out = {};
  $('.amenity-tag').each((_, el) => {
    const $el = $(el);
    const name = textOf($el);
    if (name) out[name.toLowerCase()] = !$el.hasClass('amenity-tag--off');
  });
  return out;
}

/** `.info-row` → `{label: value}` (Offer, Property Type, Bedrooms, Minimum Stay, …). */
function infoRows($) {
  const out = {};
  $('.info-row').each((_, el) => {
    const label = textOf($(el).find('.info-label'));
    const value = textOf($(el).find('.info-value'));
    if (label) out[label.toLowerCase()] = value;
  });
  return out;
}

/** Every gallery image of this listing (its own `uploads/listings/<uuid>/` folder), in page order. */
function galleryFrom(html, ldImages) {
  const first = (Array.isArray(ldImages) ? ldImages : [ldImages]).find(Boolean) || '';
  const folder = (/\/uploads\/listings\/([0-9a-f-]{36})\//i.exec(first) || [])[1];
  const out = [];
  const push = (src) => {
    if (src && out.length < MAX_IMAGES && !out.some((i) => i.src_url === src)) out.push({ src_url: src });
  };
  if (folder) {
    const re = new RegExp(
      `https://cdn\\.livuma\\.com/cdn-cgi/image/width=1280,[^/"']*/prod/uploads/listings/${folder}/[A-Za-z0-9_.-]+`,
      'g'
    );
    for (const m of String(html).matchAll(re)) push(m[0]);
  }
  for (const src of Array.isArray(ldImages) ? ldImages : []) push(src);
  return out;
}

/** Tag on → 1, tag off → 0, no such tag → null. */
const flag = (tags, ...names) => {
  for (const n of names) if (n in tags) return tags[n] ? 1 : 0;
  return null;
};

/** The pure half of `detail()`. Exported for tests. */
export function detailFrom(html, url, config = {}) {
  const src = String(html || '');
  const listing = pickJsonLd(src, 'RealEstateListing')[0] || null;
  const ref = (LISTING_PATH_RE.exec((listing && listing.url) || url || '') || [])[1] || null;

  if (!listing) {
    // A paused listing is served 200 with a notice and no JSON-LD at all.
    if (ref && PAUSED_RE.test(src)) {
      return { source: 'livuma', ref, url: url || null, gone: true, raw: { paused: true } };
    }
    return null;
  }
  if (!ref) return null;

  const $ = cheerio.load(src);
  const crumbs = pickJsonLd(src, 'BreadcrumbList')[0] || null;
  const crumb = crumbPlace(crumbs);
  const crumbUrl = (crumbs?.itemListElement || []).find((i) => Number(i.position) === 2)?.item || null;
  const info = infoRows($);
  const tags = amenityTags($);
  const props = Object.fromEntries(
    (listing.additionalProperty || []).map((p) => [String(p.name || '').toLowerCase(), p.value])
  );

  const title = textOf(listing.name) || textOf($('h1').first());
  const $desc = $('.description-section .rich-text-content').first();
  $desc.find('br').replaceWith('\n');
  const description = $desc.length
    ? $desc.text().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() || null
    : textOf(listing.description);

  const geo = listing.geo || {};
  const lat = Number(geo.latitude);
  const lng = Number(geo.longitude);
  const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  const address = String(listing.address?.addressLocality || '').replace(/^\d{5},\s*/, '').trim() || null;

  const { area, from: area_from } = areaFor({ title, crumb, lat, lng, address });

  const offers = Array.isArray(listing.offers) ? listing.offers : listing.offers ? [listing.offers] : [];
  const { price_month_idr, price_year_idr } = pricesFrom(offers, config);
  const inStock = offers.length ? offers.some((o) => /InStock/i.test(String(o.availability || ''))) : null;

  const fn = String(listing.businessFunction || offers[0]?.businessFunction || '').replace(/^.*\//, '') || null;
  const category = textOf(listing.category) || info['property type'] || null;

  const floor = listing.floorSize && /MTK|m2/i.test(String(listing.floorSize.unitCode || 'MTK')) ? Number(listing.floorSize.value) : null;
  const landText = props['land size'] || info['land size'] || info.size || null;
  const land_m2 = landText ? (/are\b/i.test(landText) ? areToM2(landText) : numberIn(landText)) : null;

  const minStay = info['minimum stay'] || props['minimum stay'] || null;
  const min_months = minStay ? (/year/i.test(minStay) ? numberIn(minStay) * 12 : numberIn(minStay)) : null;

  const images = galleryFrom(src, listing.image);
  const openPlan = /open-plan|open-air living/i.test(`${props['architectural style'] || ''} ${props['outdoor features'] || ''}`);
  const privatePool = /private pool/i.test(String(props['outdoor features'] || '')) ? 1 : null;

  const host = textOf($('.host-card .host-name').first()) || null;
  const hostHref = $('.host-card a.host-profile-section').attr('href') || null;

  return {
    source: 'livuma',
    ref,
    url: listing.url || url || null,
    title,
    description,
    area,
    sub_area: null,
    location: area ? AREAS[area].label : crumb || address,
    beach_km_hint: beachHint(area, title, description),

    bedrooms: Number.isFinite(Number(listing.numberOfRooms)) ? Number(listing.numberOfRooms) : numberIn(info.bedrooms),
    bathrooms: Number.isFinite(Number(listing.numberOfBathroomsTotal))
      ? Number(listing.numberOfBathroomsTotal)
      : numberIn(info.bathrooms),
    build_m2: Number.isFinite(floor) && floor > 0 ? floor : numberIn(info['square meters']),
    land_m2,
    price_month_idr,
    price_year_idr,
    term: termFor(price_month_idr, price_year_idr),
    min_months,

    pool: flag(tags, 'pool') ?? privatePool,
    garden: flag(tags, 'garden'),
    aircon: flag(tags, 'air conditioning'),
    kitchen_full: flag(tags, 'equipped kitchen'),
    workspace: flag(tags, 'dedicated workspace'),
    living_open: openPlan ? 1 : null,

    images,
    thumb: images[0]?.src_url || null,
    lat: hasPin ? lat : null,
    lng: hasPin ? lng : null,
    pin_source: hasPin ? 'listing_map' : null,

    for_sale: fn === 'Sell' || undefined,
    // No offer in stock = the host took it off the market. No offers at all = unknown.
    gone: inStock === null ? null : !inStock,
    raw: {
      business_function: fn,
      category,
      offer: info.offer || null,
      breadcrumb: crumb,
      breadcrumb_url: crumbUrl,
      area_from,
      address: listing.address?.addressLocality || null,
      offers: offers.map((o) => ({
        price: o.price,
        currency: o.priceCurrency,
        availability: o.availability ? String(o.availability).replace(/^.*\//, '') : null,
        lease: o.leaseLength ? `${o.leaseLength.value} ${o.leaseLength.unitText}` : null,
      })),
      amenities: tags,
      properties: props,
      min_stay: minStay,
      date_posted: listing.datePosted || null,
      date_modified: listing.dateModified || null,
      host,
      host_url: hostHref ? new URL(hostHref, BASE).href : null,
    },
  };
}

/** Residential categories only — rooms, kost, land and commercial space are not a home. */
const HOME_CATEGORY_RE = /villa|house|home|apartment|loft|bungalow|townhouse|joglo|cottage|studio/i;
const NOT_HOME_RE = /room|kost|land|commercial|office|shop|warehouse|retail|business/i;

/** A long-term rental of a whole home (not a sale, not a room or kost). */
export function isRental(d) {
  if (!d || !d.raw) return false;
  if (d.raw.business_function !== 'LeaseOut') return false;
  if (/\/kost\b/.test(String(d.raw.breadcrumb_url || ''))) return false;
  const cat = String(d.raw.category || '');
  return HOME_CATEGORY_RE.test(cat) && !NOT_HOME_RE.test(cat);
}

/** Cached for a week; refetched when the sitemap's lastmod is on or after the cached copy's day. */
async function fetchListing(ctx, url, lastmod = null) {
  const res = await ctx.fetchHtml(url, { ttlHours: DETAIL_TTL_HOURS });
  if (res && res.fromCache && lastmod && res.fetchedAt && lastmod.slice(0, 10) >= String(res.fetchedAt).slice(0, 10)) {
    return ctx.fetchHtml(url, { ttlHours: DETAIL_TTL_HOURS, force: true });
  }
  return res;
}

async function* list(ctx) {
  const sm = await ctx.fetchHtml(SITEMAP_URL, { ttlHours: 24 });
  if (!sm || !sm.html) throw new Error(`livuma: sitemap unavailable (${sm ? sm.status : 'no response'})`);
  const entries = parseSitemap(sm.html);
  if (!entries.length) throw new Error('livuma: sitemap lists no listings — layout changed?');

  const tally = { listed: entries.length, sale_slug: 0, fetched: 0, gone: 0, not_rental: 0, off_area: 0, yielded: 0, errors: 0 };
  const categories = {};
  try {
    for (const e of entries) {
      if (slugLooksNonRental(e.slug)) {
        tally.sale_slug++;
        continue;
      }
      let res;
      try {
        res = await fetchListing(ctx, e.url, e.lastmod);
      } catch (err) {
        if (String(err && err.message).startsWith('blocked:')) throw err;
        tally.errors++;
        ctx.log?.warn?.(`[livuma] ${e.url}: ${String((err && err.message) || err)}`);
        continue;
      }
      tally.fetched++;
      if (!res || !res.html) continue;

      const d = detailFrom(res.html, e.url, ctx.config);
      if (!d) {
        tally.errors++;
        continue;
      }
      if (d.gone) {
        tally.gone++;
        continue;
      }
      if (!isRental(d)) {
        tally.not_rental++;
        const k = `${d.raw.business_function}/${d.raw.category}`;
        categories[k] = (categories[k] || 0) + 1;
        continue;
      }
      if (!d.area) {
        tally.off_area++;
        continue;
      }
      tally.yielded++;
      yield d;
    }
  } finally {
    ctx.log?.info?.(`[livuma] ${JSON.stringify(tally)} not-rental ${JSON.stringify(categories)}`);
  }
}

async function detail(ctx, url) {
  const res = await ctx.fetchHtml(url, { ttlHours: DETAIL_TTL_HOURS });
  if (!res || res.status === 404 || res.status === 410 || !res.html) return null;
  return detailFrom(res.html, url, ctx.config);
}

const ASSERTED = ['bathrooms', 'land_m2', 'build_m2', 'pool', 'garden', 'kitchen_full', 'aircon', 'workspace', 'living_open'];

export function applyDetail(row, d) {
  if (!d) return row;
  const out = { ...row };
  for (const k of ASSERTED) if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  if (d.min_months != null) out.min_months = d.min_months;
  if (d.lat != null && d.lng != null) {
    out.lat = d.lat;
    out.lng = d.lng;
    out.pin_source = d.pin_source || 'listing_map';
  }
  if (Array.isArray(d.images) && d.images.length) out.images = d.images;
  if (d.gone) out.availability = 'gone';
  return out;
}

export default {
  id: 'livuma',
  name: 'Livuma',
  base: BASE,
  list, detail, applyDetail, detailFrom, parseSitemap, isRental,
};
