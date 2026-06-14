#!/usr/bin/env bash
# Grade a BAKED submission inside a REAL Google Confidential Space VM (TPM-attested),
# capture the in-enclave KMS-HSM-signed payload from the serial log, then delete the VM.
# Prints ONE JSON line: {"jobId","agentId","score","scoreDigest","signature":{r,s,v},"signer"}
# Usage: grade_in_vm.sh <baked-submission> <jobId> <agentId> [image-digest]
set -uo pipefail
export PATH=/tmp/google-cloud-sdk/bin:$PATH
export GOOGLE_APPLICATION_CREDENTIALS=${GOOGLE_APPLICATION_CREDENTIALS:-/home/thegnome/ethny2026/bigquerycreds.txt}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT=honeycomb-499305; ZONE=us-central1-a
REPO=us-central1-docker.pkg.dev/honeycomb-499305/honeycomb-grader/execution-enclave
SUB="${1:?baked submission basename}"; JOB="${2:?jobId}"; AGENT="${3:?agentId}"
DIGEST="${4:-$(gcloud artifacts docker images list "$REPO" --sort-by=~CREATE_TIME --limit=1 --format='value(version)' 2>/dev/null)}"
[ -n "$DIGEST" ] || { echo "[vm] no image digest" >&2; exit 1; }
VM="grader-enclave-$(echo "$SUB" | tr -dc 'a-z0-9')"

gcloud compute instances delete "$VM" --zone=$ZONE --project=$PROJECT -q >/dev/null 2>&1 || true
echo "[vm] launching Confidential Space VM $VM  ($REPO@$DIGEST)" >&2
bash "$HERE/deploy.sh" "$REPO@$DIGEST" "$SUB" "$JOB" "$AGENT" >&2 || { echo "[vm] launch failed" >&2; exit 1; }

extract(){ python3 -c "
import sys,json
t=sys.stdin.read(); out=None; i=0
while i<len(t):
    if t[i]=='{':
        depth=0; j=i
        while j<len(t):
            if t[j]=='{': depth+=1
            elif t[j]=='}':
                depth-=1
                if depth==0: break
            j+=1
        try:
            d=json.loads(t[i:j+1])
            if isinstance(d,dict) and 'score' in d and 'signer' in d: out=d
        except Exception: pass
        i=j+1
    else: i+=1
print(json.dumps(out) if out else '')"; }

echo "[vm] polling serial port for the in-enclave signed payload (up to ~7 min)..." >&2
GRADE=""
for i in $(seq 1 28); do
  sleep 15
  S=$(gcloud compute instances get-serial-port-output "$VM" --zone=$ZONE --project=$PROJECT 2>/dev/null || true)
  G=$(printf '%s' "$S" | extract 2>/dev/null)
  if [ -n "$G" ]; then GRADE="$G"; break; fi
  echo "[vm] ...waiting ($((i*15))s)" >&2
done

gcloud compute instances delete "$VM" --zone=$ZONE --project=$PROJECT -q >/dev/null 2>&1 || true
echo "[vm] VM deleted." >&2
[ -n "$GRADE" ] || { echo "[vm] no signed payload found in serial output" >&2; exit 1; }
printf '%s\n' "$GRADE"
