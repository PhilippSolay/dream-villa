#!/usr/bin/env bash
# Import every harvest file that lands in the downloads folder, then archive it in $HARVEST_DIR
# (or file it there as FAILED-<name> when the import fails). Runs until stopped (bin/stop.sh) or
# $WATCH_HOURS (default 12, whole hours; WATCH_SECONDS overrides) hours. Normally started by bin/start.sh, which logs to watch.log.
#
# Needs ADMIN_TOKEN (an owner token) in the environment. Optional: VILLA_BASE, HARVEST_DIR,
# HARVEST_DOWNLOADS (default ~/Downloads), WATCH_HOURS.
set -u
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HARVEST_DIR="${HARVEST_DIR:-$(dirname "$BIN")}"
DOWNLOADS="${HARVEST_DOWNLOADS:-$HOME/Downloads}"
HOURS="${WATCH_HOURS:-12}"

if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "ADMIN_TOKEN is not set; export an owner token before starting the watcher" >&2
  exit 2
fi
export ADMIN_TOKEN

# A file still being written by the browser is left for the next pass (mtime under 5 s old).
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
settled() { [ $(( $(date +%s) - $(mtime "$1") )) -ge 5 ]; }

import_one() { # <script> <label> <file>
  local name; name="$(basename "$3")"
  echo "[$(date +%H:%M:%S)] importing $2$name"
  if node "$BIN/$1" "$3"; then mv "$3" "$HARVEST_DIR/"; else mv "$3" "$HARVEST_DIR/FAILED-$name"; fi
}

end=$((SECONDS + ${WATCH_SECONDS:-$((HOURS * 3600))}))
while [ $SECONDS -lt $end ]; do
  for f in "$DOWNLOADS"/villa-bvh-listings-*.json "$DOWNLOADS"/villa-listings-*.json; do
    [ -f "$f" ] && settled "$f" && import_one import-listings.mjs "listings " "$f"
  done
  for f in "$DOWNLOADS"/villa-fb-posts-*.json; do
    [ -f "$f" ] && settled "$f" && import_one import.mjs "" "$f"
  done
  sleep 30
done
echo "watcher finished"
