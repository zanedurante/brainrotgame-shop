#!/usr/bin/env bash
# Add the shop's front door to the droplet that already runs the games, or to a fresh Ubuntu box (then
# it installs Caddy too). Safe to rerun: it only writes its own Caddy site file and web root.
#
#   ops/provision.sh                        # uses DEPLOY_HOST / PUBLIC_HOSTS from ops/server.env
#   ops/provision.sh root@1.2.3.4           # a new droplet; HTTPS name defaults to shop.1-2-3-4.sslip.io
#   ops/provision.sh root@1.2.3.4 "fun.example.com other.example.com"
set -euo pipefail
cd "$(dirname "$0")/.."
source ops/server.env
HOST="${1:-$DEPLOY_HOST}"
IP="${HOST#*@}"
HOSTS="${2:-${PUBLIC_HOSTS:-$PUBLIC_HOST}}"
if [[ -n "${1:-}" && -z "${2:-}" ]]; then HOSTS="shop.${IP//./-}.sslip.io"; fi
echo "Provisioning $HOST for: $HOSTS"
ssh -o StrictHostKeyChecking=accept-new "$HOST" "HOSTS='$HOSTS' bash -s" < ops/remote-setup.sh
echo
echo "Done. Next:  DEPLOY_HOST=$HOST npm run deploy"
