#!/usr/bin/env bash
# Fast redeploy to the existing droplet: rebuild locally + scp + restart.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${DO_TOKEN:?set DO_TOKEN in env}"
TAG="tallinn-game"

API="https://api.digitalocean.com/v2"
auth=(-H "Authorization: Bearer $DO_TOKEN")

IP=$(curl -sf "${auth[@]}" "$API/droplets?tag_name=$TAG" \
  | jq -r '.droplets[0].networks.v4[] | select(.type=="public") | .ip_address' | head -n1)
if [ -z "$IP" ] || [ "$IP" = "null" ]; then
  echo "No running droplet with tag $TAG found. Run deploy2.sh instead." >&2
  exit 1
fi
echo "==> Target droplet IP: $IP"

bash deploy/build-local.sh

SSH_OPTS=(-i deploy/id_ed25519 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=deploy/known_hosts \
  -o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR)

echo "==> Uploading..."
scp "${SSH_OPTS[@]}" deploy/release.tar.gz "root@$IP:/opt/tallinn-game/release.tar.gz"

echo "==> Replacing + restarting..."
ssh "${SSH_OPTS[@]}" "root@$IP" 'set -eux
  cd /opt/tallinn-game
  rm -rf server client
  tar xzf release.tar.gz
  rm release.tar.gz
  systemctl restart tallinn.service
  sleep 1
  systemctl is-active tallinn.service
  journalctl -u tallinn.service -n 10 --no-pager'

echo "==> /healthz:"
curl -fsS "http://$IP/healthz" && echo
echo "==> Live at http://$IP/"
