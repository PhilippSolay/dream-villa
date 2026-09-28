# SPEC — villa.solay.cloud

Version 1, 2026-09-17. Source of truth for the build. Companion files: `CLAUDE.md` (conventions), `adapters/bali-home-immo.md` (proven extractor), `KICKOFF.md` (prompt to start Claude Code), `seed/` (first sweep).

---

## 1. Purpose and users

Philipp and Abigaïl are moving from Singakerta (too noisy) to a quiet villa near the beach. This app is their private agent's desk: every listing worth knowing about, filterable and rated, with what the owner said and what a viewing showed, plus a daily scrape so nothing is missed. Two users, both full access, everything attributed by name.

## 2. The brief (drives scoring — keep in `config`)

**Hard filters** (fail → `scope = market`, still stored):
- rooms: `bedrooms >= 1 AND (bedrooms + extra_rooms) >= 2 AND bedrooms <= 3`
- budget: `20_000_000 <= price_month_idr <= 80_000_000` (yearly normalised ÷ 12; widened from 25–50 M on 2026-09-20)
- area: in the target list (§7) — anything else is `market` at best. The Canggu belt (Canggu, Babakan, Berawa, Padonan, Tibubeneng, Umalas) and Center (Ubud) joined it on 2026-09-22; the desa around Ubud — Tegallalang, Payangan, Pejeng/Bedulu, Lodtunduh/Mas — on 2026-09-26.
- style: `style != 'balinese_old'`
- ~~neighbours~~: **soft** since 2026-09-22 — the `construction` keyword is too easy to hit ("brand new construction", "solid construction", a neighbour's build that is already finished), so it no longer excludes. The flag is still raised — by the scraper's text rules, by agent info, and by a viewing with `construction_nearby >= 4` — and any red flag still keeps a villa out of the flagged set (§2 Flag rule below), so a real building site is de-featured rather than hidden.
- furnishing: any (unfurnished gets `notes` hint "unfurnished — add furnishing budget")
- availability: any
- ~~beach~~: **soft** since 2026-09-17 — beach distance never excludes a listing; it is scored (see `beach` row below). `beach_km_max` (4) only sets the scale midpoint and the UI's default slider. Pool is likewise a scored preference, never a filter.

**Aggregation band** (what the scraper keeps at all): bedrooms 1–4, 15–80 M IDR/month equivalent, any beach distance, target areas + adjacent. Outside that band: skip.

**Fit score** (0–100, only meaningful for `in_filter`, but computed for all):

| feature | pts | source field | rule |
|---|---|---|---|
| big open living room | 3 | `living_open` (bool) / text | true → 3; unknown → 1 |
| airy / light | 7 | `airy` | true → 7; unknown → 3 |
| pool | 6 | `pool` | true → 6 |
| garden | 12 | `garden` | true → 12 |
| view | 14 | `view` | river → 14, rice → 11 (80 %), ocean → 7 (50 %), jungle → 4 (30 %), none/unknown → 0 |
| land | 14 | `land_m2` | ≥ 500 m² → 14, linear down to 0 at ≤ 200 m²; unknown or 0 → 7 |
| style | 12 | `style` | joglo/bamboo → 12, tropical → 8, modern/other/unknown → 0 (on top of the `joglo` flag) |
| price | 10 | `price_month_idr` | 50–70 M → 10, linear to 0 at ≤ 30 M and at ≥ 80 M; unknown → 5 |
| beach | 8 | `beach_km` | ≤ 1 km → 8, linear to 0 at 2 × `beach_km_max` (8 km); unknown → 4 |
| full kitchen | 12 | `kitchen_full` | true → 12; unknown → 6 |
| aircon | 10 | `aircon` | true → 10; unknown → 5 |
| nice furniture | 3 | `furnished` + `furniture_quality` | furnished & quality≥3 → 3; furnished unknown quality → 1; unfurnished → 0 |
| work space / shala | 3 | `workspace` | true → 3 |
| joglo | 14 | `joglo` | true → 14 |

Weights live in `config.weights` (JSON) and are editable in the Agent page; the scraper re-scores everything after a weight change. The score is normalised to the sum of the weights (`round(100 × points / Σweights)`), so edited weights keep the 0–100 scale; with the defaults above (Σ = 128) everything-true + river view + beach ≤ 1 km + land ≥ 500 m² + joglo style + 50–70 M = 100, everything unknown = 25.

`view`, `land` and `style` were raised/added on 2026-09-20 from Philipp's first 748 verdicts: his maybes sit on 300 m²+ plots (22 % maybe rate vs 4 % below), are joglo / bamboo / tropical (47 % for joglo vs 6 % modern) and look onto river, jungle or rice.

**Retuned 2026-09-27** from 1,926 verdicts (Philipp 1,619: 8 yes, 85 maybe; Abigaïl 307: 13 yes, 24 maybe; the two agree on 281 of the 303 villas both called). Share of calls that were a yes/maybe, Philipp / Abigaïl: river view 55 % / 50 %, joglo 25 % / 45 %, land 300–500 m² 11–20 % / 50–60 %, 50–70 M 14 % / 13–37 % against 2 % / 10 % at 20–30 M and 1 of 59 above 70 M; ocean view 2 % for Philipp. Beach distance (6 % at every distance), open living, furniture and workspace carried no signal. So the view table puts river first and ocean at half; `price` joins the score and **supersedes the 2026-09-20 line "price stays a filter, not a score"**: the budget is still the hard filter, the ramp only ranks inside it. Replayed on the verdicts, the ranking's AUC went 0.70 → 0.76 (Philipp) and 0.73 → 0.76 (Abigaïl), and the top tenth of Philipp's called villas holds 35 of his 92 yes/maybes instead of 28. With the threshold at 65 the live pool features 75 villas instead of 86.

**Flag** (`flagged = 1`): `scope = in_filter AND fit_score >= config.flag_threshold (65) AND red_flags = [] AND status != 'rejected'`. A flagged villa with `assessed = 'not_yet'` renders as "strong fit, unverified".

**Red flags** (array of strings, set by scraper text rules and by people): `construction`, `main_road`, `balinese_old`, `over_budget`, `quiet_low` (any quiet rating ≤ 2), `privacy_low`, plus free text from feedback (`custom:<slug>`).

## 3. Data model (SQLite DDL)

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE properties (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,              -- '<source>:<ref>' e.g. 'bhi:RF11014'; for no-ref sources a sha1 of url
  ref TEXT, source TEXT NOT NULL,        -- 'bhi','kibarer','olx','fb','wa','manual'...
  url TEXT NOT NULL, alt_urls TEXT,      -- JSON array of duplicates on other sources
  title TEXT NOT NULL, description TEXT, inclusions TEXT, terms TEXT,
  area TEXT NOT NULL,                    -- canonical (§7): 'seseh','cemagi','pererenan','munggu','nyanyi','kedungu','tanah_lot','buwit','mengwi','bingin','padang_padang','uluwatu','balangan','ungasan','pandawa','other'
  sub_area TEXT,                         -- free text as the source names it ('Beach Side', 'Tumbak Bayuh')
  address TEXT, lat REAL, lng REAL, pin_source TEXT,   -- 'listing_map','geocode','agent','centroid'
  map_url TEXT,                          -- https://www.google.com/maps?q=lat,lng
  beach_km REAL, beach_name TEXT, beach_source TEXT,   -- 'listing_text','computed'
  bedrooms INTEGER, extra_rooms INTEGER DEFAULT 0, bathrooms INTEGER,
  land_m2 INTEGER, build_m2 INTEGER,
  price_month_idr INTEGER, price_year_idr INTEGER, term TEXT,   -- 'monthly','yearly','both'
  -- for_sale INTEGER NOT NULL DEFAULT 0 (migration 012, §18): also or only offered to buy
  min_months INTEGER, furnished INTEGER, furniture_quality INTEGER,  -- furnished: 1/0/NULL(unknown)
  style TEXT,                            -- 'modern','tropical','joglo','balinese_old','industrial','bamboo',NULL
  pool INTEGER, garden INTEGER, view TEXT, joglo INTEGER, aircon INTEGER, kitchen_full INTEGER,
  workspace INTEGER, living_open INTEGER, airy INTEGER,
  images TEXT,                           -- JSON array of {src_url, file, w, h}
  hero_file TEXT,
  availability TEXT,                     -- 'available','from:<date>','gone',NULL
  available_from TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, price_history TEXT,   -- JSON [{date, price_month_idr}]
  scope TEXT NOT NULL DEFAULT 'market',  -- 'in_filter' | 'market'
  fit_score INTEGER, flagged INTEGER DEFAULT 0, red_flags TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new',    -- new, shortlist, contacted, viewing_booked, viewed, offer, rejected
  status_by INTEGER, status_at TEXT,
  assessed TEXT NOT NULL DEFAULT 'not_yet',   -- not_yet, partly, done
  raw TEXT,                              -- JSON of what the adapter saw (for debugging)
  notes TEXT                             -- person notes (migration 002)
);
CREATE INDEX idx_props_scope ON properties(scope, flagged, fit_score DESC);
CREATE INDEX idx_props_area ON properties(area);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY, name TEXT, role TEXT,   -- 'owner','agent','agency'
  phone TEXT, whatsapp TEXT, email TEXT, agency TEXT, instagram TEXT,
  responsiveness INTEGER, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_contacts_wa ON contacts(whatsapp) WHERE whatsapp IS NOT NULL;
CREATE TABLE property_contacts (property_id INTEGER, contact_id INTEGER, PRIMARY KEY(property_id, contact_id));

CREATE TABLE agent_info (   -- what the owner/agent told us
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL, contact_id INTEGER,
  by INTEGER NOT NULL, date TEXT NOT NULL,
  lease_terms TEXT, deposit TEXT, payment_schedule TEXT, included TEXT,   -- included: JSON {electricity, pool, garden, staff, wifi, water}
  neighbours TEXT, planned_builds TEXT, water_power TEXT, other TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE viewings (
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL, by INTEGER NOT NULL,
  date TEXT NOT NULL, time_of_day TEXT,      -- 'morning','midday','afternoon','evening'
  quiet INTEGER, privacy INTEGER, living_room INTEGER, light INTEGER, breeze INTEGER,
  overlooked INTEGER, construction_nearby INTEGER, beach_minutes INTEGER,   -- 1–5 scales; beach_minutes measured
  notes TEXT, photos TEXT,                   -- JSON array of image files uploaded from the phone
  verdict TEXT,                              -- 'no','maybe','yes'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ratings (   -- feature scores from listing/call (pre-viewing)
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL, by INTEGER NOT NULL,
  feature TEXT NOT NULL,   -- 'quiet','privacy','living_room','light','beach','style','overall'
  score INTEGER NOT NULL, comment TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY, property_id INTEGER, by INTEGER NOT NULL,
  text TEXT NOT NULL, applied INTEGER DEFAULT 0, applied_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
  kind TEXT NOT NULL,          -- 'scrape','learn','recheck','seed'
  sources TEXT, seen INTEGER, new INTEGER, updated INTEGER, gone INTEGER, flagged INTEGER,
  weight_changes TEXT, notes TEXT, errors TEXT
);

CREATE TABLE agent_notes (   -- written by the cloud morning session
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE inbox (   -- URLs to ingest (from the cloud session, from people pasting links)
  id INTEGER PRIMARY KEY, url TEXT UNIQUE NOT NULL, by TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending, done, failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: weights (JSON), flag_threshold ('65'), budget_min, budget_max, beach_km_max, band (JSON), areas (JSON), red_flag_keywords (JSON)
```

## 4. HTTP API

All JSON. Session cookie for the app; `Authorization: Bearer <ADMIN_TOKEN>` accepted everywhere for scripts. `/api/agent/*` accept `?token=<AGENT_TOKEN>` (GET only, HTTPS only, 60 req/h).

**Auth**
- `POST /api/login {email, password}` → sets cookie, returns `{user}`; `POST /api/logout`; `GET /api/me`.

**Properties**
- `GET /api/properties?scope=in_filter|market|all&status=&area=&min=&max=&beach=&bedrooms=&features=pool,garden&term=monthly,yearly,sale&sort=fit|price|beach|new&q=` → `[{…property, contacts:[…], counts:{viewings, ratings, feedback}}]`. Default `scope=in_filter` (the web UI always sends `scope=all`), hides `rejected` unless `status=rejected|all`. List rows are cards: `images` and `description` are left out (2026-09-26 — ~3.4 of a row's ~5 KB); `hero_url` stays, and the gallery and text come from the detail route.
- `GET /api/properties/:id` → property + `contacts`, `agent_info[]`, `viewings[]`, `ratings[]`, `feedback[]`, `price_history`.
- `GET /api/properties/:id/photos` → `{hero_url, image_urls}` — just the gallery, for a card's arrows. List rows carry `photo_count` (shown photos, `dead` ones left out) so a card knows whether to draw them.
- `POST /api/properties` (manual add: `{url}` → enqueues to inbox and returns a stub, or full object) ; `PATCH /api/properties/:id` (person-editable fields only: `extra_rooms, living_open, airy, workspace, style, beach_km, lat, lng, notes, assessed, red_flags`).
- `POST /api/properties/:id/status {status}` → sets `status, status_by, status_at`.
- `POST /api/properties/:id/ratings {feature, score, comment}`; `POST …/feedback {text}`; `POST …/agent-info {…}`; `POST …/viewings {…}` (multipart with photos allowed); `POST …/contacts {…}` (links or creates by whatsapp).
- `POST /api/properties/:id/images` multipart → stores under `data/images/<id>/` and appends to `images`.

**Contacts**: `GET /api/contacts`, `PATCH /api/contacts/:id`.

**Market**: `GET /api/market` → `{by_area:[{area, n, p25, median, p75, n_in_filter}], by_bedrooms:[…], feature_premium:[{feature, median_with, median_without, n}], shortlist_vs_median:[{property_id, price, area_median}]}` — computed over `scope=all`, band prices, excluding `gone`. `GET /api/market`, `/api/market/metrics` and `/api/stats` take `?region=center|west_coast|south`: every listing figure (and the team's activity) narrows to that region's areas; the scrape runs stay whole.

**Config / agent page**: `GET /api/config`, `PATCH /api/config {weights?, flag_threshold?}` → triggers rescore. `GET /api/runs?limit=14`. `GET /api/notes?limit=14`.

**Scraper controls**: `POST /api/scrape {source?}` (admin; runs async, returns run id). `POST /api/inbox {url, note}`.

**Agent API (GET, token in query)** — for the cloud morning session, which can only make GET requests:
- `GET /api/agent/digest?token=` → `{since, new:[{id, title, area, price_month_idr, beach_km, bedrooms, fit_score, flagged, url, hero_url, reasons:[…]}], flagged:[…same], changes:[{id, title, what:'price'|'gone'|'status', from, to}], feedback:[{id, property_id, title, by_name, text, created_at, applied}], viewings:[{property_id, title, by_name, date, verdict, quiet, privacy, notes}], run:{…last scrape run}, weights:{…}, counts:{in_filter, market, flagged, shortlist}}`. `since` = previous digest call's timestamp (stored in config `last_digest_at`); the call updates it.
- `GET /api/agent/note?token=&text=` → inserts into `agent_notes` (text ≤ 2000 chars, URL-encoded). Returns `{ok}`.
- `GET /api/agent/inbox?token=&url=&note=` → inserts into `inbox`. Returns `{ok, id}`.
- `GET /api/agent/weights?token=&set=<urlencoded JSON>` → replaces `config.weights` after validation (keys must match §2, ints 0–20), logs to `runs` as kind `learn` with `weight_changes`. Returns new weights.
- `GET /api/agent/feedback-applied?token=&id=&note=` → marks feedback row applied with a note.

All agent GETs return `text/plain` JSON (no HTML), small (< 40 KB), so a summarising fetch tool reads them whole. Cap `new` and `flagged` at 40 rows each, newest first.

## 5. UI

Single page, phone first. Routes via hash: `#/`, `#/p/:id`, `#/market`, `#/map`, `#/agent`, `#/login`.

**Header**: wordmark "Dream House" (Instrument Serif), counts chip (flagged · new today · shortlist), theme toggle, user initial.

**Home `#/`**
- Top strip: horizontal cards for `flagged` then `new today`, each with a one-line reason ("3BR Cemagi · 900 m to beach · 44 M · pool, ricefield view").
- Filter drawer (bottom sheet on phone, left rail on desktop): area checkboxes (grouped: West coast / Bukit), bedrooms 1–4 chips, price range slider 15–80 M (step 0.5 M, dual thumb), beach distance slider 0–10 km, furnished / unfurnished / any, term chips Monthly · Yearly · For sale (§18), feature checkboxes (pool, garden, view, joglo, aircon, full kitchen, workspace, airy/light, open living), status multi-select, assessed on location, source, hide rejected (on). No "in-filter only" switch (removed 2026-09-27, Philipp): the filters above are the filter, so the list, map and queues ask `scope=all`.
- Sort: fit, price, beach, newest.
- Cards: hero image (local file), price `JetBrains Mono` "44 M / mo" (yearly shown "38 M / mo · yearly"), area · sub-area, beach km, bedrooms (+extra rooms), feature chips, fit score ring, status pill, small pin icon linking to `map_url`. A card with more than one photo (`photo_count > 1`) has ‹ › glass arrows over the photo that step through the gallery in place (fetched from `/photos` on the first tap, wrapping at the ends; always shown on touch, on hover with a mouse); the rest of the photo opens the detail.
- Pull to refresh is not needed; a "Updated 06:12" line at the bottom from the last run.

**Detail `#/p/:id`** — five tabs:
1. Listing: gallery (swipe), description, inclusions/terms, source links (all `alt_urls`), pin with "Open in Google Maps" and "Directions", scraper facts table (bedrooms, land, build, term, min months, available from, first seen, price history sparkline).
2. Contact: contacts with tap-to-call, tap-to-WhatsApp (`https://wa.me/<number>?text=<prefilled template A>`), agency, responsiveness stars, notes; "Add contact".
3. From the agent: dated entries (`agent_info`), add form with the six question groups from the brief (included, neighbours, planned builds, water/power, lease terms, deposit/payment).
4. Viewing: list of visits; "Add visit" form: date, time of day, 1–5 sliders for quiet, privacy, living room, light, breeze, overlooked, construction nearby; beach minutes measured; notes; photos (camera input); verdict. Saving a visit sets `assessed` (partly → done when verdict set) and, if quiet ≤ 2 or privacy ≤ 2, adds the red flag.
5. Ratings & feedback: pre-viewing feature ratings (seven rows: quiet, privacy, living room, light, beach, style, overall), feedback box, status control (pipeline), "Message templates" section with A–G prefilled and a copy button.

**Flow mode** (`#/p/:id?flow=sort|rate|contact|view`) — for getting through many listings. Home shows a "Work through" strip with four queues under the current filters: Sort (status `new` → Shortlist, Maybe or Reject; the tap also writes this person's verdict — yes, maybe, no — and Maybe leaves the status as `new`, so a listing counts as sorted once it has a status or this person's verdict), Rate (shortlisted with no ratings → the seven rows, Overall last), Contact (shortlisted → WhatsApp template A, mark contacted), View (contacted / viewing booked → book, log the visit). Starting a stage fixes its queue in memory; the detail page opens on the stage's tab with a sticky action bar (leave, stage + position, the stage's one or two actions, skip) and moves to the next listing the moment the current one has what the stage needs (a status, an Overall rating, `contacted`, a visit with a verdict). The prev/next pager walks the same queue. Keyboard: S shortlist, M maybe, X reject, N skip, arrows prev/next. When a queue runs out, a toast names the next stage and Home comes back.

**Market `#/market`**: price distribution per area (box/whisker: p25–median–p75 per area, count), per bedrooms, feature premium table, "your shortlist vs area median" table, in-filter vs market counts. Charts as inline SVG, no library. Tabs across the top — All · Center · West Coast · South (§7 regions), pinned while the page scrolls — narrow every figure to one region; the choice rides in the hash (`#/market?region=south`) and is remembered for the next visit. Section order (2026-09-27): price per area, per bedrooms, feature premium, budget bands, price per m², availability, yearly discount, negotiable, beach premium, where the good ones come from; then the overview, asking price trend, supply flow, time on market, price drops, inclusions premium, same villa different price, shortlist vs area median, counts. Box/whisker rows read on one line, "Pererenan (1262)", at 13 px; the per-area ones (price, time on market) run north to south in §7's order, `other` last. Feature premium is a diverging bar chart of the premium % (biggest first, zero line, faded when either side has < 20 listings), the table behind a "Table" toggle. Price per m² has All · 1 BR · 2 BR · 3 BR · 4+ BR chips (`per_m2.by_br` in `/api/market/metrics`).

**Map `#/map`**: Leaflet, pins colored by status, ring for 4 km around each beach point, filter state shared with home.

**Agent `#/agent`**: last 14 runs, agent notes, current weights (editable), flag threshold, "what changed and why" list from `learn` runs, inbox with pending URLs and an "Add URL" box, buttons "Run scrape now".

**Login `#/login`**: email + password. No signup.

## 6. Scraper

`src/scrape/index.js` runs all adapters, then `images`, `pins`, `dedupe`, `score`, `recheck`, `learn`, and writes a `runs` row. Cron: `0 6 * * *` Asia/Makassar. Also `npm run scrape`.

**Adapter interface**
```js
export default {
  id: 'bhi', name: 'Bali Home Immo', base: 'https://bali-home-immo.com',
  async *list(ctx) { /* yield {url, ref, partial fields} for every index card in target areas */ },
  async detail(ctx, url) { /* return full normalised listing (see normalise.js) or null */ },
}
```
`ctx` gives `fetchHtml(url, {ttlHours})` (cached, rate-limited, UA), `log`, `config`.

**Adapters to build, in order**
1. `bhi` — Bali Home Immo. Proven index extractor and URL scheme in `adapters/bali-home-immo.md`. Detail page: inspect once with Claude Code (curl works from your machine); expected: gallery `img[src*="/images/properties/"]`, description block, a feature list, a Google Maps iframe or `data-lat/lng`, a `wa.me` link. Do not guess selectors — fetch a page and look.
2. `kibarer`, `balirealty`, `exotiq`, `balicoconutliving`, `balivillahub` — agencies; check each has a long-term rental section for Canggu-west / Tabanan / Bukit. Some are JS-rendered → `PLAYWRIGHT=1`. *Added 2026-09-28:* `apexbali` (Apex Property, apexbali.com) — an agency; walks `/rentals?page=N` and reads the SvelteKit hydration payload behind each card, detail pages for photos and prose (`adapters/apexbali.md`). Runs after `umadibali`, before `livuma`.
3. `olx` (olx.co.id, "sewa villa" in Badung/Tabanan), `rumah123`, `lamudi`, `99co` — portals; Indonesian-language; price often "juta/bulan" or "/tahun". *Added 2026-09-24:* `livuma` (livuma.com) — a listing portal with no crawlable index; walks `sitemap.xml` and reads each page's JSON-LD `RealEstateListing` (`adapters/livuma.md`). Runs after `balicoconutliving`, before `rumah123`.
4. `fbmarketplace` — only if reachable without login; otherwise skip (groups are covered by Philipp's Chrome sessions and the phase-5 WhatsApp reader).
5. `inbox` — generic: for any URL in `inbox`, try the matching adapter, else a generic extractor (OpenGraph + JSON-LD `RealEstateListing`/`Product` + regex for `IDR|Rp|juta`, `bedroom|kamar`, `m2|are`). Always store `raw`.

**Normalise** (`src/scrape/normalise.js`): title case titles; area from sub-area/location text via the §7 map; price parsing (`IDR 40.000.000/month`, `Rp 40jt/bln`, `450M/year`, `500 juta / tahun`); term from tags; `min_months` from "Minimum N months"; `beach_km` from "Walk to the beach (350m)" / "5 mins to beach" (walk: 80 m/min; scooter: 400 m/min) else computed (§7); booleans from keywords (pool, garden, joglo, rooftop, aircon/AC, kitchen, office/workspace/studio, open living/open plan/high ceiling → living_open, airy/breezy/light-filled → airy); `style` from keywords (joglo, bamboo, industrial, "traditional Balinese"/"antique"/"old" → balinese_old candidate, flag for review rather than assert); red flags from keywords (construction, "main road", "roadside", "busy road").

**Rent in a post** (`parseRent`, 2026-09-28): a Facebook post is prose, so its rent is not "the first price-shaped words". Every money mention is read on its own line: currency (IDR/Rp, USD at `usd_idr`, others skipped), units `jt`/`juta`/`M`/`mil`/`million`/`B`/`miliar`, a period after the amount ("/month", "per year", ": Annual", "for 1 year") or in its label ("Monthly: IDR 55 Million"). Not rent: an amount with no currency and no period ("2026", "300 m"); one labelled deposit, fee, electricity, cleaning, wifi, banjar; a sale, leasehold, freehold, profit or yield figure; a nightly, daily or weekly rate; a per-are rate; a total for several months or years ("/ 6 months", "for 2 years"; "12 months" is yearly). "IDR 40/month" is 40 M. Plausible rent is 2–500 M a month or 20 M–5 B a year; the first plausible monthly and yearly figure are kept (rupiah before USD), both → `term = 'both'`; a monthly figure under a thirtieth of the yearly one is a typo and dropped. An amount next to a currency with its separators in the wrong places ("IDR 25,000,0000", "IDR 50,00,000", "IDR 33.00.000") is read as its first group in millions; "IDR 4,500,000.00" drops the cents. With no period anywhere, a bare currency amount under 100 M is monthly, up to 1 B yearly, above that a sale (no rent). A harvested listing (`/api/import/listings`) with no price field takes its rent from its text the same way. Migration `013_reprice_posts` re-read every stored `fb` row once and filled the price of any other unpriced row whose text states one; `014_reprice_typos` re-read them again for the mistyped amounts.

**Images**: download every gallery image (max 20/listing) to `data/images/<id>/<n>.jpg`, resize to 1600 px max side with `sharp` (add dependency), keep `src_url`. Hero = first. Skip if already present. Cards, map pins and duplicate rows load `/thumbs/<id>/<n>.webp` instead (720 px wide WebP q72, cut on first ask into `data/thumbs/`, recut when the source is newer, public and cached 30 days like `/images/`; listing photos only — a viewing's `v…` photo is never cut). The detail gallery keeps the original.

**Pins**: priority `listing_map` (iframe `q=lat,lng` or `@lat,lng`), `geocode` (Nominatim, 1 req/s, `email` param set, query "<sub_area>, <area>, Bali") only when the listing has a street/banjar, else `centroid` (§7) with `pin_source='centroid'`. `map_url = https://www.google.com/maps?q=<lat>,<lng>`.

**Dedupe** (`src/scrape/dedupe.js`): same `key` → update. Else candidate match when `bedrooms` equal AND `area` equal AND price within 5 % AND (title similarity ≥ 0.8 (Dice on trigrams) OR first 60 chars of description equal OR any image `src_url` shared). On match: keep the older row, append `alt_urls`, merge nulls, log to run notes. Never merge across different `bedrooms`. *Amended 2026-09-17:* within the **same source**, title similarity alone is not enough (Bali Home Immo titles are templated and matched 13 distinct villas); it needs the description prefix or a shared image as well. Across sources the rule stands. Units sharing a ref number with a different letter (RF9183A/B) are never merged. *Amended 2026-09-20:* a second automatic rule merges with **no price condition** when `area` is equal (known, not `other`), the bedroom counts do not contradict (equal, or unknown on one side — Facebook posts rarely state them; two different known counts still never merge) and the two listings share **two or more photographs**, matched by `src_url` or by a 64-bit dHash within 6 bits (`src/scrape/image-hash.js`), because every agency and every Facebook poster re-uploads the same pictures; a single shared photo is not enough on its own (a complex reuses one pool shot across its units) and stays under the rule above, whose image test now reads hashes as well as `src_url`. `POST /api/duplicates/auto` runs the pass on demand. *Amended 2026-09-28:* every photo is hashed as it is written — scraped (`images.js`), imported (`/api/import/posts`, `/api/import/listings`) and uploaded (`saveImage`); until then imported photos had no hash, so Facebook cross-posts in different words never met the photo rule. The daily run back-fills any stored photo still without a hash (up to 3,000 listings a run, `images-hash.js`) before it dedupes.

**Score** (§2). **Recheck**: refetch every `status IN (shortlist, contacted, viewing_booked, viewed, offer)` and every `flagged` listing daily; price change → append `price_history`, `changes`; 404/410, `is_archived`/"no longer available" → `availability='gone'`. A page that returns 200 but cannot be parsed is a scraper error, not a delisting — it is logged and the row is left alone.

**Learn** (`src/scrape/learn.js`, rule-based, no LLM required):
- For each unapplied `feedback` row: extract reasons by keyword table (`noise|noisy|road|traffic|dogs|club → quiet`, `dark|no light → airy`, `small living|cramped → living_open`, `far from beach → beach`, `loved the garden → garden+`, `pool` …). A negative reason on feature F raises `weights[F]` by 2 (cap 20); a positive raises by 1. Log `applied_note`.
- For each new viewing with quiet ≤ 2 or privacy ≤ 2: add red flag, and if two or more rejected/low-quiet villas share the same `sub_area` + street keyword, add `low_priority_pockets` to config (used as −10 score in that pocket).
- Every weight change is a `runs` row with `weight_changes` = `[{feature, from, to, because}]`.
- If `ANTHROPIC_API_KEY` is set, `learn` may additionally call Claude (Haiku) to parse free-text feedback into the same reason schema; this is optional and must degrade to the keyword table.

## 7. Areas, centroids, beaches

Three levels, and the words for them: **Region › Area › Banjar** — `group` › `area` › `sub_area`. Center › Ubud › Nyuh Kuning, West Coast › Pererenan › Tumbak Bayuh. A listing that names only a banjar still resolves to its area (`PLACE_WORDS` in `src/areas.js`, the one table the BHI mapper, the other adapters and the Facebook importer all read). `sub_area` also holds what a source calls a side rather than a banjar ("Beach Side", "North Side").

Regions run north to south — Center, West Coast, South — and so do the areas inside them, which is the order the filter drawer shows and the order of this table. Canonical `area` values and rough centroids (verify with a geocoder once; these are approximate and only for `pin_source='centroid'`):

| area | label | centroid (lat, lng) | nearest beach point | group |
|---|---|---|---|---|
| tegallalang | Tegallalang | -8.436, 115.279 | Berawa Beach -8.6725, 115.14 | center (~35 km inland) |
| payangan | Payangan | -8.444, 115.223 | Berawa Beach -8.6725, 115.14 | center (~33 km inland) |
| ubud | Ubud | -8.507, 115.263 | Berawa Beach -8.6725, 115.14 | center (~30 km inland) |
| pejeng | Pejeng / Bedulu | -8.518, 115.29 | Berawa Beach -8.6725, 115.14 | center (~30 km inland) |
| lodtunduh | Lodtunduh / Mas | -8.542, 115.264 | Berawa Beach -8.6725, 115.14 | center (~27 km inland) |
| mengwi | Mengwi | -8.545, 115.17 | Seseh Beach -8.6315, 115.0975 | west_coast (inland ~10 km) |
| buwit | Buwit | -8.583, 115.1 | Nyanyi Beach -8.6125, 115.0765 | west_coast (inland ~4–5 km) |
| kedungu | Kedungu | -8.597, 115.064 | Kedungu Beach -8.6005, 115.0605 | west_coast |
| nyanyi | Nyanyi | -8.608, 115.08 | Nyanyi Beach -8.6125, 115.0765 | west_coast |
| tanah_lot | Tanah Lot area | -8.615, 115.09 | Tanah Lot -8.6215, 115.0865 | west_coast |
| munggu | Munggu | -8.617, 115.094 | Munggu Beach -8.6215, 115.0905 | west_coast |
| cemagi | Cemagi | -8.619, 115.103 | Cemagi/Mengening -8.6255, 115.0995 | west_coast |
| seseh | Seseh | -8.628, 115.099 | Seseh Beach -8.6315, 115.0975 | west_coast |
| pererenan | Pererenan | -8.64, 115.121 | Pererenan Beach -8.6475, 115.1185 | west_coast |
| padonan | Padonan | -8.645, 115.148 | Berawa Beach -8.6725, 115.14 | west_coast (inland ~3 km) |
| canggu | Canggu | -8.652, 115.13 | Batu Bolong / Echo -8.6565, 115.1265 | west_coast |
| tibubeneng | Tibubeneng | -8.653, 115.151 | Berawa Beach -8.6725, 115.14 | west_coast (inland ~2.5 km) |
| babakan | Babakan | -8.657, 115.139 | Batu Bolong / Echo -8.6565, 115.1265 | west_coast (inland ~1.5 km) |
| berawa | Berawa | -8.666, 115.143 | Berawa Beach -8.6725, 115.14 | west_coast |
| umalas | Umalas | -8.67, 115.157 | Berawa Beach -8.6725, 115.14 | west_coast (inland ~2 km) |
| balangan | Balangan | -8.792, 115.124 | Balangan Beach -8.7915, 115.1215 | south |
| bingin | Bingin | -8.806, 115.113 | Bingin Beach -8.8075, 115.1095 | south |
| padang_padang | Padang Padang | -8.811, 115.106 | Padang Padang -8.8115, 115.1035 | south |
| uluwatu | Uluwatu / Pecatu | -8.829, 115.098 | Suluban -8.8145, 115.0885 | south |
| ungasan | Ungasan | -8.833, 115.16 | Melasti -8.8475, 115.1555 | south |
| pandawa | Pandawa / Kutuh | -8.842, 115.19 | Pandawa Beach -8.8455, 115.1875 | south |

`beach_km` computed = haversine(pin, nearest beach point) × 1.3 (road factor). Text-derived distances win over computed.

Bali Home Immo location strings → area: `Cemagi / Seseh - Beach Side` → cemagi (if title says Seseh → seseh); `Cemagi / Seseh - Residential Side` → seseh; title containing Munggu → munggu; `Pererenan - Beach Side|North Side` → pererenan (sub_area kept; "Tumbak Bayuh", "Buduk", "Tiying Tutul" are inland north Pererenan, beach_km ≈ 3–5); `Tanah Lot Area - East side (Nyanyi)` → nyanyi; `West side (Kedungu)` → kedungu; `North side (Tabanan)` → buwit if title says Buwit else tanah_lot; `Canggu - Berawa` → berawa; `Canggu - Batu Bolong / Echo Beach|North Canggu` → canggu (a title naming Babakan, Padonan, Tibubeneng or Umalas wins, unless a proximity phrase runs into it — "5 minutes to Canggu" is a boast, not an address); `Berawa` → berawa; `Umalas` → umalas; `Ubud*` → ubud (its banjars — Nyuh Kuning, Penestanan, Sayan, Pengosekan — resolve there too); `Uluwatu - Bingin*` → bingin; `Padang Padang` → padang_padang; `Balangan` → balangan; `Uluwatu - West|Central|East` → uluwatu; `Ungasan*` → ungasan; `Pandawa*` → pandawa.

## 8. Seed

`seed/bhi-sweep-2026-09-17.json` (currently in Philipp's `~/Downloads/`): `{source, fetched_at, columns, lines:[…], raw:[…]}`. `lines` are pipe-joined: `ref|category|slug|location|bedrooms|price_idr|per|available(dd/mm/yyyy)|tags|note|thumb|categories`. `tags` is a concatenation like `leaseholdyearlymonthly` or `new,yearlymonthly` — split on known words. `thumb` is the filename under `https://bali-home-immo.com/images/properties/thumb/`. Known dirt: one row (RF10336) has several cards concatenated in `location` — discard rows where `location` is longer than 80 chars; bedrooms may be blank for 5+ BR rows. 324 rows across seseh, pererenan, tanah-lot-area, uluwatu, ungasan, pandawa, other-bali-area × monthly/yearly.

`npm run seed` imports lines as `bhi:<ref>` with `first_seen = fetched_at`, then runs `detail` for every row whose band check passes, then images/pins/score.

## 9. Deploy

- `Dockerfile`: `node:20-bookworm-slim`, `npm ci --omit=dev`, `sharp` prebuilt, `USER node`, `EXPOSE 8080`, healthcheck `GET /healthz`.
- `docker-compose.yml`: service `villa`, `restart: unless-stopped`, volume `./data:/app/data`, `env_file: .env`, Traefik labels:
  ```yaml
  labels:
    - traefik.enable=true
    - traefik.http.routers.villa.rule=Host(`villa.solay.cloud`)
    - traefik.http.routers.villa.entrypoints=websecure
    - traefik.http.routers.villa.tls.certresolver=${TRAEFIK_CERTRESOLVER}
    - traefik.http.services.villa.loadbalancer.server.port=8080
  networks: [${TRAEFIK_NETWORK}]
  ```
  with `networks: { <name>: { external: true } }`. Match the resolver and network names to Philipp's existing compose files on the VPS (look at n8n's).
- `.env.example`: `SESSION_SECRET, ADMIN_TOKEN, AGENT_TOKEN, USER1_EMAIL, USER1_NAME, USER1_PASSWORD, USER2_EMAIL, USER2_NAME, USER2_PASSWORD, TZ=Asia/Makassar, SCRAPE_CRON=0 6 * * *, PLAYWRIGHT=0, NOMINATIM_EMAIL, ANTHROPIC_API_KEY=, TRAEFIK_NETWORK, TRAEFIK_CERTRESOLVER`.
- Backups: nightly `sqlite3 data/villa.db ".backup data/backups/villa-$(date +%F).db"` via the same cron, keep 14.
- First deploy: `git clone … && cp .env.example .env && nano .env && docker compose up -d --build && docker compose exec villa npm run seed -- seed/bhi-sweep-2026-09-17.json`.

## 10. Phase 5 (later, not now)

- `whatsapp-reader` service: `whatsapp-web.js` with a persisted session volume; reads the two "Dream House" source groups and Abigaïl's forwards; posts any message with a URL, a price or "villa"/"rent" to `inbox` with the sender as `note`. QR pairing once via the container logs.
- Instagram agents: manual inbox.
- Message drafts sent from the tracker: the templates A–G are already in the UI; sending stays in WhatsApp on the phone.

## 11. Acceptance checklist

- [ ] Two logins work; every write carries `by`.
- [ ] Seed imports 324 rows; ≥ 60 end up `in_filter`; flagged list is non-empty and sensible.
- [ ] Filters, dual sliders and sort work on an iPhone-width viewport with no horizontal scroll.
- [ ] Detail tabs save and reload; a viewing with quiet=2 adds the red flag and drops the flag.
- [ ] `GET /api/agent/digest?token=` returns < 40 KB JSON and advances `last_digest_at`.
- [ ] `npm run scrape -- --source=bhi --dry` prints cards from all target areas without errors; a full run finishes < 15 min and writes a `runs` row.
- [ ] Market tab renders p25/median/p75 per area from real data.
- [ ] `docker compose up` on the VPS serves https://villa.solay.cloud with a valid cert.

## 12. Amendment 2026-09-19 — shared search (verdicts)

The status pipeline is one shared value per listing. Alongside it, each person has their own one-tap call so the two of them can see where they agree.

- **Schema** (migration `004_verdicts`): `verdicts (id, property_id, by, verdict CHECK IN ('yes','maybe','no'), created_at, updated_at, UNIQUE(property_id, by))`. Person-owned: the scraper never writes it.
- **API**: `POST /api/properties/:id/verdict {verdict: 'yes'|'maybe'|'no'|null}` upserts the caller's row (null deletes it) and returns the row payload. Every list and detail row carries `verdicts: [{by, by_name, verdict, updated_at}]` and `status_by_name`. `GET /api/properties?verdict=` filters relative to the caller: `match` (both yes), `waiting_me` (the other called, I have not), `waiting_other` (I called, the other has not), `disagree` (both called, differently), `yes` / `maybe` / `no` (either person said it — `yes` is the loose sibling of `match`, which needs both), `not_no` ("Exclude No": neither said No, uncalled included — the complement of `no`), `unvoted` (nobody). `GET /api/me` also returns `users: [{id, name}]`.
- **UI**: fifth section **Shared** (`#/shared`): Matches, Your turn, Waiting for ‹name›, Disagree, Yes / Maybes / No (either said it), Fresh picks (featured and unvoted). Cards everywhere carry both initials coloured by call, a Match pill, and the viewer's Yes / Maybe / No (tap the pressed one to clear). The detail page shows the same row under the status buttons, and the pressed status button carries the initial of whoever set it. The filter panel gains a "Shared" chip group mapping to `verdict=`.
- **Amendment 2026-09-20**: the home toolbar has no sort tabs and the header has no stats chip; the list is always best fit first. In place of the sort tabs a segmented control filters on the viewer's own call, All / Yes / Maybe / No / New: `my_verdict=yes|maybe|no|none` (`none` = not called yet), combinable with `verdict=`. "Waiting for ‹name›" (`verdict=waiting_other`) leaves out listings the viewer said No to: a No closes the matter, nobody is waited on for it.

## 13. Amendment 2026-09-19 — value fields

Derived on every list and detail row, never stored:

- `price_per_m2` = `round(price_month_idr / build_m2)` when both are present; `area_price_per_m2` = the area's median of that figure over live listings (not gone/unlisted); `vs_area_pct` = the gap in whole percent.
- `yearly_saving_pct` = `round((1 − price_year_idr / 12 / price_month_idr) × 100)` only when `term = 'both'` and the saving is positive. A yearly-only listing has a derived monthly price, so it gets no badge.
- UI: cards and the detail header show `200k/m²`, a pill "28% under" / "12% over" / "at par" (±3 % band) against the area, and "Yearly saves 18%".

## 14. Amendment 2026-09-19 — anchors and the style filter

- **Anchors** are the two people's own places (gym, school, co-working). Schema (migration `005_anchors`): `anchors (id, name, lat, lng, by, created_at)`. API: `GET /api/anchors`; `POST /api/anchors {name, location}` where `location` is `"lat, lng"` or a Google Maps link carrying coordinates (`@lat,lng`, `?q=`, `?query=`), or `{name, lat, lng}`; `DELETE /api/anchors/:id`. Every list and detail row carries `anchors: [{id, name, km}]` (haversine, 0.1 km; `km` null when the listing has no pin). `GET /api/properties?anchor=<id>&anchor_km=<km>` keeps rows within that distance (equirectangular bound in SQL; rows without a pin never match); `anchor` without `anchor_km` is a 400, an unknown anchor a 404.
- **Style filter**: `GET /api/properties?style=modern,joglo` (values from the style enum; unknown → 400).
- **UI**: cards show `1.6 km Gym · 3.4 km School` under the meta line and the style as the first feature chip; the Listing tab lists "To ‹place›" among the facts. The filter panel gains a Style chip group and a "Near a place" group: a place select, a 0.5–15 km slider, Remove, and an "Add a place" form (name + link or coordinates). The Map draws anchors as gold diamonds and now builds its query through the shared filters module (the hand-rolled dump sent `sort=worth` and failed with 400).

## 15. Amendment 2026-09-20 — the journey

The status pipeline follows the two people's calls instead of standing beside them.

1. **Yes / Maybe / No** is the first step on every listing (the Sort stage, the card capsule, the detail capsule).
2. **A Yes from either person shortlists** a `new` listing (`status = 'shortlist'`, `status_by` = who said Yes). Taking the last Yes back returns it to `new`. A Maybe or a No never moves the status: a No is a personal call, and Reject stays a tap. A Yes on a listing already further along changes nothing. The detail page shows `new` / `shortlist` as a stage label, not as buttons.
3. **Then the pipeline**, tapped on the detail page: Contacted → Booked (`viewing_booked`) → Viewed → Offer, with **Rejected** and **Gone** as the two end states.
4. **Gone** has two sources: the scraper (`availability = 'gone'|'unlisted'`, unchanged) and the person (`status = 'gone'`, the agent said it is taken). Lists hide both by default; `removed=show|only` includes both; `removed_at` is `status_at` for the person-set case. A `gone` listing is never flagged; `/api/stats` counts both sources in one `gone` bucket. (§16 stores `removed_at` / `removed_reason` rather than inferring them, and gives the archive its own section.)

## 16. Amendment 2026-09-21 — the archive

A listing that leaves the market is kept and made findable, so "what did we miss" is answerable. Nothing new is retained — rows were never deleted (CLAUDE.md) — but the removal is now *recorded* instead of inferred, and it has a place to be read.

1. **Schema** (migration `006_removed_at`): `removed_at TEXT`, `removed_reason TEXT` on `properties`, plus `idx_props_removed`. `removed_reason` is one of `delisted` (the detail page 404/410'd), `archived` (the page is up and says it is unavailable — Bali Home Immo's `is_archived`), `unlisted` (a source that ran cleanly stopped listing it for `STALE_DAYS`+), `taken` (a person tapped Gone) or `merged` (dedupe folded it into a keeper). The migration backfills rows that were already gone.
2. **`last_seen` means the last sighting again.** `markGone` used to overwrite it with the detection moment, which destroyed the only evidence of how long a villa was actually live. It now writes `removed_at` and leaves `last_seen` alone. Everything that dated a removal by `last_seen` — `/api/stats` daily, the agent digest, market metrics' supply flow — reads `COALESCE(removed_at, last_seen)`, so rows removed before the migration still read correctly.
3. **A removed listing is never flagged**, from either source (§15.4 said this; only the person-set case enforced it). `markGone` / `markUnlisted` clear `flagged`, and `scoreRow` will not set it again.
4. **A listing that comes back** loses its stamp: the upsert clears `removed_at` / `removed_reason` when a source shows it again. Its `first_seen` and `price_history` survive. A person-set `status = 'gone'` is theirs and is not cleared by the scraper; moving the status off Gone clears it, and a person tapping Gone never overwrites a record the scraper wrote first.
5. **API**: every row carries `removed_at`, `removed_reason` and `days_live` (`first_seen` → `last_seen`; → `removed_at` for a person-set removal). `GET /api/properties` gains `removed_reason=` (comma list, unknown → 400), `removed_days=<n>` (removed within the last n days) and `sort=removed` (newest loss first). Rows folded away by dedupe (`raw.merged_into`) drop out of `removed=show` and `removed=only`: they are bookkeeping, not a villa that got away.
6. **UI**: a sixth section **Gone** (`#/gone`), a full tab in the rail and the phone capsule. A window control (30 days / 90 days / A year / All) and a lens (All / Never called / We liked it / Went fast), a summary line (how many, the median days live, when the last one went), a count per reason, and the normal cards — each carrying "Gone 3d ago · live 11 days · Page taken down". Calls (Yes / Maybe / No) still work on a gone listing.

## 17. Amendment 2026-09-26 — friends and teams

Philipp and Abigaïl open the app to friends — Marina on her own, Ronnie and Janel together — and nobody's tap may move what anyone else sees. People now sit in **teams**; a team is the unit that shares.

1. **Schema** (migration `010_teams`): `teams (id, name, created_at)`; `team_listings (team_id, property_id, status, status_by, status_at, notes, assessed, PK(team_id, property_id))`; `users` gains `team_id`, `role` (`owner` | `member`), `disabled_at`, `session_epoch` (cookies issued before it are void). Team 1 is the **home team**: the two owners, seeded from `USER1_*` / `USER2_*` on every boot. Its pipeline stays on the `properties` columns, so the scraper and the morning agent read it as before; any other team's pipeline lives in `team_listings` and is laid over `properties` per request (`src/teams.js` `listingsSql`).
2. **What is whose.** Per person: verdicts. Per team, invisible outside it: who called what (the Shared filters compare teammates only), the pipeline status and the journey (a teammate's Yes shortlists for the team), notes, assessed, ratings, feedback, agent info, viewings, places (anchors), pipeline counts and "your shortlist". Shared facts, the same for everyone: listings, photos, pins, beach distances, contacts, market numbers, the scraper's removals — and the home team's person-set Gone, because "the agent says it is let" is a fact. `flagged` is recomputed per team: the shared scope, score and red flags with the team's own status, so a Reject un-features a villa only for the team that rejected it.
3. **The brief stays the owners'.** Budget, areas, bedrooms, weights and the threshold drive scope and fit for everyone, and only owners edit them. A friend's feedback and viewings never reach `learn` or the agent digest, and a friend's viewing never adds a red flag to the shared row.
4. **Owner-only**: every write on the Agent page (sources, weights, threshold, inbox, Run scrape now, duplicate merges and dismissals), imports, manual add, photo upload, contact writes, and editing a listing's facts. Friends may PATCH only `notes` and `assessed`. The API answers 403 `owners_only`. Friends **view** the Agent page read-only: sources, runs (when, not what they found), weights and threshold as plain values, the inbox and the duplicates list, with their own team's flag counts and statuses. The agent's notes and the learner's "what changed and why" stay the owners', because the morning session and `learn` write them from the home team's feedback and viewings (point 2).
5. **People** (`#/people`, owners only, from the account menu): add a person with a starting password into a new solo team, a new shared team or an existing one; reset a password, move a person, disable and re-enable (a disabled person cannot log in and their open sessions end; people are never deleted, their rows carry `by`); rename teams, delete an empty one (never the home team). Owners are managed in `.env`, not here. API: `GET/POST /api/people`, `PATCH /api/people/:id`, `POST /api/teams`, `PATCH/DELETE /api/teams/:id`. **Amendment 2026-09-26 (later)**: each person shows their Yes / Maybe / No tallies (`GET /api/people` members carry `verdicts: {yes, maybe, no}`, counted over every listing). A member's actions sit behind a ⋯ menu — Move… (a dialog: an existing team, or a new one), Reset password… (a dialog), Remove… (a confirm; Remove is the disable above, and a removed person's menu offers Restore).
6. **UI**: `/api/me` returns `{user: {…, team_id, role}, users: [teammates], team: {id, name, solo}}`. A solo team sees no collaboration at all — no Shared tab, no teammate initials, no Match pill, no "Waiting for", no Shared filter group; their own Yes / Maybe / No stays. Members see no owner-only controls: the Agent tab is theirs too, with no form, toggle or button on it and a "View only" line under the heading.

## 18. Amendment 2026-09-27 — the Term chips and "for sale"

Philipp: "we need a way to filter out monthly, yearly, sale. multiple choice." Many agency listings are for sale **and** rent (Bali Home Immo titles them "… for Sale and Rent in …"), and nothing marked them.

1. **`for_sale`** (migration `012_for_sale`, `INTEGER NOT NULL DEFAULT 0`): 1 when the listing is also or only offered to buy, freehold or leasehold. Derived from the text by `src/scrape/sale.js` on every insert and update (`store.js`), on every rescore (`rescoreAll`, `rescoreOne`), and once for the stored rows by the migration. The title counts outright ("for sale", "sale and rent", "leasehold", "freehold", "dijual"); the description only on phrasings that offer the villa ("available for rent or sale", "rental and leasehold", "freehold sale", "Dijual: Rp …"). Since 2026-09-28 also: a lease offered in the text ("Leasehold: 25 Years", "25-Year Leasehold", "Leasehold until 2053", "Ownership: Leasehold", five years and up), "Selling Price", "Harga Jual", "Jual cepat", a line or headline segment opening "FOR SALE" / "Dijual" / "Sale Tanah", and a title carrying a purchase price ("for IDR 1.575B"); bold Unicode headlines are read as plain text (NFKC). Not counted: an agency's page signature ("for more Bali villas for sale please browse this website"), a bare "Freehold (SHM)", which is the land certificate of a rental, "Lease Price" / "Asking Price", which rentals put over their yearly rent, and "Leasehold 2 tahun paling minim", a rental's minimum term. About 8 % of listings on 2026-09-27. It is a listing fact like `term`, shared by every team.
2. **API**: `term=` takes a comma list of `monthly`, `yearly`, `sale` — what to show. A listing shows when it offers one of the chosen rent terms (`both` offers either) or is for sale and `sale` is chosen; leaving `sale` out hides everything that is also for sale. All three, `any` or no `term=` = no filter; an unknown value is a 400. The old single values keep working (`term=yearly` = yearly or both, nothing for sale).
3. **UI**: the filter panel's Term row is three chips, **Monthly · Yearly · For sale**, all on by default; turning one off filters it out and counts on the Filters badge. The last chip on stays on. A Term saved in the browser before the chips (a string) still means what it meant. A card whose listing is for sale says **For sale** first among its feature chips.

