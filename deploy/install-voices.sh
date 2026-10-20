#!/usr/bin/env bash
# Install the natural voice for Star Cards on the Raspberry Pi: Piper (rhasspy/piper, MIT, offline)
# and three English voices, under /var/lib/starcards/piper, where they survive every redeploy and
# where server.py finds them by itself. Safe to run again: whatever is already there is kept.
#
#   sudo bash install-voices.sh        (or: .\deploy\deploy-from-windows.ps1 -InstallVoices)
#
# About 200 MB is downloaded (GitHub and HuggingFace), so the Pi needs internet for this one step.
# Anything that fails to download stops the script with a non-zero exit and leaves nothing half done.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo."; exit 1; }
DATA=/var/lib/starcards
PIPER_DIR=$DATA/piper
VOICES_DIR=$PIPER_DIR/voices
APP=/opt/starcards
USER_NAME=starcards
PIPER_VERSION=2023.11.14-2
VOICES="en_US-amy-medium en_US-ryan-medium en_US-lessac-medium"
HF=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0

case "$(uname -m)" in
  aarch64|arm64) ARCH=aarch64 ;;
  x86_64|amd64)  ARCH=x86_64 ;;
  *) echo "No Piper build for $(uname -m) (a 64-bit OS is needed: Raspberry Pi OS 64-bit or Ubuntu arm64)."; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { echo "curl is needed first:  sudo apt install -y curl"; exit 1; }
id -u "$USER_NAME" >/dev/null 2>&1 || { echo "The $USER_NAME user is missing: run deploy/install.sh first."; exit 1; }

install -d -m 0755 "$PIPER_DIR" "$VOICES_DIR"
# Downloads land in a scratch folder next to their final place (not /tmp, which may be noexec and is
# cleaned on reboot) and are moved in only once they are whole and checked.
TMP=$(mktemp -d "$PIPER_DIR/.download.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fetch() {   # fetch URL FILE
  echo "    $1"
  curl -fL --retry 3 --retry-delay 3 --progress-bar -o "$2" "$1" || { echo "Download failed: $1"; return 1; }
}

if [ -x "$PIPER_DIR/piper/piper" ]; then
  echo "==> Piper is already installed at $PIPER_DIR/piper"
else
  echo "==> Downloading Piper $PIPER_VERSION for $ARCH (about 25 MB)"
  fetch "https://github.com/rhasspy/piper/releases/download/$PIPER_VERSION/piper_linux_$ARCH.tar.gz" "$TMP/piper.tar.gz"
  tar -xzf "$TMP/piper.tar.gz" -C "$TMP"
  [ -x "$TMP/piper/piper" ] || { echo "The download did not unpack to piper/piper; not installing it."; exit 1; }
  # The downloaded binary is tried as the service user, never as root.
  chown -R "$USER_NAME:$USER_NAME" "$TMP/piper"
  chmod 0755 "$TMP"
  runuser -u "$USER_NAME" -- "$TMP/piper/piper" --help >/dev/null 2>&1 || { echo "piper does not run on this Pi (try: $TMP/piper/piper --help)."; exit 1; }
  rm -rf "$PIPER_DIR/piper"
  mv "$TMP/piper" "$PIPER_DIR/piper"
  echo "    installed $PIPER_DIR/piper"
fi

for voice in $VOICES; do
  if [ -s "$VOICES_DIR/$voice.onnx" ] && [ -s "$VOICES_DIR/$voice.onnx.json" ]; then
    echo "==> Voice $voice is already there"
    continue
  fi
  # en_US-amy-medium lives at en/en_US/amy/medium/ on HuggingFace.
  lang=${voice%%-*}; rest=${voice#*-}; name=${rest%-*}; quality=${voice##*-}; base=${lang%%_*}
  echo "==> Downloading voice $voice (about 60 MB)"
  fetch "$HF/$base/$lang/$name/$quality/$voice.onnx.json" "$TMP/$voice.onnx.json"
  fetch "$HF/$base/$lang/$name/$quality/$voice.onnx" "$TMP/$voice.onnx"
  mv "$TMP/$voice.onnx.json" "$VOICES_DIR/$voice.onnx.json"
  mv "$TMP/$voice.onnx" "$VOICES_DIR/$voice.onnx"
done

chown -R "$USER_NAME:$USER_NAME" "$PIPER_DIR"
chmod -R u=rwX,go=rX "$PIPER_DIR"
touch "$PIPER_DIR/prerender.log" && chown "$USER_NAME:$USER_NAME" "$PIPER_DIR/prerender.log"

echo
echo "==> Installed in $PIPER_DIR:"
echo "    piper: $(runuser -u "$USER_NAME" -- "$PIPER_DIR/piper/piper" --version 2>/dev/null || echo "$PIPER_VERSION")"
for f in "$VOICES_DIR"/*.onnx; do echo "    voice: $(basename "$f" .onnx)"; done

if [ -f /etc/systemd/system/starcards.service ]; then
  # starcards.service caps the whole service at 300 MB, which counts the piper processes it starts; a
  # medium voice needs more than that, so a drop-in (kept across redeploys) raises the cap.
  echo "==> Letting the service use enough memory for piper (systemd drop-in) and restarting it"
  install -d -m 0755 /etc/systemd/system/starcards.service.d
  printf '# Added by deploy/install-voices.sh: piper needs more than the unit'"'"'s own cap.\n[Service]\nMemoryMax=1G\n' \
    > /etc/systemd/system/starcards.service.d/voices.conf
  systemctl daemon-reload
  systemctl restart starcards.service
  sleep 1.5
  systemctl --no-pager -n 5 status starcards.service || true
fi

if [ -f "$APP/tools/prerender_tts.py" ]; then
  # The service renders the stories by itself after the restart; this run is the fallback when it
  # cannot (prerender off, or an older server), and it steps aside when the service has the lock.
  echo "==> Pre-rendering the stories in the background (log: $PIPER_DIR/prerender.log)"
  nohup nice -n 10 runuser -u "$USER_NAME" -- python3 "$APP/tools/prerender_tts.py" --data-dir "$DATA" \
    >> "$PIPER_DIR/prerender.log" 2>&1 &
fi

echo
echo "==> Done. Check:  curl -s http://localhost/api/voices"
echo "    Then on each tablet: Grown-ups > Settings > Voice > pick a natural voice from the Pi."
echo "    Watch the pre-render:  journalctl -u starcards -f   or   tail -f $PIPER_DIR/prerender.log"
