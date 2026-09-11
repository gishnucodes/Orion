#!/usr/bin/env bash
#
# Provision Orion on a fresh Ubuntu 24.04 host (Oracle Cloud Always Free ARM,
# or any equivalent VPS). Idempotent — safe to re-run.
#
# Usage:  sudo bash deploy/setup.sh
#
set -euo pipefail

ORION_USER=orion
ORION_HOME=/opt/orion
NODE_MAJOR=20
MODEL=qwen2.5:0.5b
# Which extraction backend to provision for. `gemini` (default, matches
# config.yml) skips the local Ollama install entirely — no model RAM, so a
# smaller/cheaper VM works. Set ORION_RUNNER=ollama to provision the local
# model for offline operation.
ORION_RUNNER="${ORION_RUNNER:-gemini}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

log "Installing base packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates git python3 build-essential

log "Installing Node ${NODE_MAJOR}"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
node -v

log "Creating service user ${ORION_USER}"
id -u "$ORION_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$ORION_HOME" --shell /usr/sbin/nologin "$ORION_USER"
mkdir -p "$ORION_HOME"
chown -R "$ORION_USER:$ORION_USER" "$ORION_HOME"

if [[ ! -f "$ORION_HOME/package.json" ]]; then
  cat >&2 <<'EOF'

The application is not present in /opt/orion yet.

Copy it up from your machine, then re-run this script:

    rsync -av --exclude node_modules --exclude .git \
        ./ <user>@<server>:/tmp/orion/
    sudo rsync -a /tmp/orion/ /opt/orion/
    sudo chown -R orion:orion /opt/orion

EOF
  exit 1
fi

log "Installing npm dependencies"
sudo -u "$ORION_USER" bash -c "cd '$ORION_HOME' && npm ci --omit=dev || npm install --omit=dev"

log "Installing Playwright Chromium"
# --with-deps pulls the shared libraries headless Chromium needs; on arm64 this
# is the step most likely to fail, so it runs early and loudly.
sudo -u "$ORION_USER" \
  PLAYWRIGHT_BROWSERS_PATH="$ORION_HOME/.playwright" \
  bash -c "cd '$ORION_HOME' && node node_modules/playwright/cli.js install chromium"
PLAYWRIGHT_BROWSERS_PATH="$ORION_HOME/.playwright" \
  bash -c "cd '$ORION_HOME' && node node_modules/playwright/cli.js install-deps chromium"

if [[ "$ORION_RUNNER" == "ollama" ]]; then
  log "Installing Ollama (ORION_RUNNER=ollama)"
  if ! command -v ollama >/dev/null; then
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  systemctl enable --now ollama
  sleep 5
  log "Pulling model ${MODEL}"
  ollama pull "$MODEL"
else
  log "Skipping Ollama (ORION_RUNNER=${ORION_RUNNER}; extraction uses the Gemini API)"
fi

log "Preparing runtime directories"
sudo -u "$ORION_USER" mkdir -p "$ORION_HOME/db" "$ORION_HOME/raw" "$ORION_HOME/output/logs"

if [[ ! -f "$ORION_HOME/.env" ]]; then
  cat > "$ORION_HOME/.env" <<'EOF'
# Email delivery via Resend (https://resend.com) — free tier 3,000/month.
# RESEND_API_KEY : from https://resend.com/api-keys (starts with re_)
# RESEND_TO      : where the digest goes
# RESEND_FROM    : without your own verified domain, the shared
#                  onboarding@resend.dev sender only delivers to the address
#                  registered on your Resend account.
RESEND_API_KEY=
RESEND_TO=
RESEND_FROM="Orion <onboarding@resend.dev>"

# Gemini extraction (model.runner: gemini). Key: https://aistudio.google.com/apikey
GEMINI_API_KEY=

# Google Programmable Search (scan.search_provider: google).
# GOOGLE_SEARCH_API_KEY : Custom Search API key (Google Cloud console)
# GOOGLE_SEARCH_CX      : engine id from https://programmablesearchengine.google.com
GOOGLE_SEARCH_API_KEY=
GOOGLE_SEARCH_CX=
EOF
  chown "$ORION_USER:$ORION_USER" "$ORION_HOME/.env"
  chmod 600 "$ORION_HOME/.env"
  log "Created $ORION_HOME/.env — fill in your Resend + Gemini + Google Search credentials"
fi

log "Installing systemd units"
install -m 644 "$ORION_HOME/deploy/orion.service" /etc/systemd/system/orion.service
install -m 644 "$ORION_HOME/deploy/orion.timer" /etc/systemd/system/orion.timer
systemctl daemon-reload
systemctl enable orion.timer

cat <<EOF

Setup complete.

Remaining steps, in order:

  1. Fill in Resend credentials, then verify them:
         sudo -e /opt/orion/.env
         sudo -u orion bash /opt/orion/deploy/check-resend.sh

  2. Copy your CV up (it is gitignored, so it is not in the repo):
         scp cv.md <user>@<server>:/tmp/cv.md
         sudo cp /tmp/cv.md /opt/orion/cv.md && sudo chown orion:orion /opt/orion/cv.md

  3. Seed the database so the first run is incremental, not a 6-hour cold start:
         scp db/jobs.sqlite <user>@<server>:/tmp/jobs.sqlite
         sudo cp /tmp/jobs.sqlite /opt/orion/db/jobs.sqlite
         sudo chown orion:orion /opt/orion/db/jobs.sqlite

  4. Suppress the existing backlog so the first run does not send hundreds of
     stale matches:
         sudo -u orion bash -c 'cd /opt/orion && node --env-file=.env src/notify.mjs --mark-seen'

  5. Verify, then start the timer:
         sudo -u orion bash -c 'cd /opt/orion && npm run doctor'
         sudo systemctl start orion.service
         journalctl -u orion -f
         systemctl start orion.timer
         systemctl list-timers orion.timer

EOF
