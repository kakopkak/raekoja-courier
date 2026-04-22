#!/usr/bin/env bash
# Deploy Tallinn Online to DigitalOcean.
# Requires: DO_TOKEN in env, jq, curl, ssh-keygen.
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

echo "==> Building bundle..."
tar czf deploy/bundle.tar.gz \
  --exclude='*/node_modules' --exclude='*/dist' --exclude='deploy' \
  --exclude='.git' --exclude='smoketest.mjs' --exclude='package-lock.json' \
  server client

echo "==> Building user-data..."
deploy/make-user-data.sh > deploy/user-data.sh
USERDATA_SIZE=$(wc -c < deploy/user-data.sh)
if [ "$USERDATA_SIZE" -gt 65000 ]; then
  echo "ERROR: user-data $USERDATA_SIZE bytes > 65KB limit" >&2
  exit 1
fi
echo "    user-data size: ${USERDATA_SIZE} bytes"

echo "==> Ensuring SSH key on DO account..."
if [ ! -f deploy/id_ed25519 ]; then
  ssh-keygen -t ed25519 -N "" -C "tallinn-game-deploy" -f deploy/id_ed25519 >/dev/null
  echo "    generated new keypair"
fi
SSH_PUB=$(cat deploy/id_ed25519.pub)
SSH_NAME="tallinn-game-$(openssl rand -hex 3)"

# Check if pubkey already present (by fingerprint).
FP=$(ssh-keygen -lf deploy/id_ed25519.pub | awk '{print $2}' | sed 's/^SHA256://')
EXISTING_ID=$(curl -sf "${auth[@]}" "$API/account/keys?per_page=200" \
  | jq -r --arg pub "$SSH_PUB" '.ssh_keys[] | select(.public_key == $pub) | .id' | head -n1 || true)
if [ -n "$EXISTING_ID" ] && [ "$EXISTING_ID" != "null" ]; then
  SSH_KEY_ID="$EXISTING_ID"
  echo "    reusing existing key id=$SSH_KEY_ID"
else
  SSH_KEY_ID=$(curl -sf "${auth[@]}" -X POST "$API/account/keys" -d "$(jq -n --arg name "$SSH_NAME" --arg pub "$SSH_PUB" '{name:$name,public_key:$pub}')" \
    | jq -r '.ssh_key.id')
  echo "    uploaded new key id=$SSH_KEY_ID"
fi

# Reuse an existing droplet with the same tag if one exists (idempotent re-deploys).
EXISTING_DROPLET=$(curl -sf "${auth[@]}" "$API/droplets?tag_name=$TAG" \
  | jq -r '.droplets[0].id // empty')
if [ -n "$EXISTING_DROPLET" ]; then
  echo "==> Found existing droplet id=$EXISTING_DROPLET with tag $TAG."
  read -r -p "    Destroy it and redeploy? [y/N] " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    echo "    destroying..."
    curl -sf "${auth[@]}" -X DELETE "$API/droplets/$EXISTING_DROPLET"
    sleep 3
  else
    echo "    aborting."
    exit 0
  fi
fi

echo "==> Creating droplet ($NAME, $REGION, $SIZE)..."
USER_DATA=$(cat deploy/user-data.sh)
CREATE_BODY=$(jq -n \
  --arg name "$NAME" \
  --arg region "$REGION" \
  --arg size "$SIZE" \
  --arg image "$IMAGE" \
  --arg ud "$USER_DATA" \
  --arg tag "$TAG" \
  --argjson sshkey "$SSH_KEY_ID" \
  '{
    name: $name, region: $region, size: $size, image: $image,
    backups: false, ipv6: true, monitoring: true,
    ssh_keys: [$sshkey], tags: [$tag], user_data: $ud
  }')

DROPLET_ID=$(curl -sf "${auth[@]}" -X POST "$API/droplets" -d "$CREATE_BODY" | jq -r '.droplet.id')
echo "    droplet id=$DROPLET_ID"

echo "==> Waiting for droplet to be active..."
IP=""
for i in $(seq 1 60); do
  resp=$(curl -sf "${auth[@]}" "$API/droplets/$DROPLET_ID")
  STATUS=$(echo "$resp" | jq -r '.droplet.status')
  IP=$(echo "$resp" | jq -r '.droplet.networks.v4[] | select(.type=="public") | .ip_address' | head -n1)
  printf "\r    [%02d/60] status=%s ip=%s   " "$i" "$STATUS" "${IP:-pending}"
  if [ "$STATUS" = "active" ] && [ -n "$IP" ] && [ "$IP" != "null" ]; then
    echo
    break
  fi
  sleep 4
done

if [ -z "$IP" ] || [ "$IP" = "null" ]; then
  echo "ERROR: droplet did not become active in time." >&2
  exit 1
fi

echo "==> Droplet IP: $IP"
echo "==> Waiting for cloud-init + game server (this can take 2–5 minutes)..."
READY=""
for i in $(seq 1 90); do
  if curl -fsS --max-time 3 "http://$IP/healthz" >/dev/null 2>&1; then
    READY="yes"; echo; break
  fi
  printf "\r    [%02d/90] still booting…   " "$i"
  sleep 5
done

if [ -z "$READY" ]; then
  echo
  echo "WARN: /healthz did not respond yet. The droplet may still be building."
  echo "      SSH in to debug: ssh -i deploy/id_ed25519 root@$IP 'tail -n 200 /var/log/tallinn-boot.log'"
  exit 2
fi

echo
echo "================================================================"
echo "  Tallinn Online is live!"
echo "   URL:     http://$IP/"
echo "   Health:  http://$IP/healthz"
echo "   Monitor: http://$IP/colyseus"
echo "   Droplet: id=$DROPLET_ID  region=$REGION  size=$SIZE"
echo "   SSH:     ssh -i deploy/id_ed25519 root@$IP"
echo "================================================================"
