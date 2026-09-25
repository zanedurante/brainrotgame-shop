#!/usr/bin/env bash
set -euo pipefail
stage=${1:?release directory required}
[[ $stage =~ ^/tmp/gameslop-portal\.[A-Za-z0-9]+$ && -d $stage ]] || exit 2
[[ $(id -u) == 0 ]] || exit 2
command -v cron >/dev/null || { echo 'Install cron before enabling counter exports'; exit 1; }
[[ -f $stage/counter/export_counts.py && -f $stage/ops/gameslop-plays-export.cron ]] || exit 2
[[ -f /var/lib/gameslop-plays/plays.sqlite3 ]] || { echo 'Counter database is missing'; exit 1; }
exec 9>/opt/brainrotgame/.portal-deploy.lock
flock -n 9 || { echo 'Another portal release is running'; exit 1; }
install -d -o root -g root -m 0700 /var/backups/gameslop /var/backups/gameslop/plays
install -d -o root -g root -m 0755 /opt/brainrotgame/counter
backup=$(mktemp -d /opt/brainrotgame/backups/exports.XXXXXXXXXX)
[[ ! -f /etc/cron.d/gameslop-plays-export ]] || cp -a /etc/cron.d/gameslop-plays-export "$backup/cron"
[[ ! -f /opt/brainrotgame/counter/export_counts.py ]] || cp -a /opt/brainrotgame/counter/export_counts.py "$backup/export_counts.py"
rollback() {
  if [[ -f $backup/cron ]]; then cp -a "$backup/cron" /etc/cron.d/gameslop-plays-export; else rm -f /etc/cron.d/gameslop-plays-export; fi
  if [[ -f $backup/export_counts.py ]]; then cp -a "$backup/export_counts.py" /opt/brainrotgame/counter/export_counts.py; fi
  echo "Export installation failed; previous schedule restored. Backup $backup" >&2
}
trap rollback ERR
install -m 0644 "$stage/counter/export_counts.py" /opt/brainrotgame/counter/export_counts.py.next
mv -f /opt/brainrotgame/counter/export_counts.py.next /opt/brainrotgame/counter/export_counts.py
# Export once immediately when no previous snapshot exists. Never reset the interval on redeploy.
/usr/bin/python3 -I /opt/brainrotgame/counter/export_counts.py --db /var/lib/gameslop-plays/plays.sqlite3 --output /var/backups/gameslop/plays
install -o root -g root -m 0644 "$stage/ops/gameslop-plays-export.cron" /etc/cron.d/.gameslop-plays-export.next
mv -f /etc/cron.d/.gameslop-plays-export.next /etc/cron.d/gameslop-plays-export
systemctl enable --now cron >/dev/null
systemctl is-active --quiet cron
trap - ERR
echo 'Three-day counter exports enabled in /var/backups/gameslop/plays'
