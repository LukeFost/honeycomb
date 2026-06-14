#!/usr/bin/env python3
# Warm grading daemon (Confidential Space, Stage 2). The HTTP counterpart to the single-shot
# enclave_grade.py: instead of one VM per submission (boot -> grade -> TERMINATE), ONE
# Confidential Space VM stays up and grades each submission that arrives over HTTP.
#
# This mirrors the "summon a TEE" warm runner (apps/tee-runner/enclave/enclave_server.py),
# but for GRADING. Two deliberate differences from that runner:
#
#   1. It runs a FIXED, TRUSTED scorer (scorer.score) against the baked private series --
#      NOT arbitrary buyer code. So it does NOT need the runner's signer sidecar, egress
#      firewall, or UID-drop boundary: there is no untrusted code in THIS process to fence
#      off from the KMS identity. (scorer.score still spawns the submission in its own
#      hardened worker.py child; that boundary is unchanged and lives inside score().)
#   2. The response is the on-chain-recomputable signed grade bundle (jobId, agentId, score,
#      scoreDigest, r/s/v, signer) -- the exact shape enclave_grade.grade() already returns
#      and that BountyEscrow._recordScore ecrecovers. We reuse grade() verbatim.
#
# Contract (two ways to deliver the submission source):
#   POST /grade  {code: str, jobId, agentId}            -- inline plaintext (back-compat)
#   POST /grade  {encCid: "gcs://...", jobId, agentId}  -- SEALED submission: the enclave
#                fetches the ciphertext from the submissions bucket and opens it with its
#                X25519 secret (ENCLAVE_ENC_SECRET) before grading. This is the private path:
#                the plaintext never leaves the enclave. Exactly one of code/encCid is required.
#                -> 200 {jobId, agentId, score, scoreDigest, signature:{r,s,v}, signer}
#                -> 400 bad request   -> 500 grade/transport failure   -> 502 signing failure
#   GET  /health -> 200 {ok, kmsSigner, privateSeries}
#
# Honest labeling: the enclave RUN is attested by Confidential Space; the KMS key is not yet
# attestation-gated (Stage 3 gap, see enclave_grade.py header). The signed digest still proves
# "this exact (jobId, agentId, score) was produced by the holder of the registered signer key."
import json
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# enclave_grade owns the grade logic (scorer.score -> bound keccak digest -> KMS sign). We
# import it rather than reimplement so the warm path and the single-shot path can never drift.
import enclave_grade

HOST = os.environ.get("ENCLAVE_HOST", "0.0.0.0")
PORT = int(os.environ.get("ENCLAVE_PORT", "8000"))
MAX_BODY = int(os.environ.get("MAX_REQUEST_BYTES", str(1 << 20)))  # 1 MiB request cap

# Built once at boot so /health can report the signer address and a failed KMS client is
# surfaced before we accept traffic (a grader that can't sign must not look healthy).
_SIGNER = None


def _signer():
    global _SIGNER
    if _SIGNER is None:
        from kms_sign import KmsSigner

        _SIGNER = KmsSigner(**enclave_grade.KMS)
    return _SIGNER


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
            try:
                signer = _signer().address()
            except Exception as e:  # noqa: BLE001 -- a broken KMS client is unhealthy, surface it
                self._json(503, {"ok": False, "error": "KMS signer unavailable: " + repr(e)})
                return
            self._json(200, {
                "ok": True,
                "kmsSigner": signer,
                "privateSeries": os.environ.get("PRIVATE_SERIES", "(default)"),
            })
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/grade":
            self._json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_BODY:
            self._json(413, {"error": f"request body exceeds {MAX_BODY} bytes"})
            return
        raw = self.rfile.read(length) if length else b""
        try:
            req = json.loads(raw or b"{}")
            code = req.get("code")
            enc_cid = req.get("encCid")
            # Exactly one source. encCid is the sealed/private path; code is inline plaintext.
            if (code is None) == (enc_cid is None):
                raise ValueError("provide exactly one of 'code' (inline source) or 'encCid' (sealed)")
            if code is not None and (not isinstance(code, str) or not code.strip()):
                raise ValueError("'code' must be a non-empty string (the submission .py source)")
            if enc_cid is not None and (not isinstance(enc_cid, str) or not enc_cid.strip()):
                raise ValueError("'encCid' must be a non-empty gcs:// URI")
            # jobId/agentId are stamped into the SIGNED digest, so they must be valid ints.
            # Default to the same demo values the single-shot CMD uses if omitted.
            job_id = int(req.get("jobId", 1))
            agent_id = int(req.get("agentId", 22))
        except (ValueError, KeyError, TypeError) as e:
            self._json(400, {"error": "bad request: " + repr(e)})
            return

        # Sealed path: fetch the ciphertext from GCS and open it with the enclave secret.
        # The plaintext lives only in this process. A transport/content-address/decrypt
        # failure raises here -> mapped to 500 below (we never grade tampered content).
        if enc_cid is not None:
            try:
                import enc_fetch  # lazy: inline path needs neither GCS nor PyNaCl

                code = enc_fetch.fetch_and_open(enc_cid)
            except Exception as e:  # noqa: BLE001 -- a failed open must abort the grade, loudly
                self._json(500, {"error": "encCid fetch/open failed: " + repr(e)})
                return

        # scorer.score() takes a FILE PATH (the worker child opens it), so materialize the
        # submission to a temp .py for this one grade and remove it after. The grade is fully
        # synchronous, so the file's lifetime is exactly this request.
        tmp = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".py", prefix="submission-", delete=False
            ) as f:
                f.write(code)
                tmp = f.name
            # grade() runs the real backtest in the hardened worker, builds the bound digest,
            # and KMS-signs it. Any scorer/transport failure raises here.
            bundle = enclave_grade.grade(tmp, job_id, agent_id)
        except Exception as e:  # noqa: BLE001
            # Distinguish signing failures (502, the proof couldn't be produced) from grade
            # failures (500). KmsSigner raises RuntimeError on a broken recovery id.
            msg = repr(e)
            status = 502 if "recovery id" in msg or "KMS" in msg or "sign" in msg.lower() else 500
            self._json(status, {"error": "grade failed: " + msg})
            return
        finally:
            if tmp is not None:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

        self._json(200, bundle)


def main() -> int:
    # Build the KMS client up front. If the SA/key is wrong we fail loud at boot rather than
    # 502-ing the first real grade.
    signer = _signer().address()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"[enclave_grade_server] warm grading daemon listening on {HOST}:{PORT} "
        f"(signer={signer}, series={os.environ.get('PRIVATE_SERIES', '(default)')}). "
        f"POST /grade {{code|encCid, jobId, agentId}}.",
        file=sys.stderr, flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
