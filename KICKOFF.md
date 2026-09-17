# Kickoff — paste this into Claude Code

Setup first (2 minutes):

```bash
mkdir -p ~/code/villa && cd ~/code/villa && git init
# copy CLAUDE.md, SPEC.md, KICKOFF.md and adapters/ from the handoff folder into this directory
mkdir -p seed && mv ~/Downloads/bhi-sweep-2026-09-17.json seed/
claude
```

Then paste:

---

Read CLAUDE.md, SPEC.md and adapters/bali-home-immo.md in full before writing code. They are the contract; where they say "inspect first", fetch the real page and look before choosing selectors.

Build the tracker in this order, committing after each step, and stop for my review after step 3 and step 6:

1. Scaffold: package.json (Fastify, better-sqlite3, bcryptjs, @fastify/cookie, @fastify/session, @fastify/static, @fastify/multipart, cheerio, undici, node-cron, sharp), `src/db.js` with the SPEC §3 DDL and migrations, `src/auth.js` seeding the two users from env, `/healthz`, `.env.example`, Dockerfile, docker-compose.yml with the Traefik labels from SPEC §9 (network and certresolver from env).
2. `src/scrape/normalise.js` and `src/scrape/score.js` with unit tests for every price format, the area map in SPEC §7, beach-distance parsing, the fit score and the flag rule.
3. `npm run seed`: import `seed/bhi-sweep-2026-09-17.json` (format in SPEC §8, dirt rules included), then print counts: total, in_filter, flagged, per area. **Stop here and show me the flagged list.**
4. `src/scrape/adapters/bhi.js`: port the extractor from adapters/bali-home-immo.md; inspect one detail page with curl and implement `detail()` (description, gallery, facts, map pin, WhatsApp/agent). Then images (sharp, 1600 px), pins (listing map → Nominatim → centroid), dedupe, recheck, learn, `runs` logging, cron at 06:00 Asia/Makassar. `npm run scrape -- --source=bhi --dry` must list every target area.
5. API per SPEC §4 including the GET-only `/api/agent/*` endpoints with `AGENT_TOKEN` and rate limiting; integration tests with `node --test` against a temp DB.
6. UI per SPEC §5 in Philipp's design system (Instrument Serif / DM Sans / JetBrains Mono, warm near-black + gold, light and dark), phone first: home with filters/sliders/sort, five-tab detail (Listing, Contact, From the agent, Viewing, Ratings & feedback with templates A–G), Market, Map, Agent, Login. **Stop here; I'll test on my phone.**
7. Second adapter batch (Kibarer, Bali Realty, Exotiq, Bali Coconut Living, Bali Villa Hub) and the portals (OLX, Rumah123, Lamudi, 99.co): check each site's long-term rental pages for the target areas first; skip any that need login; use Playwright only where the HTML is empty without JS.
8. README with the VPS deploy steps (SPEC §9), backup cron, and how to add a URL to the inbox.

Constraints: no framework on the frontend, no build step, dependencies minimal, never guess a selector, never delete a listing, every person-made write carries `by`. Ask me only when SPEC is silent.

---

After step 8, deploy:

```bash
ssh <vps>
git clone <repo> villa && cd villa && cp .env.example .env && nano .env   # set users, tokens, TRAEFIK_NETWORK, TRAEFIK_CERTRESOLVER
docker compose up -d --build
docker compose exec villa npm run seed -- seed/bhi-sweep-2026-09-17.json
```

Then send me (the Cowork "Bali Villa" project) the `AGENT_TOKEN` so the 07:00 morning run can read `https://villa.solay.cloud/api/agent/digest`.
