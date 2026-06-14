#!/usr/bin/env python3
"""
enc_fetch.py -- the grading enclave's side of the sealed-submission flow (Leg 1 open).

An agent seals its submission to the bounty's enclaveEncPub and uploads the
ciphertext to the honeycomb-submissions GCS bucket; the on-chain encCid is the
`gcs://honeycomb-submissions/<sha256hex>` URI (see apps/honeycomb-mcp/storage).
This module is what the enclave uses to turn that encCid back into the plaintext
submission source it grades:

    encCid --fetch--> sealed bytes --SealedBox(enclave_sk).decrypt--> submission .py

Two steps, both fail-loud (no silent fallback -- a swapped object or wrong key
must abort the grade, never grade attacker-chosen plaintext):

  1. fetch(uri): GET the object with the enclave's own GCS credentials (the CS VM's
     attested SA via the metadata server, or local ADC). The key IS the content's
     sha256, so we re-hash and compare -- a content-address mismatch is tampering.
  2. open_sealed(bytes): X25519 crypto_box_seal open with ENCLAVE_ENC_SECRET. This
     is the SAME sealed-box primitive deliver.py uses, so blobs sealed by the TS
     leg (which shells to deliver.py seal) open here byte-for-byte.

Kept dependency-light: stdlib urllib for HTTP, google-auth for the token, PyNaCl
for the box. No google-cloud-storage SDK.
"""

import base64
import hashlib
import os
import urllib.request

from nacl.public import PrivateKey, SealedBox

GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only"


def _strip0x(s: str) -> str:
    return s[2:] if s.startswith(("0x", "0X")) else s


def parse_gcs_uri(uri: str) -> tuple[str, str]:
    """gcs://bucket/key -> (bucket, key). Raises on any other scheme."""
    uri = uri.strip()
    if not uri.startswith("gcs://"):
        raise ValueError(f"not a gcs:// URI: {uri}")
    rest = uri[len("gcs://"):]
    bucket, _, key = rest.partition("/")
    if not bucket or not key:
        raise ValueError(f"malformed gcs:// URI (need bucket/key): {uri}")
    return bucket, key


def _access_token() -> str:
    # Explicit override (local/CI: GCS_ACCESS_TOKEN=$(gcloud auth print-access-token)).
    override = os.environ.get("GCS_ACCESS_TOKEN")
    if override:
        return override
    # On the Confidential Space VM this is the attested SA via the metadata server;
    # locally it's ADC. google.auth is the same library the TS side uses.
    import google.auth
    from google.auth.transport.requests import Request

    creds, _ = google.auth.default(scopes=[GCS_SCOPE])
    creds.refresh(Request())
    if not creds.token:
        raise RuntimeError(
            "GCS auth: google.auth returned no access token (no ADC / metadata credentials)"
        )
    return creds.token


def fetch(uri: str) -> bytes:
    """Download the bytes behind a gcs:// URI and verify them against the content-address key."""
    bucket, key = parse_gcs_uri(uri)
    token = _access_token()
    url = (
        f"https://storage.googleapis.com/storage/v1/b/"
        f"{urllib.parse.quote(bucket, safe='')}/o/{urllib.parse.quote(key, safe='')}?alt=media"
    )
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 -- fixed GCS host
        data = resp.read()
    got = hashlib.sha256(data).hexdigest()
    if got != key:
        raise ValueError(
            f"GCS content-address mismatch for {uri}: object hashes to {got} (tampered/swapped)"
        )
    return data


# Baked-key path: the warm image COPYs the X25519 secret here (see Dockerfile.server,
# gitignored at build). Confidential Space rejects env overrides unless the image
# declares an allow-env-override LABEL, and CS echoes any override value to the serial
# log -- so for the warm enclave the secret is baked into the private, attestation-
# gated image layer instead of injected via metadata. Env still wins when set (local/dev).
_BAKED_SECRET_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "enclave_enc_secret")


def _enclave_secret() -> PrivateKey:
    """Load the enclave's X25519 secret (matching the bounty's enclaveEncPub).

    Source order: ENCLAVE_ENC_SECRET env (local/dev), then the baked key file
    (the warm CS image). Either is base64 (preferred) or 0x/hex decoding to 32
    bytes -- the same encoding deliver.py keygen emits for `sec`.
    """
    s = os.environ.get("ENCLAVE_ENC_SECRET", "").strip()
    if not s and os.path.exists(_BAKED_SECRET_PATH):
        with open(_BAKED_SECRET_PATH, "r", encoding="utf-8") as f:
            s = f.read().strip()
    if not s:
        raise RuntimeError(
            "ENCLAVE_ENC_SECRET not set and no baked key at "
            f"{_BAKED_SECRET_PATH} -- the enclave cannot open sealed submissions "
            "without its X25519 secret (the one matching the bounty's enclaveEncPub)."
        )
    raw = None
    try:
        cand = base64.b64decode(s, validate=True)
        if len(cand) == 32:
            raw = cand
    except Exception:
        pass
    if raw is None:
        try:
            cand = bytes.fromhex(_strip0x(s))
            if len(cand) == 32:
                raw = cand
        except Exception:
            pass
    if raw is None:
        raise ValueError("ENCLAVE_ENC_SECRET must be base64 or hex decoding to 32 bytes")
    return PrivateKey(raw)


def open_sealed(blob: bytes) -> bytes:
    """X25519 sealed-box open with the enclave secret. Raises on wrong key / tamper."""
    sk = _enclave_secret()
    return SealedBox(sk).decrypt(blob)  # raises CryptoError on bad key / corrupted box


def fetch_and_open(enc_cid: str) -> str:
    """encCid -> plaintext submission source (UTF-8). The full Leg-1 open, fail-loud."""
    sealed = fetch(enc_cid)
    plain = open_sealed(sealed)
    return plain.decode("utf-8")
