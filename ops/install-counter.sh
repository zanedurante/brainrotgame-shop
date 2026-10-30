#!/usr/bin/env bash
# Run as root on the existing portal droplet with an uploaded release directory.
set -euo pipefail
stage=${1:?release directory required}
[[ $stage =~ ^/tmp/gameslop-portal\.[A-Za-z0-9]+$ && -d $stage ]] || exit 2
[[ $(id -u) == 0 ]] || exit 2
public_files=(assets/play-counts.js assets/sidebar-ads.js ads.txt robots.txt privacy.html about.html index.html)
for file in "${public_files[@]}" counter/server.py ops/gameslop-plays.service ops/brainrotgame.caddy; do
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
  status=$?
  trap - ERR
  set +e
  echo "Deployment failed; restoring portal from $backup" >&2
  # Restoring a directory does not remove files introduced by this release.
  # Only remove known public files (and their staging files) absent from the backup.
  for file in "${public_files[@]}"; do
    for candidate in "$file" "$file.next"; do
      if [[ ! -e $backup/site/$candidate && ! -L $backup/site/$candidate ]]; then
        rm -f -- "/opt/brainrotgame/site/$candidate"
      fi
    done
  done
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
  exit "$status"
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
python3 - "$backup/initial-counts.json" <<'PY'
import json, sys
slugs = {'primordial', 'primordial-tactics', 'bagbrawl', 'deadpoint', 'headsup', 'grove', 'emberwild', 'emberfell', 'pelaglyph', 'hypercycle', 'litigation', 'hollowtide', 'grandstrat', 'vipertcg', 'battlelines', 'wowzaworka'}
with open(sys.argv[1]) as handle:
    snapshot = json.load(handle)
for field in ('counts', 'weeklyCounts'):
    assert set(snapshot[field]) == slugs, 'Missing game metrics'
    assert all(type(value) is int and value >= 0 for value in snapshot[field].values()), 'Invalid count'
assert set(snapshot['lastUpdated']) == slugs, 'Missing update dates'
assert isinstance(snapshot['weeklyTrackingStartedAt'], str), 'Missing tracking start'
assert type(snapshot['asOf']) is int and snapshot['asOf'] > 0, 'Missing snapshot timestamp'
PY
if ! cmp -s "$stage/ops/brainrotgame.caddy" /etc/caddy/brainrotgame.caddy; then
  install -m 0644 "$stage/ops/brainrotgame.caddy" /etc/caddy/brainrotgame.caddy
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl reload caddy
fi
install -d -o caddy -g caddy -m 0755 /opt/brainrotgame/site/assets
for file in "${public_files[@]}"; do
  install -o caddy -g caddy -m 0644 "$stage/$file" "/opt/brainrotgame/site/$file.next"
  mv -f -- "/opt/brainrotgame/site/$file.next" "/opt/brainrotgame/site/$file"
done
curl --fail --silent --show-error --connect-timeout 5 --max-time 20 https://gameslop.now/api/plays > "$backup/public-counts.json"
for file in "${public_files[@]}"; do
  public_path="/$file"
  [[ $file != index.html ]] || public_path=/
  verified="$backup/public-${file//\//_}"
  content_type=$(curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
    --output "$verified" --write-out '%{content_type}' "https://gameslop.now$public_path")
  content_type=${content_type%%;*}
  case "$file:${content_type,,}" in
    *.html:text/html|*.txt:text/plain|*.js:text/javascript|*.js:application/javascript) ;;
    *) echo "Unexpected Content-Type for $public_path: $content_type" >&2; false ;;
  esac
  cmp "$verified" "$stage/$file"
done
systemctl is-active --quiet gameslop-plays
trap - ERR
echo "Portal deployed; backup $backup"
cat "$backup/public-counts.json"
