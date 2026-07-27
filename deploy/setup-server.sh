#!/usr/bin/env bash
# Provisiona el analizador Cuballama en un VPS Linux (Contabo).
# Uso: bash deploy/setup-server.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/cuballama}"
REPO_URL="${REPO_URL:-https://github.com/0HH02/ScraperCubaLLa.git}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-3000}"

echo "==> Actualizando sistema e instalando Node.js 20..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates git ufw

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE 'v(1[89]|2[0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Node $(node -v) / npm $(npm -v)"

echo "==> Desplegando código en ${APP_DIR}..."
if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" fetch origin
  git -C "${APP_DIR}" reset --hard "origin/${BRANCH}"
else
  rm -rf "${APP_DIR}"
  git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
fi

cd "${APP_DIR}"
npm install --omit=dev

if [[ ! -f .env ]]; then
  cat > .env <<EOF
# Producción Contabo — accesible desde internet
HOST=0.0.0.0
PORT=${PORT}
GEMINI_MODEL=gemini-2.5-flash
# Pega aquí tu clave de https://aistudio.google.com/apikey
GEMINI_API_KEY=
EOF
  echo "ATENCIÓN: edita ${APP_DIR}/.env y añade GEMINI_API_KEY"
fi

# Asegura escucha pública aunque .env exista de antes.
grep -q '^HOST=' .env && sed -i 's/^HOST=.*/HOST=0.0.0.0/' .env || echo 'HOST=0.0.0.0' >> .env
grep -q '^PORT=' .env && sed -i "s/^PORT=.*/PORT=${PORT}/" .env || echo "PORT=${PORT}" >> .env

install -m 644 "${APP_DIR}/deploy/cuballama.service" /etc/systemd/system/cuballama.service
systemctl daemon-reload
systemctl enable cuballama
systemctl restart cuballama

echo "==> Abriendo puerto ${PORT} en el firewall..."
ufw allow OpenSSH || true
ufw allow "${PORT}/tcp" || true
ufw --force enable || true

sleep 2
systemctl --no-pager --full status cuballama || true
curl -fsS "http://127.0.0.1:${PORT}/api/health" || true
echo
echo "Listo. La app debería responder en http://$(curl -fsS ifconfig.me 2>/dev/null || echo IP):${PORT}"
