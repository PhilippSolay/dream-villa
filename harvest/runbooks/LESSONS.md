# Lessons from the first harvest nights (2026-09-19 → 2026-10-06)

What the first two weeks of Facebook and Bali Villa Hub harvesting taught, kept so nobody has to
learn it again. The runbooks already apply all of it; this is the why.

## The browser and the extension
- **One tool call at a time.** A `browser_batch` with 16 waits and a poll timed out and closed the
  whole Claude in Chrome tab group; afterwards every javascript_tool call timed out until the
  extension was reloaded by hand. Babysitters never use browser_batch.
- **Babysitters must not Bash-sleep or run anything in the background**: it ends their turn. Wait with
  `computer` waits or a short in-page `await new Promise(...)` (one javascript_tool call must finish
  within ~45 s).
- **The feed only loads while the tab is visible** (`document.visibilityState`). A hidden tab shows
  skeletons forever, so the harvest pauses whenever the window is covered: by the Claude app, by
  another window, by a locked screen or a closed lid. The fix that worked: AppleScript that makes the
  harvest tab the active tab of its own window and raises that window (RUNBOOK step 3). On one night
  "hidden" was neither lid nor lock: the tab sat in the background of a window with 169 other tabs.
- **Facebook wipes localStorage**, so the harvester keeps posts in memory and downloads them as files
  (auto-flush every 100 posts) before anything navigates away.
- **A tab freezes after ~1,000 expanded posts** unless the DOM is lightened; the harvester blanks
  images far above the viewport every 5 rounds. A frozen tab: close it, open a new one, reinstall.
- **Bali Villa Hub in a background tab froze the renderer after 3 pages** (timer throttling). Run it
  in the foreground, alone, or use `__bvh.run3`, which paces by network latency instead of timers.
- **Chrome must allow automatic downloads** for the site, or only the first file of a run arrives.

## Facebook groups
- **"Join group" is not "private".** The button also shows on public groups you have not joined, and
  their feed is readable. One group (1089661415521898) was skipped by mistake on it. Skip only when
  there is no feed.
- **Group search caps at a handful of results per query.** Vary the query ("ubud long term rental",
  "ubud house rent", ...) rather than scrolling one result list; your joined-groups page
  (`facebook.com/groups/joins/`) is the cheapest way to see which ones you can already read.
- **30-day cutoff** for a group's first harvest, every group (general Bali-wide ones included).
  Older history is not worth the scroll time: rents and availability go stale.
- **Stop rule history.** v5 ended a group when the 5th-oldest date on the page passed the cutoff; on
  pinned and resurfaced posts that stuck for 20–30 rounds (Canggu Housing) or ended a group far too
  early (55 posts instead of 178 on CANGGU PERERENAN UMALAS before the 25-round / 150-post guard).
  v6 reads a "frontier" in scroll order with pinned posts left out; v6.1 adds the known-run stop, so
  an incremental catch-up ends 25 known posts after the last new one.
- **Preload the known ids, all of them.** Stale or empty `known/<id>.json` files made shifts run
  twice as slow; the coordinator rebuilds them at setup.
- **Yield.** A new group mostly yields market rows and cross-post duplicates: three new west-coast
  groups gave 4 in-filter listings on night 2. Night 1: 892 posts → 122 rent offers.
- **Cost.** Sonnet babysitters still tend to poll about once a minute instead of every 3–4 minutes:
  roughly 150–400k tokens per group. Full photo galleries cost ~15 s per rent post.

## Imports
- `/api/import/posts` runs the duplicate merge after every file; `/api/import/listings` does not (its
  images and hashes arrive in the background), so run the merge once at the end of a night that
  imported listings.
- Merge rule: same area plus at least 2 identical photos (perceptual hash), the agency row kept over a
  post, agent logos ignored. A photo seen on listings in two areas or with two bedroom counts is
  treated as a logo.
- The server keeps only the aggregation band (15–80 M, 1–4 bedrooms, target areas) for listings
  imports; out-of-band Facebook posts still import, as market rows for the price statistics.
- A deploy restarts the container for 30–60 s. `bin/retry.mjs` rides that out (10/20/40/60/60/60 s);
  a chunk that still fails makes the importer exit 1 and the watcher files it as `FAILED-`, never as
  imported (a file once lost chunks to a deploy that way).
- Relative Facebook times ("6d", "Yesterday at 8:15 PM") must be resolved against the file's export
  time, not the import time, or a backfilled batch lands on today (`bin/fix-dates.mjs` repaired the
  early archive).

## Night 2 (2026-09-21 → 22), for scale
Agency scrapers that night: BHI 484, Kibarer 265, Bali Realty 16, Coconut Living 42, Rumah123 569 seen.
Bali Villa Hub: 159 pages, 1,464 refs preloaded → 40 new.

| group | status | rounds | posts | imported new | reached |
|---|---|---|---|---|---|
| SESEH PERERENAN VILLAS (incremental) | done | 18 | 1517 | 18 | 09-07 |
| Nyanyi, Tanah Lot & Kedungu (incremental) | done | 14 | 330 | 4 | 09-18 |
| Canggu Seseh villa Rental (incremental) | done | 38 | 966 | 3 (+49 updated) | 09-18 |
| Seseh Munggu Cemagi Mengening (incremental) | done | 9 | 269 | 7 | 09-18 |
| CANGGU PERERENAN UMALAS (incremental) | done | 6 | 235 | 30 | — |
| nyanyi, kedunggu and yehgangga | stalled | 82 | 925 | 17 | 09-08 |
| SESEH CEMAGI KEDUNGU | done | 25 | 1267 | 6 | 07-16 |
| SESEH MUNGGU COMMUNITY (new) | done | 73 | 485 | 93 | 07-25 |
| CaNGGU Housing (new) | done | 25 | 183 | 95 | 05-16 |
| Pererenan Community Housing (members-only, new) | done | 35 | 253 | 34 | 08-14 |
| Canggu Housing (members-only, new) | stalled | 131 | 881 | 123 | 08-29 |

Where the 344 imported rows went: 185 merged as duplicates (119 Facebook cross-posts with identical
text, 45 Rumah123 relistings, 21 Bali Villa Hub), 96 market-only (44 outside the target areas, 25
outside 20–80 M, 15 with unknown or 4+ bedrooms, the rest flags), 63 new in filter (41 west coast,
22 Bukit). The morning merge pass then found 101 more shared-photo duplicates.
