# Harvest channels: every way a listing gets into the tracker

The tracker ([villa.solay.cloud](https://villa.solay.cloud)) collects long-term villa rentals in three
regions of Bali: **West coast** (Tanah Lot down through Seseh / Cemagi / Pererenan to the Canggu belt),
**South** (the Bukit: Bingin, Uluwatu, Ungasan) and **Center** (Ubud and the villages around it). The
listings come in through six channels. Whatever the channel, the listing goes through the same
pipeline on the server: normalise → pin on the map → score → store → de-duplicate. People's own
data (ratings, notes, status) is never touched by any of them.

| # | channel | runs | who / what does it | lands through |
|---|---|---|---|---|
| 1 | Agency and portal scrapers | daily 06:00 Asia/Makassar | the server itself | the scraper (`src/scrape/`) |
| 2 | Facebook groups | nightly, 03:00 | a logged-in Chrome + Claude agents (this kit) | `POST /api/import/posts` (source `fb`) |
| 3 | WhatsApp chats and groups | when an owner exports a chat | `npm run import:whatsapp` | `POST /api/import/posts` (source `wa`) |
| 4 | Bali Villa Hub | now and then | a Chrome tab + `browser/bvh-harvester.js` | `POST /api/import/listings` |
| 5 | The inbox | any time | anyone pasting a URL, or the cloud agent | `POST /api/inbox`, `GET /api/agent/inbox` |
| 6 | Single listings by hand | any time | an owner (or an agent on their behalf) | the inbox, or `POST /api/import/listings` |

Every write door is **owner-only** (the owners' session cookie, or the `ADMIN_TOKEN` bearer token,
which acts as the first owner). Friends see what comes in but cannot feed it; to try the import side,
run the tracker locally (`npm run dev`) and point the kit at it with `VILLA_BASE=http://localhost:8080`.

## 1. Agency and portal scrapers (daily)

The server scrapes these sites every morning at 06:00 Asia/Makassar (`npm run scrape` runs the same
thing by hand). One adapter per site in `src/scrape/adapters/`, run in the order of
`src/scrape/adapters/index.js`; the notes behind each one (reachability, URL scheme, quirks) are in
`adapters/<id>.md`. The scrapers are polite: one request per second per host, a normal browser
user agent, back-off on 429/403, and an HTML cache so a page is not fetched twice a day.

| id | site | what it is |
|---|---|---|
| `bhi` | [bali-home-immo.com](https://bali-home-immo.com) | Bali Home Immo, the first and biggest agency; server-rendered |
| `kibarer` | [villabalisale.com](https://www.villabalisale.com) | Kibarer Property (the real domain; kibarer.com is a parked page) |
| `balirealty` | [balirealty.com](https://www.balirealty.com) | Bali Realty, WordPress + Realia theme |
| `balicoconutliving` | [balicoconutliving.com](https://balicoconutliving.com) | Bali Coconut Living, server-rendered index |
| `umadibali` | [umadibali.com](https://umadibali.com) | Uma di Bali Properties, walks the target areas by URL |
| `apexbali` | [apexbali.com](https://apexbali.com) | Apex Property, strongest on the west coast; JSON-LD detail pages |
| `livuma` | [livuma.com](https://livuma.com) | Livuma, a listing portal where owners and agents post; walked through its sitemap |
| `rumah123` | [rumah123.com](https://www.rumah123.com) | Rumah123, the big Indonesian portal; server-rendered |

Sites looked at and **skipped** (no adapter; the evidence is in `adapters/<id>.md`):

| id | site | why |
|---|---|---|
| `exotiq` | exotiqproperty.com | sales-only agency, no long-term rentals |
| `balivillahub` | balivillahub.com | Vercel Security Checkpoint: HTTP 429 on every request, even robots.txt. Harvested from a browser instead, channel 4 |
| `olx` | olx.co.id | Akamai Bot Manager proof-of-work challenge |
| `lamudi` | lamudi.co.id | the edge firewall answers 401 Access Denied to every request |
| `99co` | 99.co | Cloudflare "Just a moment" JavaScript challenge (403) |
| `fbmarketplace` | facebook.com/marketplace | login-only and JavaScript-rendered; Facebook is covered by channel 2 |

A single URL from any of these sites still gets in through the inbox (channel 5).

## 2. Facebook groups (nightly, through a browser)

Most private landlords in Bali advertise in Facebook groups, not on agency sites. Groups cannot be
scraped from a server: they are login-only, the feed is rendered by JavaScript, and Facebook blocks
anything that is not a real logged-in browser. So this kit harvests them the way a person reads them:
a logged-in Chrome window, with an in-page script (`browser/harvester.js`) that scrolls the group in
chronological order, expands "See more", reads each post's text, date, poster and photos, and saves
batches as JSON files to the downloads folder. A watcher (`bin/watch.sh`) imports each file into the
tracker. Claude agents drive the browser through the Claude in Chrome extension: a coordinator plans
the night, a cheaper babysitter agent polls the harvester (`runbooks/`). Nobody clicks or types on
Facebook; the script only scrolls and reads.

- **First harvest: 30 days back.** A group's first run reads its feed back to 30 days before today,
  with a depth guard (at least 25 scroll rounds and 150 posts) so a few pinned or resurfaced old
  posts cannot end it early. A busy group takes up to 90 minutes.
- **Then incremental catch-up, every night.** Once a group has a `last_done` date (in the local,
  untracked `nightly-state.json`), the next run starts from that date minus 2 days, and the ids of
  every post already harvested are preloaded into the script. It stops as soon as it meets 25 known
  posts in a row ("caught up"), usually within about 10 minutes.
- Post-level filtering is the server's job: "looking for" posts, sales, rooms, nightly rentals and
  posts without a rent signal are counted and skipped at import; out-of-band rentals are kept as
  market data for the price statistics.

The groups, in [`groups.json`](groups.json) (run order), as of 2026-10-06. Status: **active** =
harvested every night; **pending** = queued, its first harvest has not completed yet; **deferred** =
off for now; **skipped** = never, with the reason. Whether a group runs as a first harvest or as a
catch-up is decided by `nightly-state.json`, not by this status. Members-only groups need the
harvesting account to be a member.

### West coast (12: 11 active, 1 skipped)

| group | status | notes |
|---|---|---|
| [SESEH PERERENAN VILLAS](https://www.facebook.com/groups/971973697615659) | active |  |
| [SESEH CEMAGI KEDUNGU VILLA & LAND / BUY, SELL, & RENT](https://www.facebook.com/groups/682601905670900) | active |  |
| [SESEH MUNGGU COMMUNITY](https://www.facebook.com/groups/1149882145879552) | active |  |
| [Canggu Seseh villa Rental](https://www.facebook.com/groups/530386003677300) | active |  |
| [Nyanyi, Tanah Lot & Kedungu Tabanan Rental & Housing](https://www.facebook.com/groups/683021575895129) | active |  |
| [Seseh Munggu Cemagi Mengening Nyanyi Villa Land Rental & Sale](https://www.facebook.com/groups/935087911500663) | active |  |
| [CANGGU PERERENAN UMALAS land villa & house RENT/SELL/BUY](https://www.facebook.com/groups/3234845689886542) | active |  |
| [Pererenan Community Housing - Rent Villa Room Seseh Cemagi Kedungu Tumbak](https://www.facebook.com/groups/2230099523983457) | active | members-only |
| [nyanyi, kedunggu and yehgangga property land, house, villa](https://www.facebook.com/groups/1089661415521898) | active |  |
| [CaNGGU Housing//Find your villa in Bali](https://www.facebook.com/groups/1480505465561758) | active |  |
| [Canggu Housing - Rent Room House Villa - Berawa Umalas Pererenan Kerobokan](https://www.facebook.com/groups/canggucommunityhousingbali) | active | members-only |
| [Kedungu Community Housing & Land](https://www.facebook.com/groups/kedungucommunityhousing) | skipped | members-only; join request not approved; the feed is not readable |

### Bukit / South (7: 7 active)

| group | status | notes |
|---|---|---|
| [Uluwatu Bingin Ungasan Long Term Villa Rentals](https://www.facebook.com/groups/1092991768912362) | active |  |
| [BINGIN-ULUWATU VILLA/LAND for RENT](https://www.facebook.com/groups/545600252991788) | active |  |
| [House Rent Jimbaran, Ungasan, Pecatu, Uluwatu, Nusadua](https://www.facebook.com/groups/235219200275280) | active |  |
| [Uluwatu Land & Villas: Ulu, Bingin, Padang, Nyang Nyang, Nunggalan](https://www.facebook.com/groups/3537135643276985) | active |  |
| [Pecatu Uluwatu Land & Villas](https://www.facebook.com/groups/2480132188853806) | active |  |
| [Villa/House/GuestHouse for Rent&Sell Jimbaran, Ungasan, Pecatu and Uluwatu](https://www.facebook.com/groups/1133478877784739) | active |  |
| [Uluwatu Community Housing - Buy rent Villa & Land](https://www.facebook.com/groups/uluwatucommunity) | active | members-only |

### Ubud / Center (35: 14 active, 9 pending, 1 deferred, 11 skipped)

| group | status | notes |
|---|---|---|
| [Ubud Long Term Villa Rentals](https://www.facebook.com/groups/294118640941955) | deferred | the group admin paused posting on 2025-08-24; recheck now and then |
| [Ubud Family Villa - House for rent / Sale](https://www.facebook.com/groups/1775258645956385) | active |  |
| [Ubud Rental Community](https://www.facebook.com/groups/739201996218855) | active |  |
| [Ubud Mindful Villa Rental Direct by Owner - Bali](https://www.facebook.com/groups/1203881647508074) | active |  |
| [UBUD REAL ESTATE (Property Sales & Rentals)](https://www.facebook.com/groups/2064550190483379) | active |  |
| [Ubud Villa Rentals Direct by Owner](https://www.facebook.com/groups/2191710220855231) | active |  |
| [Ubud Villa Rental](https://www.facebook.com/groups/ubudvillarentals) | active |  |
| [House For Rent In Ubud Bali](https://www.facebook.com/groups/905785052822153) | active |  |
| [Property in Ubud (rent or buy)](https://www.facebook.com/groups/ubudproperty) | active |  |
| [land villa for sale/rent ubud](https://www.facebook.com/groups/492241320964939) | active |  |
| [Bali Houses and Land](https://www.facebook.com/groups/ubud.rentals) | active |  |
| [houseswitch ubud, uluwatu, canggu, amed, sanur](https://www.facebook.com/groups/314751259561523) | skipped | archived: admin-paused since Sep 2022, last post Nov 2021; also covers the Bukit |
| [Sacred Valley Housing and Marketing](https://www.facebook.com/groups/514943685262182) | skipped | a Peru group (Pisac / Taray, Sacred Valley), not Bali |
| [Ubud house rentals](https://www.facebook.com/groups/476997090681474) | active | 18K members, 90+ posts a day |
| [Ubud - House & Rental](https://www.facebook.com/groups/430209969164638) | active | 14K members, 40+ posts a day |
| [Ubud Community Housing -Rent villa, land, room, house Penestanan Tegalalang](https://www.facebook.com/groups/632760578889860) | active | 10K members, 90+ posts a day |
| [rent villa / lease hold villa,land bali, ubud,](https://www.facebook.com/groups/537165141600306) | active | 12K members, 90+ posts a day |
| [UBUD House & Rent](https://www.facebook.com/groups/882946489781623) | pending | 8.2K members, 60 posts a day |
| [house,villa, for rent in ubud](https://www.facebook.com/groups/322373738887155) | pending | 5.5K members, 10+ posts a day |
| [Ubud villa and room for rent](https://www.facebook.com/groups/878689880433408) | pending | 5.1K members, 50+ posts a day |
| [Ubud Rentals](https://www.facebook.com/groups/2534956786797976) | pending | 5.4K members, 5 posts a day |
| [UBUD BRAND NEW VILLA RENTAL AND HOUSING](https://www.facebook.com/groups/1446752979816422) | pending | 3.1K members, 50+ posts a day |
| [UBUD VILLA PRIVATE](https://www.facebook.com/groups/912837490578084) | pending | 2.3K members, 10+ posts a day |
| [Ubud Bali Villa Rental direct by Owner \| arenda](https://www.facebook.com/groups/216919092087294) | pending | 95K members but only 8 posts a day |
| [Real Estate Ubud House Finder,Property,Land,Homes for Sale,Lease and Rent](https://www.facebook.com/groups/129654987193494) | pending | 1.4K members |
| [Bali Trusted \| Ubud Villa Rent and Sell](https://www.facebook.com/groups/balitrustedubud) | pending | 871 members, 10 posts a day |
| [VILLA MURAH DI UBUD DAN SEKITARNYA](https://www.facebook.com/groups/195741392306817) | skipped | nightly/staycation villas, not long-term |
| [STAYCATION ON BUDGET IN UBUD (PROMO VILLA MURAH)](https://www.facebook.com/groups/3941247725894863) | skipped | staycation promos, not long-term |
| [INFO SEWA VILLA MURAH DI UBUD](https://www.facebook.com/groups/1944201845812122) | skipped | short-stay villas |
| [Staycation & Dayuse Private Villas Ubud](https://www.facebook.com/groups/1192322959512698) | skipped | day use / staycation |
| [Kost Ubud Area](https://www.facebook.com/groups/768008063736979) | skipped | rooms (kost), out of scope |
| [Info Kost Ubud Area dan sekitaran nya.](https://www.facebook.com/groups/2762058120567227) | skipped | rooms (kost), out of scope |
| [INFO KOS&KONTRAKAN UBUD](https://www.facebook.com/groups/1585087031590990) | skipped | rooms (kost), out of scope |
| [GUEST HOUSE & HOMESTAY UBUD AREA](https://www.facebook.com/groups/670154690944899) | skipped | guest houses / homestays |
| [Ubud Guest House](https://www.facebook.com/groups/ubudguesthouse) | skipped | guest houses |

### Bali-wide (6: 6 pending)

| group | status | notes |
|---|---|---|
| [Monthly Rent Villa & House Bali](https://www.facebook.com/groups/921979121570193) | pending |  |
| [BALI LONG TERM Yearly/Monthly Rentals](https://www.facebook.com/groups/balirealestate) | pending |  |
| [Bali MONTHLY Rental Villas](https://www.facebook.com/groups/balimonthlyvillas) | pending |  |
| [Bali House Apartment Villa for Rent](https://www.facebook.com/groups/balihomerent) | pending |  |
| [BALI RENTAL ROOMS & VILLAS](https://www.facebook.com/groups/460364820648524) | pending |  |
| [Bali Cheap Rentals - not more than 25mill/month](https://www.facebook.com/groups/505131353625199) | pending |  |

Totals: 60 groups, 32 active, 15 pending, 1 deferred, 12 skipped; 47 run each night.

To add a group: append it to `groups.json` (id or slug from its URL, name, url, region, status
`pending`); it gets a 30-day first harvest on the next night.

## 3. WhatsApp chats and groups (exports)

Agencies and landlords also send listings over WhatsApp: in one-to-one chats with an agent and in
local housing groups. There is no live WhatsApp reader; instead an owner exports the chat from the
phone ("Export chat", with media) and imports the zip:

```
npm run import:whatsapp -- "~/Downloads/WhatsApp Chat - <group>.zip" --dry   # show what it would import
npm run import:whatsapp -- "~/Downloads/WhatsApp Chat - <group>.zip"
```

It registers the chat as a `whatsapp_group` source and sends the rent offers to the same door as
Facebook, `POST /api/import/posts`, with source id `wa`. A "post" is one sender's burst of messages
(text, then photos) within 3 minutes; its id is built from the chat, the timestamp and the sender, so
re-importing a newer export of the same chat updates posts instead of duplicating them. The default
reach is 30 days (`--days=N` or `--since=YYYY-MM-DD` change it; `--group=<source id>` and `--name=…` set the channel, `--no-images` skips photos, `--base=URL` and `--token=…` override `VILLA_BASE` and `ADMIN_TOKEN`).
Only photos the phone actually downloaded ship in the export. Target and token as for this kit:
`VILLA_BASE`, `ADMIN_TOKEN`. (The command arrives with the WhatsApp import branch, which is being merged now.)

## 4. Bali Villa Hub (browser harvester)

[balivillahub.com](https://www.balivillahub.com) is a large listings site (about 3,200 listings) that
blocks every server request with a bot checkpoint, but loads fine in a normal browser. So it is
harvested from a Chrome tab: paste `browser/bvh-harvester.js` into the tab's console (or run it
through Claude in Chrome), then `await __bvh.run2(1, 159)`. The script walks the listing pages with
same-origin requests, opens the detail page of every card in a target area, reads the structured
JSON-LD there (price, bedrooms, bathrooms, map pin, photos), and saves files of 80 listings to the
downloads folder (`villa-bvh-listings-*.json`). The watcher imports them through
`POST /api/import/listings` (source `balivillahub`), which keeps only rows inside the band.
`node bin/known-bvh-refs.mjs` lists the refs already held; `__bvh.preload(...)` them first and a
re-run costs about 10 minutes instead of 25. Run it in the foreground tab, alone.

Coverage today is the west coast and the Bukit: the script's area map has no Center areas yet and
skips Ubud cards (`SKIP_AREAS`).

## 5. The inbox (any URL)

Anyone who finds a listing anywhere (an agency site, a portal, a forwarded link) can drop its URL
in the inbox:

- **The Agent page** in the app: paste a URL, or "Add URL from this source" on a channel's row, which
  tags the URL with that channel so the Agent page counts what each Facebook or WhatsApp group
  actually produced. This posts `{url, note, source_id}` to `POST /api/inbox` with the session cookie.
- **A script**, with an owner token:
  ```
  curl -X POST https://villa.solay.cloud/api/inbox \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
    -d '{"url":"https://...","note":"seen on a walk in Pererenan"}'
  ```
- **The cloud agent.** A Claude session reads the tracker every morning at 07:00 through a GET-only
  agent API with its own `AGENT_TOKEN`, which can write nothing but notes and inbox URLs. It queues a
  URL with `GET /api/agent/inbox?token=…&url=…&note=…`.

The inbox is drained on the next scrape run (or at once with `npm run scrape -- --inbox-only`). Each
URL goes to the adapter whose site it is on, else to a generic extractor (OpenGraph, JSON-LD and
price/bedroom patterns). A URL a person chose is always stored, even outside the band (then as
market data). A URL already in the inbox is not added twice.

## 6. Single listings by hand

When an owner pastes a few listing URLs to "harvest":

1. **Check the tracker first.** The daily scrapers may already hold it (look it up in the app by area,
   price and bedrooms, or by its ref).
2. **The site has an adapter** (channel 1): put the URL in the inbox. The adapter reads it exactly
   as the daily run would.
3. **The site has no adapter** (a portal like Livuma was, before its adapter): the generic extractor
   gets such pages half right (on Livuma: 8 of 30 photos, no land size or bathrooms, the wrong
   price). Build the listing yourself from the page's JSON-LD (`RealEstateListing`: name, offers,
   geo, numberOfRooms, numberOfBathroomsTotal, image) and import it:

   ```json
   {
     "source": "livuma",
     "listings": [{
       "ref": "12345", "url": "https://livuma.com/s/12345/villa-pererenan",
       "title": "3BR villa with rice-field view, Pererenan",
       "description": "…", "area": "pererenan", "bedrooms": 3, "bathrooms": 3,
       "price_month_idr": 32000000, "term": "monthly", "min_months": 6,
       "lat": -8.64, "lng": 115.12, "images": ["https://…/1.jpg", "https://…/2.jpg"]
     }]
   }
   ```

   Save it as `villa-listings-<source>-<date>.json` and either drop it in the downloads folder (the
   watcher imports it) or run `ADMIN_TOKEN=… node harvest/bin/import-listings.mjs <file>`. `ref`,
   `url` and `title` are required; everything else is optional and wins over what the server would
   guess from the description. Take the area from the title or the opening line when the portal's own
   region field is coarse. (Alternatively, run the same POST from inside the server's container,
   where `ADMIN_TOKEN` already lives, so the token never leaves the server.)
