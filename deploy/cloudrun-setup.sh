#!/usr/bin/env bash
#
# One-time GCP infrastructure for running Orion as a scheduled Cloud Run Job.
# Creates: APIs, an Artifact Registry repo, a GCS bucket for the SQLite
# database, Secret Manager secrets, two service accounts (runtime + scheduler),
# IAM bindings, and a nightly Cloud Scheduler trigger.
#
# Idempotent-ish: re-running is generally safe, but "already exists" errors are
# expected on a second run and can be ignored.
#
# Prerequisites: gcloud is authenticated (`gcloud auth login`) and a billing
# account id is available.
#
# Usage:
#   PROJECT_ID=orion-hunter-xxxx BILLING_ACCOUNT=0X0X0X-0X0X0X-0X0X0X \
#     bash deploy/cloudrun-setup.sh
#
# After it runs, populate the placeholder secrets (see the echoed instructions),
# then build and deploy with deploy/cloudrun-deploy.sh.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:?set BILLING_ACCOUNT (gcloud beta billing accounts list)}"
REGION="${REGION:-us-central1}"
TZ_NAME="${TZ_NAME:-America/New_York}"
SCHEDULE="${SCHEDULE:-0 6 * * *}"

BUCKET="${PROJECT_ID}-state"
RUN_SA="orion-job@${PROJECT_ID}.iam.gserviceaccount.com"
SCHED_SA="orion-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
secret() {  # create-or-add a secret version without echoing the value
  local name="$1" value="$2"
  if gcloud secrets describe "$name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --project "$PROJECT_ID" --data-file=- >/dev/null
  else
    printf '%s' "$value" | gcloud secrets create "$name" --project "$PROJECT_ID" \
      --replication-policy=automatic --data-file=- >/dev/null
  fi
}

log "Creating project ${PROJECT_ID} (skip if it exists)"
gcloud projects create "$PROJECT_ID" --name="Orion Job Hunter" 2>/dev/null || true
gcloud beta billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT" >/dev/null
gcloud config set project "$PROJECT_ID" >/dev/null

log "Enabling APIs"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com secretmanager.googleapis.com \
  generativelanguage.googleapis.com customsearch.googleapis.com \
  storage.googleapis.com apikeys.googleapis.com bigquery.googleapis.com \
  --project "$PROJECT_ID"

log "Artifact Registry repo + GCS state bucket"
gcloud artifacts repositories create orion --project "$PROJECT_ID" \
  --repository-format=docker --location="$REGION" 2>/dev/null || true
gcloud storage buckets create "gs://${BUCKET}" --project "$PROJECT_ID" \
  --location="$REGION" --uniform-bucket-level-access 2>/dev/null || true

log "Service accounts"
gcloud iam service-accounts create orion-job --project "$PROJECT_ID" \
  --display-name="Orion Cloud Run job" 2>/dev/null || true
gcloud iam service-accounts create orion-scheduler --project "$PROJECT_ID" \
  --display-name="Orion scheduler" 2>/dev/null || true

log "BigQuery dataset (analysis mirror for Looker Studio)"
bq --project_id="$PROJECT_ID" --location=US mk --dataset \
  --description "Orion job scanner results" "${PROJECT_ID}:orion" 2>/dev/null || true

log "IAM bindings"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUN_SA}" --role="roles/secretmanager.secretAccessor" \
  --condition=None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${RUN_SA}" --role="roles/storage.objectAdmin" >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUN_SA}" --role="roles/bigquery.jobUser" --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUN_SA}" --role="roles/bigquery.dataEditor" --condition=None >/dev/null

log "API keys (Gemini + Custom Search), stored in Secret Manager"
GEMINI_KEY=$(gcloud services api-keys create --project "$PROJECT_ID" \
  --display-name="orion-gemini" \
  --api-target=service=generativelanguage.googleapis.com \
  --format="value(response.keyString)")
SEARCH_KEY=$(gcloud services api-keys create --project "$PROJECT_ID" \
  --display-name="orion-customsearch" \
  --api-target=service=customsearch.googleapis.com \
  --format="value(response.keyString)")
secret GEMINI_API_KEY "$GEMINI_KEY"
secret GOOGLE_SEARCH_API_KEY "$SEARCH_KEY"
# Placeholders — fill these in (see below).
secret GOOGLE_SEARCH_CX "REPLACE_ME"
secret RESEND_API_KEY "REPLACE_ME"
secret RESEND_TO "REPLACE_ME"
secret RESEND_FROM "Orion <onboarding@resend.dev>"

log "Nightly Cloud Scheduler trigger (${SCHEDULE} ${TZ_NAME})"
gcloud run jobs add-iam-policy-binding orion --project "$PROJECT_ID" --region "$REGION" \
  --member="serviceAccount:${SCHED_SA}" --role="roles/run.invoker" >/dev/null 2>&1 || \
  echo "(deploy the job first, then re-run to bind the scheduler)"
gcloud scheduler jobs create http orion-nightly --project "$PROJECT_ID" --location "$REGION" \
  --schedule="$SCHEDULE" --time-zone="$TZ_NAME" \
  --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/orion:run" \
  --http-method=POST --oauth-service-account-email="${SCHED_SA}" \
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" 2>/dev/null || true

cat <<EOF

Setup complete. Remaining manual steps:

  1. Create a Programmable Search Engine at
     https://programmablesearchengine.google.com  (search the whole web),
     copy its "Search engine ID", and store it:

       printf '%s' 'YOUR_CX_ID' | gcloud secrets versions add GOOGLE_SEARCH_CX \\
         --project ${PROJECT_ID} --data-file=-

  2. Store your Resend credentials the same way (RESEND_API_KEY, RESEND_TO,
     and optionally RESEND_FROM).

  3. Build and deploy the job:
       PROJECT_ID=${PROJECT_ID} bash deploy/cloudrun-deploy.sh

  4. (First deploy) bind the scheduler and create it by re-running this script,
     or run the two scheduler commands above.
EOF
