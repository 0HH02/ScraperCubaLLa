#!/usr/bin/env bash
# Actualiza el código desde GitHub y reinicia el servicio.
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/cuballama}"
BRANCH="${BRANCH:-main}"

cd "${APP_DIR}"
git fetch origin
git reset --hard "origin/${BRANCH}"
npm install --omit=dev
systemctl restart cuballama
sleep 2
systemctl --no-pager --full status cuballama
curl -fsS http://127.0.0.1:${PORT:-3000}/api/health
echo
