#!/usr/bin/env bash
# ===========================================================================
# Deploy the Honeycomb dashboard (apps/web) to Cloud Run.
#
# Two steps: Cloud Build builds + pushes the image (apps/web/Dockerfile, repo-root
# context), then Cloud Run deploys it. Build context is the REPO ROOT so the
# workspace lockfile is available (see apps/web/Dockerfile). No local Docker needed.
#
#   bash apps/web/deploy.sh
#
# PREREQUISITES (one-time, need a project Owner/Editor — neither the bq-script SA
# nor lukefosteraz@gmail.com had these on honeycomb-499305 as of 2026-06-14):
#   gcloud services enable run.googleapis.com --project=honeycomb-499305
#       # cloudbuild + artifactregistry are already enabled.
#   # the DEPLOYING identity needs: roles/run.admin + roles/iam.serviceAccountUser
#   #   (actAs on the runtime SA) + roles/cloudbuild.builds.editor.
#   # the RUNTIME SA (bq-script) already holds BigQuery Job User + Data Viewer.
# ===========================================================================
set -euo pipefail

PROJECT="${PROJECT:-honeycomb-499305}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-honeycomb-web}"
REPO="${REPO:-honeycomb}"            # Artifact Registry repo (created if missing)
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/web:latest"
# Cloud Run runs as this SA; it must hold BigQuery Job User + Data Viewer.
RUNTIME_SA="${RUNTIME_SA:-bq-script@honeycomb-499305.iam.gserviceaccount.com}"

# Mainnet escrow (the "close quick" redeploy). Lowercased in bq.ts; either case is fine.
BQ_ESCROW_ADDRESS="${BQ_ESCROW_ADDRESS:-0x90058162D3d55542f39507d0328538824A24C9C3}"
# Billing/project for BigQuery jobs (public-dataset reads still bill to a project).
BQ_BILLING_PROJECT="${BQ_BILLING_PROJECT:-honeycomb-499305}"

# --- /ops dashboard wiring -------------------------------------------------
# /ops talks to the deployed honeycomb-api over HTTP. Point it at that service.
HONEYCOMB_API_URL="${HONEYCOMB_API_URL:-https://honeycomb-api-912224428574.us-central1.run.app}"
# Write surface (grade / open-bounty) is LOCAL-DEV ONLY. We set the flag to 0
# EXPLICITLY (not just leave it unset) so the deployed env states the posture:
# /ops is read-only here. The write token (HONEYCOMB_API_TOKEN) is deliberately
# NOT mounted, so even if the flag were flipped the proxy 503s before any upstream
# write -- the public dashboard is read-only by construction, no perms to manage.
HONEYCOMB_DEV="${HONEYCOMB_DEV:-0}"

# --- /agents dashboard wiring ----------------------------------------------
# The per-agent pages (/agents, /agents/[id]) read the SAME Neon DB the MCP
# writes to (grades / tool_calls), via DATABASE_URL. It is a CREDENTIAL, so it
# is mounted from Secret Manager (honeycomb-database-url), never inlined here.
# Set DB_SECRET="" to deploy WITHOUT Neon -- the pages then render an honest
# "persistence not configured" state instead of failing.
DB_SECRET="${DB_SECRET:-honeycomb-database-url}"

cd "$(git rev-parse --show-toplevel)"

echo "[deploy] project=$PROJECT region=$REGION service=$SERVICE"
echo "[deploy] image=$IMAGE runtime-sa=$RUNTIME_SA"
echo "[deploy] BQ_ESCROW_ADDRESS=$BQ_ESCROW_ADDRESS"
echo "[deploy] HONEYCOMB_API_URL=$HONEYCOMB_API_URL"
echo "[deploy] HONEYCOMB_DEV=$HONEYCOMB_DEV  (0 = /ops read-only; no write token mounted)"
echo "[deploy] DB_SECRET=${DB_SECRET:-<none>}  (Neon URL for /agents; empty = persistence off)"

# 1. Artifact Registry repo (idempotent).
gcloud artifacts repositories describe "$REPO" \
  --project="$PROJECT" --location="$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" \
       --project="$PROJECT" --location="$REGION" --repository-format=docker \
       --description="Honeycomb container images"

# 2. Build + push via Cloud Build. `builds submit` has no --file flag, so the
#    Dockerfile path lives in apps/web/cloudbuild.yaml (-f apps/web/Dockerfile).
gcloud builds submit --project="$PROJECT" \
  --config apps/web/cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE}" .

# 3. Deploy to Cloud Run.
#    DATABASE_URL is mounted from Secret Manager when DB_SECRET is set; otherwise
#    the flag is omitted entirely and /agents renders its "persistence off" state.
SECRET_FLAGS=()
if [[ -n "${DB_SECRET}" ]]; then
  SECRET_FLAGS+=(--set-secrets="DATABASE_URL=${DB_SECRET}:latest")
fi

gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$RUNTIME_SA" \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 --memory=512Mi \
  --min-instances=0 --max-instances=4 \
  --set-env-vars="BQ_ESCROW_ADDRESS=${BQ_ESCROW_ADDRESS},BQ_BILLING_PROJECT=${BQ_BILLING_PROJECT},HONEYCOMB_API_URL=${HONEYCOMB_API_URL},HONEYCOMB_DEV=${HONEYCOMB_DEV}" \
  ${SECRET_FLAGS[@]+"${SECRET_FLAGS[@]}"}

echo "[deploy] done. URL:"
gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --format='value(status.url)'
