#!/usr/bin/env bash
# Runs ON the server as root (piped in by ops/provision.sh). Expects HOSTS (space separated) in the
# environment; the first is the canonical name.
#
# The shop is one static page and Caddy serves it off disk, so this only has to install Caddy if it is
# not already there, make a directory, and add one site block. Same shape as Heads Up's setup, so the
# sites' provisioning scripts coexist on one droplet without touching each other's files.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
: "${HOSTS:?}"
read -r -a NAMES <<< "$HOSTS"

echo "[1/3] Caddy"
if ! command -v caddy >/dev/null; then
  while fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1; do sleep 3; done
  apt-get update -q >/dev/null
  apt-get install -y -q curl gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q >/dev/null && apt-get install -y -q caddy >/dev/null
fi
if command -v ufw >/dev/null; then for r in 80/tcp 443/tcp 443/udp; do ufw allow "$r" >/dev/null 2>&1 || true; done; fi

echo "[2/3] web root"
mkdir -p /opt/brainrotgame/site
chown -R caddy:caddy /opt/brainrotgame 2>/dev/null || chown -R www-data:www-data /opt/brainrotgame 2>/dev/null || true
chmod -R a+rX /opt/brainrotgame
if [[ ! -f /opt/brainrotgame/site/index.html ]]; then
  printf '<!doctype html><meta charset=utf-8><title>%s</title><body style="background:#0d0f14;color:#f2f4f8;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">Nothing deployed here yet. Run <code style="margin-left:.4em">npm run deploy</code></body>' "${NAMES[0]}" > /opt/brainrotgame/site/index.html
  chmod a+r /opt/brainrotgame/site/index.html
fi

echo "[3/3] HTTPS front door (Caddy) for ${NAMES[*]}"
# Every bare name serves the same page from the same root; each www is sent to its own bare name. Caddy
# fetches certificates for all of them itself once their DNS points here, and retries quietly until it does.
BARE=$(IFS=,; echo "${NAMES[*]}" | sed 's/,/, /g')
{
  echo "$BARE {"
  echo "  encode gzip"
  echo "  root * /opt/brainrotgame/site"
  echo "  # One page that changes when it changes: never cache it for long."
  echo "  header Cache-Control \"no-cache\""
  echo "  file_server"
  echo "  try_files {path} /index.html"
  echo "}"
  for n in "${NAMES[@]}"; do
    echo "www.$n {"
    echo "  redir https://$n{uri} permanent"
    echo "}"
  done
} > /etc/caddy/brainrotgame.caddy
touch /etc/caddy/Caddyfile
grep -q 'import /etc/caddy/brainrotgame.caddy' /etc/caddy/Caddyfile || printf '\nimport /etc/caddy/brainrotgame.caddy\n' >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { echo "  Caddyfile did not validate; not reloading"; exit 1; }
systemctl enable caddy >/dev/null 2>&1; systemctl reload caddy 2>/dev/null || systemctl restart caddy
echo "  caddy $(systemctl is-active caddy) | root /opt/brainrotgame/site | $(for n in "${NAMES[@]}"; do printf 'https://%s ' "$n"; done)"
