# Adapter notes — Bali Home Immo (bhi)

Proven on 2026-09-17 from a logged-out browser. Pages are server-rendered (cards are in the HTML), ~0.8–1.2 MB each because of a giant nav menu. Same-origin `fetch()` of index pages worked without any headers; from Node use a normal browser UA and 1 req/s.

## URL scheme

- Index: `https://bali-home-immo.com/realestate-property/for-rent/villa/{monthly|yearly}/{area}?page={n}` — `page` starts at 1 (omit), stop when a page yields 0 cards. Page 2 of `monthly/seseh` had 3 cards (26 total), so most areas are 1–3 pages.
  *Coverage audit 2026-09-26:* the index payload carries `pagination.last_page` (30 cards a page) and the walk stops there. Page counts that day, monthly / yearly: `seseh` 1/2, `pererenan` 4/4, `tanah-lot-area` 1/2, `canggu` 7/**10** (209/277 villas), `berawa` 4/5, `umalas` 3/4, `ubud` 2/3, `uluwatu` 3/3, `ungasan` 4/3, `pandawa` 2/2, `other-bali-area` 1/1 — 71 index requests a day, 1 004 cards, 1 001 in a §7 area (763 in the band). `yearly/canggu` sat exactly on the old `MAX_PAGES = 10`, one listing from silently losing its tail; the cap is now 40 (a safety stop only, with a `warn` if it is ever reached). Every §7 area is reachable: the slugs above cover all of them (`appData.areas` has no slug for Mengwi, Buwit, Kedungu, Nyanyi, Munggu, Bingin, Balangan or Padang Padang — those come through `seseh`/`tanah-lot-area`/`uluwatu` sub-areas or `other-bali-area` titles). `kerobokan`, `seminyak`, `petitenget-batu-belig`, `jimbaran`, `nusa-dua` and the rest are deliberately not walked.
- Areas that matter (slugs): `seseh` (= Cemagi & Seseh; sub-areas `seseh_cemagi-beach-side`, `seseh_seseh-residential-side`), `pererenan` (`pererenan_pererenan-beachside`, `pererenan_north-pererenan`), `tanah-lot-area` (`tanah-lot-area_seseh`, `_west-tanah-lot`, `_north-tanah-lot`), `uluwatu` (`uluwatu_west`, `_central`, `_east`, `uluwatu_bingin-beach-side`, `uluwatu_bingin-residential-side`, `uluwatu_balangan-beach-side`, `uluwatu_balangan-residential-side`, `uluwatu_padang-padang1`, `uluwatu_nyang-nyang1`), `ungasan` (`ungasan_east-2`, `_west-2`, `ungasan_melasti1`), `pandawa` (`pandawa_west-1`, `_east-1`, `pandawa_kutuh1`), `canggu` (sub-areas `canggu_batu-bolong-echo-beach`, `canggu_berawa`, `canggu_north-canggu`), `berawa`, `umalas` — the Canggu belt, added 2026-09-22 — and `ubud` for Center; Babakan, Padonan and Tibubeneng have no slug of their own and are read from the sub-area or the title. `other-bali-area` (catch-all; filter by title for Buwit/Mengwi/Kaba-Kaba/Nyanyi/Kedungu).
- Detail: `.../for-rent/villa/{monthly|yearly}/{area}/{slug}-rf{number}{letter?}` — the ref is the last path segment suffix, e.g. `-rf9183d`. Refs are case-insensitive; store upper-case `RF9183D`. Units in the same complex share a number and differ by letter (RF9183A/B/C/E).
- Thumbnails: `https://bali-home-immo.com/images/properties/thumb/<file>`; full-size (expected) `https://bali-home-immo.com/images/properties/<file>` — verify on a detail page.
- Site-wide WhatsApp: `+62 821 9435 9401` (agency line, appears in nav). Per-listing agent may differ — check the detail page.

## Card structure (index page)

Each card is a `div.group.relative.flex.flex-col…` containing one `<a href="…-rfNNNN">`. Card text (whitespace-collapsed) looks like:

```
[Newly Listed][leasehold|freehold][yearly][monthly][free-text note]TITLE LOCATION - SUB- RFNNNN Bedroom: N [dd/mm/yyyy ]IDR 40.000.000/month
```

Examples:
- `leaseholdmonthlyModern 2 bedroom villa for sale and rental in Cemagi BaliCemagi / Seseh - Beach Side- RF10679Bedroom: 2IDR 40.000.000/month`
- `yearlymonthlyWalking distance to the beach and ocean view from rooftop | Minimum 2 months rental | Monthly installment payment available for yearly rentalModern 3 Bedroom Villa for Rental in Bali Cemagi BeachsideCemagi / Seseh - Beach Side- RF9183EBedroom: 3IDR 50.000.000/month`
- `Newly Listedyearlymonthly2 Bedroom Modern Villa For Rent in Cemagi BeachsideCemagi / Seseh - Beach Side- RF7025BBedroom: 215/12/2026 IDR 62.500.000/month`

Notes:
- The date after `Bedroom: N` is the **available-from** date (dd/mm/yyyy). Beware `Bedroom: 215/12/2026` — bedrooms is one digit.
- Price is always shown per month on these pages even in the `yearly` category; whether a yearly lease exists is the `yearly` tag. Cards listed only under `yearly/…` and not `monthly/…` are yearly-only.
- Tags: `leasehold`/`freehold` mean the villa is also for sale (ignore for rent, but note: a for-sale villa may be sold from under a tenant).
- The free-text note often carries the best facts: "Walk to the beach (350m)", "Minimum 6 months rent", "Pet friendly", "Open for sublease", "2 units available", "All services and utilities included in price", "Price is negotiable".
- Title from the URL slug (strip `-rfNNNN`, hyphens → spaces) matches the card title case-insensitively; use it to split the note (before) from the location (after).

## Extractor (worked in-page; port to cheerio)

```js
// Walk up from each ref link to the smallest ancestor that has price+bedrooms AND exactly one ref link
function extractCards(doc, origin) {
  const seen = new Map();
  for (const a of doc.querySelectorAll('a[href*="/realestate-property/for-rent/"]')) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/-(rf\d+[a-z]?)$/i); if (!m) continue;
    let el = a;
    for (let i = 0; i < 8 && el; i++) {
      const t = el.textContent || '';
      const refLinks = el.querySelectorAll('a[href*="-rf"]').length;
      if (/IDR/.test(t) && /Bedroom/i.test(t)) { if (refLinks <= 1) break; else { el = null; break; } }
      el = el.parentElement;
    }
    if (!el) continue;                                   // ancestor contained several cards — skip, fixes the RF10336 concat bug
    const text = (el.textContent || '').replace(/\s+/g, ' ').replace(/SEE MORE IMAGES IN DETAIL PAGE|Previous slide|Next slide/g, '').trim();
    const ref = m[1].toUpperCase();
    if (seen.has(ref)) continue;
    const img = el.querySelector('img'); 
    seen.set(ref, { ref, url: new URL(href, origin).href, text, thumb: img && (img.getAttribute('src') || img.getAttribute('data-src')) });
  }
  return [...seen.values()];
}

function parseCard(c) {
  const slug = c.url.split('/').pop().replace(new RegExp('-' + c.ref.toLowerCase() + '$'), '');
  const title = slug.replace(/-/g, ' ');
  const tagm = c.text.match(/^((?:Newly Listed|leasehold|freehold|yearly|monthly)+)/i);
  const tags = (tagm ? tagm[1] : '').toLowerCase();
  const rest = c.text.slice(tagm ? tagm[1].length : 0);
  const li = rest.toLowerCase().indexOf(title.toLowerCase());
  const refIdx = rest.indexOf(c.ref);
  const note = li >= 0 ? rest.slice(0, li).trim() : '';
  const location = (li >= 0 ? rest.slice(li + title.length, refIdx) : rest.slice(0, refIdx)).replace(/^\s*|-\s*$/g, '').trim();
  const bedrooms = Number((c.text.match(/Bedroom: (\d)/) || [])[1]) || null;
  const available = (c.text.match(/Bedroom: \d(\d{2}\/\d{2}\/\d{4})/) || [])[1] || null;   // dd/mm/yyyy
  const pm = c.text.match(/IDR ([\d.]+)\/(month|year)/);
  const price = pm ? Number(pm[1].replace(/\./g, '')) : null;
  return { ref: c.ref, url: c.url, title, location, note, bedrooms, available, price_month_idr: pm && pm[2] === 'month' ? price : null,
           price_year_idr: pm && pm[2] === 'year' ? price : null,
           term: /yearly/.test(tags) && /monthly/.test(tags) ? 'both' : /yearly/.test(tags) ? 'yearly' : 'monthly',
           for_sale: /leasehold|freehold/.test(tags), newly_listed: /newly listed/.test(tags), thumb: c.thumb };
}
```

## Detail page — inspected 2026-09-17 (curl, logged out, browser UA)

The site is an **Inertia.js** app: the detail page is server-rendered with the whole listing as JSON in
`<div id="app" data-page="…">` (HTML-escaped: `&quot;` → `"`, `&amp;` → `&`, `&#039;` → `'`). Parse
`JSON.parse(unescape(attr))`, then `props.property` is the record. No Google Maps iframe, no listing JSON-LD
(only `RealEstateAgent` + `WebSite`), so **read the JSON, do not scrape the HTML**. Page ~820 KB.

`props.property` fields (RF9183D):

| field | example | use |
|---|---|---|
| `property_id` | `RF9183D` | ref |
| `name` | `Modern 3 Bedroom Villa for Rental in Bali Cemagi Beachside` | title |
| `label` | `Walking distance to the beach and ocean view from rooftop \| Minimum 2 months rental \| …` | the card note |
| `description` | HTML `<p>…</p>` | description (strip tags, keep paragraphs) |
| `is_archived` | `true` | **recheck signal** → `availability='gone'` when true (RF9183D is archived yet still served; it is absent from the index sweep) |
| `images` | array of 20 full-size URLs `https://bali-home-immo.com/images/properties/<file>.jpg` | gallery, hero = first |
| `area`, `subArea` | `Cemagi / Seseh`, `Beach Side` | location → §7 map (join with ` - ` to get the index string) |
| `latitude`, `longitude` | `-8.6435654`, `115.1078041` (strings) | pin, `pin_source='listing_map'` |
| `price` | `44000000.0000` (string) | price for `props.propertyPriceCategory` (`monthly`\|`yearly`) |
| `available_categories` | `[{label:'yearly', price:'450000000.0000'}, {label:'monthly', price:'44000000.0000'}]` | both prices + term |
| `bedroom`, `land_size`, `building_size`, `furniture` | `3`, `100 m²`, `158 m²`, `Furnished` | facts |
| `availability` | `01/02/2027` (dd/mm/yyyy) | available_from |
| `zoning`, `leaseholdPeriod`, `is_price_on_request`, `video_id` | | store in raw |
| `grouped_attributes.generalInfo[]` | `{label, value, type}`: Land Size, Building Size, Year of Build, Floor Level, View (`Pool`\|`Ocean`\|`Rice field`…), Style / Design (`Modern`…), Surrounding, Zoning | view, style, land/build |
| `grouped_attributes.indoor[]` | Living room (`Enclosed`\|`Open`…), Dinning room, Kitchen (`Enclosed`…), Bedroom, Bathroom, Ensuite Bathroom | `living_open` = Living room !== Enclosed; `kitchen_full` = Kitchen present; bathrooms |
| `grouped_attributes.outdoor[]` | Swimming Pool (`Yes`), Pool Size, Balcony, Shower, Garden (when present) | pool, garden |
| `grouped_attributes.facilities[]` | Furniture, Electricty power (watt), Air Conditioner (count), Water Source, Internet, Parking, Parking size | aircon = count > 0, furnished |
| `monthlyCosts.items[]` / `yearlyCosts.items[]` | `{label, value}`: Monthly cost included (`Yes full`), Banjar fee + Security, Cleaning Service, Pool Maintenance, Garden Maintenance, Bin Collection, Electricity, Unlimited Internet (`Included`\|`Not included`…); `remark` | `inclusions` (JSON) |
| `quick_stats[]` | Bedroom, Bathroom, Swimming Pool | cross-check |

Also on the page: `props.meta.wa_phone_number = 6282194359401` (agency line), `wa.me/6282194359401?text=…RF9183D…`
prefilled links, a second sales line `+62 853 3774 3862` (Uluwatu office). **No per-listing agent name** on this
page — contact = agency. `props.appData.areas` gives the canonical area/sub-area slugs for URL building:
`seseh [cemagi-beach-side, seseh-residential-side]`, `pererenan [pererenan-beachside, north-pererenan]`,
`tanah-lot-area [seseh, west-tanah-lot, north-tanah-lot]`, `uluwatu [west, central, east, bingin-beach-side,
bingin-residential-side, balangan-beach-side, balangan-residential-side, padang-padang1, nyang-nyang1]`,
`ungasan [east-2, west-2, melasti1]`, `pandawa [west-1, east-1, kutuh1]`, `other-bali-area []`.

Index pages are the same Inertia shape — check `data-page` there too before falling back to the card-text
extractor above (which stays the proven fallback).

The three seed URLs to test with:
- https://bali-home-immo.com/realestate-property/for-rent/villa/monthly/seseh/modern-3-bedroom-villa-for-rental-in-bali-cemagi-beachside-rf9183d
- https://bali-home-immo.com/realestate-property/for-rent/villa/monthly/seseh/ricefield-view-2-bedroom-villa-for-rent-in-cemagi-beachside-rf11014
- https://bali-home-immo.com/realestate-property/for-rent/villa/monthly/pererenan/2-bedroom-villa-for-yearly-rental-in-pererenan-rf126

Known from the sweep: RF11014 is 2BR, 40 M/mo, Cemagi beach side, ricefield view, leasehold (also for sale). RF9183D's siblings A/B/E are 3BR at 44–50 M/mo, "walking distance to the beach and ocean view from rooftop, minimum 2 months, monthly instalments available for yearly". RF126 is 2BR, 50 M/mo, Pererenan beach side, "~5 mins to Pererenan Beach, minimum 6 months".
