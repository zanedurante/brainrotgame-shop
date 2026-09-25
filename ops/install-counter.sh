#!/usr/bin/env bash
# Run as root on the existing portal droplet with an uploaded release directory.
set -euo pipefail
stage=${1:?release directory required}
[[ $stage =~ ^/tmp/gameslop-portal\.[A-Za-z0-9]+$ && -d $stage ]] || exit 2
[[ $(id -u) == 0 ]] || exit 2
for file in index.html assets/play-counts.js counter/server.py ops/gameslop-plays.service ops/brainrotgame.caddy; do
  [[ -f $stage/$file && ! -L $stage/$file ]] || { echo "Missing $file"; exit 2; }
done
exec 9>/opt/brainrotgame/.portal-deploy.lock
flock -n 9 || { echo 'Another portal release is running'; exit 1; }
if [[ -n ${EXPECTED_PORTAL_SHA256:-} ]]; then
  [[ $(sha256sum /opt/brainrotgame/site/index.html | cut -d' ' -f1) == "$EXPECTED_PORTAL_SHA256" ]] || { echo 'Portal changed since review'; exit 1; }
fi
release=$(date -u +%Y%m%dT%H%M%SZ)-$(sha256sum "$stage/index.html" | cut -c1-12)
backup=/opt/brainrotgame/backups/$release
[[ ! -e $backup ]] || { echo 'Release backup already exists'; exit 1; }
install -d -m 0700 "$backup"
cp -a /opt/brainrotgame/site "$backup/site"
cp -a /etc/caddy/brainrotgame.caddy "$backup/brainrotgame.caddy"
[[ ! -f /opt/brainrotgame/counter/server.py ]] || cp -a /opt/brainrotgame/counter/server.py "$backup/server.py"
[[ ! -f /etc/systemd/system/gameslop-plays.service ]] || cp -a /etc/systemd/system/gameslop-plays.service "$backup/gameslop-plays.service"
was_active=false; was_enabled=false
systemctl is-active --quiet gameslop-plays && was_active=true
systemctl is-enabled --quiet gameslop-plays 2>/dev/null && was_enabled=true
if [[ -f /var/lib/gameslop-plays/plays.sqlite3 ]]; then
  python3 - "$backup/plays.sqlite3" <<'PY'
import sqlite3, sys
with sqlite3.connect('/var/lib/gameslop-plays/plays.sqlite3') as source, sqlite3.connect(sys.argv[1]) as destination:
    source.backup(destination)
PY
fi
rollback() {
  echo "Deployment failed; restoring portal from $backup" >&2
  cp -a "$backup/site/." /opt/brainrotgame/site/
  cp -a "$backup/brainrotgame.caddy" /etc/caddy/brainrotgame.caddy
  systemctl stop gameslop-plays || true
  if [[ -f $backup/server.py ]]; then cp -a "$backup/server.py" /opt/brainrotgame/counter/server.py; fi
  if [[ -f $backup/gameslop-plays.service ]]; then
    cp -a "$backup/gameslop-plays.service" /etc/systemd/system/gameslop-plays.service
  else
    systemctl disable gameslop-plays >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/gameslop-plays.service
  fi
  systemctl daemon-reload
  if $was_active; then systemctl start gameslop-plays || true; fi
  if $was_enabled; then
    systemctl enable gameslop-plays >/dev/null 2>&1 || true
  else
    systemctl disable gameslop-plays >/dev/null 2>&1 || true
  fi
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy || true
  # Keep the counter database intact, including clicks received during the attempt.
}
trap rollback ERR
chown root:root /opt/brainrotgame
chmod 0755 /opt/brainrotgame
install -d -o root -g root -m 0755 /opt/brainrotgame/counter
install -m 0644 "$stage/counter/server.py" /opt/brainrotgame/counter/server.py.next
mv -f /opt/brainrotgame/counter/server.py.next /opt/brainrotgame/counter/server.py
install -m 0644 "$stage/ops/gameslop-plays.service" /etc/systemd/system/gameslop-plays.service
systemctl daemon-reload
systemctl enable gameslop-plays >/dev/null
systemctl restart gameslop-plays
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:3012/api/plays > "$backup/initial-counts.json"
install -m 0644 "$stage/ops/brainrotgame.caddy" /etc/caddy/brainrotgame.caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
install -d -o caddy -g caddy -m 0755 /opt/brainrotgame/site/assets
install -o caddy -g caddy -m 0644 "$stage/assets/play-counts.js" /opt/brainrotgame/site/assets/play-counts.js.next
mv -f /opt/brainrotgame/site/assets/play-counts.js.next /opt/brainrotgame/site/assets/play-counts.js
install -o caddy -g caddy -m 0644 "$stage/index.html" /opt/brainrotgame/site/index.html.next
mv -f /opt/brainrotgame/site/index.html.next /opt/brainrotgame/site/index.html
curl --fail --silent --show-error --connect-timeout 5 --max-time 20 https://gameslop.now/api/plays > "$backup/public-counts.json"
curl --fail --silent --show-error --connect-timeout 5 --max-time 20 https://gameslop.now/ | cmp - "$stage/index.html"
curl --fail --silent --show-error --connect-timeout 5 --max-time 20 https://gameslop.now/assets/play-counts.js | cmp - "$stage/assets/play-counts.js"
systemctl is-active --quiet gameslop-plays
trap - ERR
echo "Portal deployed; backup $backup"
cat "$backup/public-counts.json"
