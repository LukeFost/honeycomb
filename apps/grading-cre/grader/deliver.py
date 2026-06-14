#!/usr/bin/env python3
"""
deliver.py — sealed-submission encryption + private winner delivery (Gap 2).

NaCl/libsodium sealed boxes (X25519 + crypto_box_seal). This replaces the
placeholder makerPubKey/enclaveEncPub (0x..1111 / 0x..2222) in the mainnet e2e
with real X25519 keys, and implements the two-leg encrypted flow:

  Leg 1 (submit):   agent  seals submission  -> enclaveEncPub   => encCid
  Leg 2 (deliver):  enclave opens encCid, re-seals WINNER       => deliveryCid
                    maker  opens deliveryCid with its secret     => winning code

A sealed box (crypto_box_seal) encrypts to a recipient X25519 *public* key using
an ephemeral sender keypair, so the sender needs no key of its own and the
recipient needs only its own secret to open — perfect for "anyone can seal to the
enclave/maker, only the holder of the secret can read".

Public keys are 32 bytes, surfaced as 0x-prefixed bytes32 hex for on-chain use
(createBounty's makerPubKey / enclaveEncPub args). Secrets are 32 bytes, surfaced
as base64 (kept off-chain). Sealed blobs are written to local files under /tmp
(the demo uses local files, not IPFS); the file path is the "CID-like" pointer.

Subcommands:
  keygen
  seal    <pubkey-hex32> <plaintext-file> [--out PATH]
  open    <secret-b64-or-hex> <sealed-blob>
  reseal  <enclave-sec-b64-or-hex> <maker-pub-hex32> <sealed-blob> [--out PATH]
  selftest
"""

import argparse
import base64
import json
import os
import sys
import time

from nacl.public import PrivateKey, PublicKey, SealedBox


# --------------------------------------------------------------------------- #
# encoding helpers
# --------------------------------------------------------------------------- #
def _strip0x(s: str) -> str:
    return s[2:] if s.startswith(("0x", "0X")) else s


def pub_to_hex32(pub: PublicKey) -> str:
    """32-byte X25519 public key as 0x-prefixed bytes32 (for on-chain)."""
    return "0x" + bytes(pub).hex()


def sec_to_b64(sec: PrivateKey) -> str:
    return base64.b64encode(bytes(sec)).decode()


def pub_from_hex32(s: str) -> PublicKey:
    raw = bytes.fromhex(_strip0x(s))
    if len(raw) != 32:
        raise ValueError(f"X25519 pubkey must be 32 bytes, got {len(raw)}")
    return PublicKey(raw)


def sec_from_str(s: str) -> PrivateKey:
    """Accept a secret as base64 (preferred) or 0x/hex; must decode to 32 bytes."""
    s = s.strip()
    raw = None
    # try base64 first
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
        raise ValueError("secret must be base64 or hex decoding to 32 bytes")
    return PrivateKey(raw)


# --------------------------------------------------------------------------- #
# subcommands
# --------------------------------------------------------------------------- #
def cmd_keygen(_args) -> int:
    sk = PrivateKey.generate()
    out = {"pub": pub_to_hex32(sk.public_key), "sec": sec_to_b64(sk)}
    print(json.dumps(out))
    return 0


def _default_blob_path(prefix: str) -> str:
    return f"/tmp/{prefix}-{int(time.time()*1000)}-{os.getpid()}.sealed"


def cmd_seal(args) -> int:
    pub = pub_from_hex32(args.pubkey)
    with open(args.plaintext, "rb") as f:
        msg = f.read()
    blob = SealedBox(pub).encrypt(msg)
    out_path = args.out or _default_blob_path("seal")
    with open(out_path, "wb") as f:
        f.write(blob)
    # the local file path is the CID-like pointer
    print(out_path)
    return 0


def cmd_open(args) -> int:
    sk = sec_from_str(args.secret)
    with open(args.blob, "rb") as f:
        blob = f.read()
    plain = SealedBox(sk).decrypt(blob)  # raises on wrong key / tamper
    sys.stdout.buffer.write(plain)
    return 0


def cmd_reseal(args) -> int:
    """Enclave post-resolve step: open with enclave secret, re-seal to maker pub."""
    enclave_sk = sec_from_str(args.enclave_sec)
    maker_pub = pub_from_hex32(args.maker_pub)
    with open(args.blob, "rb") as f:
        blob = f.read()
    plain = SealedBox(enclave_sk).decrypt(blob)          # open enclave-sealed
    resealed = SealedBox(maker_pub).encrypt(plain)       # re-seal to maker
    out_path = args.out or _default_blob_path("deliver")
    with open(out_path, "wb") as f:
        f.write(resealed)
    print(out_path)
    return 0


def cmd_selftest(_args) -> int:
    """Local roundtrip proof — no chain. Prints PASS/FAIL per check; exit 0 iff all pass."""
    import subprocess
    import tempfile

    here = os.path.dirname(os.path.abspath(__file__))
    self_py = os.path.abspath(__file__)
    py = sys.executable
    sample = os.path.join(here, "submissions", "accumulate.py")
    if not os.path.exists(sample):
        print(f"FAIL setup: sample not found {sample}")
        return 1

    def run(*argv) -> bytes:
        r = subprocess.run([py, self_py, *argv], capture_output=True)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.decode())
        return r.stdout

    ok = True

    def check(label, cond):
        nonlocal ok
        ok = ok and cond
        print(f"{'PASS' if cond else 'FAIL'}  {label}")

    with open(sample, "rb") as f:
        original = f.read()

    maker = json.loads(run("keygen"))
    enclave = json.loads(run("keygen"))
    check("keygen maker pub is bytes32", len(_strip0x(maker["pub"])) == 64)
    check("keygen enclave pub is bytes32", len(_strip0x(enclave["pub"])) == 64)

    # Leg 1: agent seals submission to enclave pub
    enc_blob = run("seal", enclave["pub"], sample).decode().strip()
    check("seal -> blob exists", os.path.exists(enc_blob))

    # enclave opens it (roundtrip == original)
    opened = run("open", enclave["sec"], enc_blob)
    check("enclave open(encCid) == original", opened == original)

    # Leg 2: enclave reseals winning code to maker pub
    deliver_blob = run("reseal", enclave["sec"], maker["pub"], enc_blob).decode().strip()
    check("reseal -> deliveryCid blob exists", os.path.exists(deliver_blob))

    # maker opens resealed blob == original
    maker_opened = run("open", maker["sec"], deliver_blob)
    check("maker open(deliveryCid) == winning code", maker_opened == original)

    # enclave secret must NOT open the maker-sealed blob
    leak = False
    try:
        run("open", enclave["sec"], deliver_blob)
        leak = True  # it opened => leak
    except RuntimeError:
        leak = False
    check("enclave sec CANNOT open maker-sealed blob", not leak)

    # ciphertext is not the plaintext
    with open(enc_blob, "rb") as f:
        check("ciphertext != plaintext", f.read() != original)

    print("ALL PASS" if ok else "SOME FAILED")
    return 0 if ok else 1


def main() -> int:
    p = argparse.ArgumentParser(description="X25519 sealed-box delivery CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("keygen", help="print {pub,sec} JSON")

    sp = sub.add_parser("seal", help="seal plaintext to an X25519 pub")
    sp.add_argument("pubkey")
    sp.add_argument("plaintext")
    sp.add_argument("--out")

    op = sub.add_parser("open", help="open a sealed blob with a secret")
    op.add_argument("secret")
    op.add_argument("blob")

    rp = sub.add_parser("reseal", help="enclave: open w/ enclave sec, re-seal to maker pub")
    rp.add_argument("enclave_sec")
    rp.add_argument("maker_pub")
    rp.add_argument("blob")
    rp.add_argument("--out")

    sub.add_parser("selftest", help="local roundtrip PASS/FAIL (no chain)")

    args = p.parse_args()
    return {
        "keygen": cmd_keygen,
        "seal": cmd_seal,
        "open": cmd_open,
        "reseal": cmd_reseal,
        "selftest": cmd_selftest,
    }[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
