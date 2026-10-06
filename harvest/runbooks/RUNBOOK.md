# Facebook harvest — runbook for the babysitter agent

Goal: harvest each group you are given back to its cutoff, through the owner's logged-in Chrome
(Claude in Chrome tools), saving posts as JSON files in the downloads folder that the watcher
(`bin/watch.sh`) imports into the tracker. Read this with SHIFT-RULES.md; where they differ,
SHIFT-RULES.md wins (it is newer).

Paths: `<kit>` = the repo's `harvest/` directory, `<work>` = `$HARVEST_DIR` or `<kit>`; your prompt
gives both as absolute paths. Quote them: the path may contain a space.

## Pieces
- `<kit>/browser/harvester.js` — the in-page script. Install it by running its full contents with
  `mcp__claude-in-chrome__javascript_tool` on the Facebook tab (returns "installed v6";
  `__villa.status().ver` is '6.1'). Then `await __villa.start('<groupId>', '<name>', <options>)`.
- Your groups and their options come from the coordinator (`bin/state.mjs queue`). You never edit
  groups.json or nightly-state.json; the coordinator records what finished.
- `<kit>/bin/watch.sh` — imports files from the downloads folder (runs in the background; check with
  `pgrep -f harvest/bin/watch.sh`; restart with `"<kit>/bin/start.sh"`).
- `<work>/harvest.log` — append one line per check: time, group, rounds, total, oldest, pending, visible, note.

## Reinstall recipe (after a reload or a frozen tab)
1. `node "<kit>/bin/known-ids.mjs" <groupId>` in Bash (or read `<work>/known/<groupId>.json`): a JSON
   array of the post ids already harvested for that group.
2. Paste the full contents of harvester.js into javascript_tool → "installed v6".
3. `__villa.preload(<the JSON array>)` → the count preloaded. These posts are skipped (no text, no
   photo galleries): this is what makes a reinstall cheap. Over 800 ids: chunk it (SHIFT-RULES step 4).
4. `await __villa.start('<groupId>', '<name>', <options>)`.
The tab re-scrolls from the top (unavoidable) but only spends time on posts it has not seen.

## Loop (every 3–4 minutes; one small javascript_tool call per check)
1. `const s=__villa.status(); ({ver:s.ver, running:s.running, paused:s.paused, done:s.done, stalled:s.stalled, rounds:s.rounds, total:s.total, imgs:s.imgs, pending:s.pending, oldest:s.oldest, visible:s.visible, path:s.path, error:s.error, waitingUntil:s.waitingUntil, stopReason:s.stopReason})`
2. If the call errors with "__villa is not defined" or times out twice, the page reloaded or froze:
   - frozen (timeouts): close the tab (tabs_close_mcp), create a new one, navigate to
     `https://www.facebook.com/groups/<id>?sorting_setting=CHRONOLOGICAL`, wait 6 s, then the
     Reinstall recipe for the SAME group. Note it in harvest.log.
   - reloaded (script gone, page fine): the Reinstall recipe.
3. If `visible` is "hidden" for two consecutive checks, the Chrome window is behind another app (often
   the Claude app) or the Facebook tab is not the active tab of its window. Fix it from Bash with
   AppleScript (allowed: it only selects a tab and raises a window):
   `osascript -e 'tell application "Google Chrome"' -e 'repeat with w in windows' -e 'set i to 0' -e 'repeat with t in tabs of w' -e 'set i to i + 1' -e 'if (URL of t) contains "facebook.com/groups" then' -e 'set active tab index of w to i' -e 'set index of w to 1' -e 'end if' -e 'end repeat' -e 'end repeat' -e 'activate' -e 'end tell'`
   then re-check. Still hidden (screen locked, display off) → log it once and follow SHIFT-RULES step 6.
4. `done` true → report the group to the coordinator (status, `reached` = oldest), then the next group:
   navigate (standalone call, then wait 6 s), check the page has a feed (SHIFT-RULES step 2), reinstall,
   start with its options. Wait 90 s between groups.
5. `stalled` true (the feed stopped delivering after 3 ten-minute waits) → report stalled with
   `reached`, move to the next group.
6. Every ~30 minutes: `pgrep -f harvest/bin/watch.sh` is alive and `ls ~/Downloads/villa-fb-posts-*.json | wc -l`
   is not growing (files are imported within a minute). Restart the watcher if it is dead.
7. Never type into the page, never click anything except through the harvester; never open links.
8. Stop when your groups are done or when told, and report.

## Rate and throttle rules (built into the script; do not tighten)
Scroll every 4.5–7.5 s, a 20 s pause every 40 scrolls, a 10-minute wait when the feed goes idle
(at most 3), 90 s between groups.

## How a group ends (harvester v6.1, `status().stopReason`)
- `frontier` — the date that 70% of the last 20 posts are as old as or older than has been past the
  cutoff for 2 rounds in a row, with the depth guard met (first harvest: 25 rounds and 150 posts;
  incremental: 6 rounds, 0 posts). Pinned, featured and "shared a memory" posts do not count.
- `known-run` — incremental runs only (at least 50 ids preloaded): 25 posts in a row were already
  known, so the group is caught up.
- `stalled`, `manual`, `error`, `idle` — see SHIFT-RULES.md for what to log and do.

## Bali Villa Hub (a listings site, not Facebook)
- The site blocks curl (Vercel checkpoint). Harvest it from a Chrome tab on https://www.balivillahub.com/en:
  inject `<kit>/browser/bvh-harvester.js` via javascript_tool, `__bvh.preload(<node "<kit>/bin/known-bvh-refs.mjs">)`,
  then `await __bvh.run2(1, 159)`; poll `__bvh.status()`.
- About 3,200 listings over 159 pages (unfiltered). Only in-region cards fetch a detail page (~25 min
  for a first run, ~10 min with a preload).
- Files auto-flush every 80 listings to the downloads folder (`villa-bvh-listings-NN-*.json`); the
  watcher imports them via POST /api/import/listings, which drops out-of-band rows (`skipped.out_of_band`).
- Chrome must allow automatic downloads for balivillahub.com, else only the first file lands.
- Run it in the foreground tab, alone, when no Facebook harvest needs the window: in a background tab
  the renderer went unresponsive after 3 pages. `__bvh.run3` (no timer pacing) is the fallback for a
  tab that may be hidden.
- Gotcha: `red_flags` is unioned on update, so a flag from a bad import sticks until cleared.
