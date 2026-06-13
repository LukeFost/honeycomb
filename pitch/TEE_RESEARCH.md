# TEE Research — Confidential Scorer

> Research notes for the **Confidential Scorer** (the Go enclave that grades models
> blind against hidden backtest data). Not a final decision. Standing preference:
> **use Google** for this TEE. This doc captures what that actually looks like, the
> clean on-chain path, and the honest tradeoffs, plus why the other options were
> considered and set aside.

## TL;DR

- **Preferred: Google Cloud Confidential Space** (Confidential VM, AMD SEV / Intel TDX).
  We're already on the Google track (BigQuery) and have GCP credits, so it fits.
- The thing everyone gets wrong about it (the "no on-chain verifier" objection) is
  **solved by the Cloud KMS key-release pattern**: the enclave never verifies a JWT
  on-chain. Instead, an HSM-held **secp256k1** key will only sign for the exact
  attested image, and the contract checks that signature with plain `ecrecover`.
- Effort to a working attested scorer that signs on-chain: **~8-13 hrs**, doable in
  one hackathon day by one person.

---

## The two confidential services (don't conflate them)

| Service | What it does | Solution | Owner |
|---|---|---|---|
| **AI Tester** | LLM judges "real model vs hardcoded to public set," writes signed valid/invalid + codeHash on-chain | **Chainlink Confidential AI + CRE** (hosted LLM-in-TEE; we have the API key) | Alex |
| **Confidential Scorer** | Downloads encrypted model by CID, decrypts in enclave, runs backtest vs hidden data, signs score | **Our own enclave — Google Confidential Space (preferred)** | TBD |

The AI Tester is a *Chainlink-hosted* TEE we call as an API (see the
[chainlink-confidential-ai-attester-demo](https://github.com/smartcontractkit/chainlink-confidential-ai-attester-demo)
shape: POST `/v1/inference`, callback into a CRE workflow, `onReport` on a contract
behind the KeystoneForwarder). The Scorer runs **arbitrary Go + IPFS + a backtest** —
not an LLM call — so Confidential AI doesn't fit it. The Scorer needs its own enclave.
This doc is about the Scorer.

---

## Google Cloud Confidential Space (preferred)

### What it is

A composition of three GCP primitives:

1. **Confidential VM** — runs on AMD SEV or Intel TDX. CPU memory encryption hides RAM
   from the hypervisor / Google operators. Boot chain measured into a vTPM.
2. **Confidential Space OS image** — hardened Container-Optimized OS. Runs a *launcher*
   (not a shell). Launcher pulls the workload container, measures it, runs it, serves
   attestation tokens. **SSH is disabled in the production image** — operators can't
   exec in.
3. **Google Cloud Attestation** — verifies the hardware quote, returns a signed OIDC
   **JWT** (the attestation token) carrying the workload's identity claims.

Boot flow: launcher measures the container image into PCRs -> requests a vTPM quote ->
Google Cloud Attestation verifies and returns a signed JWT -> JWT lands at
`/run/container_launcher/attestation_verifier_claims_token` inside the container.
Custom-audience tokens on demand via `/run/container_launcher/teeserver.sock`.

### Go support

Fully supported, no constraints. It's container-native: build an OCI image, push to
**Artifact Registry**, point the VM at it via `tee-image-reference`. Any binary in the
image runs as-is. No SDK, no sidecar.

Constraints worth knowing:
- Image must live in **Artifact Registry** (not Docker Hub).
- One workload container per VM.
- The container image digest (`submods.container.image_digest`) is the unit of
  measurement. Change anything in the image -> new digest -> breaks IAM bindings (see
  cons).
- Inbound firewall closed by default; **outbound egress open** (IPFS fetch just works).

### The attestation token

RS256 OIDC **JWT**, signed by Google. JWKS at
`https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com`
(a PKI/cert variant exists too, more stable for offline use).

Key claims: `image_digest` (SHA256 of the container — the binding field), `hwmodel`
(`GCP_AMD_SEV` / `INTEL_TDX`), `dbgstat` (`disabled-since-boot` in prod), `swname`
(`CONFIDENTIAL_SPACE`), `support_attributes` (`STABLE` vs `EXPERIMENTAL`), `eat_nonce`
(replay protection), plus GCE placement.

Trust chain: hardware measurement -> vTPM quote -> Google Cloud Attestation -> signed
JWT. **Google is the root of trust for the signature.**

### On-chain verification — the three paths

This is the part the first-pass research flagged as "eliminated." It's not, because of
Option C.

**Option A — full on-chain JWT verification.** The token is RSA-signed. Verifying
RSA-2048 in Solidity via the MODEXP precompile costs ~300K-2M+ gas, no production
library exists, and the signing key rotates. **Skip.**

**Option B — off-chain verify + trusted relayer.** Relayer verifies the Google JWT
(standard OIDC, easy), then signs the result with its own key; contract `ecrecover`s
the relayer key. Easy, but the contract now trusts the *relayer*, not the hardware.
Acceptable for a demo, but it's the same trust shape as the Chainlink-forwarder pattern.

**Option C — Cloud KMS key release + `ecrecover` (recommended).** The clean Google-native
path:

1. Create a Cloud KMS **HSM** key, algorithm `EC_SIGN_SECP256K1_SHA256`. Public key is
   known, hardcode it in the contract.
2. Configure a **Workload Identity Pool** whose attestation policy says: only release
   this key to a workload where `image_digest == sha256:<pinned>` AND
   `dbgstat == disabled-since-boot` AND `STABLE in support_attributes`.
3. The genuine scorer image gets the attestation token, federates it into a credential,
   calls KMS `asymmetricSign` on the score hash.
4. KMS returns a secp256k1 signature.
5. Solidity does `ecrecover(hash, v, r, s)` and checks it equals the known KMS pubkey.

Why it's clean: the private key never leaves the HSM, and KMS refuses to sign for any
image that isn't the pinned digest. **Change the scoring code -> new digest -> KMS won't
sign.** No on-chain JWT verification needed; the contract just does a standard
`ecrecover`. This is the intended pattern (Google's own MPC-signing blog uses it).

Caveats on Option C:
- `EC_SIGN_SECP256K1_SHA256` is **HSM-only** in Cloud KMS (~$2.50/mo per key version,
  negligible).
- KMS returns lower-S normalized sigs; you derive Ethereum's `v` (27/28) by trial
  recovery against the known pubkey (~10 lines of Go; solved, see `go-kms-signer`).

### Network egress

Standard GCP VPC, default egress allow-all. With an external IP (default) or Cloud NAT,
`http.Get("https://ipfs.io/ipfs/<CID>")` works directly. Contrast AWS Nitro, which has
no network and needs a vsock proxy.

### Setup time and cost

~8-13 hrs total to a working attested scorer that signs on-chain (project setup 15m;
containerize Go scorer 2-4h; KMS+WIP+IAM 1-2h; deploy VM + iterate 1-2h; wire KMS signing
+ v/r/s 1-2h; Solidity verifier 1h; e2e debug 1-2h). The
[Confidential Space codelab](https://codelabs.developers.google.com/codelabs/confidential-space)
is the fastest onramp.

Cost: Confidential VM (`n2d-standard-2`, SEV) ~$0.10/hr; HSM key ~$2.50/mo; signing
$0.03 / 10k ops. $300 free trial + sponsor credits cover it.

### Honest cons (hackathon lens)

1. **Artifact Registry required** — no Docker Hub source. 15-min setup but a required step.
2. **Workload Identity Pool friction** — 5-6 gcloud commands with project numbers / pool
   IDs that must match exactly. Most common failure: a typo -> silent `403` from KMS ->
   VM log just says "workload finished non-zero." Painful to debug.
3. **No SSH in prod image** — debug via Cloud Logging. Use the `confidential-space-debug`
   image family (SSH enabled, VM stays up) during dev against non-sensitive data, switch
   to prod for the demo.
4. **Token audience/nonce handling** — default audience is `sts.googleapis.com`; an
   external verifier needs a custom-audience token via the teeserver socket. Extra steps.
5. **Image digest pinning is feature + friction** — every code change = new digest =
   must update the KMS IAM binding before the new image can sign. Mitigate with a
   rebuild+push+extract-digest+rebind shell script.
6. **secp256k1 is HSM-only** — can't use a cheaper SOFTWARE key.
7. **Lower-S -> recover `v`** — ~10 lines of Go, non-obvious but solved.
8. **Google is the attestation root** — "the exact binary ran" really means "Google
   attests it ran on Google's hardware." Fine for a demo; a production protocol's
   skeptics will note Google could theoretically forge a token. Same trust shape as any
   cloud HSM/TEE. Be ready to say it plainly.

### Recommended architecture (Google path)

```
[IPFS / CID] --HTTP GET--> [Go scorer in Confidential Space container]
                                 |
                         [decrypt model bundle]
                         [run inference vs hidden backtest data]
                         [compute score hash]
                                 |
                         [call Cloud KMS HSM asymmetricSign]
                         [KMS checks: image_digest == pinned &&
                                      dbgstat == disabled-since-boot &&
                                      STABLE in support_attributes]
                                 |
                    <-- secp256k1 sig (r,s) -- derive v --
                                 |
[BountyEscrow.sol] <-- (scoreHash, v, r, s) --> ecrecover == knownKmsPubKey
```

Trust claim for judges: *the only code that can produce a signature valid against the
contract's registered pubkey is the exact published container image, running on Google
Confidential Space with attestation on. Cloud KMS enforces this at the HSM; it refuses
to sign for any other image.*

---

## Alternatives considered (set aside, kept for reference)

**Marlin Oyster** — Nitro-backed CVM, full egress, Docker+Go. Has a real Solidity
attestation path (`NitroProver` contracts + an attestation-verifier enclave returning a
secp256k1 sig). Strong on-chain story, Web3-native. Set aside only because of the Google
preference; this is the fallback if Confidential Space fights us.

**AWS Nitro Enclaves (raw)** — killed by networking: no network interface at all, IPFS
fetch needs a vsock-to-TCP proxy hardcoded at launch. 2-4 hrs of plumbing before the Go
binary can do its job. (Marlin is Nitro under the hood without this pain.)

**Phala / dstack** — Intel TDX, docker-compose, deterministic secp256k1 key derivation,
ERC-8004 registry on Sepolia. Fast to deploy but trust runs through Phala as
intermediary; weaker on-chain story than Oyster or the KMS pattern.

**Azure confidential VMs (TDX)** — no on-chain Solidity verifier for Azure quotes;
tooling is off-chain (Intel Trust Authority / TPM). Most friction, worst on-chain story.

---

## Open questions before committing

1. Confirm the KMS Option C path end-to-end with a smoke test (attested image -> KMS
   sign -> Solidity `ecrecover`) before building backtest logic. This is the 3am risk.
2. Decide who owns the Scorer (Go enclave) now that Alex has the AI Tester.
3. Does the score get on-chain directly from the scorer's KMS sig (Option C), or do we
   also route the settlement through Chainlink Automation at the sweep? (They compose:
   Chainlink triggers the sweep, the scorer signs, the contract verifies.)

## Sources

- [Confidential Space overview](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/confidential-space-overview)
- [Attestation token claims](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/token-claims)
- [Attestation assertions / IAM policy fields](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/attestation-assertions)
- [Create and grant access to confidential resources (WIP + KMS)](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/create-grant-access-confidential-resources)
- [Cloud KMS algorithms](https://docs.cloud.google.com/kms/docs/algorithms) · [KMS pricing](https://cloud.google.com/kms/pricing)
- [Confidential Space codelab](https://codelabs.developers.google.com/codelabs/confidential-space)
- [MPC + Confidential Space signing (Google blog)](https://cloud.google.com/blog/products/identity-security/how-to-secure-digital-assets-with-multi-party-computation-and-confidential-space)
- [salrashid123/confidential_space](https://github.com/salrashid123/confidential_space) · [courtyard-nft/go-kms-signer](https://github.com/courtyard-nft/go-kms-signer)
- AI Tester reference: [chainlink-confidential-ai-attester-demo](https://github.com/smartcontractkit/chainlink-confidential-ai-attester-demo)
