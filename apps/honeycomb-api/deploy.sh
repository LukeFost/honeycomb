#!/usr/bin/env bash
# ===========================================================================
# Deploy the Honeycomb HTTP API (apps/honeycomb-api) to Cloud Run.
#
# Two steps: Cloud Build builds + pushes the image (apps/honeycomb-api/Dockerfile,
# repo-root context, BuildKit ON -- see cloudbuild.yaml), then Cloud Run deploys it
# with all secrets mounted from Secret Manager. The VPC connector is still
# attached so the optional enclave grading backend can be enabled without a new
# deploy script, but direct grading is the default.
#
#   bash apps/honeycomb-api/deploy.sh
#
# OPTIONAL ENCLAVE NETWORK PATH (chosen 2026-06-14): Serverless VPC connector + internal IP.
#   --vpc-connector honeycomb-conn (10.8.0.0/28) routes RFC-1918 egress onto the
#   VPC; --vpc-egress private-ranges-only keeps PUBLIC egress (Sepolia RPC, etc.)
#   going straight out. The enclave VM grading-enclave-warm reaches :8000 via its
#   internal IP, and firewall allow-grading-enclave-8000-internal opens :8000 to
#   10.8.0.0/28 only. Setting HONEYCOMB_ENABLE_ENCLAVE_GRADING=1 makes /grade
#   use GRADER_ENCLAVE_URL=http://<internal-ip>:8000 (currently 10.128.0.25).
#
# SECRETS: mounted via --set-secrets (Secret Manager -> env). NONE are baked into
#   the image. The runtime SA (bq-script@) holds secretAccessor on the mounted
#   secrets below.
#
# /submit is intentionally direct/off-chain now. It grades the submitted work and
# returns a durable submission.sha256 receipt plus recordedOnChain=false; it does
# not shell to CRE, need a CRE login/API key, or claim to mutate the escrow leader.
#
# PREREQUISITES (already satisfied on honeycomb-499305 as of 2026-06-14):
#   - run.googleapis.com + cloudbuild + artifactregistry + vpcaccess enabled.
#   - VPC connector honeycomb-conn READY (us-central1, 10.8.0.0/28).
#   - runtime SA bq-script@ granted secretAccessor on each mounted secret.
#   - enclave VM grading-enclave-warm (internal IP 10.128.0.25), firewalled
#     :8000 <- 10.8.0.0/28 by tag grading-enclave.
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
# Internal IP of grading-enclave-warm. Ephemeral: stable across stop/start but
# CHANGES if the VM is recreated (that's what stranded the old .14). Re-check with
# `gcloud compute instances list` and update here after any rebuild. The firewall
# keys on tag `grading-enclave` + the connector range, not the IP, so only this
# literal needs to track the VM. :8000 is the warm daemon.
GRADER_ENCLAVE_URL="${GRADER_ENCLAVE_URL:-http://10.128.0.25:8000}"


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
#      INFERENCE_API_KEY_VAR  (optional AI validity; only used when explicitly enabled)
#      SEPOLIA_RPC            (chain RPC; sepolia.ts reads SEPOLIA_RPC env first)
#      HONEYCOMB_API_TOKEN    (write-route guard; without it write routes 401)
#      DATABASE_URL           (Neon; powers all 3 recording streams — telemetry,
#                              grades, and the co-located chain subscriber)
#      SEPOLIA_WS             (Alchemy wss node; the chain subscriber's eth_subscribe.
#                              SEPARATE from SEPOLIA_RPC — Goldsky HTTP can't do WS)
#
# ALWAYS-ON for the co-located subscriber: server.ts boots a long-lived
# eth_subscribe watcher in-process (startSubscriberIfConfigured). Cloud Run would
# (a) idle the instance to zero between requests and (b) throttle its CPU to ~0
# when no request is in flight — either freezes the WS loop and drops events. So:
#   --min-instances=1   keep one instance always warm (never scale to zero)
#   --no-cpu-throttling  allocate CPU continuously, not just during a request, so
#                        the background subscriber keeps processing pushed logs.
# This is the cost of hosting the watcher here (one always-warm instance) — the
# tradeoff the user accepted by choosing "co-locate in honeycomb-api".
gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$RUNTIME_SA" \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=2 --memory=2Gi \
  --min-instances=1 --max-instances=2 \
  --no-cpu-throttling \
  --timeout=300 \
  --vpc-connector="$VPC_CONNECTOR" \
  --vpc-egress=private-ranges-only \
  --set-env-vars="HOST=0.0.0.0,HONEYCOMB_ENABLE_ENCLAVE_GRADING=${HONEYCOMB_ENABLE_ENCLAVE_GRADING:-0},GRADER_ENCLAVE_URL=${GRADER_ENCLAVE_URL},HONEYCOMB_GRADER_VENV=/repo/apps/grading-cre/grader/.venv/bin,HONEYCOMB_PYTHON=/repo/apps/grading-cre/grader/.venv/bin/python" \
  --set-secrets="SEP_PRIVATE_KEY=honeycomb-sep-private-key:latest,INFERENCE_API_KEY_VAR=honeycomb-inference-api-key:latest,SEPOLIA_RPC=honeycomb-sepolia-rpc:latest,HONEYCOMB_API_TOKEN=honeycomb-api-token:latest,DATABASE_URL=honeycomb-database-url:latest,SEPOLIA_WS=honeycomb-sepolia-ws:latest"

echo "[deploy] done. URL:"
gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --format='value(status.url)'
