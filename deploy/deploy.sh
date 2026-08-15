#!/usr/bin/env bash
# Deploy the service, the ingest job, and the 6-hour schedule.
# Safe to re-run — every step is create-or-update.
#
#   ./deploy/deploy.sh YOUR_PROJECT_ID
#
# Grant people access afterwards with:
#   ./deploy/grant.sh YOUR_PROJECT_ID user:someone@yourcompany.com
#   ./deploy/grant.sh YOUR_PROJECT_ID domain:yourcompany.com

set -euo pipefail

PROJECT="${1:?Usage: ./deploy/deploy.sh PROJECT_ID}"
REGION="${REGION:-us-central1}"
DATASET="${DATASET:-cursor_usage}"
SERVICE="cursor-spend-dashboard"
JOB="cursor-spend-ingest"
SA_EMAIL="cursor-spend@${PROJECT}.iam.gserviceaccount.com"

ENVS="STORAGE_DRIVER=bigquery,GCP_PROJECT_ID=${PROJECT},BQ_DATASET=${DATASET},BQ_LOCATION=${REGION},MONTHLY_BUDGET_USD=${MONTHLY_BUDGET_USD:-3000},ON_DEMAND_BUDGET_USD=${ON_DEMAND_BUDGET_USD:-1500}"

gcloud config set project "$PROJECT" >/dev/null

echo "==> Deploying ingest job"
if gcloud run jobs describe "$JOB" --region="$REGION" >/dev/null 2>&1; then
  VERB="update"
else
  VERB="create"
fi
gcloud run jobs "$VERB" "$JOB" \
  --source=. \
  --region="$REGION" \
  --service-account="$SA_EMAIL" \
  --set-env-vars="$ENVS" \
  --set-secrets="CURSOR_API_KEY=cursor-admin-api-key:latest" \
  --command=node \
  --args=scripts/ingest-cli.mjs \
  --task-timeout=20m \
  --max-retries=2 \
  --memory=1Gi

echo "==> Deploying dashboard service (IAP on, no anonymous access)"
gcloud run deploy "$SERVICE" \
  --source=. \
  --region="$REGION" \
  --service-account="$SA_EMAIL" \
  --set-env-vars="$ENVS" \
  --no-allow-unauthenticated \
  --iap \
  --memory=1Gi \
  --min-instances=0

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
echo "==> Letting IAP invoke the service"
gcloud run services add-iam-policy-binding "$SERVICE" \
  --region="$REGION" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
  --role=roles/run.invoker >/dev/null

echo "==> Scheduling ingestion every 6 hours (IST)"
SCHED_SA="$SA_EMAIL"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SCHED_SA}" --role=roles/run.invoker --condition=None >/dev/null

URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB}:run"
if gcloud scheduler jobs describe "${JOB}-6h" --location="$REGION" >/dev/null 2>&1; then
  SVERB="update"
else
  SVERB="create"
fi
gcloud scheduler jobs "$SVERB" http "${JOB}-6h" \
  --location="$REGION" \
  --schedule="0 */6 * * *" \
  --time-zone="Asia/Kolkata" \
  --uri="$URI" \
  --http-method=POST \
  --oauth-service-account-email="$SCHED_SA" \
  --attempt-deadline=1800s

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
echo
echo "Dashboard: $URL"
echo
echo "Nobody can open it yet — IAP denies by default. Grant access:"
echo "  ./deploy/grant.sh $PROJECT domain:yourcompany.com"
echo
echo "First run needs history. Backfill once (takes a few minutes):"
echo "  gcloud run jobs execute $JOB --region=$REGION --args=scripts/backfill.mjs --wait"
