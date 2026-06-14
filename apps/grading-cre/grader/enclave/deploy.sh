#!/usr/bin/env bash
# Deploy the execution-grading enclave to Google Confidential Space (Stage 2).
#
# Launches a Confidential VM that pulls the enclave image BY DIGEST, runs the grade,
# signs the score in-enclave with the KMS HSM key (via the attested workload SA), and
# logs the signed payload. The VM is single-shot: it grades one submission and the
# launcher exits.
#
# Prereqs (already provisioned this session):
#   - Artifact Registry repo honeycomb-grader + image pushed (build.sh).
#   - Workload SA grader-enclave@ with cloudkms.signerVerifier + viewer on score-signer,
#     artifactregistry.reader, logging.logWriter.
#   - confidentialcomputing + compute APIs enabled.
#
# Usage:  ./deploy.sh <image-digest> [submission-basename] [bountyId]
#   <image-digest>  e.g. us-central1-docker.pkg.dev/.../execution-enclave@sha256:abc...
#   submission      a file baked into the image under submissions/ (default clean.py)
set -euo pipefail

PROJECT=honeycomb-499305
ZONE=us-central1-a
SA=grader-enclave@honeycomb-499305.iam.gserviceaccount.com
# Debug family: lets the container's stdout reach the serial log so we can SEE the signed
# payload for the demo. Prod hardening swaps this for the `confidential-space` family.
CS_IMAGE_FAMILY=confidential-space-debug

IMAGE_DIGEST="${1:?need image digest (…/execution-enclave@sha256:…)}"
SUBMISSION="${2:-clean.py}"
JOB_ID="${3:?need jobId (uint256)}"
AGENT_ID="${4:?need agentId (uint256)}"
VM_NAME="grader-enclave-$(echo "$SUBMISSION" | tr -dc 'a-z0-9')"

# The container ENTRYPOINT is `python3 enclave_grade.py`; tee-cmd supplies its ARGS:
#   <submission> <jobId> <agentId>  -> the enclave signs keccak256(jobId,agentId,score).
# Submissions are baked into the image at /grader/submissions/.
gcloud compute instances create "$VM_NAME" \
  --project="$PROJECT" --zone="$ZONE" \
  --machine-type=n2d-standard-2 \
  --confidential-compute-type=SEV \
  --shielded-secure-boot \
  --maintenance-policy=TERMINATE \
  --service-account="$SA" \
  --scopes=https://www.googleapis.com/auth/cloud-platform \
  --image-project=confidential-space-images \
  --image-family="$CS_IMAGE_FAMILY" \
  --metadata="^~^tee-image-reference=${IMAGE_DIGEST}~tee-container-log-redirect=true~tee-cmd=[\"submissions/${SUBMISSION}\",\"${JOB_ID}\",\"${AGENT_ID}\"]"

echo
echo "Launched $VM_NAME. Stream the in-enclave signed output with:"
echo "  gcloud compute instances get-serial-port-output $VM_NAME --zone=$ZONE --project=$PROJECT | grep -A12 '\"score\"'"
