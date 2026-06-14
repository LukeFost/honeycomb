#!/usr/bin/env python3
# Honest proof bundle (A4). Assembles the thing the buyer actually pays for: the run output
# bound to a cryptographic proof it ran in THIS image inside a real Confidential Space TEE.
#
# A bare KMS signature proves only "some key signed these bytes". It does NOT prove the bytes
# came out of a TEE -- the SA could sign anything from anywhere. So the bundle pairs the
# signature with the Confidential Space ATTESTATION JWT (Google-signed, binds the image digest +
# the buyer's nonce). The buyer verifies BOTH offline:
#   1. ecrecover(digest, signature) == signer   (the signer is the enclave's KMS identity), AND
#   2. the attestation JWT validates against Google's CS JWKS, with image_digest == the image
#      they expected and eat_nonce == the nonce they sent.
# Only when both hold is "this output ran in that TEE" established. Either alone is insufficient,
# which is exactly the honesty gap A4 closes (see enclave_grade.py:16-18 for the old gap).
#
# Digest preimage (replaces the grading-specific keccak(jobId,agentId,score)):
#
#   digest = keccak256(abi.encode(bytes32 codeHash, bytes32 inputHash, bytes32 outputHash,
#                                 uint256 nonce))
#
# All four fields are fixed 32-byte words, so abi.encode is plain concatenation -- no dynamic
# offsets (the trap that bit StrategyVault.onReport; see strategyvault-onreport-flat-encoding).
# - codeHash   = keccak256(utf8(code))
# - inputHash  = keccak256(utf8(stdin_input))
# - outputHash = keccak256(utf8(canonical_output_json))  -- binds the exact bytes returned
# - nonce      = the buyer's per-request nonce as uint256 (binds the bundle to THIS purchase)
#
# The signature is produced by the SIGNER SIDECAR over the unix socket -- this module never
# imports kms_sign or touches the SA token. That separation is P0-2: the only process holding a
# KMS path is signer_sidecar.py; everything else asks it to sign a 32-byte digest.
import json

from eth_hash.auto import keccak

import attestation
from signer_sidecar import sign_via_sidecar


def _keccak_utf8(s: str) -> bytes:
    return keccak(s.encode("utf-8"))


def _u256(x: int) -> bytes:
    return int(x).to_bytes(32, "big")


def _nonce_to_uint(nonce: str) -> int:
    """Buyer nonce -> uint256 for the digest. Accept a 0x-hex string, a decimal string, or any
    string (hashed to 32 bytes as a fallback so arbitrary nonces still bind deterministically)."""
    n = nonce.strip()
    try:
        if n.lower().startswith("0x"):
            return int(n, 16)
        return int(n)
    except ValueError:
        # Non-numeric nonce: bind via its keccak so it still maps to a stable uint256.
        return int.from_bytes(_keccak_utf8(n), "big")


def canonical_output(run_result: dict) -> str:
    """Canonical JSON of the run output that outputHash commits to. Sorted keys + compact
    separators so the buyer can recompute the exact same bytes from the returned fields."""
    return json.dumps(
        {
            "stdout": run_result["stdout"],
            "stderr": run_result["stderr"],
            "exitCode": run_result["exitCode"],
            "timedOut": run_result["timedOut"],
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def build_bundle(code: str, stdin_input: str, run_result: dict, nonce: str,
                 audience: str = "honeycomb-tee-runner") -> dict:
    """Bind the run to a signature + attestation and return the full proof bundle.

    Raises if the attestation can't be obtained (unless ATTESTATION_ALLOW_ABSENT=1, in which case
    attestation is null with a loud reason -- never a fake JWT). The signature always comes from
    the sidecar; if the sidecar is down, that raises too (the run is unprovable -> surface it)."""
    code_hash = _keccak_utf8(code)
    input_hash = _keccak_utf8(stdin_input)
    out_json = canonical_output(run_result)
    output_hash = _keccak_utf8(out_json)
    nonce_uint = _nonce_to_uint(nonce)

    # abi.encode(bytes32, bytes32, bytes32, uint256) == concatenation (all static 32-byte words).
    digest = keccak(code_hash + input_hash + output_hash + _u256(nonce_uint))

    # Sign via the sidecar (P0-2): this process never holds the KMS path.
    sig = sign_via_sidecar(digest)
    if "error" in sig:
        raise RuntimeError(f"signer sidecar refused to sign: {sig['error']}")

    # Obtain the CS attestation bound to the buyer nonce. Honest-absence handling: raise unless
    # the dev-box opt-in is set, in which case attestation is null with the reason recorded.
    attestation_jwt = None
    attestation_note = None
    nonce_bound = False
    try:
        attestation_jwt = attestation.fetch_attestation_jwt(nonce, audience=audience)
        nonce_bound = attestation.attestation_is_nonce_bound()
        if not nonce_bound:
            attestation_note = (
                "static claims token: proves TEE+image but does NOT bind eat_nonce to this request"
            )
    except attestation.AttestationError as e:
        if not attestation.ALLOW_ABSENT:
            raise
        attestation_note = f"ATTESTATION ABSENT (dev only): {e}"

    return {
        "result": {
            "stdout": run_result["stdout"],
            "stderr": run_result["stderr"],
            "exitCode": run_result["exitCode"],
            "durationMs": run_result["durationMs"],
            "timedOut": run_result["timedOut"],
        },
        "codeHash": "0x" + code_hash.hex(),
        "inputHash": "0x" + input_hash.hex(),
        "outputHash": "0x" + output_hash.hex(),
        "canonicalOutput": out_json,  # the exact bytes outputHash commits to (buyer recomputes)
        "nonce": nonce,
        "nonceUint": str(nonce_uint),
        "digest": "0x" + digest.hex(),
        "signature": {"r": sig["r"], "s": sig["s"], "v": sig["v"]},
        "signer": sig["signer"],
        "attestation": attestation_jwt,            # the Google-signed CS JWT, or null (dev only)
        "attestationNonceBound": nonce_bound,      # whether eat_nonce binds this request
        "attestationNote": attestation_note,       # loud reason when not fully bound / absent
    }


if __name__ == "__main__":
    # Local smoke: build a bundle for a canned run result. Requires the sidecar running and
    # (in the enclave) the launcher socket; on a dev box set ATTESTATION_ALLOW_ABSENT=1 and run
    # a fake sidecar. See _smoke_proof.py for the hermetic version.
    import sys

    rr = {"stdout": "hi\n", "stderr": "", "exitCode": 0, "durationMs": 12, "timedOut": False}
    b = build_bundle("print('hi')", "", rr, sys.argv[1] if len(sys.argv) > 1 else "0x01")
    print(json.dumps(b, indent=2))
