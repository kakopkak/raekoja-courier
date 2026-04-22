#!/usr/bin/env bash
# Pre-build server + client locally and package into deploy/release.tar.gz.
# This avoids running npm install / Vite on a small droplet.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Building client (Vite)..."
(cd client && npm run build)

echo "==> Building server (tsc)..."
(cd server && npm run build)

echo "==> Installing server runtime-only node_modules..."
rm -rf deploy/.stage
mkdir -p deploy/.stage/server deploy/.stage/client
cp -r server/dist deploy/.stage/server/dist
cp server/package.json deploy/.stage/server/package.json
if [ -f server/package-lock.json ]; then
  cp server/package-lock.json deploy/.stage/server/package-lock.json
fi

pushd deploy/.stage/server >/dev/null
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
popd >/dev/null

# Client: just the built dist/, strip sourcemaps to keep bundle small.
cp -r client/dist/. deploy/.stage/client/dist/
find deploy/.stage/client/dist -name '*.map' -delete

echo "==> Packaging release.tar.gz..."
tar czf deploy/release.tar.gz -C deploy/.stage server client
rm -rf deploy/.stage

echo "    bundle: $(du -h deploy/release.tar.gz | awk '{print $1}')"
