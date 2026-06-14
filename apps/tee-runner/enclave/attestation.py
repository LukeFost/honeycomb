#!/usr/bin/env python3
# Confidential Space attestation (A4). This is the half of the proof that a bare KMS signature
# CANNOT give you: a Google-signed token asserting "this exact container image ran in a genuine
# AMD-SEV Confidential Space VM", bound to the buyer's nonce so it can't be replayed.
#
# Two ways to obtain the token inside the workload:
#
#   1. STATIC claims token (always present): the launcher writes a fresh JWT to
#      /run/container_launcher/attestation_verifier_claims_token at boot. It has no custom nonce,
#      so it proves "image X ran in a TEE" but not "...for THIS request". Useful as a fallback.
#
#   2. DYNAMIC token with a buyer nonce (the real one): POST to the launcher's local attestation
#      socket asking for a token whose `eat_nonce` claim equals the buyer's per-request nonce.
#      The verifier (Google) signs it; the buyer later checks `eat_nonce == their nonce`, which
#      binds the attestation to their specific summon -- no replay of an old token.
#
# The JWT is signed by Google's Confidential-Space attestation service; the buyer verifies it
# offline against the published JWKS (https://confidentialcomputing.googleapis.com/.well-known/...
# / the `jku`/`kid` in the header) and asserts: issuer is the CS verifier, `eat_nonce` matches,
# and the image-digest claim (`submods.container.image_digest` / `swname`+`image_reference`)
# matches the image they expected. We do NOT verify here -- the enclave just OBTAINS the token;
# trust comes from the BUYER verifying it, not from us asserting it's good.
#
# Per the project's honesty rule: if no attestation is obtainable (running outside CS, launcher
# socket absent), we RAISE -- we never fabricate or return a placeholder token, because the whole
# product is "the proof is real". A caller that wants to run unattested on a dev box must opt in
# explicitly (ATTESTATION_ALLOW_ABSENT=1), and the bundle then carries attestation:null with a
# loud reason, never a fake JWT.
import http.client
import json
import os
import socket

# Where the launcher exposes the attestation token grant. On Confidential Space this is a unix
# socket; the HTTP path requests a token with custom claims (audience + nonce).
LAUNCHER_SOCKET = os.environ.get("CS_ATTEST_SOCKET", "/run/container_launcher/teeserver.sock")
STATIC_TOKEN_PATH = os.environ.get(
    "CS_ATTEST_TOKEN_PATH", "/run/container_launcher/attestation_verifier_claims_token"
)

# Dev-box escape hatch: allow assembling a bundle with attestation:null (loud) when no launcher
# is present. NEVER set this in the enclave -- there the attestation is the product.
ALLOW_ABSENT = os.environ.get("ATTESTATION_ALLOW_ABSENT") == "1"


class AttestationError(Exception):
    """No genuine attestation could be obtained. The run is NOT TEE-provable; surface loudly."""


class _UnixHTTPConnection(http.client.HTTPConnection):
    """http.client over an AF_UNIX socket (the launcher's teeserver.sock speaks HTTP/1.1)."""

    def __init__(self, sock_path, timeout=10):
        super().__init__("localhost", timeout=timeout)
        self._sock_path = sock_path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._sock_path)
        self.sock = s


def fetch_attestation_jwt(nonce: str, audience: str = "honeycomb-tee-runner") -> str:
    """Return a Confidential Space attestation JWT whose `eat_nonce` is the buyer `nonce`.

    Tries the launcher token endpoint first (binds the nonce -- the real proof). Falls back to
    the static claims token ONLY if a fallback is acceptable for the caller's threat model; the
    static token does NOT carry the buyer nonce, so the bundle records which kind was obtained.
    Raises AttestationError if neither is available (unless ALLOW_ABSENT, handled by the caller)."""
    if not nonce or not isinstance(nonce, str):
        raise AttestationError("a non-empty buyer nonce is required to bind the attestation")

    # 1. Dynamic, nonce-bound token from the launcher socket.
    if os.path.exists(LAUNCHER_SOCKET):
        body = json.dumps(
            {
                "audience": audience,
                "nonces": [nonce],  # CS sets eat_nonce from the first nonce
                "token_type": "OIDC",
            }
        )
        try:
            conn = _UnixHTTPConnection(LAUNCHER_SOCKET)
            conn.request(
                "POST",
                "/v1/token",
                body=body,
                headers={"Content-Type": "application/json"},
            )
            resp = conn.getresponse()
            data = resp.read().decode()
            conn.close()
            if resp.status != 200:
                raise AttestationError(
                    f"launcher token endpoint returned {resp.status}: {data[:200]}"
                )
            token = data.strip().strip('"')
            if token.count(".") != 2:
                raise AttestationError(f"launcher returned a non-JWT response: {data[:120]}")
            return token
        except (OSError, http.client.HTTPException) as e:
            raise AttestationError(f"launcher token request failed: {e!r}")

    # 2. Static claims token (no buyer-nonce binding). Present on any CS boot.
    if os.path.exists(STATIC_TOKEN_PATH):
        with open(STATIC_TOKEN_PATH) as f:
            token = f.read().strip()
        if token.count(".") == 2:
            # The caller is responsible for noting this token does NOT bind the buyer nonce.
            return token
        raise AttestationError(f"static claims token at {STATIC_TOKEN_PATH} is not a JWT")

    raise AttestationError(
        f"no Confidential Space attestation available "
        f"(neither {LAUNCHER_SOCKET} nor {STATIC_TOKEN_PATH} exists). "
        f"Not running in a TEE. Set ATTESTATION_ALLOW_ABSENT=1 on a dev box to assemble a bundle "
        f"with attestation:null (NEVER in the enclave -- the attestation is the product)."
    )


def attestation_is_nonce_bound() -> bool:
    """True iff the dynamic, buyer-nonce-bound path is available (the launcher socket exists).
    The bundle records this so a buyer knows whether eat_nonce is meaningful."""
    return os.path.exists(LAUNCHER_SOCKET)


if __name__ == "__main__":
    import sys

    n = sys.argv[1] if len(sys.argv) > 1 else "demo-nonce"
    try:
        jwt = fetch_attestation_jwt(n)
        print(f"got JWT ({len(jwt)} chars), nonce-bound={attestation_is_nonce_bound()}")
        print(jwt[:80] + "...")
    except AttestationError as e:
        print(f"AttestationError: {e}", file=sys.stderr)
        sys.exit(2)
