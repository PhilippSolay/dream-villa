# Bali Realty — `balirealty`

`https://www.balirealty.com` — inspected 2026-09-18 with curl (logged out, browser UA).
Fixtures in `test/fixtures/balirealty-index.html` / `balirealty-detail.html`.

## Reachability

* `robots.txt`: Yoast block, `User-agent: * / Disallow:` — nothing disallowed.
  Sitemap `https://www.balirealty.com/sitemap_index.xml`.
* WordPress + the **Realia** property theme, fully server-rendered. No login, no JS
  needed. **Method: html.** A `/wp-json/` root exists but the `property` CPT is not
  exposed there; the themed HTML is the documented path and is what the adapter uses.

## URL scheme

```
/properties/?filter-contract=RENT&filter-property-type=75             # page 1
/properties/page/N/?filter-contract=RENT&filter-property-type=75      # 12 cards a page
/properties/<slug>-<ref>/                                             # detail
```

`filter-property-type=75` is Villa; `filter-contract=RENT` is the long-term rental
contract (sales are `SALE`). 6 pages of rentals on 2026-09-18 (~72 listings).
`MAX_PAGES = 20` (own constant since 2026-09-26, was the shared 10) is a safety stop;
the walk ends on the theme's own markers (no link to page N+1, or page 1 served again). `<ref>` is the trailing number in the slug and equals the
"Reference" the detail page prints.

There is also a `filter-location=<term-id>` select (Seseh 201, Cemagi 158, Munggu 199,
Pererenan 156, Mengwi 198, Nyanyi 188, Tanah Lot 108, Tabanan 107, Bingin 207,
Balangan 149, Pecatu 161, Uluwatu 151, Ungasan 125, Pandawa 202, Kutuh 170,
Melasti 228, Buduk 237, Beraban 163). The adapter does **not** use it: the whole rental
list is only 6 pages, so one unfiltered walk plus an area test on the card is cheaper
than 18 filtered walks, and it survives the ids being renumbered.

### Coverage audit — 2026-09-26

The whole rental list (`filter-contract=RENT`, with or without the villa type) is
6 pages, **70 villas**; the adapter reads all of it in **6 requests a day**. 48 resolve
to a §7 area from the card title: canggu 12, berawa 10, pererenan 8, umalas 6, cemagi 3,
tanah_lot 2, padonan 2, babakan 2, seseh 1, ungasan 1, balangan 1. Of the 22 dropped,
20 are Seminyak / Petitenget / Jimbaran / Nusa Dua / Renon — correctly out of area — and
two were target villas whose title named only a banjar or a beach: *"…in Semat…"*
(Tibubeneng) and *"…Near Lima Beach"* (the detail page's taxonomy says Pererenan).
Both words are now in `PLACE_WORDS` (`src/areas.js`), so both are read — **50 in area**.
The per-location filter is still not needed: one walk already sees every rental.

## Index card

Root `div.property-container`.

| field | selector |
|---|---|
| url + title | `.property-text h3 a` — the card title has `" – <ref>"` appended, stripped |
| blurb | first `div` in `.property-text` |
| price | `.property-currency-box[data-base-currency][data-base-amount]` (e.g. `IDR` / `365000000`); the visible `.property-box-price` is the same number formatted |
| bed/bath/parking | `.property-attributes .col-xs-3` → `h4` value, `p[title]` label |
| badge | `.arrow-ribbon .property-badge` → `Rent` |
| thumb | `img[data-src]` (lazyloaded; `src` is a base64 placeholder) |
| area | the card has no location field — `_shared.areaFromText` reads it from the title and blurb ("…in Pererenan", "…in Tumbak Bayuh") and the partial states `area` outright |
| pagination | `a[href*="/page/N/"]` |

### The card has no period — the 150 M boundary

`data-base-amount` is a bare number. A card must still decide monthly vs yearly for the
SPEC §2 band check, which runs before `detail()` is fetched. Rule, in order:

1. the title or blurb says `yearly` / `annual` / `per year` / `tahun` → yearly;
2. it says `monthly` / `per month` / `bulan` → monthly;
3. otherwise **≥ 150 000 000 IDR = yearly, below = monthly**.

That threshold is a boundary rather than a guess: the band is 15–80 M/month, i.e.
180–960 M/year, so no in-band listing can be misread either way. The detail page states
the period in full (`IDR 365,000,000/year`) and overwrites both columns.

Amounts seen on the two rental index pages: 225 M–750 M (yearly) and one 35 M (monthly).

## Detail page

| field | selector |
|---|---|
| title | `meta[property="og:title"]` — the theme comments its own `<h1>` out; `" – <ref>"` and `" - BALI REALTY"` stripped |
| price | `.property-pricing` → `IDR 365,000,000/year` (period stated) |
| overview | `.property-overview li` → `span` label / `strong` value: Price, Reference, Contact name, Contact phone, Type, Sold, Contract, Status, Location, Land Size, Bedrooms, Bathrooms, Parking |
| bed/bath | `.property-main-features li` → `.feature-names` label + `span` value |
| facilities | `.property-amenities li` — **every** facility is rendered; the ones this villa does *not* have carry `class="no"`, so only `li:not(.no)` is kept |
| description | `.property-description` (headings removed) |
| gallery | `.property-gallery img[data-src]` (9 on the fixture) |
| area | `<body class="… locations-pererenan …">` — the taxonomy term, the most reliable location source on the page; mapped to a canonical SPEC §7 key and set as `area` on the partial (`normaliseListing` honours it) |
| WhatsApp | `a[href*="wa.me/"]` → the assigned agent's number (`+6281908196990`, "Vherina") |
| availability | overview `Sold` (Yes/No) and `Status` (Available / Rented / Sold) |

### No map pin

`#simple-map` renders with `data-latitude=""` / `data-longitude=""` on every page
checked, so `detail()` returns `lat: null` and pins fall through to geocode/centroid.

## Currency

Rental prices are IDR (`data-base-currency="IDR"`). Sale cards in the same theme use
`AUD`/`USD`. `_shared.moneyIdr` converts USD at `config.usd_idr` (default 16 000) and
records `price_currency` / `price_original` in `raw`; any other currency yields no price
rather than a wrong one.

## Politeness

`ctx.fetchHtml` gives 1 req/s per host, 24 h HTML cache, browser UA, 429/403 back-off.
Detail pages of listings already stored are cached for 7 days (shared rule,
`src/scrape/ingest.js` `detailPlan`): refreshed on each listing's own weekday, refetched
the same day when the card's price, bedrooms or title moves, new refs fetched at once.
The overview's Status (Rented/Sold) is only on the detail page, so on a cached day it can
surface up to a week late.
