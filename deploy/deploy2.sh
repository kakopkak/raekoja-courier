#!/usr/bin/env bash
# Two-phase deploy: slim cloud-init (no build on box) + SCP of pre-built artifacts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${DO_TOKEN:?set DO_TOKEN in env}"
REGION="${DO_REGION:-fra1}"
SIZE="${DO_SIZE:-s-1vcpu-1gb}"
IMAGE="${DO_IMAGE:-ubuntu-24-04-x64}"
NAME="${DO_NAME:-tallinn-online}"
TAG="tallinn-game"

API="https://api.digitalocean.com/v2"
auth=(-H "Authorization: Bearer $DO_TOKEN" -H "Content-Type: application/json")

echo "==> Pre-building release bundle locally..."
bash deploy/build-local.sh

echo "==> Ensuring SSH key on DO..."
if [ ! -f deploy/id_ed25519 ]; then
  ssh-keygen -t ed25519 -N "" -C "tallinn-game-deploy" -f deploy/id_ed25519 >/dev/null
fi
SSH_PUB=$(cat deploy/id_ed25519.pub)
EXISTING_ID=$(curl -sf "${auth[@]}" "$API/account/keys?per_page=200" \
  | jq -r --arg pub "$SSH_PUB" '.ssh_keys[] | select(.public_key == $pub) | .id' | head -n1 || true)
if [ -n "$EXISTING_ID" ] && [ "$EXISTING_ID" != "null" ]; then
  SSH_KEY_ID="$EXISTING_ID"
else
  SSH_KEY_ID=$(curl -sf "${auth[@]}" -X POST "$API/account/keys" \
    -d "$(jq -n --arg name "tallinn-game-$(openssl rand -hex 3)" --arg pub "$SSH_PUB" '{name:$name,public_key:$pub}')" \
    | jq -r '.ssh_key.id')
fi
echo "    ssh key id=$SSH_KEY_ID"

# Clean up any existing droplet with our tag.
EXISTING_DROPLET=$(curl -sf "${auth[@]}" "$API/droplets?tag_name=$TAG" | jq -r '.droplets[0].id // empty')
if [ -n "$EXISTING_DROPLET" ]; then
  echo "==> Destroying existing droplet id=$EXISTING_DROPLET..."
  curl -sf -X DELETE "${auth[@]}" "$API/droplets/$EXISTING_DROPLET" -w "HTTP %{http_code}\n"
  sleep 4
fi

echo "==> Creating droplet ($NAME, $REGION, $SIZE)..."
USER_DATA=$(cat deploy/cloud-init-slim.sh)
CREATE_BODY=$(jq -n \
  --arg name "$NAME" --arg region "$REGION" --arg size "$SIZE" --arg image "$IMAGE" \
  --arg ud "$USER_DATA" --arg tag "$TAG" --argjson sshkey "$SSH_KEY_ID" '
  { name:$name, region:$region, size:$size, image:$image,
    backups:false, ipv6:true, monitoring:true,
    ssh_keys:[$sshkey], tags:[$tag], user_data:$ud }')

DROPLET_ID=$(curl -sf "${auth[@]}" -X POST "$API/droplets" -d "$CREATE_BODY" | jq -r '.droplet.id')
echo "    droplet id=$DROPLET_ID"

echo "==> Waiting for public IP..."
IP=""
for i in $(seq 1 45); do
  resp=$(curl -sf "${auth[@]}" "$API/droplets/$DROPLET_ID")
  STATUS=$(echo "$resp" | jq -r '.droplet.status')
  IP=$(echo "$resp" | jq -r '.droplet.networks.v4[] | select(.type=="public") | .ip_address' | head -n1)
  printf "\r    [%02d/45] status=%s ip=%s        " "$i" "$STATUS" "${IP:-pending}"
  if [ "$STATUS" = "active" ] && [ -n "$IP" ] && [ "$IP" != "null" ]; then
    echo; break
  fi
  sleep 4
done

if [ -z "$IP" ] || [ "$IP" = "null" ]; then
  echo "ERROR: droplet did not get an IP" >&2; exit 1
fi
echo "==> IP: $IP"

echo "==> Waiting for SSH + slim cloud-init..."
SSH_OPTS=(-i deploy/id_ed25519 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=deploy/known_hosts \
  -o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR)
for i in $(seq 1 60); do
  if ssh "${SSH_OPTS[@]}" "root@$IP" 'test -f /var/lib/tallinn-boot-ready' 2>/dev/null; then
    echo "    cloud-init done."
    break
  fi
  printf "\r    [%02d/60] waiting for cloud-init…  " "$i"
  sleep 5
done

echo "==> Uploading release bundle..."
scp "${SSH_OPTS[@]}" deploy/release.tar.gz "root@$IP:/opt/tallinn-game/release.tar.gz"

echo "==> Extracting + starting service..."
ssh "${SSH_OPTS[@]}" "root@$IP" 'set -eux
  cd /opt/tallinn-game
  tar xzf release.tar.gz
  rm release.tar.gz
  systemctl restart tallinn.service
  sleep 2
  systemctl is-active tallinn.service
  journalctl -u tallinn.service -n 30 --no-pager'

echo "==> Waiting for /healthz..."
READY=""
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://$IP/healthz" >/dev/null 2>&1; then
    READY="yes"; break
  fi
  printf "\r    [%02d/30] waiting for HTTP…   " "$i"
  sleep 2
done

echo
if [ -z "$READY" ]; then
  echo "ERROR: /healthz not responding. Check: ssh -i deploy/id_ed25519 root@$IP 'journalctl -u tallinn -n 100'"
  exit 2
fi

echo "================================================================"
echo "  Tallinn Online is live!"
echo "   URL:     http://$IP/"
echo "   Health:  http://$IP/healthz"
echo "   Monitor: http://$IP/colyseus"
echo "   Droplet: id=$DROPLET_ID  region=$REGION  size=$SIZE"
echo "   SSH:     ssh -i deploy/id_ed25519 root@$IP"
echo "================================================================"
