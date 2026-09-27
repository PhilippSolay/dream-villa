# villa.solay.cloud

Private villa-search tracker for Philipp and Abigaïl. Browses, filters, rates and
annotates long-term rentals in west Bali and the Bukit, scraped daily and read by a
morning Claude session.

Read `SPEC.md` first — it is the contract. `CLAUDE.md` has the working conventions.
Adapter notes live in `adapters/`.

## Stack

Node 20, ES modules, no build step. Fastify + better-sqlite3 (`data/villa.db`).
Scraping: undici + cheerio, Playwright only behind `PLAYWRIGHT=1`. node-cron for the
daily job. bcryptjs + a signed HttpOnly cookie for auth. Images via `@fastify/static`
+ sharp. Frontend: vanilla JS, one `public/index.html` / `app.js` / `styles.css`.
Tests: `node --test`.

## Local dev

```
npm install
cp .env.example .env && nano .env      # openssl rand -hex 32 for each secret/token
npm run dev                             # :8080, watch mode
npm test
npm run seed -- ./seed/bhi-sweep-2026-09-17.json
npm run scrape -- --source=bhi --dry
```

`npm run seed -- <file>` flags: `--no-detail` (skip detail-page enrichment),
`--no-images` (skip the image pass), `--limit=N` (first N rows only).

`npm run scrape` flags: `--source=bhi` (or a comma list; omit for every adapter),
`--dry` (print what would be upserted, write nothing), `--limit=N` (cap per adapter),
`--no-detail`, `--no-images`, `--inbox-only` (just drain the inbox, skip the crawl).

## Images

Every gallery image is downloaded once, resized to max 1600 px JPEG q82 and stored at
`data/images/<id>/<n>.jpg`; the DB entry keeps `{ src_url, file, w, h, hash }`, where `hash`
is the 64-bit perceptual dHash (`src/scrape/image-hash.js`) dedupe uses to recognise the
same photograph re-uploaded by a different agency. `npm run images:audit [-- --fix]` checks
(and repairs) what is actually on disk; `npm run images:hash [-- --limit=N] [-- --ids=1,2]`
back-fills `hash` on files stored before hashing existed and prints a JSON summary.

## Sources

Working adapters, in run order (`src/scrape/adapters/index.js`):

| id | site | notes |
|---|---|---|
| `bhi` | Bali Home Immo | server-rendered, proven first |
| `kibarer` | Kibarer Property (villabalisale.com — the real domain, not kibarer.com) | server-rendered Laravel |
| `balirealty` | Bali Realty | WordPress + Realia theme, server-rendered |
| `balicoconutliving` | Bali Coconut Living | server-rendered index, JS only on the search form |
| `umadibali` | Uma di Bali Properties | WordPress, server-rendered; walks the §7 locations by URL, skips the rented archive |
| `rumah123` | Rumah123 (portal) | Next.js app-router but fully server-rendered HTML |

Skipped — no adapter, see `adapters/<id>.md` for the evidence:

| id | why |
|---|---|
| `exotiq` | sales-only agency, no long-term rentals |
| `balivillahub` | Vercel Security Checkpoint — 429 on every request, even robots.txt |
| `olx` | Akamai Bot Manager proof-of-work challenge |
| `lamudi` | edge WAF returns 401 Access Denied on every request |
| `99co` | Cloudflare "Just a moment" JS challenge (403) |
| `fbmarketplace` | login-only, JS-rendered; SPEC §6 allows skipping it |

Manual: **inbox**. Any URL — including the blocked sources above, or a WhatsApp/FB
forward — goes through `src/scrape/inbox.js`: matched against a known adapter's
hostname, else the generic extractor (OpenGraph + JSON-LD + `Rp|juta|kamar` regexes).

### Adding a URL to the inbox

- **Agent page** in the app → "Add URL from this source" (or the inbox box directly):
  posts `{url, note, source_id}` to `POST /api/inbox` using your session cookie.
- **From the terminal / a script**, with the admin token:
  ```
  curl -X POST https://villa.solay.cloud/api/inbox \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
    -d '{"url":"https://...","note":"from Abigaïl","source_id":"..."}'
  ```
- **The cloud agent session** queues one with a plain GET (no body, so no auth header
  needed from a tool that can only fetch): `GET /api/agent/inbox?token=&url=&note=`.

The inbox is drained on the next scrape run (or `--inbox-only`).

## Agent API

SPEC §4 — GET-only, `text/plain` bodies containing JSON, token in the query string
*or* an `Authorization: Bearer` header, HTTPS required outside dev, 60 requests/hour
per token across the whole set (`src/routes/agent.js`).

| endpoint | does |
|---|---|
| `GET /api/agent/digest?token=` | new/flagged listings, changes, feedback, viewings, last run, weights, counts — under 40 KB, advances `last_digest_at` |
| `GET /api/agent/note?token=&text=` | appends a dated note (1–2000 chars) |
| `GET /api/agent/inbox?token=&url=&note=` | queues a URL for the next scrape |
| `GET /api/agent/weights?token=[&set=]` | reads weights, or sets named weights (JSON object, each 0–20) and rescores |
| `GET /api/agent/feedback-applied?token=&id=[&note=]` | marks a feedback row as applied |

## Daily schedule

`SCRAPE_CRON` (default `0 6 * * *`, `TZ=Asia/Makassar`) runs the full scrape — every
enabled adapter, images, geocode, dedupe, score, recheck, learn — then a backup
(`data/backups/villa-<date>.db`, keep 14). A tick that finds a scrape still running
(its own or one started from the Agent page) is skipped, not queued. `SCRAPE_CRON=off`
disables it.

The scrape, the backup, `POST /api/scrape`, the two import routes and every full rescore
(after a weight or threshold edit, or a migration) never run on the web thread: each is a job (`src/jobs/`) in a child process
of its own with its own SQLite connection, so photos and the API keep answering while
it works. Same container, no extra service.

## The archive (Gone)

A listing is never deleted. When a source stops offering it — the detail page 404s
(`delisted`), the page says unavailable (`archived`), it drops off the index for three
days (`unlisted`) — or a person taps Gone because the agent said it is taken (`taken`),
the row is stamped with `removed_at` and `removed_reason` and moves to the **Gone** tab
(`#/gone`), where it says how long it was live and whether either of you ever called it.
`last_seen` stays the last real sighting, so "live 11 days" is a real figure. Duplicates
folded away by dedupe (`merged`) never appear there. See SPEC §16.

```
GET /api/properties?removed=only&sort=removed&removed_days=30
GET /api/properties?removed=only&removed_reason=delisted,archived
```

## Deploy

VPS: Hostinger, `/opt/villa`, behind the existing Traefik (`proxy` network,
`mytlschallenge` resolver — same as `bali.solay.cloud`). Primary path is a direct git
push from the Mac to a bare repo on the VPS; GitHub's SSH/API are unreliable from here
and the VPS has no GitHub credentials.

**First time:**
```
ssh ibukadek-vps 'bash -s' < scripts/vps-bootstrap.sh   # creates /opt/villa.git + hook + data dirs + a starter .env
ssh ibukadek-vps                                        # then, on the VPS:
nano /opt/villa/.env                                     # set USER1_PASSWORD, USER2_PASSWORD (and check names/emails)
exit
scripts/deploy.sh --data                                 # push, sync data/villa.db + data/images, build, start, health-check
```

**Every later deploy**, from the Mac, on a clean `master`:
```
scripts/deploy.sh            # push, rebuild, restart, health-check
scripts/deploy.sh --dry      # see the commands first
```
Refuses to run on a dirty tree or a branch other than `master`.

**Alternative (GitHub clone)**, if the direct push path is ever unavailable:
```
ssh ibukadek-vps
cd /opt && git clone https://<token>@github.com/PhilippSolay/dream-villa.git villa
cd villa && cp .env.example .env && nano .env
docker compose up -d --build
docker compose exec villa npm run seed -- seed/bhi-sweep-2026-09-17.json
```

**Logs:** `ssh ibukadek-vps 'cd /opt/villa && docker compose logs -f villa'`

**Run a scrape or seed inside the container:**
```
ssh ibukadek-vps 'cd /opt/villa && docker compose exec villa npm run scrape -- --source=bhi --dry'
ssh ibukadek-vps 'cd /opt/villa && docker compose exec villa npm run seed -- seed/bhi-sweep-2026-09-17.json'
```

**Rotate `AGENT_TOKEN`:** edit `AGENT_TOKEN=` in `/opt/villa/.env` on the VPS, then
`docker compose up -d --build` (env is read once at container start) to pick it up.
Send Philipp the new value for the Cowork "Bali Villa" project's 07:00 morning run.

## Backups

`scripts/backup-pull.sh` rsyncs `/opt/villa/data/backups/` down to
`~/Developer/villa-backups/` on the Mac. Restoring: stop the container, copy a dated
`.db` over `data/villa.db`, start it again:
```
ssh ibukadek-vps 'cd /opt/villa && docker compose stop villa'
ssh ibukadek-vps 'cp /opt/villa/data/backups/villa-2026-09-17.db /opt/villa/data/villa.db'
ssh ibukadek-vps 'cd /opt/villa && docker compose start villa'
```

## Troubleshooting

- **Cert not issued** — check `docker logs traefik-traefik-1` for ACME errors, and
  confirm Cloudflare's SSL/TLS mode is **Full** (not Flexible) for `solay.cloud`.
- **401 on the agent API** — wrong or missing `token`; it must match `AGENT_TOKEN` in
  `/opt/villa/.env` exactly.
- **Scrape looks stuck or empty** — a source may be backing off after a 429/403; check
  `data/cache/` (24 h HTML/JSON cache) and the adapter's page under `adapters/*.md`.

See also: `SPEC.md`, `CLAUDE.md`, `adapters/`.
