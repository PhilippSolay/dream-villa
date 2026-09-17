# Adapter notes — OLX Indonesia (`olx`) — **BLOCKED, not implemented**

Checked 2026-09-18 from Philipp's machine with curl, browser UA, `-sL`, HTTP/2 and HTTP/1.1.

## Verdict

**Blocked by Akamai Bot Manager.** No adapter file exists; the registry has no `olx` entry.
Re-check in a few months, or feed individual OLX URLs through the `inbox` adapter from a
browser session (the phase-5 route Philipp already uses for Facebook groups).

## What was tried and what came back

| Request | Result |
|---|---|
| `GET https://www.olx.co.id/` with Chrome UA | HTTP/2 stream reset — `curl: (92) HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR`, 0 bytes |
| same with `--http1.1` | `curl: (28) Operation timed out after 45 s with 0 bytes received` |
| `GET https://www.olx.co.id/bali_g2000007/q-sewa-villa` with Chrome UA | same: connection killed, 0 bytes |
| `GET https://www.olx.co.id/` with **no** User-Agent | HTTP 200, 2 221 bytes — an Akamai interstitial, not the site |
| `GET .../bali_g2000007/q-sewa-villa` with no UA | HTTP 200, 2 320 bytes — same interstitial |

The 200-byte-ish body is the Akamai challenge:

```html
<meta http-equiv="refresh" content="5; URL='/?bm-verify=AAQAAAAO…'" />
<iframe src="https://statics.olx.co.id/external/base/splashScreen/boardingScreen.html">
… xhr.open("POST", "/_sec/verify?provider=interstitial", false) … {"bm-verify": "…", "pow": j}
```

i.e. a `bm-verify` proof-of-work token that has to be posted back to `/_sec/verify` by the
page's own JS before any content is served. DNS confirms the edge: `www.olx.co.id` →
`olxid.edgekey.net` → `e178290.dscb.akamaiedge.net`. With a browser UA the fingerprint
mismatch (curl TLS/HTTP2 + Chrome UA) makes Akamai drop the connection outright.

Solving that challenge is bot-detection bypass, which CLAUDE.md and SPEC §6 rule out. Not attempted.

## robots.txt (fetched fine — 200, 437 bytes)

```
User-agent: *
Disallow: /api/      Disallow: /post/   Disallow: /edit/     Disallow: /account/
Disallow: /chat/     Disallow: /profile/ Disallow: /payments/ Disallow: /nf/
Disallow: /items$
Disallow: */*?*filter=*price_     (and condition_, cartype_, mileage_, transmission_, year_)
```

So even if the challenge were not there: the search *pages* are allowed, the internal
`/api/` is not, and the `filter=price_…` facet URLs are not — a future adapter would have to
page plain search URLs and filter prices itself.

## URL scheme observed (from the redirect targets, never rendered)

- Search: `https://www.olx.co.id/{location-slug}_g{geoId}/q-{keywords}` —
  e.g. `bali_g2000007/q-sewa-villa`, `badung-kab_g4000027/q-sewa-villa`.
- Category filter appends `/properti_c5` before the `q-` segment.
- Pagination is `?page=n` on the same path.

Unverified — no card HTML was ever seen, so **no selectors are recorded here on purpose**
(SPEC: never guess a selector).
