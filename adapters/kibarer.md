# Kibarer Property — `kibarer`

Inspected 2026-09-18 with curl (logged out, browser UA, `-sL`). Fixtures in
`test/fixtures/kibarer-index.html` / `kibarer-detail.html`.

## Which domain

`kibarer.com` **is not the agency site**. It resolves to a WordPress "this domain is
for sale" page (`<title>Front Page - kibarer.com</title>`, "INQUIRIES to buy this
domAIN"). `kibarerproperty.com` is a one-page card that points at the live site.

The agency's live long-term rental site is **`https://www.villabalisale.com`**
(JSON-LD `Organization.name = "Kibarer Property"`, `alternateName = "Villa Bali Sale"`).
The adapter id stays `kibarer` (SPEC §6) and `base` is villabalisale.com.

> Same owner as Bali Home Immo (both Kibarer group), but a different reference
> series (`YRV…`/`YRC…`/`YRE…`/`YRR…` vs BHI's `RF…`) and different inventory.
> Cross-source overlap is left to `src/scrape/dedupe.js`.

## Reachability

* `robots.txt`: Yoast block, `User-agent: * / Disallow:` — nothing disallowed.
  Sitemap `https://kibarer.com/sitemap_index.xml` (the parked domain's).
* No login, no Cloudflare challenge, no JS needed: the index and detail pages are
  fully server-rendered Laravel + Tailwind. **Method: html.** `needsBrowser` is not set.

## URL scheme

```
/realestate-property/for-rent/villa/all/<area>            # page 1
/realestate-property/for-rent/villa/all/<area>?page=N     # 10 cards a page
/realestate-property/for-rent/villa/<annually|monthly>/<area>/<slug>-<ref>   # detail
```

Rental area slugs offered include `amed bukit canggu lombok lovina nusa-islands
pererenan sanur seminyak tabanan ubud umalas uluwatu` plus per-village slugs that
aren't in that top-level list but resolve fine (`munggu`, `cemagi`, `mengwi`, `seseh`,
`kedungu`, `nyanyi`, `buwit`, `tanah-lot`, `padonan`, `tibubeneng`, `babakan`,
`berawa`, `balangan`, `bingin`, `padang-padang`, `ungasan`, `pandawa` — all probed
2026-09-26 with curl, browser UA, 1 req/s). `TARGET_SLUGS` now walks every slug that
exists and maps to a `defaults.js` `areas` entry, west to east:

```
ubud                                                              # Center
mengwi buwit kedungu nyanyi tanah-lot tabanan
munggu cemagi seseh pererenan padonan canggu
tibubeneng babakan berawa umalas                                  # West Coast + Canggu belt
bukit balangan bingin padang-padang uluwatu ungasan pandawa       # South (the Bukit)
```

`tabanan` and `bukit` are broad regional indexes kept alongside their villages' own
slugs — the site's per-village page is not a strict subset of the regional one, and
`list()` dedupes by ref across every slug regardless of overlap. `buwit` returned zero
listings on 2026-09-26 (`No Properties Found`, still a valid page) and is kept for
when one appears.

Observed page counts 2026-09-26 (curl, browser UA, 1 req/s; last `?page=N` seen):

| slug | pages | | slug | pages | | slug | pages |
|---|---|---|---|---|---|---|---|
| ubud | 3 | | tanah-lot | 2 | | umalas | 16 |
| mengwi | 4 | | tabanan | 7 | | bukit | 9 |
| buwit | 1 (0 cards) | | munggu | 3 | | balangan | 2 |
| kedungu | 3 | | cemagi | 6 | | bingin | 1 |
| nyanyi | 2 | | seseh | 3 | | padang-padang | 1 |
| pererenan | 15 | | padonan | 7 | | uluwatu | 4 |
| canggu | 45 | | tibubeneng | 1 | | ungasan | 8 |
| | | | babakan | 3 | | pandawa | 1 |
| | | | berawa | 17 | | | |

`MAX_PAGES` from `_shared.js` (10) is shared with adapters whose indexes stay small;
Kibarer's own `KIBARER_MAX_PAGES = 50` covers `canggu`'s ~45 pages with room to grow.
It is a safety ceiling only — `list()` still stops at the paginator's own last page or
the first page that yields nothing new, whichever comes first.

`all` is a term-agnostic index; each card's own URL carries `annually` or `monthly`.

## Index card

Root `div.property-thumbnail[data-id]` (also carries `for-rent` / `for-sale`).

| field | selector |
|---|---|
| url | `a[href*="/realestate-property/for-rent/"]` |
| ref | `.property-code` (e.g. `YRV4752`), fallback `-yrv4752` in the URL |
| title | `.property-title` |
| location | last `div` inside `.property-location` — `"Pererenan"`, `"Canggu, Pererenan"`, `"Bukit, Ungasan"`, `"Tabanan, Nyanyi"` |
| price | `.property-price` → `.property-status` (`Yearly Rent` / `Monthly Rent`) + a span `idr 220,000,000 / Annually` |
| bed/bath/land/build | `.property-specifications .property-meta`, keyed by the **icon filename** (`bed.svg`, `bathtub.svg`, `scale-frame-enlarge.svg` = land in *are*, `scale-frame-reduce.svg` = building in m²) |
| thumb | `img[src*="/uploads/images/property/"]` (`…/thumb/…` on cards) |
| pagination | `.page-link[href*="?page="]`, max of all `?page=N` seen |

The index also carries a JSON-LD `ItemList` of name/url/image, but every `offers.price`
in it is `0`, so it is not used.

## Detail page

| field | selector |
|---|---|
| title | `#property-name` |
| price | `#property-price .primary-price` — a **bare** amount (`idr 220,000,000`); the period comes from the URL's `/annually/` or `/monthly/` segment |
| bed/bath/land/build | `.property-badges .property-badge`, same icon-filename keys (alt is empty here — the icon file is the only label both templates share) |
| specification | `#specifications dl > div` → `dd` label / `dt` value: Code, Location, Status, Land Size, Building Size |
| facilities | `#facilities .property-facility span` → `Pool`, `Kitchen`, `Air Conditioner`, `Electricity`, `Dining Area`, `Water Source`, `Cable Tv`, `Parking / Carport`, `Storage` |
| description | `#property-description .description` (HTML paragraphs) |
| gallery | `img[src*="/uploads/images/property/"]` **excluding** `/uploads/images/property/thumb/` — the thumb path belongs to the "similar properties" carousel at the bottom (13 real images vs 42 carousel thumbs on the fixture) |
| distances | `#distances .property-distance` — Beach / Airport / Market, empty on every page checked |

### No map pin

`div.property-detail[data-latitude][data-longitude]` looks like a listing pin but is
**not**: two different Pererenan listings (YRV4752, YRC5202) both carry
`-8.581189 / 115.19926`, which is the agency office near Mengwi. A second hardcoded
pair (`-8.6714246 / 115.1607031`) sits in the page's `initMap()`. The adapter therefore
returns `lat: null` and lets `src/scrape/pins.js` fall through to geocode/centroid.

### Contact

The floating WhatsApp button ships **commented out** in the footer:
`<!-- <a href="https://api.whatsapp.com/send?phone=6288219082080" …> -->`. It is the
agency number and identical on every page, so `detail()` reads it off the raw HTML
rather than the DOM.

## Prices and currency

Every rental price seen was IDR (`idr 220,000,000 / Annually`, `idr 45,000,000 / Monthly`).
A currency switcher exists (`/currency/usd` …) but the default render is IDR. `moneyIdr`
would convert a USD amount at `config.usd_idr` (default 16 000 IDR/USD) and record
`price_currency` / `price_original` in `raw`; no such page was seen.

## Area translation

`_shared.areaFromText` maps the site's own comma-joined tokens (`"Bukit, Ungasan"`,
`"Tabanan, Nyanyi"`, `"Canggu, Pererenan"`, `"Pererenan, Buduk"`) to a canonical SPEC §7
key, which the partial carries as `area` — `normaliseListing` honours an explicit
canonical area, so no Bali-Home-Immo-shaped location string is faked and normalise.js is
not extended. The site's own string travels on untouched as `location`.

`_shared.subAreaFrom` keeps whatever is finer than the area (`"Pererenan, Tumbak"` →
`Tumbak`, `"Canggu, Pererenan"` → none) and `_shared.beachHint` supplies SPEC §7's
≈4 km for the inland north-Pererenan pockets (Tumbak Bayuh, Buduk, Tiying Tutul).

A bare `Bukit`, `Canggu`, `Badung` or `Bali` maps to nothing on purpose — those cover
target and non-target villages alike, and a card with no §7 area is never yielded.

## Politeness

One request per second per host and a 24 h HTML cache come from `ctx.fetchHtml`
(`src/scrape/fetch.js`). Browser UA, no cookies, no login.

Detail pages of listings already stored are cached for 7 days (the shared rule in
`src/scrape/ingest.js` `detailPlan`, CLAUDE.md): refreshed on each listing's own weekday,
refetched the same day when the card's price, bedrooms or title differs from the stored
row, and a new ref is fetched at once. The index card owns price, title and bedrooms over
a cached detail. Note the card carries no rented/sold marker here — "Rented out" is only
read off the detail page, so on a cached day it can surface up to a week late (the row
still goes `unlisted` after 3 days off the index).
