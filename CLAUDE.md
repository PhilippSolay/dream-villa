# villa.solay.cloud — Bali Dream House tracker

Private villa-search tracker for Philipp and Abigaïl. One Docker container on the Hostinger VPS behind Traefik. Read `SPEC.md` before touching anything; it is the contract. Read `adapters/bali-home-immo.md` before touching the scraper.

## What this is
- A mobile-first web app (two logins) to browse, filter, rate and annotate villa listings in west Bali (Seseh / Cemagi / Pererenan / Tanah Lot area / Buwit / Mengwi) and the Bukit (Bingin / Uluwatu / Ungasan).
- A scraper that runs daily at 06:00 Asia/Makassar inside the same service, pulls listings from agency sites and portals, downloads images, resolves map pins, dedupes, scores, flags.
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
- `scope` is `in_filter` or `market`; both are stored, the UI defaults to `in_filter`.
- Never delete listings; mark `availability = 'gone'` with `last_seen`.
- Secrets only in `.env` (see `.env.example`). Tokens in query strings are allowed only on `/api/agent/*` (the cloud session can only do GET), over HTTPS, rate-limited, with a dedicated `AGENT_TOKEN` that cannot write anything but notes and inbox URLs.
- Respect source sites: one request per second per host, normal browser UA, cache HTML for 24 h in `data/cache/`, back off on 429/403.

## People
- Philipp (owner, `USER1_*` env) and Abigaïl (`USER2_*` env). Both are admins in the app; there are no other roles.
