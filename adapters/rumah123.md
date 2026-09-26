# Adapter notes — Rumah123 (`rumah123`)

Inspected 2026-09-18 with curl (`-sL --http1.1`, Chrome UA, no cookies, logged out). **Reachable,
server-rendered, no challenge, no login.** This is the only one of the four portals in SPEC §6
item 3 that answered at all — see `adapters/olx.md`, `adapters/lamudi.md`, `adapters/99co.md`.

Pages are Next.js app-router and heavy (1.0–1.3 MB index, ~0.5 MB detail) but every card and
every fact we want is in the HTML. 1 req/s, 24 h cache, normal browser UA — the standard ctx.

## robots.txt (200, 5 703 bytes)

`User-agent: *` **disallows `/api`** and a long list of *query-string* facets:
`?location=`, `?bedroom*`, `?minPrice=`/`?maxPrice=`, `?propertyTypes=`, `?rentPeriod*`,
`?sort*`, `?furnish*`, `?utm_*` … It does **not** disallow the pretty path segments or `?page=`.

**Therefore the adapter only ever fetches path-shaped search URLs plus `?page=n`, and does all
filtering itself.** No facet query strings, no `/api` calls, no `/*/list-iklan-tayang/*`.
(There is also a named group for `ClaudeBot`/`anthropic-ai`/`GPTBot`… that *re-allows* most of
those facets; we are not that crawler — we send a browser UA as CLAUDE.md requires — so we
follow the stricter `*` group.)

## URL scheme

- Search: `https://www.rumah123.com/sewa/{kabupaten}/{area}/{villa|rumah}/` — `sewa` = rent.
  Pagination `?page=n`, `n` from 2; page 1 has no parameter. The next page is linked as
  `<a rel="next" href="…?page=2">`; absence of `rel="next"` is the end.
- 20 cards per page (sometimes fewer, e.g. `tabanan/kerambitan` had 3).
- **Verified 200 (2026-09-26), Center:** `gianyar/`: `ubud` (364 villa results),
  `sukawati` (17), `tegallalang` (8), `payangan` (3), `tampaksiring` (3). Gianyar's
  kecamatan are the §7 areas; `tampaksiring` files under `pejeng`, `sukawati` has no
  default (it also holds Batuan and Celuk) and waits for the card's own desa.
- **Verified 200 (2026-09-18):** `badung/`: `seseh`, `cemagi`, `munggu`, `pererenan`, `mengwi`,
  `nyanyi`, `pecatu`, `uluwatu`, `ungasan`, `kutuh`, `balangan`, `kuta-selatan`.
  `tabanan/`: `kediri`, `tanah-lot`, `kedungu`, `buwit`, `kerambitan`.
  **Verified 404:** `badung/bingin`, `badung/padang-padang`, `tabanan/nyanyi` — Bingin and
  Padang Padang have no slug of their own; they turn up under `pecatu`/`uluwatu`, and Nyanyi
  sits under `badung/` even though the village is in Tabanan.
- Both property types matter: `…/villa/` and `…/rumah/` ("Sewa Rumah Kontrakan di …") — the
  same card markup, plenty of villas listed as `rumah`.
- Detail: `https://www.rumah123.com/properti/{kabupaten-desa}/{slug}-{ref}/`, e.g.
  `/properti/badung-seseh/3-bedroom-villa-for-yearly-rental-in-seseh-vlr349347/`.
  **`ref` is the last hyphen segment of the slug** — `vlr349347`, `hor6676262`. The prefix
  (`vlr`, `hor`, …) is *not* a property-type marker: `hor6676262` is a villa. Store lower-case.

## Index page — three parallel sources, all in the HTML

1. **`<script id="__srp_seo_rescue" type="application/json">`** — the cleanest: the **first 10**
   cards as `{title, url, image, price, location, propertyType, shortDescription}`. Missing
   bedrooms, and it only covers half the page, so it is a cross-check, not the source.
2. **`<script type="application/ld+json">`** — a breadcrumb, a page-level `RealEstateListing`
   ("Kami memiliki 37234 daftar villa disewakan di Badung"), and an array of
   `SingleFamilyResidence` for **2** cards only (with `geo`, `numberOfBedrooms`, `floorSize`).
   Too partial to drive `list()`.
3. **The card DOM** — all 20, with stable `data-test-id` attributes. **This is what `list()`
   parses.**

### Card fields (all verified on `/sewa/badung/seseh/villa/` and `/sewa/badung/villa/`)

| field | selector (inside the card) |
|---|---|
| url + ref | `a[data-test-id="srp-card-listing-title-link"]` → `href` |
| title | `[data-test-id="srp-card-listing-title"]` (an `h2`) |
| price | `[data-test-id="srp-card-listing-price-main"]` → `Rp 450 Juta /tahun` |
| location | `[data-test-id="srp-card-listing-location"]` → `Kerobokan, Badung` |
| snippet | `[data-test-id="srp-card-listing-description"]` (truncated with `…`) |
| bedrooms | the `span` wrapping `<use xlink:href="…SearchPageIcons.svg#bedroom-icon">` |
| bathrooms | same, `#bathroom-icon` |
| thumb | first `img[src*="picture.rumah123.com"]` in the card |
| agent | `[data-test-id="srp-card-agent-name"]`, updated-at `[data-test-id="srp-card-last-update"]` |
| phone | `button[data-test-id="srp-card-enquiry-phone"]` `title="+628515…"` — **masked**, useless |

Cards are found the way `bhi` does it: walk up from each title link to the smallest ancestor
that also holds a price element and exactly one title link.

### Price formats seen

`Rp 450 Juta /tahun`, `Rp 40 Juta /bulan`, `Rp 37 Juta /bulan`, `Rp 750 Juta /tahun`,
`Rp 150 Juta /tahun`. Always `Rp <n> <unit> /<period>`; units `Juta`/`Miliar`, periods
`/bulan` `/tahun` (and `/hari` on daily rentals — those are skipped). `normalise.parsePrice`
already handles all of this (`juta`, `miliar`, `bulan`, `tahun` are in its tables); the adapter
only decides which of `price_month_idr` / `price_year_idr` the number lands in.

### Location taxonomy

`"<desa or kelurahan>, <kabupaten>"` — `Seseh, Badung`, `Munggu, Badung`, `Kutuh, Badung`,
`Kediri, Tabanan`, `Mengwi, Badung`. The string follows the *search slug*, so a listing under
`/sewa/badung/mengwi/villa/` says `Mengwi, Badung` even when its title says "di Seseh". See
"Area mapping" below — this is the one place the adapter has to think.

## Detail page

One `<script type="application/ld+json">` with an `@graph`:

- `@graph[0]` = `["WebPage","RealEstateListing"]` → `datePosted`, `dateModified`, `breadcrumb`
  (the full `Beranda › Villa Disewa › Bali › Badung › Seseh` chain — **the reliable area signal**),
  and `mainEntity`.
- `mainEntity` = `["Accommodation","Product"]` →
  `name`, `description` (the full, untruncated ad text), `image[]` as `{contentUrl, name}`
  (13–15 per listing), `address {addressLocality:"Seseh, Badung", addressRegion:"Bali"}`,
  `numberOfBedrooms`, `numberOfBathroomsTotal`, `geo {latitude, longitude}`, `sku` (= ref) and
  `offers.priceSpecification {price:"400000000", priceCurrency:"IDR",
  referenceQuantity.unitCode: "ANN" | "MON"}` plus `offers.availability`
  (`https://schema.org/InStock`).
- `@graph[1]` = `["Person","RealEstateAgent"]` → agent `name`, `url`, and `telephone` **masked**
  (`"+62821******"`).

**`unitCode` is the term:** `ANN` → `price_year_idr`, `MON` → `price_month_idr`.

### Spec table (DOM)

Label/value `<p>` pairs; the adapter matches the *label text*, not the Tailwind width class:

`Tipe Sewa: Seluruh Villa` · `Kamar Tidur: 3` · `Kamar Mandi: 2` · `Kapasitas: 1 Orang` ·
`Metode Pembayaran: Transfer Bank` · `Pemandangan: Pemukiman Warga` · `Tipe Properti: Villa` ·
`Tipe Iklan: Disewa` · `ID Iklan: vlr349347`. Other listings add `Luas Tanah`, `Luas Bangunan`,
`Kondisi Perabotan`, `Daya Listrik`, `Sertifikat`.

`Luas Tanah` / `Luas Bangunan` are often missing from the table and present in the description
instead ("Luas Tanah: 150 m²") — parse both.

### Facilities (DOM, language-independent)

`<p>…<svg><use xlink:href="/portal-public/0.20.11/ListingPageIcons.svg#pool"></use></svg><span>Kolam Renang</span></p>`.
Icon ids seen: `ac`, `kitchen-set`, `pool`, `kompor`, `parking-area`, `garden`, `internet`.
The adapter reads the **icon id** (`#pool` → `pool`, `#garden` → `garden`, `#ac` → `aircon`,
`#kitchen-set` → `kitchen_full`) and falls back to the Indonesian label text.

### Indonesian → our fields

`kolam renang` → `pool` · `taman` → `garden` · `kamar tidur` → `bedrooms` ·
`kamar mandi` → `bathrooms` · `luas tanah` → `land_m2` · `luas bangunan` → `build_m2` ·
`furnished` / `full furnished` / `perabotan lengkap` → `furnished = 1` ·
`unfurnished` / `kosongan` / `tanpa perabot` → `furnished = 0` ·
`minimal sewa N tahun|bulan` → `min_months` (`normalise.parseMinMonths` already reads
`bulan`/`tahun`; the adapter parses it too and fills the gap when the text form differs).
Whole descriptions are **not** translated — SPEC §6 wants facts, not machine translation.

## Coordinates — read this before trusting a pin

`mainEntity.geo` exists on every detail page, but it is **not a survey-grade pin**:

- Both Seseh listings inspected (different agents, different villas) carry the *identical*
  point `-8.617202, 115.127342`.
- Two Munggu listings carry `-8.62998, 115.118027` and `-8.632601344761904, 115.15007587666666`
  — the second is ~5 km east of Munggu, in Canggu.

So it is an agent-placed or desa-level marker, not a map pin from the listing.
**The adapter emits it as `pin_source: 'geocode'`, never `'listing_map'`, and drops it entirely
when it falls more than 6 km from the resolved area's §7 centroid** — in that case `placePins`
uses our own curated centroid, which is the better number.

## Contact

- Agent name and profile URL: yes. Phone: **masked** everywhere (`+62821******`, and the card
  button's `title="+628515…"`). Revealing it is a JS/XHR action behind a button.
- There is one `https://wa.me/085311111010` link in the page, but it is the same number on
  every listing and starts with a domestic `0` — it is Rumah123's own line, not the agent's.
  The adapter records it as `role: 'portal'` so nobody mistakes it for the owner.
- **Verdict: no usable direct contact.** Philipp opens the listing URL and taps the button.

## `gone` signal

- Deleted listing → **HTTP 404** with `<title>404 Page Not Found | Rumah123.com</title>`
  (verified on a made-up ref). `ctx.fetchHtml` turns that into `html: null`, and `detail()`
  returns `{gone: true}`.
- Still-listed-but-taken → `offers.availability` other than `InStock`, or the page text
  carrying `sudah disewa` / `sudah terjual` / `tidak tersedia` / `iklan tidak ditemukan`.
  (Not observed in the sample; implemented defensively, cheap to check.)

## Noise filter (portals carry a lot)

`list()` yields a card **only** when all of these hold:

1. the URL is a `/properti/…` listing with a parsable ref;
2. the price parses to IDR **per month or per year** — `/hari` (daily) is dropped;
3. `bedrooms` is present on the card;
4. the title/URL does not match `kost|kos-kosan|apartemen|apartment|ruko|rukan|kantor|office|
   gudang|warehouse|tanah|kavling|lahan|hotel|homestay|guest ?house|resort|per malam|per hari|
   harian|nightly|daily`;
5. the price is not obviously nightly (`< Rp 5 juta` with `/hari`-shaped wording).

Everything past that is left to the band check in `ingest.js` (`bedrooms 1–4`,
`15–80 juta/month`, area in the §7 list).

## Area mapping — the assumption to keep an eye on

SPEC §7's table is written for Bali Home Immo's location strings; Rumah123 speaks
desa/kecamatan. `normalise.normaliseListing` honours a canonical §7 `area` (and `sub_area`)
set on the partial, so **the adapter resolves the area itself and states it outright** — on the
`list()` card and again on the `detail()` payload. `mapArea` is not involved.

`resolveArea` works in this order:
village keyword in the *location* string → village keyword in the *title* → the search slug's
own area → kecamatan default. Village keywords: seseh, cemagi/mengening, munggu, pererenan,
nyanyi, kedungu/belalang, tanah lot / beraban / kaba-kaba (→ `tanah_lot`), buwit, bingin,
padang padang, balangan, ungasan / melasti (→ `ungasan`), pandawa / kutuh (→ `pandawa`),
pecatu / uluwatu / suluban (→ `uluwatu`).

Kecamatan defaults (**assumptions, SPEC is silent**):

- `Mengwi, Badung` with no village hint → `mengwi` (the task brief says so);
- `Kediri, Tabanan` with no village hint → `tanah_lot` (Kediri kecamatan holds
  Beraban/Tanah Lot, Belalang/Kedungu and Nyanyi);
- `Kerambitan, Tabanan` with no village hint → `buwit`;
- **`Kuta Selatan, Badung` with no village hint → nothing.** That kecamatan also contains
  Jimbaran, Benoa and Nusa Dua, which are not target areas — better to lose a card than to
  file a Nusa Dua villa under Uluwatu.

A card whose area cannot be resolved is **not yielded at all** (the band check would drop it).

`sub_area` is the portal's own head segment — `"Seseh, Badung"` → `Seseh`, `"Kediri, Tabanan"`
→ `Kediri` — and the full portal string travels as `source_location`, which ends up in `raw`.

*Superseded 2026-09-18:* an earlier version of this adapter emitted a synthetic
Bali-Home-Immo-shaped `location` string (`bhiLocationFor`) because `normaliseListing` then
ignored `partial.area`, with "adjacent in-band proxy" areas for `munggu`, `mengwi` and `buwit`,
which `applyDetail` had to undo. `normaliseListing` now takes the area directly; the workaround
and the proxies are gone.

## Volume seen

`Sewa Villa di Badung` claims 37 234 listings portal-wide; per target area a page holds 20 and
the adapter takes at most 3 pages × 2 property types × 17 areas. Nearly all of it is filtered
out by the band (most Badung "villa" stock is Canggu/Seminyak nightly rental or far over
budget) — that is expected and is not a bug.

## Live check — 2026-09-18

`list()` over `badung/seseh`, `badung/mengwi`, `tabanan/kediri`, `badung/ungasan`, type `villa`,
2 pages each (10 requests, 1 req/s, all cached on the second run):

```
cards=122  in-band=93
resolved areas (adapter): seseh 36, ungasan 36, mengwi 24, kedungu 8, buwit 6, tanah_lot 6,
                          cemagi 2, pererenan 2, munggu 1, nyanyi 1
areas after normalise   : seseh 34, ungasan 36, mengwi 13, pererenan 13, kedungu 8, buwit 6,
                          tanah_lot 6, munggu 3, cemagi 2, nyanyi 1
```

The gap between the two rows was the old proxy workaround (11 of the 24 Mengwi cards have no
"Mengwi" in the title, so `mapArea` filed them under Pererenan until `applyDetail` moved them
back). Since the area is now stated on the partial the two rows are identical — re-verified
2026-09-18 after the change: 122 cards, 93 in band, `seseh 36 / ungasan 36 / mengwi 24 /
kedungu 8 / buwit 6 / tanah_lot 6 / cemagi 2 / pererenan 2 / munggu 1 / nyanyi 1` before and
after `normaliseListing`. `detail()` on two of them returned full descriptions, 20 and 15
images, bathrooms, `furnished`, `pool` and a `geocode` pin.

**One bug the live run caught and the tests now pin down:** the first version tested the
`gone` keywords against `$('body').text()`, which in cheerio includes `<script>` contents — and
the Next.js payload carries a report-a-listing translation table with *"Sudah terjual/tersewa"*
in it, so **every live listing came back `gone: true`**. The check now runs over the visible
text only (`script`/`style`/`noscript`/`template` stripped). Worth remembering for any other
adapter that greps a page for status words.
