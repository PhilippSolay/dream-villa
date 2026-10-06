# harvest/ — the browser harvest kit

The tracker's server scrapes agency websites by itself (see [channels.md](channels.md) §1). Two
sources cannot be scraped from a server: **Facebook groups**, which are login-only and rendered by
JavaScript, and **Bali Villa Hub**, which answers every server request with a bot checkpoint. This
kit harvests both from a real, logged-in Chrome window and imports what it reads into the tracker.

It is built to be run by **Claude agents**: a coordinator agent plans a night and keeps the state, a
cheaper babysitter agent (Sonnet) drives the Chrome tab through the Claude in Chrome extension and
polls the harvester every few minutes. The runbooks in `runbooks/` are written for those agents.
A person can do every step by hand too (below).

[channels.md](channels.md) lists every way a listing gets into the tracker, including every
Facebook group this kit reads.

## What is in here

```
browser/harvester.js      in-page Facebook group harvester (v6.1); installs window.__villa
browser/bvh-harvester.js  in-page Bali Villa Hub harvester; installs window.__bvh
bin/import.mjs            import one Facebook file  -> POST /api/import/posts    (chunks of 200)
bin/import-listings.mjs   import one listings file  -> POST /api/import/listings (chunks of 50)
bin/retry.mjs             fetch with retries through a deploy restart (~4 min)
bin/watch.sh              imports every harvest file that lands in the downloads folder, then archives it
bin/start.sh, bin/stop.sh watcher + keep-awake on / off
bin/state.mjs             the nightly queue (groups.json + nightly-state.json); records finished groups
bin/known-ids.mjs         ids of the posts already harvested for a group (for __villa.preload)
bin/known-bvh-refs.mjs    refs of the Bali Villa Hub listings already harvested (for __bvh.preload)
bin/merge.mjs             merge a group's archived files into one, best text and photo per post
bin/fix-dates.mjs         one-off: re-date archived posts saved before the date-parser fix
bin/lib.mjs               shared paths, token, date parser
groups.json               the Facebook groups: id, name, url, region, status
runbooks/NIGHTLY.md       coordinator runbook for one night
runbooks/SHIFT-RULES.md   the babysitter's exact per-group procedure
runbooks/BABYSITTER-PROMPT.md, runbooks/RUNBOOK.md   babysitter background, recovery, Bali Villa Hub
runbooks/LESSONS.md       what the first nights taught, and why the rules are what they are
test/                     node --test harvest/test
```

## Setup

- Node 20 or newer (no npm install needed: the kit uses only Node's standard library), bash, and on
  a Mac optionally `jq` for chunked preloads.
- Google Chrome, logged in to Facebook with an account that is a member of the members-only groups,
  and the Claude in Chrome extension if agents drive it. Allow automatic downloads for facebook.com
  and balivillahub.com, or only the first file of a run arrives.
- Environment:

  | variable | meaning | default |
  |---|---|---|
  | `ADMIN_TOKEN` | an owner's bearer token for the tracker (the import routes are owner-only) | none, required |
  | `VILLA_BASE` | the tracker to import into | `https://villa.solay.cloud` |
  | `HARVEST_DIR` | working directory: archived files, `known/`, logs, `nightly-state.json` | this `harvest/` directory |
  | `HARVEST_DOWNLOADS` | where Chrome saves files | `~/Downloads` |
  | `HARVEST_TZ` | the zone "today" is taken in for cutoffs | `Asia/Makassar` |

  Export the token in your shell; never put it in a file in the repo or on a command line. Without a
  token for the live tracker, run the tracker locally (`npm run dev`) and set
  `VILLA_BASE=http://localhost:8080` with the local `ADMIN_TOKEN` from your `.env`.
- Everything the kit writes into `HARVEST_DIR` is gitignored (`harvest/.gitignore`): harvested files
  hold other people's posts and photos and grow to many gigabytes.

## How a night runs

1. **Start** (`bin/start.sh`): the watcher starts in the background and the machine is kept awake
   (`caffeinate` on a Mac; with `HARVEST_DISABLESLEEP=1` also `pmset disablesleep`, for a Mac that
   should keep going with the lid closed. That one is global: `bin/stop.sh` must turn it off again).
2. **Plan** (`node bin/state.mjs queue`): every `active` and `pending` group in `groups.json`.
   Groups harvested before (a `last_done` in `nightly-state.json`) run first as a cheap incremental
   catch-up; groups never harvested get a 30-day first harvest.
3. **Shifts**: for each group the babysitter opens
   `https://www.facebook.com/groups/<id>?sorting_setting=CHRONOLOGICAL`, installs `browser/harvester.js`,
   preloads the known post ids, and starts it. The harvester scrolls every 4.5–7.5 s, expands
   "See more", captures each post's text, date and photo gallery, and downloads a JSON file every 100
   posts. It ends the group on its own: when the feed's dates have passed the cutoff, or (catch-up
   runs) after 25 already-known posts in a row.
4. **Import**: the watcher sees each `villa-fb-posts-*.json` in the downloads folder, sends it with
   `bin/import.mjs`, and moves it into `HARVEST_DIR` (or to `FAILED-<name>` there if it failed after
   retries). The server classifies each post (rent offer, wanted, sale, off-topic), stores the rent
   offers as listings and merges duplicates.
5. **Wrap up**: the coordinator records finished groups (`node bin/state.mjs done <id>`), re-queues
   failed files, runs `bin/stop.sh`, and writes a short report.

The details, including what to do when the tab is hidden, frozen or logged out, are in
[runbooks/NIGHTLY.md](runbooks/NIGHTLY.md) and [runbooks/SHIFT-RULES.md](runbooks/SHIFT-RULES.md).

## One group by hand

1. `bin/start.sh` (with `ADMIN_TOKEN` exported) so the watcher imports what you harvest.
2. In Chrome, open `https://www.facebook.com/groups/<id>?sorting_setting=CHRONOLOGICAL`. Keep the
   tab visible: the feed only loads while it is on screen.
3. Open the developer console and paste the whole of `browser/harvester.js`. It answers `installed v6`.
4. If the group was harvested before, `node bin/known-ids.mjs <id>` and paste its output into
   `__villa.preload(<output>)`.
5. Start it: `await __villa.start('<id>', '<group name>', {cutoff: '2026-09-06'})` for a first
   harvest (30 days back), or `{cutoff: '<last run minus 2 days>', minRounds: 6, minPosts: 0}` for a
   catch-up.
6. Watch it with `__villa.status()` (rounds, total, oldest, stopReason). Files land in the downloads
   folder as it goes; `__villa.stop()` ends it early and flushes what it holds.
7. `bin/stop.sh` when the watcher has imported the last file.

Bali Villa Hub works the same way on a tab at https://www.balivillahub.com/en with
`browser/bvh-harvester.js`, `__bvh.preload(<node bin/known-bvh-refs.mjs>)` and
`await __bvh.run2(1, 159)`; poll `__bvh.status()`.

## Import one file

```
ADMIN_TOKEN=… node harvest/bin/import.mjs ~/Downloads/villa-fb-posts-<group>-001-<time>.json
ADMIN_TOKEN=… node harvest/bin/import-listings.mjs ~/Downloads/villa-bvh-listings-20-<time>.json
```

Both print a JSON summary (seen, new, updated, skipped by reason) and exit 1 if any chunk failed
after its retries. Re-importing a file is safe: the server updates what it already holds and never
moves a listing's first-seen date later.

## Tests

`node --test harvest/test` runs the harvester's stop rules against a simulated feed and the node
side's date parser and queue (no browser, no network). The root `npm test` does not include them.
