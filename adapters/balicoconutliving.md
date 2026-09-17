# Bali Coconut Living — `balicoconutliving`

`https://balicoconutliving.com` — inspected 2026-09-18 with curl (logged out, browser UA).
Fixtures in `test/fixtures/balicoconutliving-index.html` / `balicoconutliving-detail.html`.

## Reachability

* `robots.txt`:
  ```
  User-agent: *
  Disallow: /private/
  Disallow: /news/?q=
  Disallow: /property/search
  Sitemap: https://balicoconutliving.com/sitemap.xml
  ```
* No login, no challenge. **Method: html.** The listing *index* is server-rendered
  (the cards are in the HTML); only the search form on it is a Vue component.

> **`/property/search` is the site's own JSON/HTML search endpoint and robots.txt
> disallows it.** The adapter does not call it, even though it would allow area
> filtering. It walks the paged index instead.

## URL scheme

```
/property/villa-for-long-term-rental              # monthly + yearly, 12 cards a page
/property/villa-for-long-term-rental/?page=N
/property/villa-for-monthly-rental                # same shape, one term
/property/villa-for-yearly-rental
/bali-villa-<monthly|yearly>-rental/<Area>/<id>-<ref>/<Name>   # detail
```

The adapter walks `villa-for-long-term-rental` only, because it already unions both
terms. The paginator advertises `?page=390`, which is not real; the walk stops at
`MAX_PAGES = 10`, on a page that links to no page N+1, or on a page that repeats refs
already seen. Newest listings come first, so 10 pages ≈ the 120 most recent rentals.
A path segment after the index (`…/villa-for-yearly-rental/Pererenan`) is **not** an
area filter — it returns the unfiltered list.

`sitemap.xml` (225 URLs) also lists individual rental listings and is a useful
cross-check, but it is far from complete and is not used by `list()`.

## Index card

Root `div.property-thumb`. Cards link through `onclick="openDetail("\/bali-villa-…")"`,
never an `href` — the adapter parses that attribute.

| field | selector |
|---|---|
| url | `.property-title a[onclick]` → `openDetail("…")`, backslash-unescaped |
| title | `.property-title a` (upper-case on the site; `normalise.titleCase` fixes it) |
| ref + location | `.property-thumb-meta` → `ID V009-4425 \| VILLA - Pererenan`; the location half maps to a canonical SPEC §7 key and the partial states `area` outright (`normaliseListing` honours it) |
| price | per-term tab panes `#yearly-thumb-<id>` / `#monthly-thumb-<id>` → `.price-icon` (`IDR 360.000.000`, `IDR 35.000.000`). A `#leasehold-thumb-<id>` pane is a **sale** price and is ignored |
| bed / furnished / land / build | `.icon-thumb[title]` → `Bedroom(s)`, `Furnished status`, `Land Size`, `Building Size`, value in `.icon-text` |
| status label | `.property-thumb-label .property-label` → `Rented Until October 2026`, `26 Years Lease` — "Rented" sets `gone` |
| thumb | `img[src*="/upload/image/property"]`; `/_thumb/` removed gives the full size |

Prices use `.` as the thousands separator (`IDR 360.000.000`) — `normalise.parsePrice`
already handles that.

## Detail page

| field | selector |
|---|---|
| title | `h1.title-header` |
| facts | the `section.line-section` whose `h2` ends in `Detail` → `.list-detail li` = `Label: <span>value</span>`: ID, Type, Location, Bedroom(s), Bathroom(s), Swimming Pool, Furniture, Living Room, Land Size, Building Size, No. of Floor |
| description | the `section.line-section` whose `h2` is `Description` → `p` |
| included facilities | `h2 = Included Facilities` → `li` (Swimming Pool, Living Room, Kitchen, Garden, AC, Internet, Pool Maintenance, Gardener, Housemaid, Banjar, Rubbish Collection, Parking Space, Fridge) |
| extra-cost facilities | `h2 = Other Facilities with Additional Cost` (e.g. Electricity) |
| price | `.property-detail-price .tab-pane#<term>` — often literally `TBA`, in which case the card's price is what survives the ingest merge |
| gallery | `/upload/image/property_gallery/<name>.jpeg` (thumbs under `/_thumb/`); capped at 20 |
| WhatsApp | `wa.me/623618476727` (agency line, `+62 361 847 6727`) |

### Availability lives on the card, not the detail page

A detail page carries **no** availability marker of its own: every `.property-label`
on it belongs to an "OTHER PROPERTY" card in the footer carousel (checked against
`The-Green-Apartment-13`, which the index labels *"Rented Until October 2026"* and whose
own page says nothing). `detail()` therefore returns `gone: null` — unknown — and
`applyDetail` falls back to the card's verdict, which `normaliseListing` preserved in
`raw`. Matching "rented" against the whole page would mark every listing gone.

### Map pin — `pin_source: 'listing_map'`

The Google-Maps bootstrap ships inside an HTML comment but keeps the real marker:

```
var markers = [ ["Villa Pelangi",'-8.6426109', '115.12913159999994'] ];
```

Villa Pelangi's pin lands in Pererenan, i.e. it is a per-listing coordinate, not a
site default (contrast `kibarer`). `detail()` reads it and sets
`pin_source = 'listing_map'`.

## Currency

All prices seen are IDR. A `/currency/setCurrency/` endpoint exists but the default
render is IDR; `_shared.moneyIdr` would convert USD at `config.usd_idr` (default 16 000)
and record `price_currency` / `price_original` in `raw`.

## Politeness

`ctx.fetchHtml` gives 1 req/s per host, 24 h HTML cache, browser UA, 429/403 back-off.
`/property/search` is never requested.
