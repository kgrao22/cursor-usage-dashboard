#!/usr/bin/env bash
# One-time GCP setup. Run once per project, then use deploy.sh for every push.
#
# Architecture, and why it is split in two:
#
#   Cloud Run SERVICE  cursor-spend-dashboard   IAP-protected, read-only
#   Cloud Run JOB      cursor-spend-ingest      no ingress, writes to BigQuery
#   Cloud Scheduler -> the JOB, every 6 hours
#
# IAP intercepts inbound requests and substitutes the caller's identity, so a
# scheduler calling an IAP-protected service fights the very thing protecting
# it. Running ingestion as a Job sidesteps that entirely: nothing external can
# reach it, and the dashboard has no write path to abuse.
#
#   ./deploy/setup.sh YOUR_PROJECT_ID

set -euo pipefail

PROJECT="${1:?Usage: ./deploy/setup.sh PROJECT_ID}"
REGION="${REGION:-us-central1}"
DATASET="${DATASET:-cursor_usage}"
SA="cursor-spend"
SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"

echo "Project : $PROJECT"
echo "Region  : $REGION"
echo

gcloud config set project "$PROJECT" >/dev/null

echo "==> Enabling APIs (a few minutes on a fresh project)"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  bigquery.googleapis.com \
  secretmanager.googleapis.com \
  iap.googleapis.com \
  artifactregistry.googleapis.com

echo "==> Service account"
gcloud iam service-accounts create "$SA" \
  --display-name="Cursor spend dashboard" 2>/dev/null || echo "    exists"

for ROLE in roles/bigquery.dataEditor roles/bigquery.jobUser; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${SA_EMAIL}" --role="$ROLE" --condition=None >/dev/null
done

echo "==> BigQuery dataset ${DATASET} in ${REGION}"
bq --location="$REGION" mk --dataset "${PROJECT}:${DATASET}" 2>/dev/null || echo "    exists"

echo "==> Secret for the Cursor admin key"
if ! gcloud secrets describe cursor-admin-api-key >/dev/null 2>&1; then
  echo "    Paste the Cursor TEAM ADMIN API key, then press Ctrl-D:"
  gcloud secrets create cursor-admin-api-key --data-file=-
else
  echo "    exists — to rotate:"
  echo "    printf '%s' 'crsr_...' | gcloud secrets versions add cursor-admin-api-key --data-file=-"
fi
gcloud secrets add-iam-policy-binding cursor-admin-api-key \
  --member="serviceAccount:${SA_EMAIL}" \
  --role=roles/secretmanager.secretAccessor >/dev/null

echo
echo "Setup complete. Next:"
echo "  ./deploy/deploy.sh $PROJECT"
