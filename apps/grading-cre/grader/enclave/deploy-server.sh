#!/usr/bin/env bash
# Deploy the WARM grading enclave to Google Confidential Space (Stage 2).
#
# Unlike the single-shot deploy.sh (one VM per submission, --maintenance-policy=TERMINATE,
# tee-cmd per run), this VM STAYS UP and runs the long-lived daemon (enclave_grade_server.py).
# Each submission arrives over HTTP at POST /grade; the honeycomb-api /grade route reaches it
# at GRADER_ENCLAVE_URL. Same shape as apps/tee-runner/enclave/deploy.sh (the summon runner).
#
# Prereqs (already provisioned this session -- see grader-stage2-live-prod memory):
#   - Artifact Registry repo honeycomb-grader + warm image pushed BY DIGEST (build-server.sh).
#   - Workload SA grader-enclave@ with cloudkms.signerVerifier + viewer on score-signer,
#     artifactregistry.reader, logging.logWriter.
#   - confidentialcomputing + compute APIs enabled.
#
# Usage:  ./deploy-server.sh <image-digest>
#   <image-digest>  e.g. us-central1-docker.pkg.dev/.../grading-enclave-warm@sha256:abc...  (BY DIGEST)
set -euo pipefail

PROJECT=honeycomb-499305
ZONE=us-central1-a
SA=grader-enclave@honeycomb-499305.iam.gserviceaccount.com
# Debug family during bring-up: routes the daemon's stdout/stderr to the serial log so we can
# SEE it come up + sign. Swap to `confidential-space` (non-debug) for the real demo.
CS_IMAGE_FAMILY="${CS_IMAGE_FAMILY:-confidential-space-debug}"

IMAGE_DIGEST="${1:?need image digest (…/grading-enclave-warm@sha256:…) -- run build-server.sh to get it}"
VM_NAME="${VM_NAME:-grading-enclave-warm}"

# OAuth scope = cloud-platform. The Confidential Space LAUNCHER itself (not just our daemon)
# needs broad scope BEFORE the container starts: it pulls the image from AR (devstorage) AND
# builds the attestation/verifier client, which lists project regions (compute) to reach the
# Confidential Computing API. Narrowing to cloudkms+logging+devstorage was verified to fail in
# two stages: first "cannot pull the image ... 401" (no AR scope), then "failed to create REST
# verifier client ... 403: insufficient authentication scopes" (no compute scope for the verifier).
# So we match the proven single-shot deploy.sh and use cloud-platform. The SA's IAM ROLES remain
# the real least-privilege boundary (signerVerifier on one key, AR reader, log writer) -- the OAuth
# scope is only a coarse upper bound on what those roles can be exercised as.
SCOPES="https://www.googleapis.com/auth/cloud-platform"

# The daemon takes NO container args and NO baked submissions: requests arrive over HTTP. We pass
# no tee-cmd. NO --maintenance-policy=TERMINATE: the VM stays up and serves grade requests.
gcloud compute instances create "$VM_NAME" \
  --project="$PROJECT" --zone="$ZONE" \
  --machine-type=n2d-standard-2 \
  --confidential-compute-type=SEV \
  --shielded-secure-boot \
  --service-account="$SA" \
  --scopes="$SCOPES" \
  --image-project=confidential-space-images \
  --image-family="$CS_IMAGE_FAMILY" \
  --metadata="^~^tee-image-reference=${IMAGE_DIGEST}~tee-container-log-redirect=true"

echo
echo "Launched warm grading daemon $VM_NAME. It stays up. Watch it come up with:"
echo "  gcloud compute instances get-serial-port-output $VM_NAME --zone=$ZONE --project=$PROJECT | grep enclave_grade_server"
echo
echo "Point honeycomb-api at it:  GRADER_ENCLAVE_URL=http://<VM_INTERNAL_IP>:8000"
echo "(firewall the VM's :8000 to the API's egress IP; the daemon binds 0.0.0.0:8000)."
echo "Delete when done:  gcloud compute instances delete $VM_NAME --zone=$ZONE --project=$PROJECT -q"
