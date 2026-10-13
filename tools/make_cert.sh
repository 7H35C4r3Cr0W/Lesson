#!/usr/bin/env bash
# Make a home certificate authority and a certificate for the Pi, so Star Cards can
# run on https. https is what lets Safari on the iPad use the microphone (the 🙋
# button can then listen) and keep the app working from the Home Screen when the
# Pi is briefly unreachable. Needs openssl (installed on Raspberry Pi OS).
#
#   sudo bash tools/make_cert.sh starcards.local 192.168.1.50
#
# Then on the iPad (one time):
#   1. Open http://starcards.local/starcards-home-ca.crt   (install.sh copies it into web/ for you
#      if you put it there; or AirDrop / email the file), tap Allow, then
#      Settings > General > VPN & Device Management > install the profile.
#   2. Settings > General > About > Certificate Trust Settings > turn ON "Star Cards Home CA".
#   3. In /etc/default/starcards set
#        STARCARDS_ARGS=--cert /etc/starcards/cert.pem --key /etc/starcards/key.pem --port 443
#      and  sudo systemctl restart starcards . Open https://starcards.local/ and re-add it to the Home Screen.
set -euo pipefail
NAME="${1:-$(hostname).local}"
IP="${2:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
OUT=/etc/starcards
install -d -m 0750 -o root -g starcards "$OUT" 2>/dev/null || install -d -m 0755 "$OUT"
cd "$OUT"

if [ ! -f ca.key ]; then
  openssl genrsa -out ca.key 3072 2>/dev/null
  openssl req -x509 -new -key ca.key -sha256 -days 3650 -subj "/CN=Star Cards Home CA" -out ca.crt
fi
openssl genrsa -out key.pem 2048 2>/dev/null
cat > san.cnf <<EOF
[req]
distinguished_name=dn
req_extensions=v3_req
prompt=no
[dn]
CN=$NAME
[v3_req]
subjectAltName=DNS:$NAME,DNS:$(hostname),IP:$IP
extendedKeyUsage=serverAuth
EOF
openssl req -new -key key.pem -out req.csr -config san.cnf
openssl x509 -req -in req.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out cert.pem -days 825 -sha256 \
  -extensions v3_req -extfile san.cnf 2>/dev/null
rm -f req.csr san.cnf
chmod 640 key.pem ca.key; chgrp starcards key.pem 2>/dev/null || true
cp ca.crt /opt/starcards/web/starcards-home-ca.crt 2>/dev/null || true
echo "Certificate for $NAME and $IP written to $OUT (valid 825 days; CA valid 10 years)."
echo "Install the CA on the iPad: http://$NAME/starcards-home-ca.crt"
