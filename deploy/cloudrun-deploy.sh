#!/usr/bin/env bash
#
# Build and (re)deploy Orion as a Cloud Run Job. Idempotent — safe to re-run
# after any code change. It rebuilds the image with Cloud Build and updates the
# job in place; the schedule, secrets, and bucket are left untouched.
#
# One-time infrastructure (project, APIs, bucket, secrets, service accounts,
# scheduler) is created by deploy/cloudrun-setup.sh — run that first.
#
# Usage:
#   PROJECT_ID=orion-hunter-xxxx bash deploy/cloudrun-deploy.sh
#
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID to your GCP project id}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-orion}"
JOB="${JOB:-orion}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${JOB}:latest"
RUN_SA="orion-job@${PROJECT_ID}.iam.gserviceaccount.com"
BUCKET="${BUCKET:-${PROJECT_ID}-state}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash-lite}"
# 4Gi: a run that meets a large backlog (e.g. right after tools/import-slugs.mjs
# adds boards) embeds thousands of postings in one pass; 2Gi risked an OOM that
# loses the whole night's work.
MEMORY="${MEMORY:-4Gi}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

cd "$(dirname "$0")/.."

log "Building image with Cloud Build: ${IMAGE}"
gcloud builds submit --project "$PROJECT_ID" --tag "$IMAGE" .

# The tracking sheet id (src/sheet.mjs). --set-env-vars replaces every variable,
# so an unset SHEET_ID would silently disconnect the sheet on the next deploy:
# fall back to the value the job already has.
if [ -z "${SHEET_ID:-}" ]; then
  SHEET_ID="$(gcloud run jobs describe "$JOB" --project "$PROJECT_ID" --region "$REGION" --format=json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const e=JSON.parse(s).spec.template.spec.template.spec.containers[0].env||[];process.stdout.write((e.find(v=>v.name==="SHEET_ID")||{}).value||"")}catch{}})')"
fi

# `deploy` creates the job on first run and updates it in place afterwards.
log "Deploying Cloud Run job: ${JOB}"
gcloud run jobs deploy "$JOB" \
  --project "$PROJECT_ID" --region "$REGION" \
  --image "$IMAGE" \
  --service-account "$RUN_SA" \
  --memory "$MEMORY" --cpu 2 \
  --task-timeout 10800 --max-retries 1 --parallelism 1 --tasks 1 \
  --set-env-vars "GCS_BUCKET=${BUCKET},GCS_DB_OBJECT=jobs.sqlite,GEMINI_MODEL=${GEMINI_MODEL},BQ_DATASET=orion,BQ_TABLE=jobs,SHEET_ID=${SHEET_ID}" \
  --set-secrets "GEMINI_API_KEY=GEMINI_API_KEY:latest,GOOGLE_SEARCH_API_KEY=GOOGLE_SEARCH_API_KEY:latest,GOOGLE_SEARCH_CX=GOOGLE_SEARCH_CX:latest,RESEND_API_KEY=RESEND_API_KEY:latest,RESEND_TO=RESEND_TO:latest,RESEND_FROM=RESEND_FROM:latest"

log "Done. Trigger a run with:  gcloud run jobs execute ${JOB} --project ${PROJECT_ID} --region ${REGION}"
