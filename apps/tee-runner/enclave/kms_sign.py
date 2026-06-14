#!/usr/bin/env python3
# In-enclave KMS signing. Signs a 32-byte score-attestation digest with the Cloud KMS
# HSM EC_SIGN_SECP256K1 key and returns an Ethereum (r, s, v) that recovers to the
# enclave's registered signer address. Runs IN the Confidential Space container, using
# the VM's attested service account -- no key material ever leaves the HSM.
#
# This is the Python port of the PROVEN smoke-test recipe (HARNESS_SPEC.md:161):
#   - KMS asymmetric_sign over digest SHA256 -> DER ECDSA sig.
#   - parse DER -> (r, s); normalize low-s (EIP-2); ecrecover rejects high-s.
#   - try recovery id 27/28; the one that recovers the KMS address is v.
#
# Verified design: ecrecover(digest, 27, r, s) == KMS address, through the real Solidity
# precompile (Solc 0.8.30). The contract stores the digest as scoreAttestationHash; the
# (r,s,v) is enclave provenance the verifier can ecrecover off-chain (Stage 3 makes the
# on-chain check a gate).
#
# NOTE on the digest: gcloud's CLI hashes the input itself; the SDK's asymmetric_sign
# takes a pre-computed Digest message. So HERE we pass the 32-byte digest directly and
# ecrecover against THAT digest (not sha256(digest)). The grade digest IS already a
# sha256, so it is the right 32-byte value to sign and to recover against.
import hashlib

from google.cloud import kms
from eth_keys import keys as eth_keys
from eth_keys.datatypes import Signature as EthSignature

# secp256k1 order; low-s threshold is n/2 (EIP-2).
_SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_HALF_N = _SECP256K1_N // 2


def _der_to_rs(der: bytes) -> tuple[int, int]:
    # Minimal DER ECDSA parse: SEQ { INTEGER r, INTEGER s }. No external asn1 dep.
    if der[0] != 0x30:
        raise ValueError("not a DER SEQUENCE")
    idx = 2  # skip SEQ tag + length (sigs are < 128 bytes so length is single-byte)
    if der[idx] != 0x02:
        raise ValueError("expected INTEGER for r")
    rlen = der[idx + 1]
    r = int.from_bytes(der[idx + 2 : idx + 2 + rlen], "big")
    idx = idx + 2 + rlen
    if der[idx] != 0x02:
        raise ValueError("expected INTEGER for s")
    slen = der[idx + 1]
    s = int.from_bytes(der[idx + 2 : idx + 2 + slen], "big")
    return r, s


class KmsSigner:
    def __init__(self, project, location, keyring, key, version="1"):
        self._client = kms.KeyManagementServiceClient()
        self._name = self._client.crypto_key_version_path(project, location, keyring, key, version)

    def address(self) -> str:
        """Enclave's Ethereum address from the KMS public key: keccak256(X||Y)[-20:]."""
        pub = self._client.get_public_key(request={"name": self._name})
        der = _pem_to_der(pub.pem)
        point = der[-65:]  # trailing uncompressed point 0x04||X||Y in the SPKI
        if point[0] != 0x04:
            raise ValueError("unexpected pubkey encoding (no uncompressed point)")
        pk = eth_keys.PublicKey(point[1:])  # eth_keys wants the 64-byte X||Y
        return pk.to_checksum_address()

    def sign(self, digest32: bytes) -> dict:
        """Sign a 32-byte digest -> {r, s, v, signer}. v is 27/28, s is low-s normalized."""
        if len(digest32) != 32:
            raise ValueError("digest must be exactly 32 bytes")
        resp = self._client.asymmetric_sign(
            request={"name": self._name, "digest": {"sha256": digest32}}
        )
        r, s = _der_to_rs(resp.signature)
        if s > _HALF_N:  # EIP-2 low-s; ecrecover rejects high-s
            s = _SECP256K1_N - s

        signer = self.address()
        for v in (27, 28):
            sig = EthSignature(vrs=(v - 27, r, s))
            recovered = sig.recover_public_key_from_msg_hash(digest32).to_checksum_address()
            if recovered.lower() == signer.lower():
                return {
                    "r": "0x" + r.to_bytes(32, "big").hex(),
                    "s": "0x" + s.to_bytes(32, "big").hex(),
                    "v": v,
                    "signer": signer,
                }
        raise RuntimeError("no recovery id reproduced the KMS address -- signing is broken")


def _pem_to_der(pem: str) -> bytes:
    import base64

    body = "".join(
        line for line in pem.splitlines() if "-----" not in line
    )
    return base64.b64decode(body)


if __name__ == "__main__":
    # Self-test inside the container: sign a known digest, print the recovered signer.
    signer = KmsSigner("honeycomb-499305", "us-central1", "honeycomb-grader", "score-signer")
    d = hashlib.sha256(b"honeycomb-kms-smoke-test").digest()
    print("signer:", signer.address())
    print("sig:", signer.sign(d))
