#!/usr/bin/env bash
# One-shot: nginx + HTTPS (Let's Encrypt) for the chess site under /chess/.
# Usage: sudo bash chess-nginx.sh [domain] [app-port]
# Prereq: A-record of the domain points to this VM, app listens on the port.
set -euo pipefail
DOMAIN="${1:-patriotzone.ru}"
APP_PORT="${2:-3000}"
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx curl

cat > /etc/nginx/sites-available/chess <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location = /chess { return 301 /chess/; }

    location /chess/ {
        proxy_pass http://127.0.0.1:${APP_PORT}/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / { return 302 /chess/; }
}
NGINX

ln -sf /etc/nginx/sites-available/chess /etc/nginx/sites-enabled/chess
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx
ufw allow 'Nginx Full' >/dev/null 2>&1 || true

certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos \
  --register-unsafely-without-email --redirect

systemctl reload nginx
if curl -fsS "http://127.0.0.1:${APP_PORT}/healthz" >/dev/null 2>&1; then
  echo "OK: https://${DOMAIN}/chess/"
else
  echo "OK: https://${DOMAIN}/chess/ (nginx+cert ready, but the app on :${APP_PORT} is NOT running - start it: cd ~/3playerchess && pm2 start server.js --name chess3)"
fi
