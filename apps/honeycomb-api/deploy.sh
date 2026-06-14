#!/usr/bin/env bash
# ===========================================================================
# Deploy the Honeycomb HTTP API (apps/honeycomb-api) to Cloud Run.
#
# Two steps: Cloud Build builds + pushes the image (apps/honeycomb-api/Dockerfile,
# repo-root context, BuildKit ON -- see cloudbuild.yaml), then Cloud Run deploys it
# with the VPC connector attached so /grade can reach the internal-only grading
# enclave, and with all secrets mounted from Secret Manager.
#
#   bash apps/honeycomb-api/deploy.sh
#
# NETWORK PATH (chosen 2026-06-14): Serverless VPC connector + internal IP.
#   --vpc-connector honeycomb-conn (10.8.0.0/28) routes RFC-1918 egress onto the
#   VPC; --vpc-egress private-ranges-only keeps PUBLIC egress (GitHub for cre, the
#   Sepolia RPC) going straight out. The enclave VM grading-enclave-warm has NO
#   public IP -- only 10.128.0.14 -- and firewall allow-grading-enclave-8000-internal
#   opens :8000 to 10.8.0.0/28 only. So GRADER_ENCLAVE_URL=http://10.128.0.14:8000.
#
# SECRETS: mounted via --set-secrets (Secret Manager -> env). NONE are baked into
#   the image. The runtime SA (bq-script@) holds secretAccessor on all five.
#
# KNOWN LIMITATION -- /submit broadcast leg: submitWork shells to the `cre` CLI,
#   which authenticates via interactive `cre login` (browser OAuth+2FA) writing
#   ~/.cre/cre.yaml. There is no such session in Cloud Run, and the CRE_API_KEY
#   path gates on Early-Access deploy approval (returns "invalid token"). So in the
#   deployed image /submit's `cre workflow simulate --broadcast` step FAILS LOUDLY
#   (no false green -- correct per the error-handling contract). /bounties, /grade
#   (incl. the enclave-signed score via the connector), /jobs, /events, /reputation
#   all work. Run /submit's broadcast from a box with a live `cre login` session.
#
# PREREQUISITES (already satisfied on honeycomb-499305 as of 2026-06-14):
#   - run.googleapis.com + cloudbuild + artifactregistry + vpcaccess enabled.
#   - VPC connector honeycomb-conn READY (us-central1, 10.8.0.0/28).
#   - 5 secrets created; runtime SA bq-script@ granted secretAccessor on each.
#   - enclave VM internal-only (10.128.0.14), firewalled :8000 <- 10.8.0.0/28.
# ===========================================================================
set -euo pipefail

PROJECT="${PROJECT:-honeycomb-499305}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-honeycomb-api}"
REPO="${REPO:-honeycomb}"            # Artifact Registry repo (shared with web)
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/honeycomb-api:latest"
# Cloud Run runs as this SA; it holds secretAccessor on the 5 secrets + BigQuery
# Job User/Data Viewer (for /reputation).
RUNTIME_SA="${RUNTIME_SA:-bq-script@honeycomb-499305.iam.gserviceaccount.com}"

# VPC connector -> reach the internal-only grading enclave.
VPC_CONNECTOR="${VPC_CONNECTOR:-honeycomb-conn}"
# Internal IP of grading-enclave-warm. (Internal IPs are stable across stop/start;
# re-check with `gcloud compute instances describe grading-enclave-warm` if the VM
# is recreated.) :8000 is the warm daemon, opened to the connector range only.
GRADER_ENCLAVE_URL="${GRADER_ENCLAVE_URL:-http://10.128.0.14:8000}"
# CRE relay settings file naming the deployed escrow/forwarder (mainnet-settings).
HONEYCOMB_CRE_TARGET="${HONEYCOMB_CRE_TARGET:-mainnet-settings}"

cd "$(git rev-parse --show-toplevel)"

echo "[deploy] project=$PROJECT region=$REGION service=$SERVICE"
echo "[deploy] image=$IMAGE runtime-sa=$RUNTIME_SA"
echo "[deploy] vpc-connector=$VPC_CONNECTOR -> GRADER_ENCLAVE_URL=$GRADER_ENCLAVE_URL"

# 1. Artifact Registry repo (idempotent; shared with the web image).
gcloud artifacts repositories describe "$REPO" \
  --project="$PROJECT" --location="$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" \
       --project="$PROJECT" --location="$REGION" --repository-format=docker \
       --description="Honeycomb container images"

# 2. Build + push via Cloud Build (BuildKit on -- see cloudbuild.yaml).
gcloud builds submit --project="$PROJECT" \
  --config apps/honeycomb-api/cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE}" .

# 3. Deploy to Cloud Run with the connector + secrets.
#    --set-secrets maps Secret Manager -> env (latest version). The server reads:
#      SEP_PRIVATE_KEY        (write routes sign chain tx)
#      INFERENCE_API_KEY_VAR  (maker/inference path)
#      SEPOLIA_RPC            (chain RPC; sepolia.ts reads SEPOLIA_RPC env first)
#      CRE_API_KEY            (present for completeness; see /submit limitation above)
#      HONEYCOMB_API_TOKEN    (write-route guard; without it write routes 401)
gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$RUNTIME_SA" \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=2 --memory=2Gi \
  --min-instances=0 --max-instances=2 \
  --timeout=300 \
  --vpc-connector="$VPC_CONNECTOR" \
  --vpc-egress=private-ranges-only \
  --set-env-vars="HOST=0.0.0.0,GRADER_ENCLAVE_URL=${GRADER_ENCLAVE_URL},HONEYCOMB_CRE_TARGET=${HONEYCOMB_CRE_TARGET},HONEYCOMB_GRADER_VENV=/repo/apps/grading-cre/grader/.venv/bin" \
  --set-secrets="SEP_PRIVATE_KEY=honeycomb-sep-private-key:latest,INFERENCE_API_KEY_VAR=honeycomb-inference-api-key:latest,SEPOLIA_RPC=honeycomb-sepolia-rpc:latest,CRE_API_KEY=honeycomb-cre-api-key:latest,HONEYCOMB_API_TOKEN=honeycomb-api-token:latest"

echo "[deploy] done. URL:"
gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --format='value(status.url)'
