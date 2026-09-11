#!/usr/bin/env bash
#
# Push Orion to a server and provision it.
#
#   bash deploy/push.sh -k ~/.ssh/orion.key ubuntu@1.2.3.4            # app only
#   bash deploy/push.sh -k ~/.ssh/orion.key --seed ubuntu@1.2.3.4     # + seed the database
#   bash deploy/push.sh -k ~/.ssh/orion.key --seed --setup ubuntu@1.2.3.4
#
# --seed   also copies db/jobs.sqlite so the first server run is incremental
#          rather than a multi-hour cold start.
# --setup  runs deploy/setup.sh remotely after copying (needs sudo on the host).
#
# Secrets (cv.md, .env) are copied over SSH but never committed anywhere.
#
set -euo pipefail
cd "$(dirname "$0")/.."

KEY=""; SEED=0; SETUP=0; TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -k|--key)  KEY="$2"; shift 2 ;;
    --seed)    SEED=1; shift ;;
    --setup)   SETUP=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *)         TARGET="$1"; shift ;;
  esac
done

[[ -n "$TARGET" ]] || { echo "Usage: bash deploy/push.sh -k <key> [--seed] [--setup] user@host" >&2; exit 1; }

SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[[ -n "$KEY" ]] && SSH_OPTS+=(-i "$KEY")
RSH="ssh ${SSH_OPTS[*]}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

log "Checking connectivity to $TARGET"
ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 "$TARGET" 'echo "  connected: $(lsb_release -ds 2>/dev/null || uname -a)"'

log "Preparing /tmp/orion-push on the server"
ssh "${SSH_OPTS[@]}" "$TARGET" 'rm -rf /tmp/orion-push && mkdir -p /tmp/orion-push'

log "Copying application"
# node_modules and .playwright are rebuilt on the host (native + arm64 binaries);
# raw/ and output/ are regenerated; db/ is handled separately by --seed.
rsync -az --info=stats1 -e "$RSH" \
  --exclude node_modules \
  --exclude .git \
  --exclude .playwright \
  --exclude raw \
  --exclude raw-test \
  --exclude output \
  --exclude db \
  --exclude '.DS_Store' \
  ./ "$TARGET:/tmp/orion-push/"

for secret in cv.md .env; do
  if [[ -f "$secret" ]]; then
    log "Copying $secret"
    rsync -az -e "$RSH" "$secret" "$TARGET:/tmp/orion-push/$secret"
  else
    echo "  WARNING: $secret not found locally — you must create it on the server"
  fi
done

if [[ $SEED -eq 1 ]]; then
  if [[ -f db/jobs.sqlite ]]; then
    log "Seeding database ($(du -h db/jobs.sqlite | cut -f1))"
    ssh "${SSH_OPTS[@]}" "$TARGET" 'mkdir -p /tmp/orion-push/db'
    # Checkpoint any WAL into the main file first so the copy is self-contained.
    sqlite3 db/jobs.sqlite 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true
    rsync -az --info=stats1 -e "$RSH" db/jobs.sqlite "$TARGET:/tmp/orion-push/db/jobs.sqlite"
  else
    echo "  WARNING: db/jobs.sqlite not found — skipping seed"
  fi
fi

log "Installing into /opt/orion"
ssh "${SSH_OPTS[@]}" "$TARGET" '
  set -e
  sudo mkdir -p /opt/orion
  sudo rsync -a /tmp/orion-push/ /opt/orion/
  sudo chmod 600 /opt/orion/.env 2>/dev/null || true
  sudo chown -R root:root /opt/orion
  echo "  installed"
'

if [[ $SETUP -eq 1 ]]; then
  log "Running setup.sh remotely (this installs Node, Chromium and Ollama — several minutes)"
  ssh "${SSH_OPTS[@]}" -t "$TARGET" 'sudo bash /opt/orion/deploy/setup.sh'
else
  cat <<EOF

Copied. Now provision the host:

    ssh ${KEY:+-i $KEY} $TARGET
    sudo bash /opt/orion/deploy/setup.sh

Or re-run this script with --setup to do it in one step.
EOF
fi
