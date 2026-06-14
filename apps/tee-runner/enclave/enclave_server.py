#!/usr/bin/env python3
# A5: the warm TEE daemon. This is the container ENTRYPOINT (replaces the grading enclave's
# single-shot enclave_grade.py). One Confidential Space VM stays up; each paid request runs the
# buyer's Python in a FRESH hardened child and returns the run output bundled with the proof it
# ran in this image inside a real TEE.
#
# It is the TRUSTED ROOT PARENT and owns the whole enclave lifecycle. At startup, while it still
# has root + CAP_NET_ADMIN (before any UID-drop), it brings up the trust boundary ONCE:
#
#   1. signer sidecar (P0-2)  -- the ONLY process holding a KMS path; private 0600 unix socket.
#   2. egress proxy (P0-4)    -- default-deny forward proxy, the sole egress chokepoint (proxy mode).
#   3. egress firewall (P0-4) -- iptables OUTPUT owner-match on the nobody uid -> DROP all egress
#                                except the proxy port (+DNS). Installed HERE because it needs
#                                CAP_NET_ADMIN, which is lost the moment a child setuids.
#
# Only after the boundary is up does it accept requests. Each POST /run forks code_worker.py via
# runner.run(), which drops to the unprivileged uid and (proxy mode) is governed by the firewall
# above. The daemon then asks the sidecar to sign the proof digest and assembles the bundle.
#
# HONESTY: the daemon REFUSES to serve if the confinement it depends on is not enforceable in
# this environment (not Linux / not root / no nobody user) -- unless SANDBOX_ALLOW_UNSAFE=1, the
# dev-box opt-in, which serves with a loud warning and unconfined runs. It NEVER silently serves
# user code without the cuts. Likewise, build_bundle raises if no real attestation is available
# (unless ATTESTATION_ALLOW_ABSENT=1), so a run that cannot be proven is surfaced, not faked.
import json
import os
import socket
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

import runner
import proof
import sandbox

HOST = os.environ.get("ENCLAVE_HOST", "0.0.0.0")
PORT = int(os.environ.get("ENCLAVE_PORT", "8000"))

# Where the trusted children listen. The sidecar socket is 0600 (only this root parent can reach
# it; the nobody uid cannot). The proxy listens on loopback and is the only egress the firewall
# permits the nobody uid to reach.
SIGNER_SOCK = os.environ.get("SIGNER_SOCK", "/run/signer.sock")
EGRESS_PROXY_HOST = os.environ.get("EGRESS_PROXY_HOST", "127.0.0.1")
EGRESS_PROXY_PORT = int(os.environ.get("EGRESS_PROXY_PORT", "8080"))
EGRESS_MODE = os.environ.get("EGRESS_MODE", "block").lower()

# x402 audience the attestation token is minted for (the buyer checks this in the JWT's aud).
ATTEST_AUDIENCE = os.environ.get("ATTEST_AUDIENCE", "honeycomb-tee-runner")

MAX_BODY = int(os.environ.get("MAX_REQUEST_BYTES", str(1 << 20)))  # 1 MiB request cap

# Subprocess handles for the trusted children, kept so a crash is visible (we poll them).
_SIDECAR_PROC = None
_PROXY_PROC = None


def _wait_for_unix_socket(path: str, timeout_s: float = 10.0) -> bool:
    """Block until a child has bound `path`, or timeout. The sidecar binds it after building the
    KMS client; we must not accept requests before it can sign."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if os.path.exists(path):
            try:
                c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                c.connect(path)
                c.close()
                return True
            except OSError:
                pass
        time.sleep(0.1)
    return False


def _wait_for_tcp(host: str, port: int, timeout_s: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            c = socket.create_connection((host, port), timeout=0.5)
            c.close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def start_signer_sidecar() -> subprocess.Popen:
    """Launch the signer sidecar (P0-2) and wait until its socket is signable. It builds the KMS
    client at startup; if that fails it exits loud and we never come up (a daemon that can't prove
    runs must not look healthy)."""
    env = dict(os.environ)
    env["SIGNER_SOCK"] = SIGNER_SOCK
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "signer_sidecar.py")],
        env=env,
    )
    if not _wait_for_unix_socket(SIGNER_SOCK):
        proc.terminate()
        raise RuntimeError(
            f"signer sidecar did not bind {SIGNER_SOCK} in time (KMS client init failed? "
            f"see sidecar stderr). The daemon cannot prove runs without it -- refusing to serve."
        )
    print(f"[enclave_server] signer sidecar up on {SIGNER_SOCK}", file=sys.stderr, flush=True)
    return proc


def start_egress_proxy() -> subprocess.Popen:
    """Launch the default-deny egress proxy (P0-4). Only in proxy mode -- block mode has no
    network at all (empty netns), so there is nothing to proxy."""
    if EGRESS_MODE != "proxy":
        return None
    env = dict(os.environ)
    env["EGRESS_PROXY_HOST"] = EGRESS_PROXY_HOST
    env["EGRESS_PROXY_PORT"] = str(EGRESS_PROXY_PORT)
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "egress_proxy.py")],
        env=env,
    )
    if not _wait_for_tcp(EGRESS_PROXY_HOST, EGRESS_PROXY_PORT):
        proc.terminate()
        raise RuntimeError(
            f"egress proxy did not listen on {EGRESS_PROXY_HOST}:{EGRESS_PROXY_PORT} in time. "
            f"In proxy mode the proxy is the ONLY egress -- refusing to serve without it."
        )
    print(
        f"[enclave_server] egress proxy up on {EGRESS_PROXY_HOST}:{EGRESS_PROXY_PORT}",
        file=sys.stderr, flush=True,
    )
    return proc


def install_firewall_once() -> None:
    """Install the iptables uid firewall ONCE (proxy mode), while we still hold CAP_NET_ADMIN.
    Keyed on the fixed nobody uid that runner.run() will drop the worker child to. No-op in block
    mode (the empty netns is the boundary there)."""
    if EGRESS_MODE != "proxy":
        return
    import pwd
    uid = pwd.getpwnam(sandbox.UNPRIVILEGED_USER).pw_uid
    sandbox.install_egress_firewall(uid)  # raises if not enforceable (unless ALLOW_UNSAFE)


def preflight() -> dict:
    """Honest readiness check. Reports the confinement actually enforceable here and REFUSES to
    serve if the cuts the design depends on are absent -- unless the dev-box opt-in is set."""
    status = sandbox.confinement_status()
    enforceable = status["uidDrop"] and status["metadataBlock"]
    if not enforceable and not sandbox.ALLOW_UNSAFE:
        raise RuntimeError(
            f"[enclave_server] REFUSING to serve: confinement not enforceable ({status['reason']}). "
            f"This daemon runs ARBITRARY user code with NETWORK ON; without UID-drop + metadata "
            f"block the signing identity is exposed. Set SANDBOX_ALLOW_UNSAFE=1 ONLY on a dev box."
        )
    return status


class Handler(BaseHTTPRequestHandler):
    # Quiet the default per-request stderr line; we log what we care about ourselves.
    def log_message(self, fmt, *args):  # noqa: A003
        pass

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            status = sandbox.confinement_status()
            self._json(200, {
                "ok": True,
                "egressMode": EGRESS_MODE,
                "confinement": status,
                "attestationNonceBound": _attestation_nonce_bound(),
            })
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/run":
            self._json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_BODY:
            self._json(413, {"error": f"request body exceeds {MAX_BODY} bytes"})
            return
        raw = self.rfile.read(length) if length else b""
        try:
            req = json.loads(raw or b"{}")
            code = req["code"]
            stdin_input = req.get("input", "")
            nonce = req.get("nonce")
            if not isinstance(code, str):
                raise TypeError("code must be a string")
            if not nonce or not isinstance(nonce, str):
                # The nonce binds the attestation + the proof digest to THIS purchase. Without it
                # the proof is replayable, so we reject rather than mint an unbound bundle.
                raise ValueError("a non-empty string 'nonce' is required (binds the proof to this request)")
        except (ValueError, KeyError, TypeError) as e:
            self._json(400, {"error": "bad request: " + repr(e)})
            return

        # 1. Run the buyer's code once in a fresh hardened child. A program that crashes or times
        #    out is a NORMAL result (nonzero/None exitCode); only a transport failure raises.
        try:
            run_result = runner.run(code, stdin_input)
        except runner.WorkerError as e:
            self._json(500, {"error": "run transport failed: " + repr(e)})
            return

        # 2. Bind the run to a signature (via the sidecar) + the CS attestation, and return the
        #    full bundle. build_bundle raises if the run cannot be proven (no attestation, sidecar
        #    down) -- we surface that as a 502 rather than returning an unprovable result as if it
        #    were proven. The whole product is "the proof is real."
        try:
            bundle = proof.build_bundle(code, stdin_input, run_result, nonce, audience=ATTEST_AUDIENCE)
        except Exception as e:  # noqa: BLE001 -- attestation/signing failure must surface, not 200
            self._json(502, {"error": "proof assembly failed: " + repr(e)})
            return

        self._json(200, bundle)


def _attestation_nonce_bound() -> bool:
    try:
        import attestation
        return attestation.attestation_is_nonce_bound()
    except Exception:  # noqa: BLE001
        return False


def main() -> int:
    # Bring up the trust boundary BEFORE serving, while we still have root + CAP_NET_ADMIN.
    status = preflight()
    print(f"[enclave_server] confinement: {json.dumps(status)}", file=sys.stderr, flush=True)

    global _SIDECAR_PROC, _PROXY_PROC
    _SIDECAR_PROC = start_signer_sidecar()
    _PROXY_PROC = start_egress_proxy()
    install_firewall_once()

    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"[enclave_server] warm TEE daemon listening on {HOST}:{PORT} "
        f"(egress={EGRESS_MODE}, audience={ATTEST_AUDIENCE}). POST /run {{code,input,nonce}}.",
        file=sys.stderr, flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for p in (_PROXY_PROC, _SIDECAR_PROC):
            if p is not None:
                p.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
