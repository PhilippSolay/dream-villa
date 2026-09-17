# Bali Villa Hub — `balivillahub` (NOT IMPLEMENTED — bot challenge)

`https://balivillahub.com` — inspected 2026-09-18 with curl (logged out, browser UA).

## Verdict

**Blocked. Every request, including `/robots.txt`, returns HTTP 429 and a
"Vercel Security Checkpoint" interstitial.** No adapter file was created.

## Evidence

Three attempts, escalating headers, all identical:

| attempt | request | result |
|---|---|---|
| 1 | `curl -sL -A <Chrome UA> https://balivillahub.com/` | `429`, 32 189 B |
| 2 | + `Accept-Language: en-US,en;q=0.9` | `429`, 32 178 B |
| 3 | + `Accept`, `Sec-Fetch-Mode/Site/Dest`, `Upgrade-Insecure-Requests` | `429`, 32 183 B |

The body is the same every time:

```html
<!DOCTYPE html><html lang="en" data-astro-cid-4wdtffzm><head>…
<title>Vercel Security Checkpoint</title>
```

`https://balivillahub.com/robots.txt` returns that page too, so there is no robots
policy to read and no sitemap to discover. The site is an Astro app behind Vercel's
bot-mitigation challenge, which is solved in-browser by a JS/cryptographic check.

## Why no Playwright adapter either

CLAUDE.md allows Playwright for pages that are merely *empty without JS*. This is not
that: it is an explicit anti-bot gate returning 429, the HTTP status
`src/scrape/fetch.js` already treats as "back off". Driving a headless browser through
a security checkpoint is working around a site's refusal, not rendering its content —
so the site is skipped rather than automated. A listing from Bali Villa Hub can still
reach the tracker through the `inbox` (paste the URL; the generic extractor runs).

## If this changes

Re-test with a plain `curl -sL -A <Chrome UA> https://balivillahub.com/robots.txt`.
A `200` with a real robots body means the challenge was lifted; the site is an Astro
build, so the listing pages would most likely be server-rendered HTML (or carry a
`__NEXT_DATA__`-style island payload — `_shared.nextData()` is there for that case)
and a normal html-method adapter would do.
