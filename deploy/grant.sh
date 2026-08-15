#!/usr/bin/env bash
# Grant someone access to the IAP-protected dashboard.
#
#   ./deploy/grant.sh PROJECT_ID domain:yourcompany.com          # everyone on the domain
#   ./deploy/grant.sh PROJECT_ID user:alice@yourcompany.com      # one person
#   ./deploy/grant.sh PROJECT_ID group:finance@yourcompany.com   # a Google group
#
# Prefer a group over a domain: spend data broken down by named individuals is
# not something the whole company needs, and a group is one place to change it.

set -euo pipefail

PROJECT="${1:?Usage: ./deploy/grant.sh PROJECT_ID MEMBER}"
MEMBER="${2:?e.g. user:someone@yourcompany.com | group:… | domain:yourcompany.com}"
REGION="${REGION:-us-central1}"
SERVICE="cursor-spend-dashboard"

gcloud iap web add-iam-policy-binding \
  --project="$PROJECT" \
  --member="$MEMBER" \
  --role=roles/iap.httpsResourceAccessor \
  --region="$REGION" \
  --resource-type=cloud-run \
  --service="$SERVICE"

echo "Granted $MEMBER. It can take a minute or two to take effect."
