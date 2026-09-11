#!/usr/bin/env bash
#
# One-time setup for continuous deployment: every push to main runs
# cloudbuild.yaml (test -> build -> push -> update the Cloud Run job).
#
# Creates: an `orion-build` service account with the minimum roles to push the
# image and update the job, the ORION_CV_MD secret (cv.md is not in git), a
# Cloud Build GitHub connection, the linked repository, and the trigger.
#
# Safe to re-run. The GitHub connection needs a one-time authorization in the
# browser: on first run the script prints the link and exits; open it, install
# the Cloud Build GitHub App on the repository, then run the script again.
#
# Usage:
#   PROJECT_ID=orion-hunter-xxxx bash deploy/cloudbuild-trigger-setup.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
REPO_URL="${REPO_URL:-https://github.com/gishnucodes/Orion.git}"
BRANCH_PATTERN="${BRANCH_PATTERN:-^main$}"
CONNECTION="${CONNECTION:-orion-github}"
LINKED_REPO="${LINKED_REPO:-orion}"
TRIGGER="${TRIGGER:-orion-deploy-main}"

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
BUILD_SA="orion-build@${PROJECT_ID}.iam.gserviceaccount.com"
RUN_SA="orion-job@${PROJECT_ID}.iam.gserviceaccount.com"
CB_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
cd "$(dirname "$0")/.."

log "Enabling APIs"
gcloud services enable cloudbuild.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com run.googleapis.com --project "$PROJECT_ID"

log "Build service account and roles"
gcloud iam service-accounts create orion-build --project "$PROJECT_ID" \
  --display-name="Orion Cloud Build deployer" 2>/dev/null || true
gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None \
  --member="serviceAccount:${BUILD_SA}" --role="roles/logging.logWriter" >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None \
  --member="serviceAccount:${BUILD_SA}" --role="roles/run.developer" >/dev/null
gcloud artifacts repositories add-iam-policy-binding orion --project "$PROJECT_ID" \
  --location "$REGION" --member="serviceAccount:${BUILD_SA}" \
  --role="roles/artifactregistry.writer" >/dev/null
# Updating a job that runs as orion-job requires permission to act as it.
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" --project "$PROJECT_ID" \
  --member="serviceAccount:${BUILD_SA}" --role="roles/iam.serviceAccountUser" >/dev/null

log "ORION_CV_MD secret (cv.md is gitignored, the build reads it from here)"
if [[ ! -s cv.md ]]; then
  echo "cv.md not found next to config.yml — create it first" >&2
  exit 1
fi
if gcloud secrets describe ORION_CV_MD --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud secrets versions add ORION_CV_MD --project "$PROJECT_ID" --data-file=cv.md >/dev/null
else
  gcloud secrets create ORION_CV_MD --project "$PROJECT_ID" \
    --replication-policy=automatic --data-file=cv.md >/dev/null
fi
gcloud secrets add-iam-policy-binding ORION_CV_MD --project "$PROJECT_ID" \
  --member="serviceAccount:${BUILD_SA}" --role="roles/secretmanager.secretAccessor" >/dev/null

log "GitHub connection ${CONNECTION}"
# The Cloud Build service agent stores the GitHub OAuth token in Secret Manager.
gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None \
  --member="serviceAccount:${CB_AGENT}" --role="roles/secretmanager.admin" >/dev/null
if ! gcloud builds connections describe "$CONNECTION" --project "$PROJECT_ID" --region "$REGION" >/dev/null 2>&1; then
  gcloud builds connections create github "$CONNECTION" --project "$PROJECT_ID" --region "$REGION"
fi
STAGE=$(gcloud builds connections describe "$CONNECTION" --project "$PROJECT_ID" --region "$REGION" \
  --format='value(installationState.stage)')
if [[ "$STAGE" != "COMPLETE" ]]; then
  ACTION=$(gcloud builds connections describe "$CONNECTION" --project "$PROJECT_ID" --region "$REGION" \
    --format='value(installationState.actionUri)')
  cat <<EOF

GitHub authorization needed (stage: ${STAGE}).
  1. Open: ${ACTION}
  2. Sign in to GitHub, authorize Google Cloud Build, and install the
     Cloud Build GitHub App on the repository (${REPO_URL}).
  3. Re-run this script to link the repository and create the trigger.
EOF
  exit 0
fi

log "Linking repository ${REPO_URL}"
gcloud builds repositories create "$LINKED_REPO" --project "$PROJECT_ID" --region "$REGION" \
  --connection="$CONNECTION" --remote-uri="$REPO_URL" 2>/dev/null || true

log "Trigger ${TRIGGER} (${BRANCH_PATTERN})"
REPO_RESOURCE="projects/${PROJECT_ID}/locations/${REGION}/connections/${CONNECTION}/repositories/${LINKED_REPO}"
if gcloud builds triggers describe "$TRIGGER" --project "$PROJECT_ID" --region "$REGION" >/dev/null 2>&1; then
  echo "Trigger exists — leaving it as is"
else
  # Docs-only commits do not need a new image.
  gcloud builds triggers create github --name="$TRIGGER" --project "$PROJECT_ID" --region "$REGION" \
    --repository="$REPO_RESOURCE" --branch-pattern="$BRANCH_PATTERN" \
    --build-config=cloudbuild.yaml --ignored-files='**/*.md,docs/**' \
    --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
    --description="Test, build and deploy the Orion Cloud Run job on push to main"
fi

cat <<EOF

Done. Pushes to main now deploy automatically. Run it by hand with:
  gcloud builds triggers run ${TRIGGER} --branch=main --project ${PROJECT_ID} --region ${REGION}
EOF
