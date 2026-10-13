#!/usr/bin/env bash
# Copy Star Cards' database backups onto a mounted NAS folder.
# The app already writes a daily snapshot to /var/lib/starcards/backups/ (last 7 kept);
# this just mirrors those onto the NAS so they survive an SD-card death.
#
# Run it from cron (as root, so it can read the service's backups), e.g. nightly at 3:15:
#   sudo crontab -e
#   15 3 * * *  /opt/starcards/tools/backup-to-nas.sh /mnt/nas-starcards >> /var/log/starcards-nasbackup.log 2>&1
set -euo pipefail

SRC=/var/lib/starcards/backups
DEST="${1:-/mnt/nas-starcards}"

if [ ! -d "$SRC" ]; then
  echo "$(date -Is) no backups yet at $SRC"; exit 0
fi
# Refuse to run if the NAS is not actually mounted (don't fill the SD card pretending to be the NAS).
if ! mountpoint -q "$DEST"; then
  echo "$(date -Is) ERROR: $DEST is not a mounted NAS share — skipping"; exit 1
fi
mkdir -p "$DEST"
rsync -a "$SRC"/ "$DEST"/
echo "$(date -Is) copied $(ls -1 "$SRC" | wc -l) backup file(s) to $DEST"
