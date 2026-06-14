#!/usr/bin/env python3
# A4 honest-proof smoke (hermetic). The KMS recipe is proven live (grader-kms-ecrecover-proven);
# what's NEW in A4 is the BUNDLE: the digest preimage, the canonical-output binding, and the
# pairing with an attestation token. The load-bearing question this test answers is the honesty
# self-check from the plan:
#
#   "Can a buyer, using ONLY the returned bundle, recompute the digest and ecrecover the
#    signature to the claimed signer -- and does that verification FAIL if any field is tampered?"
#
# If yes, the proof is real (not decorative). We run it with a REAL secp256k1 key in the fake
# sidecar (so ecrecover yields a known address) and a fabricated attestation (no launcher on the
# dev box). Run with the test venv:  .venv-test/bin/python _smoke_proof.py
import json
import os
import sys
import types

from eth_keys import keys
from eth_hash.auto import keccak

# signer_sidecar imports kms_sign which imports google.cloud.kms (enclave-only, absent in the
# test venv). Stub just that module so the import chain resolves; we replace sign_via_sidecar
# with a real-secp256k1 fake anyway, so the KMS client is never used.
for modname in ("google", "google.cloud", "google.cloud.kms"):
    if modname not in sys.modules:
        sys.modules[modname] = types.ModuleType(modname)
sys.modules["google.cloud.kms"].KeyManagementServiceClient = object

# --- real secp256k1 keypair for the fake sidecar -------------------------------------------
_PRIV = keys.PrivateKey(b"\x11" * 32)
_SIGNER_ADDR = _PRIV.public_key.to_checksum_address()


def _fake_sign_via_sidecar(digest32, sock_path=None):
    """Sign like kms_sign.py does: real secp256k1, low-s normalized, recovery-id v in {27,28}."""
    assert len(digest32) == 32
    sig = _PRIV.sign_msg_hash(digest32)  # eth_keys gives (r, s, v) with v in {0,1}, low-s already
    return {
        "r": "0x" + sig.r.to_bytes(32, "big").hex(),
        "s": "0x" + sig.s.to_bytes(32, "big").hex(),
        "v": sig.v + 27,
        "signer": _SIGNER_ADDR,
    }


# --- stub the sidecar + attestation BEFORE importing proof ----------------------------------
import signer_sidecar
signer_sidecar.sign_via_sidecar = _fake_sign_via_sidecar

import attestation
# Fabricate a JWT-shaped token so the bundle carries a non-null attestation in the test. (The
# REAL token comes from the launcher in the CS VM; here we only test the BUNDLE assembly + the
# signature verification, not JWT validation -- that is the buyer's offline check against Google
# JWKS, exercised in the CS VM.)
_FAKE_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.c2ln"
attestation.fetch_attestation_jwt = lambda nonce, audience="honeycomb-tee-runner": _FAKE_JWT
attestation.attestation_is_nonce_bound = lambda: True

import proof


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}  {detail}")
    if not ok:
        sys.exit(f"FAILED: {name}")


# --- buyer-side independent verification (this is what the browser/client will do) ----------
def buyer_recompute_digest(bundle) -> bytes:
    """Recompute the digest from ONLY the bundle's public fields, the way a buyer must."""
    code_hash = bytes.fromhex(bundle["codeHash"][2:])
    input_hash = bytes.fromhex(bundle["inputHash"][2:])
    # outputHash must equal keccak(canonicalOutput) -- recompute it from the returned bytes.
    output_hash = keccak(bundle["canonicalOutput"].encode("utf-8"))
    nonce_uint = int(bundle["nonceUint"])
    return keccak(code_hash + input_hash + output_hash + nonce_uint.to_bytes(32, "big"))


def buyer_ecrecover(digest32, sig) -> str:
    r = int(sig["r"], 16)
    s = int(sig["s"], 16)
    v = sig["v"] - 27  # back to {0,1} for eth_keys
    signature = keys.Signature(vrs=(v, r, s))
    pub = signature.recover_public_key_from_msg_hash(digest32)
    return pub.to_checksum_address()


# --- build a real bundle --------------------------------------------------------------------
CODE = "print('hello from TEE')"
STDIN = "ping"
NONCE = "0x2a"  # 42
RUN = {"stdout": "hello from TEE\n", "stderr": "", "exitCode": 0, "durationMs": 19, "timedOut": False}

bundle = proof.build_bundle(CODE, STDIN, RUN, NONCE)
print("bundle:", json.dumps({k: (v[:24] + "..." if isinstance(v, str) and len(v) > 27 else v)
                             for k, v in bundle.items() if k != "result"}, indent=0)[:400])

# 1. the bundle's own digest must equal what the buyer recomputes from public fields
buyer_digest = buyer_recompute_digest(bundle)
check("digest reproducible from bundle fields", "0x" + buyer_digest.hex() == bundle["digest"],
      bundle["digest"][:18])

# 2. outputHash actually commits to the returned output bytes
check("outputHash == keccak(canonicalOutput)",
      "0x" + keccak(bundle["canonicalOutput"].encode()).hex() == bundle["outputHash"])

# 3. canonicalOutput matches the result fields the buyer sees
recomputed_canon = json.dumps(
    {"stdout": RUN["stdout"], "stderr": RUN["stderr"], "exitCode": RUN["exitCode"], "timedOut": RUN["timedOut"]},
    sort_keys=True, separators=(",", ":"),
)
check("canonicalOutput is canonical + matches result", bundle["canonicalOutput"] == recomputed_canon)

# 4. THE load-bearing check: ecrecover the signature to the claimed signer
recovered = buyer_ecrecover(buyer_digest, bundle["signature"])
check("ecrecover(digest, sig) == signer", recovered == bundle["signer"] == _SIGNER_ADDR,
      f"{recovered} vs {bundle['signer']}")

# 5. attestation present + nonce-bound flag set
check("attestation present", bundle["attestation"] == _FAKE_JWT and bundle["attestationNonceBound"] is True)

# --- TAMPER checks: verification MUST FAIL if any committed field is altered -----------------
# 5a. tamper the output -> recomputed digest changes -> ecrecover yields a DIFFERENT address
t = dict(bundle); t["canonicalOutput"] = bundle["canonicalOutput"].replace("hello", "HACKED")
t_digest = buyer_recompute_digest(t)
t_recovered = buyer_ecrecover(t_digest, bundle["signature"])  # same sig, tampered digest
check("tampered output -> ecrecover != signer", t_recovered != bundle["signer"],
      f"recovered {t_recovered[:10]}.. (must differ)")

# 5b. tamper the nonce -> digest changes -> recovery diverges
t2 = dict(bundle); t2["nonceUint"] = str(int(bundle["nonceUint"]) + 1)
t2_recovered = buyer_ecrecover(buyer_recompute_digest(t2), bundle["signature"])
check("tampered nonce -> ecrecover != signer", t2_recovered != bundle["signer"])

# 5c. tamper the codeHash -> digest changes -> recovery diverges
t3 = dict(bundle); t3["codeHash"] = "0x" + ("ff" * 32)
t3_recovered = buyer_ecrecover(buyer_recompute_digest(t3), bundle["signature"])
check("tampered codeHash -> ecrecover != signer", t3_recovered != bundle["signer"])

# 5d. a forged signature (random) does NOT recover to the signer for the honest digest
forged = {"r": "0x" + ("01" * 32), "s": "0x" + ("02" * 32), "v": 27}
try:
    forged_recovered = buyer_ecrecover(buyer_digest, forged)
    check("forged signature -> != signer", forged_recovered != bundle["signer"])
except Exception:
    check("forged signature -> rejected", True, "recover raised (acceptable)")

print("\nA4 proof bundle smoke: all checks passed. Proof is load-bearing (tamper -> verification fails).")
