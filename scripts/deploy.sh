#!/usr/bin/env bash
# Release the portal and persistent counter service on the existing droplet.
#   npm run deploy
#   DEPLOY_HOST=root@1.2.3.4 npm run deploy   # a different box
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_HOST="${DEPLOY_HOST:-}"; ENV_PUBLIC="${PUBLIC_HOST:-}"
source ops/server.env
HOST="${ENV_HOST:-$DEPLOY_HOST}"
PUBLIC="${ENV_PUBLIC:-$PUBLIC_HOST}"
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
tar -czf "$archive" index.html assets/play-counts.js counter/server.py ops/gameslop-plays.service ops/brainrotgame.caddy ops/install-counter.sh
stage=$(ssh "$HOST" 'mktemp -d /tmp/gameslop-portal.XXXXXXXXXX')
[[ $stage =~ ^/tmp/gameslop-portal\.[A-Za-z0-9]+$ ]] || exit 2
scp "$archive" "$HOST:$stage/release.tar.gz"
expected=${EXPECTED_PORTAL_SHA256:-}
[[ -z $expected || $expected =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid expected portal hash'; exit 2; }
ssh "$HOST" "tar -xzf '$stage/release.tar.gz' -C '$stage' && EXPECTED_PORTAL_SHA256='$expected' bash '$stage/ops/install-counter.sh' '$stage'"
echo "Deployed $(git rev-parse --short HEAD) to $HOST. https://$PUBLIC"
