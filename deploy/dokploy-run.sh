#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# AeroAssist — one-command deploy onto a server that already runs Dokploy
# (Traefik + Docker Swarm). It does NOT touch Dokploy, n8n, or anything else:
# it builds the app image and registers it with the existing Traefik so the
# app comes up on your domain with an automatic Let's Encrypt certificate.
#
# Run as root on the server:
#   curl -fsSL <raw url>/deploy/dokploy-run.sh | DOMAIN=aeroassist.online bash
#
# Prereqs: DNS A records for the domain + www must already point at this server
# (Traefik needs that to issue the HTTPS certificate).
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${DOMAIN:-aeroassist.online}"
WWW="www.${DOMAIN}"
APP_DIR="${APP_DIR:-/opt/aeroassist}"
REPO_URL="${REPO_URL:-https://github.com/alsalahee1/task.git}"
BRANCH="${BRANCH:-ui-modernization}"
NAME="aeroassist"
PORT="${PORT:-3000}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then echo "Please run as root."; exit 1; fi
command -v docker >/dev/null || { echo "Docker not found on this host."; exit 1; }

# --- 1. get the code --------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  log "Updating $APP_DIR ($BRANCH)"
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "Cloning into $APP_DIR ($BRANCH)"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

# --- 2. build the image -----------------------------------------------------
log "Building the ${NAME} image (zero-dependency, ~30s)"
docker build -t "${NAME}:latest" "$APP_DIR"

# --- 3. discover the Dokploy network + Traefik cert resolver ----------------
NET="$(docker network ls --format '{{.Name}}' | grep -x 'dokploy-network' || true)"
[ -z "$NET" ] && NET="$(docker network ls --format '{{.Name}}' | grep -i dokploy | head -n1 || true)"
[ -z "$NET" ] && { echo "!! Could not find the Dokploy docker network:"; docker network ls; exit 1; }

CERT_RESOLVER="$(awk '/certificatesResolvers:/{f=1;next} f&&/^[[:space:]]+[A-Za-z0-9_-]+:/{gsub(/[ :]/,"");print;exit}' \
  /etc/dokploy/traefik/traefik.yml 2>/dev/null || true)"
[ -z "$CERT_RESOLVER" ] && CERT_RESOLVER="letsencrypt"

log "Using network=$NET  cert-resolver=$CERT_RESOLVER  domain=$WWW / $DOMAIN"

RULE="Host(\`$WWW\`) || Host(\`$DOMAIN\`)"
LABELS=(
  "traefik.enable=true"
  "traefik.docker.network=$NET"
  "traefik.http.routers.${NAME}.rule=$RULE"
  "traefik.http.routers.${NAME}.entrypoints=websecure"
  "traefik.http.routers.${NAME}.tls=true"
  "traefik.http.routers.${NAME}.tls.certresolver=$CERT_RESOLVER"
  "traefik.http.services.${NAME}.loadbalancer.server.port=$PORT"
  "traefik.http.routers.${NAME}-web.rule=$RULE"
  "traefik.http.routers.${NAME}-web.entrypoints=web"
  "traefik.http.routers.${NAME}-web.middlewares=${NAME}-redir"
  "traefik.http.middlewares.${NAME}-redir.redirectscheme.scheme=https"
)

docker volume create "${NAME}-data" >/dev/null

# --- 4. deploy (Swarm service if this is a swarm, else a plain container) ----
if [ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)" = "active" ]; then
  log "Deploying as a Swarm service"
  docker service rm "${NAME}" >/dev/null 2>&1 || true
  sleep 3
  SARGS=()
  # set both service labels (swarm provider) and container labels (docker provider)
  for l in "${LABELS[@]}"; do SARGS+=(--label "$l" --container-label "$l"); done
  docker service create --name "${NAME}" \
    --network "$NET" \
    --mount type=volume,source="${NAME}-data",target=/data \
    --replicas 1 \
    "${SARGS[@]}" \
    "${NAME}:latest"
else
  log "Deploying as a Docker container"
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  LARGS=()
  for l in "${LABELS[@]}"; do LARGS+=(--label "$l"); done
  docker run -d --name "${NAME}" --restart unless-stopped \
    --network "$NET" \
    -v "${NAME}-data":/data \
    "${LARGS[@]}" \
    "${NAME}:latest"
fi

# --- 5. verify --------------------------------------------------------------
log "Waiting for the app to come up..."
sleep 10
echo "--- container / service state ---"
docker ps --filter "name=${NAME}" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
echo "--- routing test through Traefik (Host: $WWW) ---"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $WWW" http://127.0.0.1/ || true)"
echo "HTTP via Traefik -> $code  (301/308 = routing works, redirecting to HTTPS)"

cat <<EOF

==========================================================================
 Done. If DNS for $WWW points at this server, open:

     https://$WWW

 The first visit may take ~30s while Traefik issues the SSL certificate.
 Sign in as  admin / admin123  and change the password immediately.

 If the routing test above showed 404, tell your assistant — Traefik may
 use different entrypoint/resolver names and we'll adjust one line.
==========================================================================
EOF
