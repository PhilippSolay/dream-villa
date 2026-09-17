# Exotiq Property — `exotiq` (NOT IMPLEMENTED — no long-term rentals)

`https://www.exotiqproperty.com` — inspected 2026-09-18 with curl (logged out,
browser UA, `-sL`).

## Verdict

**Reachable, but there is nothing to scrape: Exotiq is a sales-only agency.**
No adapter file was created.

## Evidence

* `robots.txt` allows everything relevant:
  ```
  User-agent: *
  Disallow: /admin/ /login/ /register/ /checkout/ /search/ /cart/ /user/
  Sitemap: https://www.exotiqproperty.com/sitemap.xml
  ```
* `sitemap.xml` — 1 096 URLs, sectioned as:

  | prefix | count |
  |---|---|
  | `/id/…` (Indonesian mirror) | 540 |
  | `/listings/…` | 461 |
  | `/blog/…` | 23 |
  | `/property-for-sale/…` | 19 |
  | `/villas-for-sale/…` | 10 |
  | `/land-for-sale/…` | 10 |
  | `/apartments-for-sale/…` | 5 |
  | `/beachfront-…`, `/off-plan-…`, `/hotels-and-resorts-…`, `/commercial-…`, `/luxury-…`, `/exceptional-…`, `/market-fresh-…`, `/reduced-in-price-…` `-for-sale` | 1–3 each |

  **Zero `for-rent` / `rental` / `lease` category URLs.** Every category slug ends in
  `-for-sale`.
* Site nav (`/all-listings`, homepage) offers only `…-for-sale/<area>` filters — no
  rent/lease toggle, no `filter-contract` equivalent.
* The 12 occurrences of "rental" on `/all-listings` are all sales copy — *"attractive
  rental returns"*, *"strong rental potential"*, *"continuing the current rental with
  ROI of 9 %"* — inside listings offered freehold or leasehold.
* Target-area coverage exists (Ungasan, Pandawa, Kaba-Kaba, Pererenan, Beraban,
  Nyambu) but only for sale.

## Technical notes, if this ever changes

* Webflow site (`cdn.prod.website-files.com`), server-rendered collection lists —
  `div.listing_component` → `a.listing_link[href="/listings/<slug>"]`,
  `h3.listing_title`, `div.listing_details`. No JS needed, no login.
* Detail pages are `/listings/<slug>`; an `/id/listings/<slug>` mirror exists.
* Revisit if Exotiq adds a rentals section; the extractor would be a short Webflow
  card walk over `/all-listings` plus its pagination.
