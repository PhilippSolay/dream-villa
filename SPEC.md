# SPEC — villa.solay.cloud

Version 1, 2026-09-17. Source of truth for the build. Companion files: `CLAUDE.md` (conventions), `adapters/bali-home-immo.md` (proven extractor), `KICKOFF.md` (prompt to start Claude Code), `seed/` (first sweep).

---

## 1. Purpose and users

Philipp and Abigaïl are moving from Singakerta (too noisy) to a quiet villa near the beach. This app is their private agent's desk: every listing worth knowing about, filterable and rated, with what the owner said and what a viewing showed, plus a daily scrape so nothing is missed. Two users, both full access, everything attributed by name.

## 2. The brief (drives scoring — keep in `config`)

**Hard filters** (fail → `scope = market`, still stored):
- rooms: `bedrooms >= 1 AND (bedrooms + extra_rooms) >= 2 AND bedrooms <= 3`
- budget: `25_000_000 <= price_month_idr <= 50_000_000` (yearly normalised ÷ 12)
- area: in the target list (§7) — anything else is `market` at best
- style: `style != 'balinese_old'`
- neighbours: no known construction next door (`red_flags` does not contain `construction`)
- furnishing: any (unfurnished gets `notes` hint "unfurnished — add furnishing budget")
- availability: any
- ~~beach~~: **soft** since 2026-09-17 — beach distance never excludes a listing; it is scored (see `beach` row below). `beach_km_max` (4) only sets the scale midpoint and the UI's default slider. Pool is likewise a scored preference, never a filter.

**Aggregation band** (what the scraper keeps at all): bedrooms 1–4, 15–80 M IDR/month equivalent, any beach distance, target areas + adjacent. Outside that band: skip.

**Fit score** (0–100, only meaningful for `in_filter`, but computed for all):

| feature | pts | source field | rule |
|---|---|---|---|
| big open living room | 15 | `living_open` (bool) / text | true → 15; unknown → 7 |
| airy / light | 12 | `airy` | true → 12; unknown → 6 |
| pool | 12 | `pool` | true → 12 |
| garden | 10 | `garden` | true → 10 |
| view | 10 | `view` | ocean → 10, rice/river/jungle → 7, none/unknown → 0 |
| beach | 10 | `beach_km` | ≤ 1 km → 10, linear to 0 at 2 × `beach_km_max` (8 km); unknown → 5 |
| full kitchen | 10 | `kitchen_full` | true → 10; unknown → 5 |
| aircon | 8 | `aircon` | true → 8; unknown → 4 |
| nice furniture | 8 | `furnished` + `furniture_quality` | furnished & quality≥3 → 8; furnished unknown quality → 4; unfurnished → 0 |
| work space / shala | 8 | `workspace` | true → 8 |
| joglo | 7 | `joglo` | true → 7 |

Weights live in `config.weights` (JSON) and are editable in the Agent page; the scraper re-scores everything after a weight change. The score is normalised to the sum of the weights (`round(100 × points / Σweights)`), so edited weights keep the 0–100 scale; with the defaults above (Σ = 110) everything-true + ocean + beach ≤ 1 km = 100, everything unknown = 28.

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
  raw TEXT                               -- JSON of what the adapter saw (for debugging)
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
  feature TEXT NOT NULL,   -- 'quiet','privacy','living_room','light','beach','overall'
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
- `GET /api/properties?scope=in_filter|market|all&status=&area=&min=&max=&beach=&bedrooms=&features=pool,garden&sort=fit|price|beach|new&q=` → `[{…property, contacts:[…], counts:{viewings, ratings, feedback}}]`. Default `scope=in_filter`, hides `rejected` unless `status=rejected|all`.
- `GET /api/properties/:id` → property + `contacts`, `agent_info[]`, `viewings[]`, `ratings[]`, `feedback[]`, `price_history`.
- `POST /api/properties` (manual add: `{url}` → enqueues to inbox and returns a stub, or full object) ; `PATCH /api/properties/:id` (person-editable fields only: `extra_rooms, living_open, airy, workspace, style, beach_km, lat, lng, notes, assessed, red_flags`).
- `POST /api/properties/:id/status {status}` → sets `status, status_by, status_at`.
- `POST /api/properties/:id/ratings {feature, score, comment}`; `POST …/feedback {text}`; `POST …/agent-info {…}`; `POST …/viewings {…}` (multipart with photos allowed); `POST …/contacts {…}` (links or creates by whatsapp).
- `POST /api/properties/:id/images` multipart → stores under `data/images/<id>/` and appends to `images`.

**Contacts**: `GET /api/contacts`, `PATCH /api/contacts/:id`.

**Market**: `GET /api/market` → `{by_area:[{area, n, p25, median, p75, n_in_filter}], by_bedrooms:[…], feature_premium:[{feature, median_with, median_without, n}], shortlist_vs_median:[{property_id, price, area_median}]}` — computed over `scope=all`, band prices, excluding `gone`.

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
- Filter drawer (bottom sheet on phone, left rail on desktop): area checkboxes (grouped: West coast / Bukit), bedrooms 1–4 chips, price range slider 15–80 M (step 0.5 M, dual thumb), beach distance slider 0–10 km, furnished / unfurnished / any, term monthly / yearly / any, feature checkboxes (pool, garden, view, joglo, aircon, full kitchen, workspace, airy/light, open living), status multi-select, assessed on location, source, hide rejected (on), "in-filter only" (on).
- Sort: fit, price, beach, newest.
- Cards: hero image (local file), price `JetBrains Mono` "44 M / mo" (yearly shown "38 M / mo · yearly"), area · sub-area, beach km, bedrooms (+extra rooms), feature chips, fit score ring, status pill, small pin icon linking to `map_url`.
- Pull to refresh is not needed; a "Updated 06:12" line at the bottom from the last run.

**Detail `#/p/:id`** — five tabs:
1. Listing: gallery (swipe), description, inclusions/terms, source links (all `alt_urls`), pin with "Open in Google Maps" and "Directions", scraper facts table (bedrooms, land, build, term, min months, available from, first seen, price history sparkline).
2. Contact: contacts with tap-to-call, tap-to-WhatsApp (`https://wa.me/<number>?text=<prefilled template A>`), agency, responsiveness stars, notes; "Add contact".
3. From the agent: dated entries (`agent_info`), add form with the six question groups from the brief (included, neighbours, planned builds, water/power, lease terms, deposit/payment).
4. Viewing: list of visits; "Add visit" form: date, time of day, 1–5 sliders for quiet, privacy, living room, light, breeze, overlooked, construction nearby; beach minutes measured; notes; photos (camera input); verdict. Saving a visit sets `assessed` (partly → done when verdict set) and, if quiet ≤ 2 or privacy ≤ 2, adds the red flag.
5. Ratings & feedback: pre-viewing feature ratings (six rows), feedback box, status control (pipeline), "Message templates" section with A–G prefilled and a copy button.

**Market `#/market`**: price distribution per area (box/whisker: p25–median–p75 per area, count), per bedrooms, feature premium table, "your shortlist vs area median" table, in-filter vs market counts. Charts as inline SVG, no library.

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
2. `kibarer`, `balirealty`, `exotiq`, `balicoconutliving`, `balivillahub` — agencies; check each has a long-term rental section for Canggu-west / Tabanan / Bukit. Some are JS-rendered → `PLAYWRIGHT=1`.
3. `olx` (olx.co.id, "sewa villa" in Badung/Tabanan), `rumah123`, `lamudi`, `99co` — portals; Indonesian-language; price often "juta/bulan" or "/tahun".
4. `fbmarketplace` — only if reachable without login; otherwise skip (groups are covered by Philipp's Chrome sessions and the phase-5 WhatsApp reader).
5. `inbox` — generic: for any URL in `inbox`, try the matching adapter, else a generic extractor (OpenGraph + JSON-LD `RealEstateListing`/`Product` + regex for `IDR|Rp|juta`, `bedroom|kamar`, `m2|are`). Always store `raw`.

**Normalise** (`src/scrape/normalise.js`): title case titles; area from sub-area/location text via the §7 map; price parsing (`IDR 40.000.000/month`, `Rp 40jt/bln`, `450M/year`, `500 juta / tahun`); term from tags; `min_months` from "Minimum N months"; `beach_km` from "Walk to the beach (350m)" / "5 mins to beach" (walk: 80 m/min; scooter: 400 m/min) else computed (§7); booleans from keywords (pool, garden, joglo, rooftop, aircon/AC, kitchen, office/workspace/studio, open living/open plan/high ceiling → living_open, airy/breezy/light-filled → airy); `style` from keywords (joglo, bamboo, industrial, "traditional Balinese"/"antique"/"old" → balinese_old candidate, flag for review rather than assert); red flags from keywords (construction, "main road", "roadside", "busy road").

**Images**: download every gallery image (max 20/listing) to `data/images/<id>/<n>.jpg`, resize to 1600 px max side with `sharp` (add dependency), keep `src_url`. Hero = first. Skip if already present.

**Pins**: priority `listing_map` (iframe `q=lat,lng` or `@lat,lng`), `geocode` (Nominatim, 1 req/s, `email` param set, query "<sub_area>, <area>, Bali") only when the listing has a street/banjar, else `centroid` (§7) with `pin_source='centroid'`. `map_url = https://www.google.com/maps?q=<lat>,<lng>`.

**Dedupe** (`src/scrape/dedupe.js`): same `key` → update. Else candidate match when `bedrooms` equal AND `area` equal AND price within 5 % AND (title similarity ≥ 0.8 (Dice on trigrams) OR first 60 chars of description equal OR any image `src_url` shared). On match: keep the older row, append `alt_urls`, merge nulls, log to run notes. Never merge across different `bedrooms`. *Amended 2026-09-17:* within the **same source**, title similarity alone is not enough (Bali Home Immo titles are templated and matched 13 distinct villas); it needs the description prefix or a shared image as well. Across sources the rule stands. Units sharing a ref number with a different letter (RF9183A/B) are never merged.

**Score** (§2). **Recheck**: refetch every `status IN (shortlist, contacted, viewing_booked, viewed, offer)` and every `flagged` listing daily; price change → append `price_history`, `changes`; 404/410, `is_archived`/"no longer available" → `availability='gone'`. A page that returns 200 but cannot be parsed is a scraper error, not a delisting — it is logged and the row is left alone.

**Learn** (`src/scrape/learn.js`, rule-based, no LLM required):
- For each unapplied `feedback` row: extract reasons by keyword table (`noise|noisy|road|traffic|dogs|club → quiet`, `dark|no light → airy`, `small living|cramped → living_open`, `far from beach → beach`, `loved the garden → garden+`, `pool` …). A negative reason on feature F raises `weights[F]` by 2 (cap 20); a positive raises by 1. Log `applied_note`.
- For each new viewing with quiet ≤ 2 or privacy ≤ 2: add red flag, and if two or more rejected/low-quiet villas share the same `sub_area` + street keyword, add `low_priority_pockets` to config (used as −10 score in that pocket).
- Every weight change is a `runs` row with `weight_changes` = `[{feature, from, to, because}]`.
- If `ANTHROPIC_API_KEY` is set, `learn` may additionally call Claude (Haiku) to parse free-text feedback into the same reason schema; this is optional and must degrade to the keyword table.

## 7. Areas, centroids, beaches

Canonical `area` values and rough centroids (verify with a geocoder once; these are approximate and only for `pin_source='centroid'`):

| area | label | centroid (lat, lng) | nearest beach point | group |
|---|---|---|---|---|
| seseh | Seseh | -8.628, 115.099 | Seseh Beach -8.6315, 115.0975 | west |
| cemagi | Cemagi | -8.619, 115.103 | Cemagi/Mengening -8.6255, 115.0995 | west |
| munggu | Munggu | -8.617, 115.094 | Munggu Beach -8.6215, 115.0905 | west |
| pererenan | Pererenan | -8.640, 115.121 | Pererenan Beach -8.6475, 115.1185 | west |
| nyanyi | Nyanyi | -8.608, 115.080 | Nyanyi Beach -8.6125, 115.0765 | west |
| kedungu | Kedungu | -8.597, 115.064 | Kedungu Beach -8.6005, 115.0605 | west |
| tanah_lot | Tanah Lot area | -8.615, 115.090 | Tanah Lot -8.6215, 115.0865 | west |
| buwit | Buwit | -8.583, 115.100 | Nyanyi Beach | west (inland ~4–5 km) |
| mengwi | Mengwi | -8.545, 115.170 | Seseh Beach | west (inland ~10 km) |
| bingin | Bingin | -8.806, 115.113 | Bingin Beach -8.8075, 115.1095 | bukit |
| padang_padang | Padang Padang | -8.811, 115.106 | Padang Padang -8.8115, 115.1035 | bukit |
| uluwatu | Uluwatu / Pecatu | -8.829, 115.098 | Suluban -8.8145, 115.0885 | bukit |
| balangan | Balangan | -8.792, 115.124 | Balangan Beach -8.7915, 115.1215 | bukit |
| ungasan | Ungasan | -8.833, 115.160 | Melasti -8.8475, 115.1555 | bukit |
| pandawa | Pandawa / Kutuh | -8.842, 115.190 | Pandawa Beach -8.8455, 115.1875 | bukit |

`beach_km` computed = haversine(pin, nearest beach point) × 1.3 (road factor). Text-derived distances win over computed.

Bali Home Immo location strings → area: `Cemagi / Seseh - Beach Side` → cemagi (if title says Seseh → seseh); `Cemagi / Seseh - Residential Side` → seseh; title containing Munggu → munggu; `Pererenan - Beach Side|North Side` → pererenan (sub_area kept; "Tumbak Bayuh", "Buduk", "Tiying Tutul" are inland north Pererenan, beach_km ≈ 3–5); `Tanah Lot Area - East side (Nyanyi)` → nyanyi; `West side (Kedungu)` → kedungu; `North side (Tabanan)` → buwit if title says Buwit else tanah_lot; `Uluwatu - Bingin*` → bingin; `Padang Padang` → padang_padang; `Balangan` → balangan; `Uluwatu - West|Central|East` → uluwatu; `Ungasan*` → ungasan; `Pandawa*` → pandawa.

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
