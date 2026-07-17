# AeroAssist container image — for deploying on Dokploy / any Docker host.
# The app is zero-dependency (Node's built-in http + node:sqlite), so there is
# no `npm install` step: we just copy the source and run it.
FROM node:22-slim

WORKDIR /app

# App source (see .dockerignore for what's excluded).
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# SQLite database lives on a mounted volume so data survives redeploys.
ENV AERO_DB=/data/aeroassist.db
RUN mkdir -p /data

EXPOSE 3000

# node:sqlite is flagless on some Node 22.x builds and behind
# --experimental-sqlite on others; detect which this image needs so the
# container starts either way. `exec` keeps Node as PID 1 for clean shutdown.
CMD ["sh", "-c", "if node -e \"require('node:sqlite')\" 2>/dev/null; then exec node server/index.js; else exec node --experimental-sqlite server/index.js; fi"]
