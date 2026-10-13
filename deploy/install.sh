#!/usr/bin/env bash
# Install or update Star Cards on a Raspberry Pi (Raspberry Pi OS Bookworm or Trixie).
# Safe to run again and again. Never touches the database.
#
#   sudo bash install.sh
#
# Run it from the copied source folder (deploy/deploy-from-windows.ps1 does this for you).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo."; exit 1; }
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/starcards
USER_NAME=starcards

echo "==> Checking Python"
python3 - <<'PY'
import sys
v = sys.version_info
assert v >= (3, 9), f"Python 3.9 or newer is needed, found {sys.version.split()[0]}"
import sqlite3  # noqa: F401  (ships with python3 on Raspberry Pi OS)
print("    python", sys.version.split()[0], "ok")
PY

echo "==> Service user"
id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$USER_NAME"

echo "==> Fixing Windows line endings in the copied files"
find "$SRC" -type f \( -name '*.py' -o -name '*.sh' -o -name '*.service' -o -name '*.json' -o -name '*.md' \
  -o -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.webmanifest' -o -name 'starcards.default' \) \
  -exec sed -i 's/\r$//' {} +

echo "==> Checking the card content"
(cd "$SRC" && python3 tools/validate_content.py) || { echo "Fix the content errors above first."; exit 1; }

echo "==> Installing to $APP"
rm -rf "$APP.new"
install -d -m 0755 "$APP.new"
cp -r "$SRC/server.py" "$SRC/web" "$SRC/content" "$SRC/tools" "$APP.new/"
[ -d "$SRC/tests" ] && cp -r "$SRC/tests" "$APP.new/"
chown -R root:root "$APP.new"
chmod -R u=rwX,go=rX "$APP.new"
find "$APP.new/tools" -name '*.sh' -exec chmod +x {} + 2>/dev/null || true
# A home CA made by tools/make_cert.sh lives in /etc/starcards; keep its download link alive across updates.
[ -f /etc/starcards/ca.crt ] && install -m 0644 /etc/starcards/ca.crt "$APP.new/web/starcards-home-ca.crt"
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"

echo "==> systemd"
install -m 0644 "$SRC/deploy/starcards.service" /etc/systemd/system/starcards.service
[ -f /etc/default/starcards ] || install -m 0644 "$SRC/deploy/starcards.default" /etc/default/starcards
systemctl daemon-reload
systemctl enable starcards.service >/dev/null
systemctl restart starcards.service
sleep 1.5
systemctl --no-pager -n 8 status starcards.service || true

echo
echo "==> Done. On the tablet open:  http://$(hostname).local/"
hostname -I 2>/dev/null | awk '{print "    or:                        http://" $1 "/"}'
echo "    Logs:  journalctl -u starcards -f"
