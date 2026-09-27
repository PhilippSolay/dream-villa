# villa.solay.cloud — Bali Dream House tracker

Private villa-search tracker for Philipp and Abigaïl. One Docker container on the Hostinger VPS behind Traefik. Read `SPEC.md` before touching anything; it is the contract. Read `adapters/bali-home-immo.md` before touching the scraper.

## What this is
- A mobile-first web app (two owners, plus friends in their own teams) to browse, filter, rate and annotate villa listings in three regions (SPEC §7): **Center** (Ubud and the desa around it — Tegallalang, Payangan, Pejeng, Lodtunduh), **West Coast** (Tanah Lot area down through Seseh / Cemagi / Pererenan to the Canggu belt) and **South** (the Bukit: Bingin / Uluwatu / Ungasan).
- A scraper that runs daily at 06:00 Asia/Makassar inside the same service, pulls listings from agency sites and portals, downloads images, resolves map pins, dedupes, scores, flags. It runs in a child process (`src/jobs/`), as do the imports, the backup and the post-migration rescore, so the web thread keeps serving while they work. New heavy work belongs there too: better-sqlite3 is synchronous.
- A small GET-only "agent API" that a cloud Claude session reads every morning at 07:00 to write the push notification and leave notes.

## Stack (do not swap without asking)
- Node 20, ES modules. Server: Fastify. DB: better-sqlite3 (file at `data/villa.db`). Scraping: undici fetch + cheerio; Playwright only behind `PLAYWRIGHT=1` for JS-rendered sources. Scheduling: node-cron. Auth: bcryptjs + signed HttpOnly cookie (`@fastify/cookie` + `@fastify/session` or a hand-rolled HMAC cookie). Images: served from `data/images/` by `@fastify/static`. Map: Leaflet + OpenStreetMap tiles.
- Frontend: vanilla ES modules + a tiny reactive store, no framework, no build step. One `public/index.html`, `public/app.js`, `public/styles.css`. Fonts via Google Fonts.
- Tests: `node --test`. Lint: none required. Keep dependencies minimal.

## Commands
- `npm run dev` — server with watch on :8080
- `npm run seed -- ./seed/bhi-sweep-2026-09-17.json` — import a sweep file
- `npm run scrape -- --source=bhi --dry` — run one adapter, print what would be upserted
- `npm run scrape` — full daily run (all adapters, images, scoring)
- `npm test`
- `docker compose up -d --build` — on the VPS

## Design system (Philipp's)
- Type: Instrument Serif (display, headings), DM Sans (body, UI), JetBrains Mono (prices, refs, distances).
- Palette: warm near-black + gold. Tokens live in `public/styles.css` `:root`; light and dark both required (`prefers-color-scheme` + `data-theme` override).
- Phone first (ratings happen standing in a villa), then desktop two-pane. Touch targets ≥ 44 px. No emoji in UI.

## Conventions
- All money is IDR integers per month. Yearly prices are stored as `price_year_idr` and normalised to `price_month_idr = round(price_year_idr / 12)` when no monthly price is given; `term` records what the listing actually offers.
- Every row that a person creates carries `by` (user id) and `created_at`. Never overwrite a person's rating, note or status from the scraper; the scraper only touches listing facts.
- `scope` is `in_filter` or `market`; both are stored and the flag rule reads it, but the list, map and queues show every listing the visible filters let through (no in-filter switch since 2026-09-27).
- Never delete listings; mark `availability = 'gone'` with `last_seen`.
- Secrets only in `.env` (see `.env.example`). Tokens in query strings are allowed only on `/api/agent/*` (the cloud session can only do GET), over HTTPS, rate-limited, with a dedicated `AGENT_TOKEN` that cannot write anything but notes and inbox URLs.
- Respect source sites: one request per second per host, normal browser UA, back off on 429/403. HTML is cached in `data/cache/`: index/list pages (and sitemaps) 24 h; the detail page of a listing we already hold 7 days, refreshed on the listing's own weekday (a seventh a day) and busted to a same-day fetch when today's card shows a different price, status, bedrooms or title (Livuma: or a newer sitemap `lastmod`); a brand-new ref is fetched at once. A cached detail never overwrites the facts today's card states. Rule and code: `src/scrape/ingest.js` (`detailPlan`); the recheck always fetches fresh.

## People
- Philipp (`USER1_*` env) and Abigaïl (`USER2_*` env) are the two owners and the home team (team 1). Friends are `member`s in their own teams, added from the People page (`#/people`), never via env. SPEC §17 is the contract: verdicts per person; pipeline, notes, visits and places per team; listing facts shared; the brief and all admin owner-only.
- A new route that shows listings to a person reads through `listingsSql(db, request.user)`; a new person-created table is read with `sameTeamSql`; a new write to shared state is `app.requireOwner`.
