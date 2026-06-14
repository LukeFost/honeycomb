#!/usr/bin/env bash
# Deploy the "Summon a TEE" WARM runner to Google Confidential Space.
#
# Unlike the single-shot grading enclave, this VM STAYS UP: it runs the long-lived daemon
# (enclave_server.py), and each paid request runs the buyer's code in a fresh hardened child.
# So there is NO --maintenance-policy=TERMINATE, NO baked private data, NO per-run tee-cmd args
# (requests arrive over HTTP from the apps/web route), and the OAuth scope is narrowed.
#
# Prereqs (mostly already provisioned this session -- see grader-stage2-live-prod memory):
#   - Artifact Registry repo + image pushed BY DIGEST (build.sh).
#   - Workload SA with cloudkms.signerVerifier + viewer on score-signer, artifactregistry.reader,
#     logging.logWriter, confidentialcomputing.workloadUser (mints the attestation token).
#   - confidentialcomputing + compute APIs enabled.
#
# Usage:  ./deploy.sh <image@sha256:...> [egress-mode]
#   <image-digest>  e.g. us-central1-docker.pkg.dev/.../tee-runner@sha256:abc...  (BY DIGEST)
#   egress-mode     "proxy" (default, network on behind the deny-by-default proxy) | "block"
set -euo pipefail

PROJECT=honeycomb-499305
ZONE=us-central1-a
SA=grader-enclave@honeycomb-499305.iam.gserviceaccount.com
# Debug family during bring-up: routes the daemon's stdout/stderr to the serial log so we can SEE
# it come up + sign. Swap to `confidential-space` (non-debug) for the real demo.
CS_IMAGE_FAMILY="${CS_IMAGE_FAMILY:-confidential-space-debug}"

IMAGE_DIGEST="${1:?need image digest (…/tee-runner@sha256:…) -- run build.sh to get it}"
EGRESS_MODE="${2:-proxy}"
VM_NAME="${VM_NAME:-tee-runner}"

# Narrowed OAuth scope: the daemon's SA only needs KMS signing (cloudkms) + log writing. The
# attestation token is minted by the launcher from the VM's own attestation, not via an OAuth
# scope, so we do NOT need cloud-platform. IAM roles on the SA remain the real authority; the
# scope is a coarser upper bound. (Grading used the broad cloud-platform; this is least-priv.)
SCOPES="https://www.googleapis.com/auth/cloudkms,https://www.googleapis.com/auth/logging.write"

# The daemon takes NO container args. We pass daemon config via tee-env (EGRESS_MODE) and rely on
# the image's ENTRYPOINT. NO --maintenance-policy=TERMINATE: the VM stays up and serves requests.
gcloud compute instances create "$VM_NAME" \
  --project="$PROJECT" --zone="$ZONE" \
  --machine-type=n2d-standard-2 \
  --confidential-compute-type=SEV \
  --shielded-secure-boot \
  --service-account="$SA" \
  --scopes="$SCOPES" \
  --image-project=confidential-space-images \
  --image-family="$CS_IMAGE_FAMILY" \
  --metadata="^~^tee-image-reference=${IMAGE_DIGEST}~tee-container-log-redirect=true~tee-env-EGRESS_MODE=${EGRESS_MODE}"

echo
echo "Launched warm daemon $VM_NAME (egress=$EGRESS_MODE). It stays up. Watch it come up with:"
echo "  gcloud compute instances get-serial-port-output $VM_NAME --zone=$ZONE --project=$PROJECT | grep enclave_server"
echo
echo "The apps/web route reaches the daemon at the VM's internal IP :8000 (firewall to the route's egress IP)."
echo "Delete when done:  gcloud compute instances delete $VM_NAME --zone=$ZONE --project=$PROJECT -q"
