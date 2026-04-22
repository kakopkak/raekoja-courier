#!/bin/bash
# Slim cloud-init: installs Node runtime + firewall + a disabled systemd unit.
# The actual app is delivered via SCP after boot.
set -euxo pipefail

exec > >(tee -a /var/log/tallinn-boot.log) 2>&1
echo "=== tallinn-game slim cloud-init $(date -Is) ==="

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates ufw

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version

mkdir -p /opt/tallinn-game

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
systemctl enable tallinn.service   # enable, do NOT start yet (no code on disk)

ufw allow 22/tcp
ufw allow 80/tcp
ufw --force enable

echo "ready $(date -Is)" > /var/lib/tallinn-boot-ready
echo "=== slim cloud-init done $(date -Is) ==="
