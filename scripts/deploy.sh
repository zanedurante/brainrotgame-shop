#!/usr/bin/env bash
# Copy the site to the droplet. There is nothing to build and no service to restart: Caddy serves the files.
#   npm run deploy
#   DEPLOY_HOST=root@1.2.3.4 npm run deploy   # a different box
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_HOST="${DEPLOY_HOST:-}"; ENV_PUBLIC="${PUBLIC_HOST:-}"
source ops/server.env
source scripts/sync-lib.sh
HOST="${ENV_HOST:-$DEPLOY_HOST}"
PUBLIC="${ENV_PUBLIC:-$PUBLIC_HOST}"
REMOTE=/opt/brainrotgame

# The site is the repo's page and any assets beside it: nothing from ops, scripts or git goes up.
rm -rf dist-deploy && mkdir -p dist-deploy
cp index.html dist-deploy/
[[ -d assets ]] && cp -r assets dist-deploy/
sync_push dist-deploy/ "$HOST:$REMOTE/site/"
# Caddy reads these as its own user, and a file copied in as root is unreadable to it.
ssh "$HOST" "chown -R caddy:caddy $REMOTE/site 2>/dev/null || chown -R www-data:www-data $REMOTE/site 2>/dev/null || true; chmod -R a+rX $REMOTE/site; systemctl is-active caddy"
echo "Deployed $(git rev-parse --short HEAD) to $HOST. https://$PUBLIC"
