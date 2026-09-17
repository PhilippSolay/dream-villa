# Adapter notes — Facebook Marketplace (`fbmarketplace`) — **SKIPPED, as SPEC §6 allows**

SPEC §6 item 4: *"only if reachable without login; otherwise skip (groups are covered by
Philipp's Chrome sessions and the phase-5 WhatsApp reader)."*

Checked 2026-09-18, 15-minute box, curl with a browser UA and `-sL`:

| Request | Result |
|---|---|
| `GET https://www.facebook.com/marketplace/bali/search?query=villa%20rent%20canggu` | HTTP **400**, 1 542 bytes |
| `GET https://www.facebook.com/marketplace/category/propertyrentals` | HTTP **400**, 1 542 bytes |

Both return the same static error shell — `<title>Error</title>`, `<meta name="robots"
content="noindex,nofollow">`, "Sorry, something went wrong" — with no listing data, no
JSON payload and no login form to even inspect. Marketplace is a logged-in-only, JS-rendered
surface; an anonymous request never reaches a search result.

**Verdict: skip.** No `src/scrape/adapters/fbmarketplace.js`, no registry entry, no tests.
Anything more would mean authenticating as Philipp, which this scraper must never do.

## The route that does work

Philipp pastes a Marketplace URL (or a group post URL) into the app's **inbox** while logged
into Facebook in his own Chrome; `src/scrape/inbox.js` + `adapters/generic.js` take it from
there (OpenGraph + JSON-LD + the `Rp|juta|kamar` regexes). That is the intended path for
Facebook content and it needs no change here.
