# Babysitter shift rules
Read BABYSITTER-PROMPT.md and RUNBOOK.md ("Reinstall recipe" and step 3, the AppleScript) first.
Your prompt gives the absolute paths of the kit (`<kit>`, the repo's `harvest/` directory) and the
work dir (`<work>`); quote them in every Bash call, the path may contain a space.

HARD RULES: never use browser_batch; never Bash sleep or run_in_background (they end your turn);
one tool call at a time; every javascript_tool call has action "javascript_exec", tabId and text;
keep each call under ~40 s. Timeout → computer wait 10 s, retry a plain status; if a trivial `1+1`
also times out on a fresh tab → stop, report "extension script channel dead".
Never click, type or open links on the page; never enter credentials; a login or checkpoint page →
stop and report. Do not edit groups.json, nightly-state.json or any script.

Tools: ONE ToolSearch "select:mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp,mcp__claude-in-chrome__tabs_context_mcp".
First tabs_context_mcp (createIfEmpty:true) and use the tab it lists.

Every ~30 min: Bash `pgrep -f harvest/bin/watch.sh >/dev/null || "<kit>/bin/start.sh"`.

Per group:
1. Navigate to `https://www.facebook.com/groups/<id>?sorting_setting=CHRONOLOGICAL` (standalone call),
   computer wait 6 s. Reinstall after every navigate.
2. get_page_text max_chars 1500: login/checkpoint → stop everything; no feed ("This group is private",
   "Only members can see", no post dates at all) → skip, log SKIPPED. A "Join group" button alone is
   NOT a skip reason: it also shows on public groups whose feed is readable.
3. javascript_tool: the FULL contents of `<kit>/browser/harvester.js` (Bash `cat`) → "installed v6"
   (`status().ver` '6.1'); verify `typeof __villa === "object"`.
4. If `<work>/known/<id>.json` exists: preload ALL of it, never only the newest part. Over 800 ids:
   split it into chunks of 800 (Bash: `jq -c '[.[800*K:800*(K+1)][]]' "<work>/known/<id>.json"` for
   K=0,1,…) and call `__villa.preload(<chunk>)` once per chunk (preload is additive). Sum the returned
   numbers; `status().preloaded` must match the file size. If the file is missing or `[]` for a group
   that was harvested before, build it with `node "<kit>/bin/known-ids.mjs" <id>` first.
5. javascript_tool: `await __villa.start('<id>', '<name>', <options>)` → "started".
6. Poll every 3–4 min: `await new Promise(r=>setTimeout(r,40000)); (()=>{const s=__villa.status();return JSON.stringify({r:s.rounds,t:s.total,i:s.imgs,p:s.pending,o:s.oldest,v:s.visible,d:s.done,st:s.stalled,e:s.error,w:s.waitingUntil,paused:s.paused,fl:(s.flushes||[]).length,sr:s.stopReason,kr:s.knownRun})})()`
   (between polls at most two separate computer waits of 10 s). After each poll append
   `[HH:MM:SS] <id> r=.. t=.. i=.. p=.. o=.. kr=.. v=.. note` (on DONE also `sr=..`: frontier |
   known-run | stalled | manual | error) to `<work>/harvest.log` (Bash echo).
   - `w` set → the harvester is waiting out a throttle; keep polling.
   - `v` "hidden": run ONCE per group this Bash (it selects the harvest tab inside its own window and
     raises it; replace GROUPKEY with the group id):
     `osascript -e 'tell application "Google Chrome"' -e 'repeat with w in windows' -e 'set i to 0' -e 'repeat with t in tabs of w' -e 'set i to i + 1' -e 'if (URL of t) contains "groups/GROUPKEY" then' -e 'set active tab index of w to i' -e 'set index of w to 1' -e 'end if' -e 'end repeat' -e 'end repeat' -e 'activate' -e 'end tell'`
     If it is still hidden on the next poll, keep polling (same poll call plus two 10 s computer waits)
     and log "waiting for visibility"; the harvester resumes by itself. Only after 30 minutes of
     continuous "hidden" stop and report "hidden 30 min" with the index of the group you were on.
   - "__villa is not defined" → the Reinstall recipe (at most 2 per group, then log FAILED, move on).
   - `d` true → `JSON.stringify(__villa.status().flushes)`, log `<id> DONE ...`, then Bash
     `ls ~/Downloads/villa-fb-posts-<id>-* 2>/dev/null; grep -A14 "villa-fb-posts-<id>" "<work>/watch.log" | grep -E "importing|\"new\"|status" | tail -6`.
   - `st` true → log STALLED with oldest, move on. A first-harvest group running over 90 min → log
     STOPPED_LONG with oldest, `__villa.stop()`, then `__villa.download('<id>')` (the group id as the
     tag, so known-ids.mjs finds the file), move on.
7. Between groups: three separate computer waits of 30 s.

Final report: at most 3 lines per group (id, status, rounds, posts, oldest, files, imported new,
incidents) plus the tab id you ended on.
