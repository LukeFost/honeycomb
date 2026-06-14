#!/usr/bin/env python3
# A5 daemon smoke (hermetic, dev box). Boots the warm daemon's HTTP server in-process with the
# trust-boundary children STUBBED (no real KMS, no launcher), runs a real program through the
# real runner.run() -> proof.build_bundle() path, and verifies over HTTP:
#   - POST /run with a real program returns a 200 bundle whose ecrecover(digest,sig)==signer
#   - the run output the buyer sees is exactly what outputHash commits to (tamper -> ecrecover diverges)
#   - missing nonce -> 400 (proof must bind to a purchase; we never mint an unbound bundle)
#   - GET /health reports confinement honestly
#
# What this does NOT prove (CS-VM only): real KMS signing, real attestation JWT, the actual
# UID-drop / iptables firewall taking effect. Those are Linux+root and verified in the enclave.
# Here we set SANDBOX_ALLOW_UNSAFE=1 so runner.run() actually executes the program unconfined on
# the dev box -- we are testing the DAEMON WIRING, not the confinement (that's _smoke_a1/egress).
#
# Run with the test venv:  SANDBOX_ALLOW_UNSAFE=1 RUN_DEADLINE_S=5 .venv-test/bin/python _smoke_server.py
import json
import os
import sys
import threading
import types
import urllib.request

# --- stubs BEFORE importing the daemon ------------------------------------------------------
# google.cloud.kms is enclave-only; stub it so signer_sidecar's import chain resolves. We replace
# the sidecar sign function with a real-secp256k1 fake, so the KMS client is never touched.
for m in ("google", "google.cloud", "google.cloud.kms"):
    sys.modules.setdefault(m, types.ModuleType(m))
sys.modules["google.cloud.kms"].KeyManagementServiceClient = object

from eth_keys import keys
from eth_hash.auto import keccak

_PRIV = keys.PrivateKey(b"\x22" * 32)
_SIGNER_ADDR = _PRIV.public_key.to_checksum_address()


def _fake_sign_via_sidecar(digest32, sock_path=None):
    assert len(digest32) == 32
    sig = _PRIV.sign_msg_hash(digest32)
    return {"r": "0x" + sig.r.to_bytes(32, "big").hex(),
            "s": "0x" + sig.s.to_bytes(32, "big").hex(),
            "v": sig.v + 27, "signer": _SIGNER_ADDR}


import signer_sidecar
signer_sidecar.sign_via_sidecar = _fake_sign_via_sidecar

import attestation
_FAKE_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.c2ln"
attestation.fetch_attestation_jwt = lambda nonce, audience="honeycomb-tee-runner": _FAKE_JWT
attestation.attestation_is_nonce_bound = lambda: True

import proof
# proof imported sign_via_sidecar by value at module load; rebind it to the fake too.
proof.sign_via_sidecar = _fake_sign_via_sidecar

import enclave_server
# Don't bring up the real sidecar/proxy/firewall on the dev box -- we stubbed signing/attestation.
enclave_server.start_signer_sidecar = lambda: None
enclave_server.start_egress_proxy = lambda: None
enclave_server.install_firewall_once = lambda: None


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}  {detail}")
    if not ok:
        sys.exit(f"FAILED: {name}")


def buyer_recompute_digest(bundle) -> bytes:
    code_hash = bytes.fromhex(bundle["codeHash"][2:])
    input_hash = bytes.fromhex(bundle["inputHash"][2:])
    output_hash = keccak(bundle["canonicalOutput"].encode("utf-8"))
    nonce_uint = int(bundle["nonceUint"])
    return keccak(code_hash + input_hash + output_hash + nonce_uint.to_bytes(32, "big"))


def buyer_ecrecover(digest32, sig) -> str:
    r, s = int(sig["r"], 16), int(sig["s"], 16)
    v = sig["v"] - 27
    return keys.Signature(vrs=(v, r, s)).recover_public_key_from_msg_hash(digest32).to_checksum_address()


def post_run(base, payload):
    req = urllib.request.Request(base + "/run", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def main():
    # Boot the server on an ephemeral loopback port. preflight() needs SANDBOX_ALLOW_UNSAFE=1 on
    # the dev box (no real confinement) -- the smoke command sets it.
    enclave_server.preflight()
    httpd = enclave_server.ThreadingHTTPServer(("127.0.0.1", 0), enclave_server.Handler)
    port = httpd.server_address[1]
    base = f"http://127.0.0.1:{port}"
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        # 1. health
        with urllib.request.urlopen(base + "/health", timeout=5) as r:
            health = json.loads(r.read())
        check("GET /health ok", health.get("ok") is True, json.dumps(health.get("confinement", {})))

        # 2. a real run -> 200 bundle with a load-bearing signature
        code = "import sys; print('hi', sys.stdin.read().strip())"
        status, bundle = post_run(base, {"code": code, "input": "buyer", "nonce": "0x2a"})
        check("POST /run -> 200", status == 200, f"status={status} body={str(bundle)[:120]}")
        check("bundle has result.stdout", bundle["result"]["stdout"].strip() == "hi buyer",
              repr(bundle["result"]["stdout"]))
        digest = buyer_recompute_digest(bundle)
        check("digest reproducible from bundle", "0x" + digest.hex() == bundle["digest"])
        recovered = buyer_ecrecover(digest, bundle["signature"])
        check("ecrecover(digest,sig)==signer", recovered == bundle["signer"] == _SIGNER_ADDR,
              f"{recovered} vs {bundle['signer']}")
        check("attestation present + nonce-bound", bundle["attestation"] == _FAKE_JWT
              and bundle["attestationNonceBound"] is True)

        # 3. tamper the returned output -> recomputed digest no longer recovers to signer
        t_bundle = dict(bundle)
        t_bundle["canonicalOutput"] = bundle["canonicalOutput"].replace("hi", "HACKED")
        t_rec = buyer_ecrecover(buyer_recompute_digest(t_bundle), bundle["signature"])
        check("tampered output -> ecrecover != signer", t_rec != bundle["signer"],
              f"recovered {t_rec[:10]}.. (must differ)")

        # 4. missing nonce -> 400 (never mint an unbound proof)
        status_nn, body_nn = post_run(base, {"code": "print(1)"})
        check("missing nonce -> 400", status_nn == 400, f"status={status_nn} {str(body_nn)[:80]}")

        # 5. non-string code -> 400
        status_bc, _ = post_run(base, {"code": 123, "nonce": "0x1"})
        check("non-string code -> 400", status_bc == 400, f"status={status_bc}")

        print("\nA5 daemon smoke: all checks passed. /run wiring + proof bundle are load-bearing over HTTP.")
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
