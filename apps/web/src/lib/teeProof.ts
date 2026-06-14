// teeProof.ts -- pure, browser-safe helpers for the x402 "summon a TEE" flow.
//
// Two jobs:
//   1. buildTransferWithAuthorizationTypedData(): produce the EIP-712 typed data
//      a buyer signs in MetaMask to authorize a USDC EIP-3009 transfer (the x402
//      payment), plus the authorization object you echo back in the payment payload.
//   2. verifyProofBundle(): independently re-derive the proof digest from the
//      bundle's own fields, ecrecover the signer AND pin it to the enclave's known
//      KMS identity (expectedSigner), and report whether the run is actually
//      TEE-proven (requires a REAL, externally-verified Google Confidential Space JWT).
//
// Everything here is client-verifiable: we never trust a server-asserted hash or
// signer. We recompute each value and compare, and we pin the recovered signer to
// the enclave's expected KMS address -- recovered == bundle.signer is self-consistency,
// NOT identity, so an attacker could sign their own digest; the expectedSigner pin
// closes that. The JWT RS256 signature is NOT verified here (it needs Google's JWKS):
// teeProven only goes true when the caller passes attestationVerified:true from a real
// external check (see notes on decodeAttestationClaims / verifyAttestationSignature).
// The bundle's self-asserted attestationNonceBound is NEVER trusted.
//
// Crypto via viem primitives only. No google-auth-library here (that is Node-only
// and lives in the route); this module must run in the browser.

import {
  keccak256,
  recoverAddress,
  getAddress,
  toHex,
  concatHex,
  type Hex,
} from "viem";

// --- Types -- mirror the verified proof bundle + x402 wire shapes EXACTLY ---

/** The {r,s,v} secp256k1 signature returned by the enclave KMS signer. */
export type ProofSignature = {
  r: Hex; // 0x..32 bytes
  s: Hex; // 0x..32 bytes (low-s)
  v: 27 | 28; // recovery id, EIP-155-free
};

/** The structured execution result inside the bundle (durationMs lives here, NOT in canonicalOutput). */
export type ProofResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
};

/** Exact keys returned by the enclave's proof.build_bundle. */
export type ProofBundle = {
  result: ProofResult;
  codeHash: Hex; // keccak256(utf8(code))
  inputHash: Hex; // keccak256(utf8(input))
  outputHash: Hex; // keccak256(utf8(canonicalOutput))
  canonicalOutput: string; // JSON of {stdout,stderr,exitCode,timedOut}, sorted keys, compact (",",":")
  nonce: string; // echoed buyer nonce (string form)
  nonceUint: string; // decimal string of nonce-as-uint256
  digest: Hex; // keccak256(codeHash ++ inputHash ++ outputHash ++ u256(nonceUint))
  signature: ProofSignature;
  signer: Hex; // ecrecover(digest, signature) MUST equal this (checksummed addr)
  attestation: string | null; // Google CS JWT (RS256) or null in dev
  attestationNonceBound: boolean; // true iff the JWT eat_nonce binds this request
  attestationNote: string | null; // loud reason when not fully bound / absent
};

/**
 * x402 PaymentRequirements (verified v2 shape). `network` is CAIP-2 "eip155:<id>";
 * `extra` carries the EIP-712 domain name+version for the USDC contract.
 */
export type PaymentRequirements = {
  scheme: "exact";
  network: string; // CAIP-2, e.g. "eip155:84532"
  asset: Hex; // USDC contract address (verifyingContract)
  amount: string; // atomic units (string)
  payTo: Hex; // recipient address
  maxTimeoutSeconds: number;
  extra: {
    name: string; // EIP-712 domain name, e.g. "USD Coin" (mainnet) / "USDC" (Base Sepolia)
    version: string; // EIP-712 domain version, e.g. "2"
  };
};

/** EIP-3009 TransferWithAuthorization authorization tuple echoed in the payment payload. */
export type Eip3009Authorization = {
  from: Hex; // buyer
  to: Hex; // payTo
  value: string; // amount (atomic units, string)
  validAfter: string; // unix seconds (string)
  validBefore: string; // unix seconds (string)
  nonce: Hex; // random 32-byte hex
};

/** The full EIP-712 typed-data object passed to eth_signTypedData_v4 / viem signTypedData. */
export type TransferWithAuthorizationTypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Hex;
  };
  types: {
    TransferWithAuthorization: { name: string; type: string }[];
  };
  primaryType: "TransferWithAuthorization";
  message: {
    from: Hex;
    to: Hex;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
};

// --- EIP-3009 typed-data builder ---

/** Parse a CAIP-2 "eip155:<id>" network string into a numeric chainId. Throws loudly on bad input. */
function chainIdFromNetwork(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) {
    throw new Error(
      `unsupported network "${network}": expected CAIP-2 form "eip155:<id>"`,
    );
  }
  return Number(m[1]);
}

/**
 * Generate a cryptographically-random 32-byte nonce as 0x-prefixed hex.
 * USDC EIP-3009 nonces are arbitrary bytes32 used for on-chain replay protection
 * (authorizationState), so randomness is the only requirement.
 */
function randomNonce32(): Hex {
  const bytes = new Uint8Array(32);
  // crypto.getRandomValues is present in browsers and modern Node global scope.
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Build the EIP-712 typed data the buyer signs in MetaMask for a USDC
 * `transferWithAuthorization` (EIP-3009), driven by an x402 PaymentRequirements.
 *
 * domain:
 *   name             <- req.extra.name      (EIP-712 domain name)
 *   version          <- req.extra.version   (EIP-712 domain version)
 *   chainId          <- parsed from req.network "eip155:<id>"
 *   verifyingContract<- req.asset           (the USDC contract)
 *
 * message (TransferWithAuthorization):
 *   from        = buyer
 *   to          = req.payTo
 *   value       = req.amount
 *   validAfter  = now - 60s  (clock-skew slack so it is valid immediately)
 *   validBefore = now + validForSeconds (default: req.maxTimeoutSeconds, min 60s)
 *   nonce       = opts.nonce when provided (the server-challenged 402 nonce that
 *                 BINDS the payment to the proof), else a fresh random 32 bytes
 *
 * NONCE BINDING: pass opts.nonce = the nonce from the route's 402 quote so
 * authorization.nonce === the challenged value. The route reads the proof nonce
 * out of authorization.nonce (it does NOT read a body nonce field), so the panel
 * MUST commit to the challenged nonce here or the purchase->proof binding is lost.
 *
 * Returns BOTH the typed data (to sign) and the authorization (to echo back in
 * the x402 payment payload alongside the signature).
 */
export function buildTransferWithAuthorizationTypedData(
  req: PaymentRequirements,
  from: Hex,
  opts?: { validForSeconds?: number; nonce?: Hex },
): {
  typedData: TransferWithAuthorizationTypedData;
  authorization: Eip3009Authorization;
} {
  const chainId = chainIdFromNetwork(req.network);

  const nowSec = Math.floor(Date.now() / 1000);
  // 60s back-date absorbs buyer/relayer/chain clock skew so the auth is live now.
  const validAfter = nowSec - 60;
  const window = opts?.validForSeconds ?? Math.max(req.maxTimeoutSeconds, 60);
  const validBefore = nowSec + window;

  // Use the server-challenged nonce when provided (binds payment to the proof);
  // otherwise generate a fresh random bytes32. Validate the override shape loudly
  // so a malformed nonce fails here, not silently on-chain or at the enclave.
  let nonce: Hex;
  if (opts?.nonce != null) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(opts.nonce)) {
      throw new Error(
        `opts.nonce must be a 0x-prefixed 32-byte hex string, got "${opts.nonce}"`,
      );
    }
    nonce = opts.nonce;
  } else {
    nonce = randomNonce32();
  }

  const authorization: Eip3009Authorization = {
    from: getAddress(from), // checksum the buyer address
    to: getAddress(req.payTo),
    value: req.amount,
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce,
  };

  const typedData: TransferWithAuthorizationTypedData = {
    domain: {
      name: req.extra.name,
      version: req.extra.version,
      chainId,
      verifyingContract: getAddress(req.asset),
    },
    // Field order MUST match the EIP-3009 TransferWithAuthorization struct on USDC.
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
  };

  return { typedData, authorization };
}

// --- Proof bundle verification (the load-bearing part) ---

/** Encode a decimal-string uint256 as a 32-byte big-endian hex word (matches the enclave). */
function u256ToHex32(decimal: string): Hex {
  // BigInt parses the decimal string; toString(16) is big-endian; left-pad to 64 nibbles.
  const big = BigInt(decimal);
  if (big < 0n) throw new Error(`nonceUint must be non-negative, got "${decimal}"`);
  const hex = big.toString(16).padStart(64, "0");
  if (hex.length > 64) {
    throw new Error(`nonceUint "${decimal}" exceeds uint256`);
  }
  return `0x${hex}`;
}

/** keccak256 over the utf8 bytes of a string (matches Python keccak256(utf8(...)) in the enclave). */
function keccakUtf8(s: string): Hex {
  return keccak256(new TextEncoder().encode(s));
}

export type AttestationStatus =
  | "absent" // attestation is null -> dev/unbacked run, NOT TEE-proven
  | "present-unverified" // JWT present but its RS256/iss/exp/eat_nonce/image_digest were NOT verified here
  | "verified-bound"; // JWT externally RS256-verified AND nonce/image bound -> TEE-proven

export type VerifyProofResult = {
  ok: boolean; // true iff ALL signature-chain checks pass (digest + outputHash + signer IDENTITY)
  digestOk: boolean; // recomputed digest == bundle.digest
  outputHashOk: boolean; // recomputed outputHash == bundle.outputHash
  signatureOk: boolean; // ecrecover(digest, sig) == bundle.signer == expectedSigner (enclave KMS identity)
  recoveredSigner: Hex | null; // checksummed recovered address, or null if recovery threw
  teeProven: boolean; // ok AND attestationStatus === "verified-bound" (real JWT verification required)
  attestationStatus: AttestationStatus;
  failures: string[]; // human-readable list of WHICH checks failed (empty when ok)
};

/**
 * Options for verifyProofBundle. `expectedSigner` is REQUIRED: it is the enclave's
 * KMS identity (the `score-signer` address). Without pinning it, a forged bundle that
 * is internally self-consistent (recovered == bundle.signer, both attacker-chosen)
 * would pass -- self-consistency is NOT identity. Pin it from a build-time constant
 * (e.g. NEXT_PUBLIC_TEE_SIGNER).
 *
 * `attestationVerified` is the RESULT of a real external JWT verification (RS256 vs
 * Google CS JWKS + iss/exp/eat_nonce-contains-nonce/image_digest), e.g. from a
 * server /api route. It is the ONLY thing that can flip teeProven true. It defaults
 * to false: the bundle's self-asserted attestationNonceBound is NEVER trusted.
 */
export type VerifyProofOptions = {
  expectedSigner: Hex; // enclave KMS signer address to pin against (required)
  attestationVerified?: boolean; // true ONLY if the JWT was externally RS256-verified + bound
};

/**
 * Verify a proof bundle WITHOUT trusting the server.
 *
 * Steps (exactly per the enclave contract's CLIENT PROOF VERIFICATION):
 *   1. recompute outputHash = keccak256(utf8(canonicalOutput)); assert == bundle.outputHash.
 *   2. recompute digest = keccak256(codeHash ++ inputHash ++ outputHash ++ u256(nonceUint));
 *      assert == bundle.digest.  (4 static 32-byte words; abi.encode == plain concat.)
 *   3. ecrecover(digest, {r,s,v}) == bundle.signer AND == opts.expectedSigner (the
 *      enclave KMS identity). Self-consistency (recovered == bundle.signer) is NOT
 *      enough: an attacker can sign their OWN digest with their OWN key and set
 *      bundle.signer to themselves. We pin against the known enclave signer.
 *   4. report attestation status. teeProven requires opts.attestationVerified === true
 *      (a REAL external RS256/JWKS verification), NEVER the bundle's self-asserted
 *      attestationNonceBound boolean.
 *
 * NEVER throws on a bad proof: returns { ok:false, failures:[...] } so the UI can
 * show exactly which check failed. Honesty rule: even when the signature chain passes
 * (ok:true), teeProven is FALSE unless the JWT was independently verified -- a signed
 * digest plus an unchecked JWT string does not prove a real TEE.
 *
 * IMPORTANT: we deliberately recompute outputHash and digest from the bundle's OWN
 * canonicalOutput / hash fields. We do NOT recompute codeHash/inputHash here because
 * we do not have the original code/input strings in the bundle; the caller who holds
 * the code/input it submitted should additionally assert
 *   keccak256(utf8(code)) === bundle.codeHash  and  keccak256(utf8(input)) === bundle.inputHash
 * to bind the proof to THEIR submission. (See bindSubmission() helper below.)
 */
export async function verifyProofBundle(
  bundle: ProofBundle,
  opts: VerifyProofOptions,
): Promise<VerifyProofResult> {
  const failures: string[] = [];

  // Normalize the pinned enclave signer once; a malformed expectedSigner is a config
  // error and must fail loudly (no silent pass).
  let expectedSigner: Hex | null = null;
  try {
    expectedSigner = getAddress(opts.expectedSigner);
  } catch (e) {
    failures.push(
      `expectedSigner is not a valid address: ${errMsg(e)} -- cannot verify signer identity`,
    );
  }

  // --- Step 1: outputHash binds the canonical output text to the hash word. ---
  let outputHashOk = false;
  try {
    const recomputedOutputHash = keccakUtf8(bundle.canonicalOutput);
    outputHashOk =
      recomputedOutputHash.toLowerCase() === bundle.outputHash.toLowerCase();
    if (!outputHashOk) {
      failures.push(
        `outputHash mismatch: recomputed ${recomputedOutputHash} != bundle ${bundle.outputHash}`,
      );
    }
  } catch (e) {
    failures.push(`outputHash recompute failed: ${errMsg(e)}`);
  }

  // --- Step 2: digest binds {code,input,output,nonce} together. ---
  // The enclave concatenates four raw 32-byte words then keccak256. We mirror that:
  // concatHex of [codeHash, inputHash, outputHash, u256(nonceUint)] -> keccak256.
  // We use bundle.outputHash (already verified in step 1) so a tampered output is
  // caught in step 1; using the bundle field keeps digest math identical to the enclave.
  let digestOk = false;
  let digest: Hex | null = null;
  try {
    const nonceWord = u256ToHex32(bundle.nonceUint);
    digest = keccak256(
      concatHex([
        bundle.codeHash,
        bundle.inputHash,
        bundle.outputHash,
        nonceWord,
      ]),
    );
    digestOk = digest.toLowerCase() === bundle.digest.toLowerCase();
    if (!digestOk) {
      failures.push(
        `digest mismatch: recomputed ${digest} != bundle ${bundle.digest}`,
      );
    }
  } catch (e) {
    failures.push(`digest recompute failed: ${errMsg(e)}`);
  }

  // --- Step 3: ecrecover the signer from the (recomputed) digest + signature. ---
  // viem recoverAddress wants a serialized signature: r ++ s ++ yParity. We build
  // it from {r,s,v}; yParity = v - 27 (the enclave emits v in {27,28}).
  let signatureOk = false;
  let recoveredSigner: Hex | null = null;
  try {
    // Recover against the digest we recomputed (digestOk), falling back to the
    // bundle.digest only if our recompute threw -- but if our recompute threw we
    // already recorded a failure, so prefer the verified value when present.
    const hashToRecover = digest ?? bundle.digest;
    const yParity = bundle.signature.v - 27;
    if (yParity !== 0 && yParity !== 1) {
      throw new Error(
        `signature.v must be 27 or 28, got ${bundle.signature.v}`,
      );
    }
    const serialized = concatHex([
      bundle.signature.r,
      bundle.signature.s,
      yParity === 0 ? "0x1b" : "0x1c", // 27 / 28 trailing byte
    ]);
    recoveredSigner = await recoverAddress({
      hash: hashToRecover,
      signature: serialized,
    });
    // IDENTITY check, not just self-consistency: the recovered address AND the
    // bundle's asserted signer must BOTH equal the pinned enclave KMS signer. This
    // is what stops a forged bundle signed with the attacker's own key (where
    // recovered == bundle.signer == attacker) from passing.
    const recovered = getAddress(recoveredSigner);
    const asserted = getAddress(bundle.signer);
    const selfConsistent = recovered.toLowerCase() === asserted.toLowerCase();
    const matchesExpected =
      expectedSigner != null &&
      recovered.toLowerCase() === expectedSigner.toLowerCase() &&
      asserted.toLowerCase() === expectedSigner.toLowerCase();
    signatureOk = selfConsistent && matchesExpected;
    if (!selfConsistent) {
      failures.push(
        `signer mismatch: recovered ${recovered} != bundle ${asserted}`,
      );
    }
    if (selfConsistent && !matchesExpected && expectedSigner != null) {
      failures.push(
        `signer is not the expected enclave identity: ${recovered} != expected ${expectedSigner}`,
      );
    }
  } catch (e) {
    failures.push(`signature recovery failed: ${errMsg(e)}`);
  }

  // --- Step 4: attestation status. Signature checks alone do NOT prove a TEE, AND
  // the bundle's own attestationNonceBound boolean is attacker-controlled, so it is
  // NEVER used to claim "proven". Only opts.attestationVerified -- the result of a
  // REAL external RS256/JWKS + iss/exp/eat_nonce/image_digest verification -- counts. ---
  let attestationStatus: AttestationStatus;
  if (bundle.attestation == null) {
    attestationStatus = "absent";
  } else if (opts.attestationVerified === true) {
    attestationStatus = "verified-bound";
  } else {
    // JWT bytes are present but NOT verified here. The bundle may self-assert
    // attestationNonceBound, but that is untrusted -- treat as unverified.
    attestationStatus = "present-unverified";
  }
  if (attestationStatus !== "verified-bound" && bundle.attestationNote) {
    // Surface the enclave's own loud reason so the UI can display it.
    failures.push(`attestation not verified: ${bundle.attestationNote}`);
  }

  const ok = outputHashOk && digestOk && signatureOk;
  // teeProven requires the full signature chain (incl. signer IDENTITY) AND a JWT
  // that was independently RS256-verified + nonce/image bound (opts.attestationVerified).
  // We do NOT trust bundle.attestationNonceBound; verifying the JWT is the caller's
  // job via verifyAttestationSignature (server-side / JWKS fetch). Until that runs,
  // teeProven is false even with a JWT string present.
  const teeProven = ok && attestationStatus === "verified-bound";

  return {
    ok,
    digestOk,
    outputHashOk,
    signatureOk,
    recoveredSigner: recoveredSigner ? getAddress(recoveredSigner) : null,
    teeProven,
    attestationStatus,
    failures,
  };
}

/**
 * Bind a proof bundle to the EXACT code/input the buyer submitted. verifyProofBundle
 * proves the bundle is internally consistent and TEE-signed, but a malicious server
 * could sign a proof for DIFFERENT code. Call this with the strings you POSTed to
 * assert the proof is about YOUR run. Returns which (if any) hashes mismatched.
 */
export function bindSubmission(
  bundle: ProofBundle,
  code: string,
  input: string,
): { codeHashOk: boolean; inputHashOk: boolean; failures: string[] } {
  const failures: string[] = [];
  const codeHashOk =
    keccakUtf8(code).toLowerCase() === bundle.codeHash.toLowerCase();
  if (!codeHashOk) failures.push("codeHash does not match submitted code");
  const inputHashOk =
    keccakUtf8(input).toLowerCase() === bundle.inputHash.toLowerCase();
  if (!inputHashOk) failures.push("inputHash does not match submitted input");
  return { codeHashOk, inputHashOk, failures };
}

// --- Attestation (Google Confidential Space JWT) helpers ---

/** Decoded, UNVERIFIED view of a Confidential Space attestation JWT. */
export type AttestationClaims = {
  header: Record<string, unknown>; // JWT header (alg should be RS256, has kid)
  payload: Record<string, unknown>; // JWT claims
  eatNonce: string[] | null; // eat_nonce claim normalized to a string array
  imageDigest: string | null; // image_digest / submods.container.image_digest if present
  issuer: string | null; // iss (expect https://confidentialcomputing.googleapis.com)
};

/** base64url -> utf8 string, browser-safe (atob + percent-decode for UTF-8). */
function b64urlDecode(seg: string): string {
  // Restore standard base64 alphabet + padding.
  let b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  else if (pad === 1) throw new Error("invalid base64url segment");
  const binary = atob(b64);
  // Reinterpret latin1 bytes as UTF-8.
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Decode a Confidential Space JWT's header + payload for DISPLAY ONLY.
 *
 * !!! This performs NO signature verification. !!! It base64url-decodes the first
 * two JWT segments so the UI can surface eat_nonce + image_digest + issuer. A
 * decoded-but-unverified JWT proves NOTHING -- anyone can forge these claims.
 * Treat the output as untrusted until verifyAttestationSignature passes.
 *
 * Returns null if the string is not a well-formed three-segment JWT.
 */
export function decodeAttestationClaims(jwt: string): AttestationClaims | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(parts[0]));
    payload = JSON.parse(b64urlDecode(parts[1]));
  } catch {
    return null;
  }

  // Normalize eat_nonce: the EAT spec allows a single string OR an array of strings.
  let eatNonce: string[] | null = null;
  const rawNonce = (payload as Record<string, unknown>)["eat_nonce"];
  if (typeof rawNonce === "string") eatNonce = [rawNonce];
  else if (Array.isArray(rawNonce))
    eatNonce = rawNonce.filter((x): x is string => typeof x === "string");

  // image_digest can appear at top level or under submods.container.image_digest
  // depending on Confidential Space token version. Check both for display.
  let imageDigest: string | null = null;
  const topDigest = (payload as Record<string, unknown>)["image_digest"];
  if (typeof topDigest === "string") imageDigest = topDigest;
  else {
    const submods = (payload as Record<string, unknown>)["submods"];
    if (submods && typeof submods === "object") {
      const container = (submods as Record<string, unknown>)["container"];
      if (container && typeof container === "object") {
        const cd = (container as Record<string, unknown>)["image_digest"];
        if (typeof cd === "string") imageDigest = cd;
      }
    }
  }

  const iss = (payload as Record<string, unknown>)["iss"];
  const issuer = typeof iss === "string" ? iss : null;

  return { header, payload, eatNonce, imageDigest, issuer };
}

/** Result of a full attestation verification (signature + claim binding). */
export type AttestationVerification = {
  signatureValid: boolean; // RS256 verified against Google CS JWKS
  nonceBound: boolean; // eat_nonce contains expectedNonce
  imageDigestMatches: boolean; // image_digest === expectedImageDigest (if provided)
  issuerOk: boolean; // iss === Confidential Space issuer
  failures: string[];
};

/**
 * The Google Confidential Space attestation issuer + how to find its JWKS.
 * Discovery doc: https://confidentialcomputing.googleapis.com/.well-known/openid-configuration
 *   -> its "jwks_uri" field gives the signing-key set used to verify RS256.
 */
export const CONFIDENTIAL_SPACE_ISSUER =
  "https://confidentialcomputing.googleapis.com";
export const CONFIDENTIAL_SPACE_OIDC_CONFIG =
  "https://confidentialcomputing.googleapis.com/.well-known/openid-configuration";

/**
 * STUB: full RS256-vs-Google-JWKS verification of the attestation JWT.
 *
 * This is intentionally NOT implemented client-side as a crypto check. Verifying
 * the token's signature requires:
 *   1. Fetch the OIDC discovery doc (CONFIDENTIAL_SPACE_OIDC_CONFIG) -> read jwks_uri.
 *   2. Fetch that JWKS, pick the JWK whose `kid` matches the JWT header `kid`.
 *   3. Verify the RS256 signature over `${header}.${payload}` with that public key.
 *   4. Assert iss === CONFIDENTIAL_SPACE_ISSUER, exp not passed, eat_nonce contains
 *      the buyer nonce, and image_digest === the expected enclave image digest.
 *
 * Where to do it: do this SERVER-SIDE in the summon route (runtime "nodejs") using
 * google-auth-library's OAuth2Client.verifyIdToken / a JWKS client -- that package
 * is Node-only and already slated for next.config.ts serverExternalPackages. The
 * browser can call a thin /api route that performs this and returns a boolean, or
 * (heavier) bundle a WebCrypto RS256 + JWKS fetch here. Until that exists, treat the
 * attestation as DISPLAY-ONLY via decodeAttestationClaims and NEVER trust the bundle's
 * self-asserted attestationNonceBound. Once this is implemented, pass its
 * (signatureValid && nonceBound && imageDigestMatches && issuerOk) result to
 * verifyProofBundle as opts.attestationVerified -- that is the ONLY input that flips
 * teeProven true.
 *
 * Throwing (not silently returning false) keeps the unimplemented gate loud per the
 * honest-failure rule: a caller that wires this in must replace the stub, not get a
 * quiet `signatureValid:false` that looks like a normal verification failure.
 */
export async function verifyAttestationSignature(
  _jwt: string,
  _opts: { expectedNonce: string; expectedImageDigest?: string },
): Promise<AttestationVerification> {
  throw new Error(
    "verifyAttestationSignature is not implemented client-side. Verify the Confidential " +
      `Space JWT server-side (runtime nodejs) against ${CONFIDENTIAL_SPACE_OIDC_CONFIG} ` +
      "(read jwks_uri, match kid, RS256-verify, assert iss/exp/eat_nonce/image_digest), " +
      "e.g. with google-auth-library, then expose the boolean via an /api route. " +
      "decodeAttestationClaims() is DISPLAY-ONLY and does not check the signature.",
  );
}

// --- internal ---

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
