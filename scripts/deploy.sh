#!/usr/bin/env bash
# villa.solay.cloud — deploy from the Mac.
#
#   scripts/deploy.sh            push master, rebuild, restart, health-check
#   scripts/deploy.sh --data     also sync data/villa.db + data/images/ first
#   scripts/deploy.sh --dry      print the commands, do nothing
#
# Primary path: git push straight to a bare repo on the VPS (no GitHub needed).
# See README.md "Deploy" for the GitHub-clone alternative.
#
# Refuses to run on a dirty tree or a non-master branch — deploy only what's committed.

set -euo pipefail

SSH_HOST=ibukadek-vps
REMOTE_NAME=vps
REMOTE_URL="${SSH_HOST}:/opt/villa.git"
REMOTE_DIR=/opt/villa
HEALTH_URL=https://villa.solay.cloud/healthz

DRY=0
SYNC_DATA=0
for arg in "$@"; do
  case "$arg" in
    --dry) DRY=1 ;;
    --data) SYNC_DATA=1 ;;
    *) echo "unknown flag: $arg (know: --dry, --data)" >&2; exit 1 ;;
  esac
done

run() {
  if [ "$DRY" = "1" ]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "master" ]; then
  echo "refusing to deploy: current branch is '$BRANCH', not 'master'." >&2
  echo "  fix: git checkout master && git merge $BRANCH   (or push $BRANCH into master yourself)" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to deploy: working tree is dirty." >&2
  echo "  fix: git status   # commit or stash what's uncommitted, then re-run" >&2
  exit 1
fi

if ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  echo "== adding remote $REMOTE_NAME -> $REMOTE_URL =="
  run git remote add "$REMOTE_NAME" "$REMOTE_URL"
fi

echo "== pushing master to $REMOTE_NAME =="
run git push "$REMOTE_NAME" master

if [ "$SYNC_DATA" = "1" ]; then
  echo "== syncing data/villa.db + data/images/ (never data/cache, never .env) =="
  run ssh "$SSH_HOST" "cd $REMOTE_DIR && (docker compose stop villa 2>/dev/null || true)"
  run rsync -az --progress "data/villa.db" "${SSH_HOST}:${REMOTE_DIR}/data/villa.db"
  run rsync -az --progress "data/images/" "${SSH_HOST}:${REMOTE_DIR}/data/images/"
  run ssh "$SSH_HOST" "chown -R 1000:1000 $REMOTE_DIR/data"   # the container runs as uid 1000 (node)
  run ssh "$SSH_HOST" "cd $REMOTE_DIR && (docker compose start villa 2>/dev/null || true)"   # first deploy: no container yet
fi

echo "== building and restarting the container =="
run ssh "$SSH_HOST" "cd $REMOTE_DIR && docker compose up -d --build"

echo "== waiting for /healthz inside the container =="
run ssh "$SSH_HOST" "cd $REMOTE_DIR && for i in \$(seq 1 30); do \
  docker compose exec -T villa node -e \"fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\" \
  && exit 0; sleep 2; done; echo 'healthz did not come up within 60s' >&2; exit 1"

echo "== checking https (Traefik re-registers the router a few seconds after a recreate) =="
run bash -c "for i in 1 2 3 4 5 6; do curl -sf -m 20 $HEALTH_URL && exit 0; sleep 5; done; echo 'public healthz not 200 after 30s' >&2; exit 1"
echo
echo "deploy done."
