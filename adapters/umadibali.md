# Uma di Bali Properties — `umadibali`

`https://umadibali.com` — inspected 2026-09-26 with curl (logged out, browser UA, ≥ 1 s
between requests). Added at Philipp's request ("Add this channel to the harvester").
Fixtures in `test/fixtures/umadibali-index.html` (yearly, Umalas, page 1 of 34),
`umadibali-index-monthly.html` (monthly, Umalas, page 1 of 2), `umadibali-detail.html`
(VB 016, available) and `umadibali-detail-avail.html` (IP 874, "Avail Oct 30, 2026").

## Reachability

* `robots.txt`:
  ```
  User-agent: *
  Disallow: /wp-admin/
  Disallow: /wp-includes/
  ```
  `/search/` and `/villa/…` are allowed.
* WordPress 4.9, no login, no challenge, no JS needed. **Method: html.** Index and
  detail pages are server-rendered; the only JS is the gallery carousel and the
  paginator buttons (which just rewrite `paging=`).
* Slow-ish: 3–5 s per page whatever its size (a zero-result page takes 3.7 s), so fewer,
  larger pages are kinder than many small ones.

## URL scheme

```
/search/?type=<yearly_rental|monthly_rental>&loc%5B%5D=<slug>&curr=idr&paging=N&ppp=48&sort-by=latest&view=grid
/villa/<slug>/          # detail (villas)
/house/<slug>/          # detail (houses — "Bali House For Rent")
```

* `type`: `monthly_rental`, `yearly_rental`, `villa` (sales), `house` (+ `house-cat=rent|sale`),
  `land`. Only the two rental types are walked. Houses for rent (`house-cat=rent`, which the
  form calls "Rent yearly") show up in `yearly_rental` too (IP 471 Rumah Pilo Umalas and
  CEF 807 Rumah Janica Berawa checked), so they need no walk of their own.
* `loc[]` is the location filter and works from the URL. The adapter walks one location at
  a time, so each card knows which of the site's locations it was listed under.
* `ppp` is free (the "Per page" box); the site's default is 12. `ppp=48` keeps the largest
  location (Umalas, 399 yearly cards) inside `MAX_PAGES = 10` and costs a quarter of the
  requests. `ppp=100` works but takes ~18 s.
* Pagination: `Page 1 of N` (and `data-page` buttons); `lastPageOf` reads N.

### Locations walked (`LOCATIONS`)

The search form's location tree, filtered to what maps to a SPEC §7 area, villages first
so a villa tagged in two places is first met in the more specific one. Counts are yearly /
monthly results on 2026-09-26 (rented listings included).

| slug | label → area | yearly / monthly |
|---|---|---|
| `tanah-lot` | Tanah Lot → tanah_lot | 5 / 1 |
| `kaba-kaba` | Kaba-Kaba → tanah_lot | 0 / 3 |
| `cepaka` | Cepaka → tanah_lot | 3 / 0 |
| `munggu` | Munggu → munggu (parent: includes `munggu-munggu`, `cepaka-munggu`) | 15 / 1 |
| `cemagi`, `cemagi-other-area` | Cemagi → cemagi | 6+2 / 0+1 |
| `seseh`, `seseh-other-area` | Seseh → seseh | 7+2 / 0+1 |
| `nyanyi` | Nyanyi → nyanyi | 1 / 0 |
| `buduk` | Buduk → pererenan (sub-area Buduk, beach ≈ 4 km) | 1 / 0 |
| `pererenan` | Pererenan → pererenan | 147 / 12 |
| `padonan` | Padonan → padonan | 15 / 1 |
| `babakan` | Babakan → babakan | 1 / 0 |
| `echo-beach` | Echo Beach → canggu | 2 / 0 |
| `berawa` | Berawa → berawa | 265 / 18 |
| `umalas` | Umalas → umalas | 399 / 23 |
| `canggu` | Canggu → canggu | 335 / 16 |
| `tabanan` | Tabanan → tanah_lot | 4 / 1 |
| `ubud` | Ubud → ubud | 0 / 1 |
| `bingin`, `uluwatu`, `ungasan` | → bingin / uluwatu / ungasan | 0 / 0, 1 / 1, 5 / 0 |
| `bukit` | Bukit → none (broad: the title decides, Jimbaran/Nusa Dua drop out) | 1 / 0 |

Not walked: `kerobokan`, `tegal-cupek`, the Seminyak area, `jimbaran`, `nusa-dua`,
`tanjung-benoa`, the east coast, `denpasar`, `dalung` (not §7 areas) and `beraban`
(Tanah Lot's desa, but no listings today and not a §7 place word — add it to
`PLACE_WORDS` in `src/areas.js` first if it ever fills up). `canggu-area` is the parent of
the whole Canggu group (787 yearly) and is not walked: its children are.

23 locations × 2 types, plus the extra pages of the four big ones: 68 index requests in
the 2026-09-26 dry run (3 min 42 s at 1 req/s and the site's 3–5 s a page).

## Index card

Root `.property-wrapper .property-item-wrapper` (the header carousel and a detail page's
"Similar villas" row reuse the card markup; the scope keeps them out).

| field | selector |
|---|---|
| url | `.property-footer a` whose text is `DETAILS` |
| title | `h3[title]` |
| code + availability | `.show-in-list-view p` → `Code : IP 874 - Avail Oct 30, 2026 \| Availability : Rented` |
| price | `.price-wrapper .property-price` → `<label>` (`YEARLY RENTAL`, `MONTHLY RENTAL`, `FOR SALE`, `FOR LEASE`) + `.property-price-text` (`Rp. 320.000.000 / year`) |
| icons | `.property-icon li` keyed by the `<i class="icon-…">`: `icon-bedroom`, `icon-bathroom`, `icon-land-size` (`150 sqm`), `icon-open-livingroom` / `icon-enclosed-livingroom`, `icon-{fully,semi,un}-furnished`, `icon-garden`, `icon-garage`, `icon-carport`, `icon-maidroom`. `li.not-active` ("Land size not defined") is skipped |
| banner | `.property-thumb-banner` (`Prime<br>Location`, `Rice-field<br>View`, `Brand<br>New`, `Rented<br>Out`) → `note` |
| thumb | first `.list-view-img[data-bg]` (full size); some brand-new listings have no photos at all |

The grid-view summary line `Price : <strong>-` is often a dash (mostly on rented cards)
while the list-view panes carry the real figure — the adapter reads only the panes.
`Rp. 0 / month` appears (IP 562) and means "not quoted"; `FOR SALE` / `FOR LEASE` panes
are sale prices and are ignored.

## Field mapping

| row | from |
|---|---|
| `ref` | the code with its space made a hyphen: `IP 874` → `IP-874`, `AR 18` → `AR-18`, `BVB 359` → `BVB-359`. Digits exactly as printed. Fallback: the `-ip-874/` tail of the URL. Key: `umadibali:IP-874` |
| `area` | the title first (`Villa La Luna Pererenan`), else the location it was found under (`Rumah Dalco` under Umalas). Detail pages carry no location at all, so they can only read the title — title-first keeps card and detail in agreement. `sub_area` is the location label when it names the same area (`Buduk`, `Echo Beach`, `Kaba-Kaba`, `Cepaka`) |
| `price_year_idr` / `price_month_idr` | the `YEARLY RENTAL` / `MONTHLY RENTAL` panes. A yearly-only listing's monthly figure is derived by `normaliseListing` (÷ 12) |
| `term` | `yearly`, `monthly` or `both`, from which panes carry a price |
| `bedrooms`, `bathrooms`, `land_m2` | the icon row (card and detail) |
| `living_open` | `icon-open-livingroom` → 1, `icon-enclosed-livingroom` → 0 |
| `furnished` | `icon-un-furnished` → 0, `icon-semi-furnished` / `icon-fully-furnished` → 1 |
| `garden` | `icon-garden`, or "Garden" in the facilities |
| `pool`, `aircon`, `kitchen_full` | the detail's Facilities / Villa Information lists: "Swimming Pool", "Air con" / "AC", "Equipped Kitchen" (not "Kitchen Semi Equipped") |
| `description` | detail `.property-desc` (houses) + the "Villa / House Information" bullet list |
| `terms` | `Facilities: …` (Bedroom, Bathroom, Living room, Kitchen, Outdoor, Other) and `Services: …` |
| `note` | the card banner and the agent's text after the code (`Minim 2 years lease`) — `normaliseListing` reads it for view, min-months and features |
| `images` | detail `#photo-gallery .full-image img[data-src]` (full size; the `-10x10` blur-up placeholders and the `-150x150` thumb strip are skipped), capped at 20 |
| `lat`, `lng` | detail `#location #map[data-lat][data-lng]` → `pin_source: 'listing_map'` (see below) |
| `available_from` | a date in the code line still to come (next section) |
| contact | the header WhatsApp `api.whatsapp.com/send?phone=085238086442` → `+6285238086442` (agency line) |

`build_m2` is never stated. Prices are always IDR in the default render (`curr=idr`).

### Map pin — `pin_source: 'listing_map'`

`<div id="map" data-lat data-lng>` in the "Map Location" section is per listing: VB 016
(Pererenan) is at −8.6423, 115.1361 and IP 874 (Umalas) at −8.6563, 115.1524 — two
villages, two pins, not an office default (contrast `kibarer`). Houses often have no map
section. A pin outside a rough Bali box (lat −9…−8, lng 114.4…115.8) is ignored.

## Rented, and "Avail <date>"

The site keeps its rented villas listed, and they are most of the index: of the 1 238
cards in the §7 locations on 2026-09-26, 850 were taken. Three places can say so: the
card's `Availability : Rented`, `RENTED OUT` / `RENTED until …` in the code line, a
"Rented Out" / "RENTED" / "SOLD OUT" banner. The detail page has no Availability field —
only the code line and the banner.

Agents write the date a villa frees up after the code: `Avail Oct 30, 2026`,
`RENTED OUT - Avail Nov 2026`, `Av April 2025`, `Avail 5 Sept 2025`,
`RENTED until June 2020`. Dates run as far out as 2043 (multi-year leases): of the 229
taken cards with a date still to come, 110 were more than a year away.

The rule (`statusFrom`, `UPCOMING_MONTHS = 3`):

1. **Taken, with a date this month or in the next three**: it frees up then —
   `available_from` = that date (the 1st when no day is given), `availability =
   'from:<date>'`, **not gone**.
2. **Taken otherwise** (no date, a date that has passed, or one further out): **gone**.
   A villa leased until 2028 is not one Philipp can move into.
3. **Not taken, with a date still to come**: available from that date, however far.
4. **Not taken, with a date that has passed**: stale bookkeeping, ignored ("Avail May 2024"
   on a card that says `Now` is simply available).

What `list()` does with a card that rule calls gone:

* **Tracked** (a live `umadibali:<ref>` row exists — `ctx.db`): it is passed on with
  `gone: true`, so the daily run marks the row gone the same morning.
* **Not tracked**: skipped. Passing on the site's whole rented archive (villas rented out
  as far back as 2020) would fill the Gone section with hundreds of villas "live 0 days"
  that were never on the market while we watched, and cost a detail request each, every
  day. This is the one place this adapter departs from `balicoconutliving` (which passes
  every "Rented" card on): there the rented cards are a handful, here they are the
  majority.
* A tracked villa that goes rented without the card saying so still leaves through the
  run's `unlisted` pass (3 days unseen); the recheck of a shortlisted villa sees a rented
  marker in the detail page's code line.

Two cards seen (AR 325, IP 288) say `Availability : Now` but keep `RENTED OUT - Avail
<2024/2025>` in the code and a "Rented Out" banner. The rule reads them as rented: the
site shows them as rented to a visitor too.

## Recheck

`src/scrape/recheck.js` rebuilds a row's partial as `location: "<area> - <sub_area>"`,
and a detail page has no location, so a villa whose title names no village would be
re-mapped to `other` there. `applyDetail` restores the row's own canonical area from the
head of that string when that happens.

## What is skipped, and why

* Sales and land (`type=villa`, `type=land`, `house-cat=sale`), `FOR SALE` / `FOR LEASE`
  price panes — out of scope.
* `DAILY RENTAL` prices (none seen in the rental indexes) — not long-term.
* Untracked rented cards — see above.
* Cards whose title and location name no §7 area (only possible under `bukit`).
* The `Price : -` grid-view summary line — the panes are the source.

## Dry run, 2026-09-26

`npm run scrape -- --source=umadibali --dry` against a throwaway DB: 1 238 cards in the
§7 locations, **388 passed on** (340 available now, 48 free within three months), 850
taken and untracked skipped, 0 off-target, 0 errors, 388 unique refs. By area: umalas 124,
canggu 105, berawa 65, pererenan 54, munggu 11, tanah_lot 7, padonan 7, cemagi 5, seseh
4, ungasan 2, nyanyi / buwit / ubud / uluwatu 1. **330 are inside the aggregation band**;
their monthly price runs p10 16.7 M, median 25 M, p90 50 M. Six detail pages fetched
live (Tanah Lot, Munggu, Cemagi, Seseh, Nyanyi, Buduk) carried six different pins.

## Cost

The index walk is ~68 pages. The shared ingest path fetches the detail page of every
in-band card on every run: ~330 pages at 3–5 s each, **~20–25 min** with the usual 24 h
cache. So detail pages are cached for **7 days** (`DETAIL_TTL_HOURS`): price, term and
availability are on the card, which is re-read every morning, and a detail page served
from cache has those fields dropped so the card's stand. After the first (cold) run a
day costs the index walk plus the new and week-old detail pages. Recheck passes
`force: true` and always reads a fresh page.

## Politeness

`ctx.fetchHtml` gives 1 request/s per host, a 24 h HTML cache, the browser UA and the
429/403 back-off. `ppp=48` keeps the daily walk to ~68 index pages. One connect timeout
was seen during inspection (after ~140 requests in 40 min); a retry minutes later worked.

## Verdict

**Implemented, `html`, daily.** Server-rendered, robots-clean, location-filterable by
URL, with a per-listing map pin and a full-size gallery on every detail page. The two
wrinkles are the rented archive (skipped unless it retires a row we hold) and the
"Avail <date>" notes in the code line (turned into `available_from`).
