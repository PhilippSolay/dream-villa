# Nightly Facebook harvest — coordinator runbook

You are the COORDINATOR of one night's Facebook harvest for the villa tracker. You decide; a
cheaper babysitter agent (Sonnet) does the polling, one shift at a time. Legwork done cheaply by
Sonnet, overseen by a stronger model: you read its reports, keep the state, decide retries and skips.
The night usually starts at 03:00 Asia/Makassar (a scheduled task) or on demand when an owner asks.

**Paths.** `<kit>` is the absolute path of the repo's `harvest/` directory. `<work>` is
`$HARVEST_DIR` if it is set, else `<kit>`. The repo path may contain a space: always quote both.
Write absolute paths (never `<kit>`) into every prompt you hand a babysitter.

Files: `<kit>/groups.json` (the curated group list, read-only for you), `<work>/nightly-state.json`
(last_done per group; change it only through `bin/state.mjs done`), `<kit>/runbooks/SHIFT-RULES.md`
(babysitter rules), `<kit>/browser/harvester.js`, `<work>/known/<id>.json`, `<work>/harvest.log`,
`<work>/watch.log`. Import target: `$VILLA_BASE`, default https://villa.solay.cloud (an import takes ~5 s).

## 0. Lock (another harvest may be running)
If `<work>/HARVEST.lock` exists and is younger than 5 h (`find HARVEST.lock -mmin -300`), an
on-demand harvest owns the Chrome tab. Wait for it with ONE Bash call that loops in-shell:
`cd "<work>"; until [ ! -e HARVEST.lock ] || [ -z "$(find HARVEST.lock -mmin -300)" ]; do sleep 60; done`
(timeout 600000 ms; repeat the call until the lock is gone). Then proceed. While you run, create
the lock yourself (`echo nightly > "<work>/HARVEST.lock"`) and delete it at wrap-up.

## 1. Setup (Bash)
- `"<kit>/bin/start.sh"` — starts the import watcher and caffeinate. It refuses to start without
  `ADMIN_TOKEN` in the environment: then stop the night and report it. Never look for the token in
  files or on the server, never print it.
- Optional, Mac with the lid closed: `HARVEST_DISABLESLEEP=1 "<kit>/bin/start.sh"` also turns on
  `pmset disablesleep` (needs a passwordless sudo rule for pmset); `stop.sh` must turn it off again.
- Raise Chrome: `osascript -e 'tell application "Google Chrome" to activate'`.
- `curl -s -m 10 "${VILLA_BASE:-https://villa.solay.cloud}/healthz"` must say ok. If not, log it
  and still harvest: files wait in the downloads folder and the watcher imports them later
  (re-queue FAILED-* files at wrap-up).
- Rebuild the known-post lists (about 5 s per group; the harvester's known-run stop needs them fresh):
  `cd "<kit>"; mkdir -p "<work>/known"; for id in $(node bin/state.mjs ids); do node bin/known-ids.mjs "$id" > "<work>/known/$id.json.tmp" && [ -s "<work>/known/$id.json.tmp" ] && mv "<work>/known/$id.json.tmp" "<work>/known/$id.json"; done`
- Log `[date] NIGHTLY start` to `<work>/harvest.log`.

## 2. Tonight's queue
`node "<kit>/bin/state.mjs" queue` prints it, one JSON object per line, already in run order:
- groups with a `last_done` → `mode: incremental`, options `{cutoff: last_done minus 2 days, minRounds: 6, minPosts: 0}`
  (cheap, about 10 min each; they run first);
- groups without one → `mode: first`, options `{cutoff: today minus 30 days}` (90-minute cap per group).
Only `active` and `pending` groups from groups.json are in it; `deferred` and `skipped` never run.

## 3. Run shifts
Load the Chrome tools once (ToolSearch `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__navigate`).
`tabs_context_mcp` with createIfEmpty:true → tab id. Navigate the tab to the first group and check
`document.visibilityState`. If "hidden": run the Chrome-activate AppleScript from RUNBOOK.md step 3
(it selects the tab inside its window and raises the window), re-check once.

Spawn ONE babysitter at a time (Agent tool, model "sonnet"), about 8 groups per shift. Prompt:
"You are a Facebook harvest babysitter for the villa tracker. Read <absolute kit>/runbooks/SHIFT-RULES.md
in full first and follow it exactly. Kit: <absolute kit>. Work dir: <absolute work>. Current Chrome tab: <id>.
Your groups, in order: <n. id — "name" options {...}> ... Stop after the last one and report."

After each shift, from its report and harvest.log:
- DONE → `node "<kit>/bin/state.mjs" done <id>`. STALLED / STOPPED_LONG → `done <id>` too (the oldest
  date it reached is in the log; next night it goes incremental).
- SKIPPED "no feed" → do not edit groups.json; list it in the report for an owner to mark `skipped`.
- "hidden 30 min" or "extension script channel dead" → stop the night (do not respawn), go to step 4.
Next shift with the remaining groups. Stop starting new groups after 08:30 local.

## 4. Wrap up
- `ls ~/Downloads/villa-fb-posts-*` (or `$HARVEST_DOWNLOADS`) must be empty: the watcher imported
  everything. Re-queue any `FAILED-villa-fb-posts-*` from tonight by copying it from `<work>` back to
  the downloads folder without the `FAILED-` prefix.
- `"<kit>/bin/stop.sh"` (with `HARVEST_DISABLESLEEP=1` if you turned it on). Confirm it prints
  "sleep guard: off".
- Delete `<work>/HARVEST.lock`.
- Append a summary to harvest.log and write `<work>/REPORT-<date>.md`: per group status, posts,
  imported new, oldest; totals; incidents.
- Final message (an owner reads it): at most 8 lines — groups done/total, new rental posts imported,
  what stopped the night if anything, what they need to do.

## Rules
Never click or type on Facebook pages or enter credentials; a login or checkpoint page → stop and report.
Never edit groups.json or the harvester scripts. Never deploy or touch the server beyond curl to the
public URL. Never run two harvesters on one tab.
