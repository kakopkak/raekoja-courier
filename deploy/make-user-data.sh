#!/usr/bin/env bash
# Produce a cloud-init user-data script that installs Node, extracts the app
# bundle embedded inline, builds, and starts the service on port 80.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_B64=$(base64 < "$ROOT/deploy/bundle.tar.gz" | tr -d '\n')

cat <<EOF
#!/bin/bash
set -euxo pipefail

exec > >(tee -a /var/log/tallinn-boot.log) 2>&1
echo "=== tallinn-game cloud-init start \$(date -Is) ==="

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates ufw

# Node.js 22 (current LTS).
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

node --version
npm --version

mkdir -p /opt/tallinn-game
cd /opt/tallinn-game
echo "${BUNDLE_B64}" | base64 -d | tar xz

# Build server
cd /opt/tallinn-game/server
npm install --include=dev --no-audit --no-fund
npm run build

# Build client (served as static from the server)
cd /opt/tallinn-game/client
npm install --include=dev --no-audit --no-fund
npm run build

# Drop dev deps to slim the install (server still needs runtime deps).
cd /opt/tallinn-game/server
npm prune --omit=dev || true

# systemd service: runs node on port 80.
cat >/etc/systemd/system/tallinn.service <<'UNIT'
[Unit]
Description=Tallinn Online game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/tallinn-game/server
Environment=PORT=80
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3
User=root
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now tallinn.service

# Firewall
ufw allow 22/tcp
ufw allow 80/tcp
ufw --force enable

# Touch a file that the deploy script polls for, confirming cloud-init finished.
echo "ok \$(date -Is)" > /var/lib/tallinn-ready
echo "=== tallinn-game cloud-init done \$(date -Is) ==="
EOF
