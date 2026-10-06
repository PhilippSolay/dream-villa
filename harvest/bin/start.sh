#!/usr/bin/env bash
# Start a harvest session: the import watcher in the background (logging to $HARVEST_DIR/watch.log)
# and, on a Mac, caffeinate so the display stays awake (a hidden or sleeping Facebook tab stops
# the harvest). Stop it all with bin/stop.sh.
#
# Needs ADMIN_TOKEN in the environment (see bin/watch.sh). Optional, Mac only: HARVEST_DISABLESLEEP=1
# also runs `sudo -n pmset -a disablesleep 1`, so the Mac keeps running with the lid closed; it needs
# a passwordless sudo rule for pmset, and bin/stop.sh (with the same variable) turns it back off.
# disablesleep is global and survives until cleared or a reboot: never leave it on.
set -u
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HARVEST_DIR="${HARVEST_DIR:-$(dirname "$BIN")}"

if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "ADMIN_TOKEN is not set; export an owner token, then run start.sh again" >&2
  exit 2
fi

mkdir -p "$HARVEST_DIR"
if pgrep -f "$BIN/watch.sh" >/dev/null; then
  echo "watcher already running"
else
  (nohup "$BIN/watch.sh" >> "$HARVEST_DIR/watch.log" 2>&1 &)
fi

if command -v caffeinate >/dev/null; then
  pgrep -f "caffeinate -dims" >/dev/null || (nohup caffeinate -dims -t 43200 >/dev/null 2>&1 &)
fi
if [ "${HARVEST_DISABLESLEEP:-0}" = 1 ] && command -v pmset >/dev/null; then
  sudo -n pmset -a disablesleep 1 || echo "could not set disablesleep (no passwordless sudo for pmset?)" >&2
fi

sleep 1
pgrep -f "$BIN/watch.sh" >/dev/null && echo "watcher alive (log: $HARVEST_DIR/watch.log)" || echo "watcher did NOT start; see $HARVEST_DIR/watch.log" >&2
command -v caffeinate >/dev/null && pgrep -f "caffeinate -dims" >/dev/null && echo "caffeinate on (12 h)"
command -v pmset >/dev/null && echo "sleep guard: $(pmset -g | grep -i SleepDisabled | tr -s ' ')"
exit 0
