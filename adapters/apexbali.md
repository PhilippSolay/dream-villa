# Apex Property — `apexbali`

`https://apexbali.com` — a Bali agency (long-term rentals, some sales, property
management), strongest on the west coast: Cemagi, Seseh, Pererenan, Canggu. Added
2026-09-28 at Philipp's request; inspected that day with curl (logged out, browser UA).
Fixtures in `test/fixtures/apexbali-*.html`.

## Reachability

* `robots.txt`: `User-agent: * / Allow: /`, disallowing the back office (`/login`,
  `/owner`, `/tenant`, `/admin`, `/dashboard`, `/inbox`, `/leads`, `/reservations`,
  `/tasks`, `/villas`, `/owners`, `/invoicing`, `/activity`, `/settings`, `/hari-ini`,
  `/calendar`, `/owner-chat`, `/owner-drafts`, `/contracts`). `/villas` is a prefix of
  `/villas…` only: `/villa/<slug>` (singular, then a slash) is not under it, and neither is
  `/rentals`. Both are allowed.
* No login, no challenge (Cloudflare serves it, but plainly). **Method: html.** The site is
  **SvelteKit**, server-rendered; every page ships its data in the hydration `<script>`.

## URL scheme

```
/rentals                 # index, 12 cards a page, featured order; "Showing 128 villas"
/rentals?page=N          # page N; a page past the end repeats the last one
/rentals?area=Seseh      # area filter (not used: the whole index is 11 pages)
/villa/<slug>-<ref>      # detail; rentals and sales share the scheme
/sales                   # sale listings (never walked)
/sitemap.xml             # ~181 /villa/ URLs, rentals and sales (not used)
```

`ref` = the villa's `id` from the payload, which is the slug's trailing code upper-cased
(`CM001`, `AP042`, `BVH-9858`). A villa offered for rent and for sale has two slugs
(`rent--…-ir001`, `sale--…-ir001`) but one id.

## `list()` — the `/rentals` walk

1. `/rentals`, then `?page=2…` (24 h cache), until the payload's `totalPages`, a page
   that adds no new ref (page 12 of 11 repeats page 11) or `MAX_PAGES = 30` (safety).
2. Each page's hydration script holds `villas:[…]` — the full record behind each card —
   plus `total`, `page`, `totalPages`, `areas`, `areaCounts`. The record is a
   `devalue.uneval` object literal (bare keys, `void 0`), read by `literalToJson` +
   `JSON.parse`; nothing is `eval`ed.
3. A card is yielded when it resolves to a §7 area and is not gone, or is gone but we
   already track a live `apexbali:<ref>` row (so that row goes gone the same morning).
   Untracked gone villas are skipped, as in `umadibali`.
4. Cards render but the payload is missing → **throws**, so the run counts the source as
   errored and never marks its rows `unlisted` on a bad day.

The index only lists `purpose: "rental"` records; anything else is dropped anyway. The
agency's back office leaks a test record (`TESTSAMI`, 5 M/month): refs starting `TEST`
are skipped.

## The villa record

| field | payload key | notes |
|---|---|---|
| ref | `id` | upper-cased |
| url | `slug` | `https://apexbali.com/villa/<slug>` |
| title | `name` | minus the trailing ` - <REF>` / ` \| <REF>` |
| location | `area` | the site's own tag (17 values on 2026-09-28, below) |
| bedrooms / bathrooms | `bedrooms` / `bathrooms` | |
| price_month_idr | `priceMonthlyIdr` | IDR integer; `0` = not quoted |
| price_year_idr | `priceYearlyIdr` | dropped when under 6 × the monthly rent: LI007 and AL005 carry the monthly figure as the yearly one |
| six-month price | `priceSixMonthIdr` | kept in `raw` only |
| land / build | `landSize` / `buildingSize` (else `livingArea`) | `"175 m²"`, mostly null |
| furnished | `furniture`, else the title | "Unfurnished" → 0 |
| amenities | `amenities[]` | chips → `pool`, `garden`, `aircon`, `kitchen_full`, `workspace` = 1; absent says nothing |
| pin | `lat`, `lng` | per villa; `pin_source: 'listing_map'` |
| photos | `photos[]` | `/villa-photos/<REF>/<n>.webp`; the index record carries 1, the detail record all (max 20) |
| status | `status`, `statusLabel`, `availabilityEndDate`, `unitsTotal`, `unitsFree` | see below |

Prices are always read from the payload in IDR. The page's IDR/USD toggle is client-side
(`idrPerUsd` in the payload) and never touches those fields.

## Area

The `area` tag first, via `areaFromText`: Seseh, Cemagi, Canggu, Pererenan, Umalas,
Tibubeneng, Kedungu, Munggu, Nyanyi map directly; Tumbak Bayuh and Buduk → `pererenan`,
Tabanan → `tanah_lot` (as for every adapter). `sub_area` is the tag when it only
restates a pocket (Beraban, Tumbak Bayuh).

Otherwise the title, with proximity phrases removed (livuma's `stripProximity`, plus
"between Canggu and Umalas" and "Minutes from Canggu"). The tag **Mengwi** is the
postcode district that holds Pererenan, Seseh and Cemagi, so a village named in the title
beats it; a Mengwi villa whose title names nothing stays `mengwi`.

Not §7, so off-target unless the title places them: **Kerobokan** (AL002, AL003 —
"between Canggu and Umalas"), **Bengkel** (AP003, AC001), **Kuta Utara** (AP019). The
Beraban villas are in gated Nyanyi and resolve to `nyanyi` from the title.

## Availability

`status` is `available` or `rented`; a rented record has `availabilityEndDate` (the last
rented day — the site prints "Available from" the day after) unless all its units are
taken with no date. Same rule as `umadibali` (`UPCOMING_MONTHS = 3`, imported from it):

1. **Available** → live (a future end date, if any, becomes `available_from`).
2. **Rented, free again this month or within the next three** → live, `available_from` =
   end + 1 day, `availability = 'from:<date>'`. Not gone. (A date already reached is just
   available.)
3. **Rented with no date** ("All 2 units taken") **or further out** (leases run to 2044)
   → gone.

On 2026-09-28: 58 available, 70 rented.

## Detail page

`/villa/<slug>` carries `villa:{…}` (the same record, all photos, the full description)
and `availability:{status, blocked:[{start,end,reason}], availableFrom}` in its payload.
`detailFrom` reads the record through the same `partialFrom` as the index.

Fallback when the payload cannot be read: the JSON-LD `Accommodation` (`name`, `url`,
`description`, `image[]` — first 8 only, `numberOfBedrooms`, `numberOfBathroomsTotal`,
`address.addressLocality`, `geo`, `offers` with a monthly `UnitPriceSpecification` and
`OutOfStock` when rented) plus the visible "Rented until Dec 14, 2026" and
"IDR 56 M /mo". `raw.from` says which was used.

Contact: the agency's general line `+62 823-4219-4697` (`wa.me/6282342194697`,
`tel:`), `role: 'agency'`. No per-villa agent.

404 for an unknown slug → `detail()` returns null; the recheck marks it delisted.

## Politeness

`ctx.fetchHtml`: 1 req/s per host, browser UA, 429/403 back-off. Index pages 24 h;
detail pages 7 days (`DETAIL_TTL_HOURS`), refreshed on the listing's own weekday and
busted by `detailPlan` when the card's price, status, bedrooms or title change. A daily
run is 11 index requests plus the new and due detail pages.
