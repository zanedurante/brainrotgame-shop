#!/usr/bin/env bash
set -euo pipefail
stage=${1:?release directory required}
[[ $stage =~ ^/tmp/gameslop-portal\.[A-Za-z0-9]+$ && -d $stage ]] || exit 2
[[ $(id -u) == 0 ]] || exit 2
[[ -f $stage/counter/release_dates.py && ! -L $stage/counter/release_dates.py && -f $stage/ops/gameslop-catalog.cron ]] || exit 2
command -v cron >/dev/null || { echo 'Install cron before enabling update dates'; exit 1; }
exec 9>/opt/brainrotgame/.portal-deploy.lock
flock -n 9 || { echo 'Another portal release is running'; exit 1; }
if [[ -n ${EXPECTED_PORTAL_SHA256:-} ]]; then
  [[ $(sha256sum /opt/brainrotgame/site/index.html | cut -d' ' -f1) == "$EXPECTED_PORTAL_SHA256" ]] || { echo 'Portal changed since review'; exit 1; }
fi
install -d -o root -g root -m 0755 /var/lib/gameslop-catalog /opt/brainrotgame/counter
backup=$(mktemp -d /opt/brainrotgame/backups/catalog.XXXXXXXXXX)
[[ ! -f /etc/cron.d/gameslop-catalog ]] || cp -a /etc/cron.d/gameslop-catalog "$backup/cron"
[[ ! -f /opt/brainrotgame/counter/release_dates.py ]] || cp -a /opt/brainrotgame/counter/release_dates.py "$backup/release_dates.py"
rollback() {
  status=$?
  trap - ERR
  set +e
  if [[ -f $backup/cron ]]; then cp -a "$backup/cron" /etc/cron.d/gameslop-catalog; else rm -f /etc/cron.d/gameslop-catalog; fi
  if [[ -f $backup/release_dates.py ]]; then cp -a "$backup/release_dates.py" /opt/brainrotgame/counter/release_dates.py; else rm -f /opt/brainrotgame/counter/release_dates.py; fi
  echo "Update-date installation failed; previous collector restored. Backup $backup" >&2
  exit "$status"
}
trap rollback ERR
install -o root -g root -m 0644 "$stage/counter/release_dates.py" /opt/brainrotgame/counter/release_dates.py.next
mv -f /opt/brainrotgame/counter/release_dates.py.next /opt/brainrotgame/counter/release_dates.py
/usr/bin/python3 -I /opt/brainrotgame/counter/release_dates.py --output /var/lib/gameslop-catalog/updates.json
chmod 0644 /var/lib/gameslop-catalog/updates.json
install -o root -g root -m 0644 "$stage/ops/gameslop-catalog.cron" /etc/cron.d/.gameslop-catalog.next
mv -f /etc/cron.d/.gameslop-catalog.next /etc/cron.d/gameslop-catalog
systemctl enable --now cron >/dev/null
systemctl is-active --quiet cron
trap - ERR
echo 'Per-game update dates enabled; refreshed every five minutes.'
