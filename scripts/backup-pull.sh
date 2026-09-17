#!/usr/bin/env bash
# Pull the nightly villa.solay.cloud backups down from the VPS.
#
#   scripts/backup-pull.sh
#
# Lands in ~/Developer/villa-backups/, not ~/ (see the filesystem-layout rule).

set -euo pipefail

SSH_HOST=ibukadek-vps
REMOTE_DIR=/opt/villa/data/backups/
LOCAL_DIR="$HOME/Developer/villa-backups/"

mkdir -p "$LOCAL_DIR"
rsync -avz --progress "${SSH_HOST}:${REMOTE_DIR}" "$LOCAL_DIR"
echo "backups synced to $LOCAL_DIR"
