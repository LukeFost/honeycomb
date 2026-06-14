# Sealed submission + private winner delivery (Gap 2)

Real NaCl/libsodium **sealed boxes** (X25519 + `crypto_box_seal`) replace the
placeholder `makerPubKey` / `enclaveEncPub` (`0x..1111` / `0x..2222`) in the
mainnet e2e. Implemented by `grader/deliver.py` (PyNaCl, runs in `grader/.venv`).

A sealed box encrypts to a recipient's X25519 **public** key with an ephemeral
sender keypair: anyone can seal to the enclave/maker, only the holder of the
matching **secret** can open. Public keys are 32 bytes → surfaced as 0x bytes32
for on-chain. Secrets are 32 bytes → base64, kept off-chain. Sealed blobs are
local files under `/tmp`; the file path is the CID-like pointer (`encCid`,
`deliveryCid`). The demo uses local files, not IPFS.

## Two legs

```
Leg 1 (submit):  agent   seal(enclaveEncPub, submission)        -> encCid
                 contract: submit(jobId, agentId, encCid)
Leg 2 (deliver): enclave reseal(enclaveSec, makerPubKey, encCid) -> deliveryCid   (after resolve)
                 CRE onReport action 3: deliverWinner(jobId, deliveryCid)
                 maker   open(makerSec, winnerDeliveryCidOf(jobId)) == winning code
```

`_deliverWinner` requires `status == Completed`, so delivery only happens
*after* `resolve` settles the job.

## CLI (`grader/.venv/bin/python grader/deliver.py ...`)

| cmd | args | output |
|-----|------|--------|
| `keygen` | – | `{"pub":"0x<32-byte X25519 pub>","sec":"<base64 secret>"}` |
| `seal` | `<pub-hex32> <plaintext-file> [--out PATH]` | writes blob, prints path (encCid) |
| `open` | `<secret-b64-or-hex> <sealed-blob>` | prints decrypted plaintext |
| `reseal` | `<enclave-sec> <maker-pub-hex32> <sealed-blob> [--out PATH]` | opens w/ enclave sec, re-seals to maker pub, prints new blob path (deliveryCid) |
| `selftest` | – | local roundtrip PASS/FAIL, no chain |

`open` raises on the wrong key or tampered ciphertext (so the enclave secret
cannot open a maker-sealed blob — verified by `selftest`).

## deliverWinner CRE payload (onReport action 3)

The CRE `grading-workflow` HTTP trigger (`onCallback`, kind `"delivery"`) builds
`actionReport(3, abi(uint256 jobId, string deliveryCid))`. The HTTP payload file
passed to `cre workflow simulate ... --http-payload <file>` must be exactly:

```json
{"kind":"delivery","jobId":<JOB>,"deliveryCid":"<deliveryCid pointer>"}
```

Example:

```json
{"kind":"delivery","jobId":42,"deliveryCid":"/tmp/deliver-1781431853139-972954.sealed"}
```

Relay (orchestrator runs this; not part of this component):

```bash
cre workflow simulate grading-workflow --non-interactive \
  --target mainnet-settings --trigger-index 0 \
  --http-payload <payload.json> --broadcast   # from apps/grading-cre, CRE_ETH_PRIVATE_KEY set
```

After it lands, `winnerDeliveryCidOf(jobId)` returns the `deliveryCid`; the maker
opens it with its X25519 secret to recover the winning code.

## Local test

`grader/.venv/bin/python grader/deliver.py selftest` → all checks PASS:
keygen bytes32 pubs; seal→enclave open == original; reseal→maker open == winning
code; enclave secret CANNOT open the maker-sealed blob; ciphertext != plaintext.

Dependency installed: **PyNaCl 1.6.2** into `grader/.venv`.
