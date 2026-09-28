// Tiny helpers shared by the step-7a agency adapters (kibarer, balirealty,
// balicoconutliving). Deliberately small: anything with real judgement in it
// belongs in normalise.js, and nothing here duplicates a rule that lives there.

import { parsePrice, usdRate, DEFAULT_USD_IDR } from '../normalise.js';
import { AREAS, PLACE_WORDS } from '../../areas.js';

/** SPEC §6: stop paging after 10 pages or when a page yields nothing new. */
export const MAX_PAGES = 10;

/** SPEC §6 "Images": max 20 per listing. */
export const MAX_IMAGES = 20;

// The USD rate lives in normalise.js (parseRent converts USD posts too).
export { DEFAULT_USD_IDR, usdRate };

/** Relative href → absolute, or null when the href is empty / unparseable. */
export function absUrl(href, base) {
  if (!href) return null;
  try {
    return new URL(String(href).trim(), base).href;
  } catch {
    return null;
  }
}

/** A cheerio selection (or plain string) → single-spaced trimmed text, or null. */
export function textOf(node) {
  if (node == null) return null;
  const raw = typeof node === 'string' ? node : typeof node.text === 'function' ? node.text() : '';
  const s = String(raw).replace(/\s+/g, ' ').trim();
  return s || null;
}

/** "1.2" / "166 m²" / "3 Are" → a number, or null. Thousands separators survive. */
export function numberIn(text) {
  const m = /(\d[\d.,]*)/.exec(String(text ?? ''));
  if (!m) return null;
  const t = m[1];
  const seps = [...t.matchAll(/[.,]/g)];
  let n;
  if (seps.length === 0) n = Number(t);
  else {
    const last = seps[seps.length - 1].index;
    const tail = t.slice(last + 1);
    n = /^\d{3}$/.test(tail)
      ? Number(t.replace(/[.,]/g, ''))
      : Number(t.slice(0, last).replace(/[.,]/g, '') + '.' + tail);
  }
  return Number.isFinite(n) ? n : null;
}

/** "3 Are" → 300 m². Bali agencies quote land in are (100 m²). */
export function areToM2(text) {
  const n = numberIn(text);
  return n == null ? null : Math.round(n * 100);
}

const CURRENCY_RE = /\b(usd|us\$|\$|aud|eur|sgd|€)\b/i;

/**
 * Money text → `{amount, per, currency, original}` in IDR.
 * Parsing itself is `normalise.parsePrice`; this only adds the currency step,
 * which normalise.js has no opinion about (everything there is already IDR).
 *
 * @param {string} text  e.g. "idr 220,000,000 / Annually", "USD 2,500 per month"
 * @param {object} [config] run config (`usd_idr`)
 * @returns {{amount:number, per:'month'|'year'|null, currency:string, original:number}|null}
 */
export function moneyIdr(text, config = {}) {
  const s = String(text ?? '');
  const parsed = parsePrice(s);
  if (!parsed) return null;

  const cur = CURRENCY_RE.exec(s);
  const token = cur ? cur[1].toLowerCase() : 'idr';
  if (token === 'usd' || token === 'us$' || token === '$') {
    return {
      amount: Math.round(parsed.amount * usdRate(config)),
      per: parsed.per,
      currency: 'USD',
      original: parsed.amount,
    };
  }
  // Anything other than IDR/USD is left unconverted: a wrong rate is worse than
  // no price, and the caller stores `original` in `raw` either way.
  if (token !== 'idr') return null;
  return { amount: parsed.amount, per: parsed.per, currency: 'IDR', original: parsed.amount };
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

/** SPEC §7 place names → canonical area id, banjars included. One table, in areas.js. */
const AREA_WORDS = PLACE_WORDS;

/**
 * First SPEC §7 area named anywhere in `text`, or null.
 * @param {...(string|null|undefined)} parts searched in the order given
 */
export function areaFromText(...parts) {
  for (const part of parts) {
    const s = String(part ?? '');
    if (!s) continue;
    for (const [re, area] of AREA_WORDS) if (re.test(s)) return area;
  }
  return null;
}

/**
 * Broad regions that are not a SPEC §7 area on their own — dropped when working out
 * the sub-area, so "Canggu, Pererenan" has no sub and "Bukit, Uluwatu, Pecatu" has
 * "Pecatu".
 */
// (Canggu stays here even though it is now an area: as a sub-area it only restates
// the region, so "Canggu, Berawa" keeps Berawa and drops the Canggu.)
const BROAD_WORDS = /^(bali|badung|bukit|canggu|tabanan|kuta utara|kec\.?\s*\w+)$/i;

/**
 * The site's own location string minus the words that only restate `area` → the
 * sub-area, or null. `normaliseListing` takes `sub_area` from the caller whenever
 * the caller also states `area`.
 */
export function subAreaFrom(location, area) {
  if (!location || !area || !AREAS[area]) return null;
  // "Uluwatu / Pecatu" is one label naming two words; both only restate the area.
  const own = new Set(
    [area.replace(/_/g, ' '), ...AREAS[area].label.split('/')].map((w) => w.trim().toLowerCase())
  );
  const rest = String(location)
    .split(/[,/|]/)
    .map((t) => t.replace(/[-–—\s]+$/, '').trim())
    .filter(Boolean)
    .filter((t) => !BROAD_WORDS.test(t))
    .filter((t) => !own.has(t.toLowerCase()) && !own.has(t.toLowerCase().replace(/\s+area$/, '')));
  const sub = rest.join(', ').trim();
  return sub || null;
}

/** `both` when a listing quotes monthly and yearly, else whichever it quotes. */
export function termFor(month, year) {
  if (month != null && year != null) return 'both';
  if (year != null) return 'yearly';
  if (month != null) return 'monthly';
  return null;
}

/** SPEC §7: the inland north-Pererenan pockets sit ≈3–5 km from the sea. */
const INLAND_PERERENAN = /tumbak\s*bayuh|\btumbak\b|\bbuduk\b|tiying\s*tutul/i;
const INLAND_PERERENAN_KM = 4;

/**
 * `beach_km_hint` for a caller that states `area` itself (and so bypasses mapArea's
 * own hint). Only the §7 pockets that SPEC gives a distance for return a number.
 */
export function beachHint(area, ...parts) {
  if (area !== 'pererenan') return null;
  return parts.some((p) => INLAND_PERERENAN.test(String(p ?? ''))) ? INLAND_PERERENAN_KM : null;
}

// ---------------------------------------------------------------------------
// Embedded JSON
// ---------------------------------------------------------------------------

const LD_RE = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Every JSON-LD node in `html` whose `@type` matches, flattened over `@graph`
 * and top-level arrays.
 * @param {string} html
 * @param {string|string[]} types e.g. 'Product' or ['Residence','Product']
 */
export function pickJsonLd(html, types) {
  const want = new Set((Array.isArray(types) ? types : [types]).map((t) => String(t).toLowerCase()));
  const out = [];
  const push = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) push(n);
      return;
    }
    if (Array.isArray(node['@graph'])) for (const n of node['@graph']) push(n);
    const t = node['@type'];
    const list = Array.isArray(t) ? t : [t];
    if (list.some((x) => x && want.has(String(x).toLowerCase()))) out.push(node);
    if (node.item) push(node.item);
    if (Array.isArray(node.itemListElement)) for (const n of node.itemListElement) push(n);
  };
  for (const m of String(html || '').matchAll(LD_RE)) {
    try {
      push(JSON.parse(m[1].trim()));
    } catch {
      /* a malformed block is not a reason to lose the good ones */
    }
  }
  return out;
}

/** Next.js `__NEXT_DATA__` payload, or null when the page is not a Next app. */
export function nextData(html) {
  const m = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(String(html || ''));
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return null;
  }
}

export default {
  MAX_PAGES,
  MAX_IMAGES,
  DEFAULT_USD_IDR,
  usdRate,
  absUrl,
  textOf,
  numberIn,
  areToM2,
  moneyIdr,
  areaFromText,
  subAreaFrom,
  beachHint,
  termFor,
  pickJsonLd,
  nextData,
};
