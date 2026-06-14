#!/usr/bin/env python3
# TRUSTED signer sidecar (P0-2). This is the ONLY process in the enclave that holds a path to
# the service-account token / KMS. It listens on a private unix socket and will sign a 32-byte
# digest on request, returning {r,s,v,signer}. Nothing else.
#
# Why it exists: the kill-chain we are severing is "arbitrary user code + network -> GCP
# metadata server (169.254.169.254) -> SA bearer token -> KMS asymmetricSign -> forge any
# signed result." Moving the KMS call into a separate process is one of the three cuts (the
# other two are UID-drop and the metadata block). After this split:
#   - the user-code process (code_worker's grandchild) has NO KMS client and NO socket to here;
#   - this sidecar accepts ONLY a digest and emits ONLY a signature -- it never runs user code,
#     never reads user input beyond 32 bytes, and has no code path that could be steered.
# So even if user code somehow reached the metadata server, the *capability* it would gain
# (an SA token) is the thing A2's UID-drop + metadata block remove; this sidecar additionally
# ensures the legitimate signing capability is not co-resident with the untrusted code.
#
# Protocol (newline-delimited JSON over a SOCK_STREAM unix socket):
#   client -> sidecar:  {"digest": "<64-hex chars = 32 bytes>"}\n
#   sidecar -> client:  {"r","s","v","signer"}\n     on success
#                       {"error": "<reason>"}\n        on bad input / signing failure
# One request per connection. The socket lives at SIGNER_SOCK (default /run/signer.sock) with
# permissions that only the trusted parent uid can reach -- the user-code uid cannot connect.
import json
import os
import socket
import sys

from kms_sign import KmsSigner

SOCK_PATH = os.environ.get("SIGNER_SOCK", "/run/signer.sock")

KMS = dict(
    project=os.environ.get("KMS_PROJECT", "honeycomb-499305"),
    location=os.environ.get("KMS_LOCATION", "us-central1"),
    keyring=os.environ.get("KMS_KEYRING", "honeycomb-grader"),
    key=os.environ.get("KMS_KEY", "score-signer"),
    version=os.environ.get("KMS_KEY_VERSION", "1"),
)


def _handle(signer: KmsSigner, conn: socket.socket) -> None:
    buf = b""
    # Read one line. Cap the read so a malicious/buggy client can't stream forever; a digest
    # request is tiny.
    while b"\n" not in buf and len(buf) < 4096:
        chunk = conn.recv(4096)
        if not chunk:
            break
        buf += chunk
    try:
        req = json.loads(buf.split(b"\n", 1)[0] or b"{}")
        digest_hex = req["digest"]
        digest = bytes.fromhex(digest_hex[2:] if digest_hex.startswith("0x") else digest_hex)
        if len(digest) != 32:
            raise ValueError("digest must be exactly 32 bytes")
        sig = signer.sign(digest)  # reuses kms_sign.py verbatim: low-s + recovery-id
        resp = {"r": sig["r"], "s": sig["s"], "v": sig["v"], "signer": sig["signer"]}
    except Exception as e:  # noqa: BLE001 -- report any failure to the caller, keep serving
        resp = {"error": repr(e)}
    conn.sendall((json.dumps(resp) + "\n").encode())


def serve() -> None:
    # Build the KMS client ONCE at startup (it resolves the SA credentials here, in the trusted
    # process, never in user code). If this fails we exit loud -- a sidecar that can't sign is
    # useless and must not look healthy.
    signer = KmsSigner(**KMS)
    addr = signer.address()
    print(f"[signer_sidecar] KMS signer ready: {addr}", file=sys.stderr, flush=True)

    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK_PATH)
    # Socket reachable only by the owning uid (the trusted parent). The user-code uid is
    # different (P0-3) and cannot connect. 0o600 on the socket node enforces it at the FS layer.
    os.chmod(SOCK_PATH, 0o600)
    srv.listen(8)
    print(f"[signer_sidecar] listening on {SOCK_PATH}", file=sys.stderr, flush=True)

    while True:
        conn, _ = srv.accept()
        try:
            _handle(signer, conn)
        finally:
            conn.close()


def sign_via_sidecar(digest32: bytes, sock_path: str = None) -> dict:
    """Client helper used by the trusted parent (runner/daemon) to get a digest signed without
    holding a KMS client itself. Connects, sends the digest, returns {r,s,v,signer}."""
    if len(digest32) != 32:
        raise ValueError("digest must be exactly 32 bytes")
    path = sock_path or SOCK_PATH
    c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    c.connect(path)
    try:
        c.sendall((json.dumps({"digest": digest32.hex()}) + "\n").encode())
        buf = b""
        while b"\n" not in buf and len(buf) < 4096:
            chunk = c.recv(4096)
            if not chunk:
                break
            buf += chunk
        resp = json.loads(buf.split(b"\n", 1)[0])
        if "error" in resp:
            raise RuntimeError("sidecar signing failed: " + resp["error"])
        return resp
    finally:
        c.close()


if __name__ == "__main__":
    serve()
