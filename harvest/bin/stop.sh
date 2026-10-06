#!/usr/bin/env bash
# Stop what bin/start.sh started: the import watcher and caffeinate. With HARVEST_DISABLESLEEP=1
# it also turns the Mac's lid-closed sleep guard back off (sudo -n pmset -a disablesleep 0).
# Files still in the downloads folder stay there; the next watcher imports them.
set -u
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pkill -f "$BIN/watch.sh" && echo "watcher stopped" || echo "no watcher was running"
command -v caffeinate >/dev/null && pkill -f "caffeinate -dims" && echo "caffeinate stopped"

if command -v pmset >/dev/null; then
  if [ "${HARVEST_DISABLESLEEP:-0}" = 1 ]; then sudo -n pmset -a disablesleep 0 || echo "could not clear disablesleep" >&2; fi
  if pmset -g | grep -qiE 'SleepDisabled[[:space:]]+1'; then
    echo "WARNING: sleep is still disabled; run: sudo pmset -a disablesleep 0" >&2
  else
    echo "sleep guard: off"
  fi
fi
exit 0
