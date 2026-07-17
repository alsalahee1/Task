#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# AeroAssist one-shot deployer for Ubuntu 22.04 / 24.04 (e.g. a Hostinger VPS).
# Installs Node.js 22, runs the app as a systemd service on localhost:3000,
# puts nginx in front of it, and gets a free HTTPS certificate for your domain.
#
# Run as root on the server:
#   DOMAIN=aeroassist.online EMAIL=you@example.com bash deploy.sh
#
# Re-runnable: safe to run again to update to the latest code.
#
# BEFORE running: point your domain's DNS A records at this server's IP:
#   aeroassist.online       A   <this server IP>
#   www.aeroassist.online   A   <this server IP>
# (Certbot needs the domain to resolve here, or the HTTPS step will fail.)
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${DOMAIN:-aeroassist.online}"
WWW="www.${DOMAIN}"
EMAIL="${EMAIL:-}"                     # optional; used for cert-expiry notices
APP_DIR="${APP_DIR:-/opt/aeroassist}"
REPO_URL="${REPO_URL:-https://github.com/alsalahee1/task.git}"
BRANCH="${BRANCH:-ui-modernization}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"       # set only if the GitHub repo is private
PORT="${PORT:-3000}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then echo "Please run as root (sudo)."; exit 1; fi

# --- 1. system packages -----------------------------------------------------
log "Updating apt and installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git nginx ca-certificates ufw

# --- 2. Node.js 22 (node:sqlite needs >= 22; Ubuntu's apt Node is too old) --
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  log "Installing Node.js 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
log "Node $(node -v) / npm $(npm -v)"

# --- 3. get the code --------------------------------------------------------
CLONE_URL="$REPO_URL"
if [ -n "$GITHUB_TOKEN" ]; then
  CLONE_URL="https://${GITHUB_TOKEN}@${REPO_URL#https://}"
fi
if [ -d "$APP_DIR/.git" ]; then
  log "Updating existing checkout in $APP_DIR"
  git -C "$APP_DIR" remote set-url origin "$CLONE_URL"
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "Cloning $REPO_URL ($BRANCH) into $APP_DIR"
  git clone --branch "$BRANCH" "$CLONE_URL" "$APP_DIR"
fi
mkdir -p "$APP_DIR/data" "$APP_DIR/backups"

# --- 4. systemd service -----------------------------------------------------
log "Installing systemd service"
cat > /etc/systemd/system/aeroassist.service <<EOF
[Unit]
Description=AeroAssist (dnata assisted-travel task manager)
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=AERO_DB=$APP_DIR/data/aeroassist.db
ExecStart=$(command -v node) server/index.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable aeroassist
systemctl restart aeroassist
sleep 2
systemctl --no-pager --full status aeroassist | head -n 6 || true

# --- 5. nginx reverse proxy (HTTP first; certbot adds HTTPS) ----------------
log "Configuring nginx for $DOMAIN and $WWW"
cat > /etc/nginx/sites-available/aeroassist <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN $WWW;

    # App + API
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Live updates (Server-Sent Events) must not be buffered
    location /api/stream {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/aeroassist /etc/nginx/sites-enabled/aeroassist
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# --- 6. firewall ------------------------------------------------------------
log "Opening the firewall for web + ssh"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
yes | ufw enable >/dev/null 2>&1 || true

# --- 7. HTTPS via Let's Encrypt --------------------------------------------
log "Requesting an HTTPS certificate (Let's Encrypt)"
apt-get install -y certbot python3-certbot-nginx
CERTBOT_EMAIL_ARG="--register-unsafely-without-email"
[ -n "$EMAIL" ] && CERTBOT_EMAIL_ARG="--email $EMAIL"
if certbot --nginx -d "$DOMAIN" -d "$WWW" --non-interactive --agree-tos --redirect $CERTBOT_EMAIL_ARG; then
  log "HTTPS is live"
else
  echo "!! Certbot failed — this almost always means DNS for $DOMAIN / $WWW"
  echo "   is not pointing at this server yet. Fix the A records, then re-run:"
  echo "   certbot --nginx -d $DOMAIN -d $WWW"
fi

# --- 8. nightly database backup + cert auto-renew ---------------------------
log "Scheduling a nightly database backup"
( crontab -l 2>/dev/null | grep -v 'aeroassist backup' ;
  echo "30 2 * * * cd $APP_DIR && /usr/bin/node setup/backup.mjs >/dev/null 2>&1 # aeroassist backup" ) | crontab -

log "Done."
echo
echo "  AeroAssist should now be live at:  https://$WWW"
echo "  Admin:  https://$WWW/admin     (sign in: admin / admin123)"
echo "  Agent:  https://$WWW/agent     (sign in: ahmed / agent123)"
echo
echo "  IMPORTANT — do these now:"
echo "   1. Sign in as admin and change the admin password (Account button)."
echo "   2. In the Staff tab, create real accounts and disable the demo ones."
echo "   3. Rotate your VPS root password in Hostinger (you shared it in chat)."
