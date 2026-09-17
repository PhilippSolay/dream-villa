# Adapter notes — Lamudi Indonesia (`lamudi`) — **BLOCKED, not implemented**

Checked 2026-09-18 from Philipp's machine with curl, browser UA, `-sL`, HTTP/2 and HTTP/1.1.

## Verdict

**Every request to the host returns `401 Access Denied` (13 bytes).** Not a login wall we could
skip past politely, not a captcha we may solve — an edge WAF rule that refuses the request
before any application code runs. No adapter file exists; the registry has no `lamudi` entry.

| Request | Result |
|---|---|
| `GET https://www.lamudi.co.id/robots.txt` | `401`, body `Access Denied` |
| `GET https://www.lamudi.co.id/bali/badung/villa/rent/` | `401`, body `Access Denied` |
| `GET https://www.lamudi.co.id/bali/rent/` | `401`, body `Access Denied` |
| `GET https://lamudi.co.id/` (bare host, follows to `www`) | `401`, body `Access Denied` |

Because **robots.txt itself is 401**, there is no crawl policy to read; treat the whole host as
off-limits until it answers again. The block looks IP/geo- or ASN-based (a plain browser on the
same connection is the next thing to try by hand, from Philipp's Chrome — if it loads there,
the site is reachable for humans and the value is in the `inbox` route, not in a scraper).

## Nothing else is recorded

No HTML was ever served, so there are no cards, no selectors, no price formats, no location
taxonomy and no detail-page notes here. Anything written down would be a guess, and SPEC §6
says never guess a selector.

## If it ever opens up

Retry order: `robots.txt` first (it must be 200 before anything else is fetched), then one
search URL, and only then write this file properly. Candidate search path seen in Lamudi's
public sitemaps historically: `https://www.lamudi.co.id/bali/badung/villa/rent/` with
`?page=n` — unverified.
