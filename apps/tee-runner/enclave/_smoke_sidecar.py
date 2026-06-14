#!/usr/bin/env python3
# Sidecar PROTOCOL smoke (offline). The KMS signing recipe itself is already proven live
# (memory: grader-kms-ecrecover-proven). What's new in A2 is the sidecar's unix-socket
# request/response framing + the digest-only contract. We stub KmsSigner so this runs with no
# GCP creds and exercise: a valid digest signs, a bad-length digest is rejected, a non-digest
# request errors -- all over the real socket path.
import json
import os
import socket
import sys
import tempfile
import threading
import time
import types

# The dev box has neither google-cloud-kms nor eth_keys (enclave-only deps). Inject minimal
# module stubs into sys.modules so `import kms_sign` succeeds offline; we then replace its
# KmsSigner with a fake. This tests the SIDECAR PROTOCOL, not the KMS recipe (already proven
# live: grader-kms-ecrecover-proven).
for modname in ("google", "google.cloud", "google.cloud.kms", "eth_keys",
                "eth_keys.datatypes"):
    if modname not in sys.modules:
        sys.modules[modname] = types.ModuleType(modname)
sys.modules["google.cloud.kms"].KeyManagementServiceClient = object
sys.modules["eth_keys"].keys = types.SimpleNamespace(PublicKey=object)
sys.modules["eth_keys.datatypes"].Signature = object

# Stub the KMS signer BEFORE importing the sidecar, so serve() builds the fake one.
import kms_sign


class _FakeSigner:
    def __init__(self, **_):
        pass

    def address(self):
        return "0x000000000000000000000000000000000000dEaD"

    def sign(self, digest32):
        assert len(digest32) == 32
        # Deterministic fake (r,s,v) keyed off the digest so we can assert round-trip fidelity.
        return {
            "r": "0x" + digest32.hex(),
            "s": "0x" + ("11" * 32),
            "v": 27,
            "signer": self.address(),
        }


kms_sign.KmsSigner = _FakeSigner

import signer_sidecar

sock = os.path.join(tempfile.mkdtemp(), "signer.sock")
signer_sidecar.SOCK_PATH = sock
os.environ["SIGNER_SOCK"] = sock

t = threading.Thread(target=signer_sidecar.serve, daemon=True)
t.start()
for _ in range(50):
    if os.path.exists(sock):
        break
    time.sleep(0.05)
else:
    sys.exit("sidecar never created its socket")


def request(obj):
    c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    c.connect(sock)
    c.sendall((json.dumps(obj) + "\n").encode())
    buf = b""
    while b"\n" not in buf:
        buf += c.recv(4096)
    c.close()
    return json.loads(buf.split(b"\n", 1)[0])


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}  {detail}")
    if not ok:
        sys.exit(f"FAILED: {name}")


# 1. valid 32-byte digest signs and round-trips through the framing
d = bytes(range(32))
r = request({"digest": d.hex()})
check("valid digest signs", r.get("r") == "0x" + d.hex() and r["v"] == 27 and "signer" in r, json.dumps(r)[:80])

# 2. 0x-prefixed digest accepted too
r = request({"digest": "0x" + d.hex()})
check("0x-prefixed digest accepted", r.get("signer", "").startswith("0x"))

# 3. wrong-length digest rejected (not 32 bytes)
r = request({"digest": "ab" * 16})
check("short digest rejected", "error" in r, json.dumps(r)[:80])

# 4. missing digest field errors, sidecar stays up
r = request({"nope": 1})
check("missing digest errors", "error" in r, json.dumps(r)[:80])

# 5. sidecar still serving after bad requests (a valid one still works)
r = request({"digest": d.hex()})
check("sidecar survives bad input", r.get("v") == 27)

# 6. the client helper sign_via_sidecar works against the same socket
r = signer_sidecar.sign_via_sidecar(d, sock)
check("sign_via_sidecar helper", r["r"] == "0x" + d.hex())

# 7. socket perms are 0600 (only owner uid can connect)
mode = oct(os.stat(sock).st_mode & 0o777)
check("socket is 0600", mode == "0o600", mode)

print("\nsidecar protocol smoke: all checks passed.")
