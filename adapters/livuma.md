# Livuma — `livuma`

`https://livuma.com` — a Bali listing portal (owners and agents post directly; long-term
rentals, short stays, kost rooms, sales, land). Inspected 2026-09-24 with curl (logged
out, browser UA). Fixtures in `test/fixtures/livuma-*.html` and `livuma-sitemap.xml`.

## Reachability

* `robots.txt`: `User-agent: * / Allow: /`, disallowing `/api/` (except `/api/public/`),
  `/_blazor`, `/_framework`, `/account`, `/chat`, `/favorites`. Listing pages
  `/s/<id>/<slug>` and `sitemap.xml` are allowed.
* No login, no challenge. **Method: html.** The site is **Blazor Server**, but every page
  is prerendered, so a plain GET carries the full listing and its JSON-LD.

> **No paged index.** `/homes` and the area landing pages (`/long-term-rentals/<area>`,
> `/villa-rentals/<area>`) server-render only the first 24 cards (a `RealEstateListing`
> `ItemList`); "Load More" goes over the `_blazor` SignalR channel, which robots.txt
> disallows. The adapter never uses it. The landing pages are also not a usable
> pre-filter: 24 cards is a fraction of each area, and their 16 areas (canggu, seminyak,
> ubud, uluwatu, berawa, pererenan, seseh, cemagi, sanur, kuta, nusa-dua, jimbaran,
> denpasar, legian, bedugul, tabanan) are coarser than §7.

## URL scheme

```
/sitemap.xml                       # ~970 listings: <loc>/s/<id>/<slug></loc> + <lastmod>
/s/<numeric id>/<slug>             # detail; the id alone identifies it (any slug resolves)
/long-term-rentals/<area>          # landing, 24 cards (not used)
/kost/<area>, /properties-for-sale/<area>, /land-for-sale/<area>, …
```

Ids are sequential (newest ≈ 3966 on 2026-09-24). `ref` = the numeric id.

## `list()` — the sitemap walk

1. `sitemap.xml` (24 h cache) → every `/s/<id>/<slug>` with its `<lastmod>`, newest id
   first (so `--limit=N` sees the newest listings).
2. Slugs that plainly say sale or plot (`for-sale`, `land`, `leasehold`, `freehold`,
   `dijual`, `tanah` …) and do **not** also say `rent`/`rental`/`monthly`/`yearly`/`sewa`
   are skipped without a request (≈ 180 of 970).
3. Every other detail page is fetched with a **7-day cache** (`DETAIL_TTL_HOURS`). A
   cached page is refetched early when the sitemap's `lastmod` is on or after the day
   it was cached. First run ≈ 790 requests at 1 req/s (≈ 15 min); after that a daily
   run fetches only new, edited and week-old pages.
4. Yielded only when `businessFunction` is `LeaseOut`, the category is a whole home
   (villa / house / apartment / loft / townhouse / bungalow …, never Room, Building
   Land, Commercial, or anything under a `/kost/` breadcrumb), the page is not
   paused/out of stock, and the listing resolves to a §7 area.

`list()` yields the full detail payload (it already had to read the page to filter);
`ingestListing`'s own `detail()` call then hits the cache.

A missing or empty sitemap **throws**, so the run counts livuma as errored and never
marks its rows `unlisted` on a bad day. One failed detail page is logged and skipped.
`list()` logs a one-line tally at the end (`listed`, `sale_slug`, `fetched`, `gone`,
`not_rental`, `off_area`, `yielded`, `errors`, and the non-rental categories seen).

## Detail page

Two JSON-LD blocks: `RealEstateListing` and `BreadcrumbList`.

| field | source |
|---|---|
| ref | `/s/<id>/` from JSON-LD `url` (else the requested URL) |
| title | `name` |
| description | `.description-section .rich-text-content` (`<br>` → newline). The JSON-LD `description` is truncated with `…` and is only the fallback |
| rental vs sale | `businessFunction` `https://schema.org/LeaseOut` vs `…/Sell`; the page's `Offer` row says "For Rent" / "For Sale (Freehold / Leasehold)" |
| category | `category` (Villa, House, Apartment, Room, Building Land, …) |
| bedrooms / bathrooms | `numberOfRooms` / `numberOfBathroomsTotal` (else `.info-row` Bedrooms / Bathrooms) |
| build_m2 | `floorSize` (`unitCode MTK`), else `.info-row` "Square Meters" |
| land_m2 | `additionalProperty` "Land Size" / `.info-row` "Size" (`5 are` → 500) — usually absent on rentals |
| prices | `offers[]`: `price` (string, `"22000000.00"`), `priceCurrency`, `leaseLength {value, unitText}`. `1 month` → `price_month_idr`, `1 year` → `price_year_idr`; other lengths ignored. `term` = `termFor()` |
| min_months | `.info-row` "Minimum Stay" (`12 months`) |
| amenities | `.amenity-tag` chips: on → 1, `amenity-tag--off` (struck through) → 0. Pool → `pool`, Garden → `garden`, Air Conditioning → `aircon`, Equipped Kitchen → `kitchen_full`, Dedicated Workspace → `workspace`. JSON-LD `amenityFeature` lists only the "on" ones, so the chips are read instead |
| living_open | `additionalProperty` Architectural Style "Open-Plan Layout" / Outdoor Features "Open-Air Living" |
| images | every `cdn.livuma.com/cdn-cgi/image/width=1280,…/prod/uploads/listings/<uuid>/…` on the page whose `<uuid>` folder matches JSON-LD `image[0]` (the page also shows similar listings' photos), page order, max 20. JSON-LD `image[]` holds only the first 8 |
| pin | `geo {latitude, longitude}` → `pin_source: 'listing_map'` |
| area hints | BreadcrumbList position 2: "Long-Term Rentals in Seseh" → `/long-term-rentals/seseh` (or the bare "Long-Term Rentals" when the host picked no area); `address.addressLocality` "80351, Mengwi" |
| listed | `datePosted` / `dateModified` (kept in `raw`) |
| host | `.host-card .host-name` + `/user/<handle>` (kept in `raw`). No phone or WhatsApp on the page — contact is Livuma chat only |

Everything else (`additionalProperty`: Views, Interior Style, Atmosphere, Highlights,
Nearby Places …; the full chip map; the original offers) is kept in `raw`, **not** fed
into the text normalise reads: hosts tick "Balinese Traditional" as one of five interior
styles, which would otherwise raise the `balinese_old` flag on modern villas.

## Area

In order, first hit wins (`areaFor`):

1. **title**, after removing proximity boasts ("5 min to Canggu", "near Seseh") — the
   most specific: "BALANGAN-ULUWATU" is Balangan, "TUMBAKBAYUH" is Pererenan.
2. **breadcrumb** area page ("… in Seseh").
3. **pin** within 2 km of a §7 centroid.
4. **address** locality — but never `mengwi`: postcode 80351 "Mengwi" is the district
   holding Pererenan, Seseh, Cemagi and Munggu, not the inland town §7 means.

Livuma areas with no §7 counterpart — Seminyak, Sanur, Kuta, Legian, Nusa Dua,
Jimbaran, Denpasar, Bedugul, Padang Bai — resolve to nothing and are not yielded.
"Tabanan" maps to `tanah_lot` via `PLACE_WORDS` (as for every adapter); "Canggu" stays
`canggu` unless the title names a Canggu-belt village.

## Availability

* Offers present but none `https://schema.org/InStock` → `gone`.
* A **paused** listing is served **200** with no JSON-LD and "This stay is currently
  unavailable / The host has temporarily paused this listing" → `detailFrom` returns
  `{ref, gone: true}`, which the recheck turns into `availability = 'gone'`.
* 404/410 → `detail()` returns null; the recheck marks it delisted.
* A delisted listing also simply drops out of the sitemap; that is only ever an
  `unlisted` note after 3 days (SPEC §6), never `gone`.

## Currency

Mostly IDR. USD converts at `config.usd_idr` (default 16 000), **EUR at `config.eur_idr`
(default 18 500, `DEFAULT_EUR_IDR`)** — some hosts price in euro (e.g. `/s/3155`,
€40 150/year). Any other currency leaves the price null. The original amount and
currency always travel in `raw.offers`.

## Politeness

`ctx.fetchHtml`: 1 req/s per host, browser UA, 429/403 back-off, 24 h cache for the
sitemap and 7 days for detail pages (busted by `lastmod`). `_blazor`, `/api/`, and the
landing pages' "Load More" are never requested.
