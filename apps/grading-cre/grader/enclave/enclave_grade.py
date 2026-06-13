#!/usr/bin/env python3
# Confidential Space entrypoint for the execution-grading enclave (Stage 2).
#
# Runs the hardened scorer on a submission against the private series (both baked into the
# image), computes the score-attestation digest, and signs that digest with the in-enclave
# KMS HSM key. Emits the grading payload as JSON on stdout.
#
# The digest is the SAME content commitment grade.ts (Stage 1) computes:
#   sha256(bountyId | submissionHash | privateSeriesHash | score)
# so the on-chain scoreAttestationHash is reproducible and verifiable. Stage 2 adds the
# KMS signature over that digest: enclave provenance the verifier can ecrecover to the
# registered signer (proven round-trip, HARNESS_SPEC.md:161).
#
# Usage (inside the container):
#   python3 enclave_grade.py <submission.py> [bountyId] [winner]
#
# What is NOT here (honest gaps, by design):
#   - The image is not yet attestation-gated for KMS key release (Stage 3 / WIF + IAM
#     image-digest condition). At Stage 2 the SA can sign; the enclave attestation is not
#     yet REQUIRED to release the key.
#   - The validity gate (Chainlink Confidential AI) stays in grade.ts; this enclave owns
#     only the honest execution number + its signature.
import hashlib
import json
import os
import sys

import scorer  # the hardened parent-scorer (spawns the untrusted worker)
from kms_sign import KmsSigner

HERE = os.path.dirname(os.path.abspath(__file__))
# Private series is baked into the image next to this entrypoint (see Dockerfile COPY).
PRIVATE_SERIES = os.path.join(HERE, "prices_private.json")

KMS = dict(
    project=os.environ.get("KMS_PROJECT", "honeycomb-499305"),
    location=os.environ.get("KMS_LOCATION", "us-central1"),
    keyring=os.environ.get("KMS_KEYRING", "honeycomb-grader"),
    key=os.environ.get("KMS_KEY", "score-signer"),
    version=os.environ.get("KMS_KEY_VERSION", "1"),
)


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def grade(submission_path: str, bounty_id: str) -> dict:
    score = scorer.score(submission_path)  # real backtested PnL, 0..10000

    with open(submission_path, "rb") as f:
        submission_hash = _sha256_hex(f.read())
    with open(PRIVATE_SERIES, "rb") as f:
        private_series_hash = _sha256_hex(f.read())

    # Content commitment, byte-identical to grade.ts executionGrade().
    commitment = f"{bounty_id}|{submission_hash}|{private_series_hash}|{score}".encode()
    digest = hashlib.sha256(commitment).digest()

    signer = KmsSigner(**KMS)
    sig = signer.sign(digest)

    return {
        "score": score,
        "attestationDigest": "0x" + digest.hex(),
        "signature": {"r": sig["r"], "s": sig["s"], "v": sig["v"]},
        "signer": sig["signer"],
    }


def main():
    if len(sys.argv) < 2:
        print("usage: enclave_grade.py <submission.py> [bountyId] [winner]", file=sys.stderr)
        return 1
    submission_path = sys.argv[1]
    bounty_id = sys.argv[2] if len(sys.argv) > 2 else "uniswap-lp-trading-bot-round-1"
    out = grade(submission_path, bounty_id)
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
