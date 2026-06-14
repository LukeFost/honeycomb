#!/usr/bin/env python3
# Confidential Space entrypoint for the execution-grading enclave.
#
# Runs the hardened scorer on a submission against the private series (baked into the
# image), then signs the BOUND score digest with the in-enclave KMS HSM key:
#
#   scoreDigest = keccak256(abi.encode(uint256 jobId, uint256 agentId, uint256 score))
#
# This is the exact digest BountyEscrow._recordGrade recomputes on-chain and checks with
# ecrecover against the bounty's registered attesterKey (fix #2). Signing the bound digest
# ties the score to (jobId, agentId, score): it can't be lied about, replayed onto another
# job/agent, or forged by a non-enclave caller.
#
# Usage (inside the container):  python3 enclave_grade.py <submission.py> <jobId> <agentId>
#
# Honest gap (Stage 3): the KMS key is not yet attestation-gated (WIF + image-digest IAM
# condition), so the SA can sign outside the enclave too. The enclave RUN is attested; the
# key is not yet enclave-exclusive.
import json
import os
import sys

from eth_hash.auto import keccak

import scorer  # hardened parent-scorer (spawns the untrusted worker)
from kms_sign import KmsSigner

KMS = dict(
    project=os.environ.get("KMS_PROJECT", "honeycomb-499305"),
    location=os.environ.get("KMS_LOCATION", "us-central1"),
    keyring=os.environ.get("KMS_KEYRING", "honeycomb-grader"),
    key=os.environ.get("KMS_KEY", "score-signer"),
    version=os.environ.get("KMS_KEY_VERSION", "1"),
)


def _u256(x: int) -> bytes:
    return int(x).to_bytes(32, "big")


def grade(submission_path: str, job_id: int, agent_id: int) -> dict:
    score = scorer.score(submission_path)  # real backtested PnL, 0..10000

    # On-chain-recomputable bound digest: keccak256(abi.encode(uint256,uint256,uint256)).
    bound = keccak(_u256(job_id) + _u256(agent_id) + _u256(score))

    signer = KmsSigner(**KMS)
    sig = signer.sign(bound)  # KMS HSM secp256k1 sign over the 32-byte digest

    return {
        "jobId": str(job_id),
        "agentId": str(agent_id),
        "score": score,
        "scoreDigest": "0x" + bound.hex(),
        "signature": {"r": sig["r"], "s": sig["s"], "v": sig["v"]},
        "signer": sig["signer"],
    }


def main():
    if len(sys.argv) < 4:
        print("usage: enclave_grade.py <submission.py> <jobId> <agentId>", file=sys.stderr)
        return 1
    out = grade(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
