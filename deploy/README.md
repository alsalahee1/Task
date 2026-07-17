# Deploying AeroAssist to your own server (aeroassist.online)

This puts the app online at **https://www.aeroassist.online** with a free
auto-renewing HTTPS certificate. Tested for a Hostinger Ubuntu 24.04 VPS, but works
on any Ubuntu 22.04/24.04 server.

There are two ways to run the server-side script:

- **This server already runs [Dokploy](https://dokploy.com)** (Traefik owns ports
  80/443, and likely other apps like n8n live alongside AeroAssist) — use
  [`dokploy-run.sh`](#auto-deploy-on-every-push-recommended) below. This is the setup
  the live AeroAssist site actually runs on.
- **A bare Ubuntu server with nothing else on it** — use `deploy.sh` (Steps 1–3
  further down), which sets up its own nginx + systemd + certbot stack.

## Auto-deploy on every push (recommended)

Once this is set up, every `git push` to `ui-modernization` automatically tests the
code and — only if the tests pass — redeploys the live site. No terminal paste
needed after this one-time setup.

**1. Create a deploy key restricted to only this one command** (so even if it
   leaked, it could redeploy the app and nothing else — no shell, no other files):
   on the server, run:

   ```bash
   mkdir -p ~/.ssh && chmod 700 ~/.ssh
   cat >> ~/.ssh/authorized_keys <<'EOF'
   command="curl -fsSL https://raw.githubusercontent.com/alsalahee1/task/ui-modernization/deploy/dokploy-run.sh | DOMAIN=aeroassist.online bash",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIrxKWDja/BC0EGOAAvgTmokgYacIzG61lsR3t9QFi5Y aeroassist-deploy
   EOF
   chmod 600 ~/.ssh/authorized_keys
   ```

**2. Add three repository secrets** on GitHub — the repo's
   **Settings → Secrets and variables → Actions → New repository secret**:

   | Secret name | Value |
   |---|---|
   | `VPS_HOST` | `82.112.226.12` |
   | `VPS_USER` | `root` |
   | `VPS_SSH_KEY` | the matching private key (ask your assistant for it — it's paired to the public key above and is only ever meant to live in this GitHub secret, never committed to the repo) |

**3. Push to `ui-modernization`.** The `Deploy` workflow
   ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)) runs the test
   suite, then SSHes in with that key — which, because of the forced `command=` above,
   can only ever run the one redeploy command no matter what it's asked to run.

To revoke auto-deploy later, delete that line from `~/.ssh/authorized_keys` on the
server (or delete the `VPS_SSH_KEY` secret on GitHub).

## Step 1 — Point the domain at your server (do this first)

At wherever you manage the domain's DNS (Hostinger → Domains → DNS/Nameservers),
create two **A records** pointing at your server's IP (e.g. `82.112.226.12`):

| Type | Name | Value |
|------|------|-------|
| A | `@`   | your server IP |
| A | `www` | your server IP |

DNS can take a few minutes (sometimes longer) to propagate. The HTTPS step in the
script needs the domain to resolve to the server, so do this before Step 2.

## Step 2 — Run one command on the server

Open your server's terminal — in Hostinger: **VPS → Manage → Browser terminal**
(or any SSH app) — sign in as `root`, and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/alsalahee1/task/ui-modernization/deploy/deploy.sh \
  | DOMAIN=aeroassist.online EMAIL=you@example.com bash
```

Replace `you@example.com` with your email (used only for certificate-expiry
notices). That's it — the script installs Node.js 22, runs AeroAssist as a service,
configures nginx, and gets the HTTPS certificate. It takes about 2–3 minutes.

When it finishes you'll see the live URLs. The app is now running and will restart
automatically on reboot or crash.

## Step 3 — Secure it (important, right after first launch)

1. Open **https://www.aeroassist.online/admin**, sign in as `admin / admin123`, and
   use the **👤 Account** button to change the admin password immediately.
2. In the **Staff** tab, create real accounts for your team and disable the demo
   users (ahmed, fatima, omar, …).
3. Change your **VPS root password** in Hostinger (the "Change" button on the VPS
   overview) — rotate it if it was ever shared.

## What the script sets up

- **Node.js 22** (required — the app uses Node's built-in SQLite).
- **AeroAssist** as a `systemd` service (`aeroassist.service`) on `localhost:3000`,
  auto-restarting, data stored in `/opt/aeroassist/data/aeroassist.db`.
- **nginx** reverse proxy for `aeroassist.online` + `www`, with Server-Sent Events
  (the live board) correctly un-buffered.
- **Let's Encrypt** HTTPS with automatic renewal, HTTP→HTTPS redirect.
- **Firewall** (ufw) allowing SSH + web only.
- A **nightly database backup** at 02:30 into `/opt/aeroassist/backups/`.

## Updating to the latest code later

Re-run the same one-liner (or, on the server):

```bash
cd /opt/aeroassist && git pull && systemctl restart aeroassist
```

## Loading your real airport (DXB)

Once it's up, load the Dubai terminals and verify coordinates as described in
[`docs/05-real-airport-setup.md`](../docs/05-real-airport-setup.md):

```bash
cd /opt/aeroassist && node setup/load-dxb.mjs
```

## Common issues

- **Certbot failed / "DNS problem"** — the A records aren't pointing at the server
  yet. Wait for DNS, then re-run: `certbot --nginx -d aeroassist.online -d www.aeroassist.online`
- **502 Bad Gateway / service won't start** — the app service isn't running. Check
  `systemctl status aeroassist` and `journalctl -u aeroassist -n 50`. If the log shows
  an error about `node:sqlite`, this Node build needs the experimental flag; re-running
  the deploy script fixes it automatically, or patch it by hand:
  ```bash
  node -e "require('node:sqlite')" 2>/dev/null && FLAG="" || FLAG="--experimental-sqlite"
  sed -i "s#^ExecStart=.*#ExecStart=$(command -v node) $FLAG server/index.js#" \
    /etc/systemd/system/aeroassist.service
  systemctl daemon-reload && systemctl restart aeroassist
  ```
- **Private repo** — if you later make the repo private, pass a GitHub token:
  `... | DOMAIN=aeroassist.online GITHUB_TOKEN=ghp_xxx bash`
