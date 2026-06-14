#!/usr/bin/env bash
# Build + push the WARM grading enclave image (Dockerfile.server) to Artifact Registry,
# then print the DIGEST. Confidential Space consumes the image BY DIGEST.
#
# Same pattern as apps/tee-runner/enclave/build.sh: CS VMs are amd64, so build
# --platform linux/amd64 explicitly (this dev box is Apple Silicon) or the launcher fails
# with an exec-format error. Requires docker+buildx and gcloud auth configured for AR
# (gcloud auth configure-docker us-central1-docker.pkg.dev).
set -euo pipefail

PROJECT="${PROJECT:-honeycomb-499305}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-honeycomb-grader}"              # reuse the existing Artifact Registry repo
IMAGE="${IMAGE:-grading-enclave-warm}"        # distinct from the single-shot execution-enclave
TAG="${TAG:-latest}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REF="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${IMAGE}:${TAG}"

echo "[build] building ${REF} (linux/amd64, Dockerfile.server) ..."
# --provenance=false keeps the pushed manifest a plain image (not an OCI index), so
# `gcloud artifacts docker images describe` returns one resolvable digest for the launcher.
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  -f "${HERE}/Dockerfile.server" \
  -t "${REF}" \
  --push \
  "${HERE}"

echo "[build] resolving pushed digest ..."
DIGEST="$(gcloud artifacts docker images describe "${REF}" \
  --project="${PROJECT}" --format='value(image_summary.digest)')"

REF_BY_DIGEST="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${IMAGE}@${DIGEST}"
echo
echo "[build] pushed. Deploy this BY-DIGEST reference:"
echo "  ${REF_BY_DIGEST}"
echo
echo "  ./deploy-server.sh ${REF_BY_DIGEST}"
