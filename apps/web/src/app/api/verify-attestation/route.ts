// ===========================================================================
// POST /api/verify-attestation -- the 4th proof leg.
//
// The Summon-a-TEE bundle pairs a KMS signature (proves "the enclave's signer
// signed this digest") with a Google Confidential Space attestation JWT (proves
// "this digest came out of THAT enclave image, bound to THIS purchase nonce").
// The browser verifies the signature leg itself (ecrecover, pinned signer). It
// CANNOT cheaply verify the JWT's RS256 signature against Google's JWKS, so it
// POSTs the JWT here. This route does the real cryptographic check and the claim
// assertions, and returns a structured verdict. Only a TRUE verdict here lets the
// client mark a run `teeProven`.
//
// What is verified (all must hold for verified:true):
//   1. RS256 signature over `${header}.${payload}` against the JWK (matched by
//      `kid`) from Google's Confidential Space JWKS (discovered via the OIDC config).
//   2. iss === https://confidentialcomputing.googleapis.com
//   3. exp in the future, nbf/iat not in the future (small skew slack).
//   4. eat_nonce contains the buyer's per-purchase nonce (binds to THIS summon).
//   5. image_digest === the expected enclave image (pinned via env) -- proves it
//      was OUR hardened runner image, not some other CS workload. Checked at the
//      top level and at submods.container.image_digest (CS token-version variance).
//   6. aud === the expected attestation audience (if pinned via env).
//
// Honest-failure: every check that fails is named in `failures[]`; the route never
// returns verified:true on a swallowed error. A malformed request -> 400; an
// unreachable JWKS / unexpected server error -> 500 (loud, not a quiet false).
//
// No new dependency: RS256 is verified with the WebCrypto `crypto.subtle` global
// (present in the Next.js "nodejs" runtime). The RSA public key is imported
// straight from the JWK (n/e).
// ===========================================================================

import { NextResponse } from "next/server";
import {
  CONFIDENTIAL_SPACE_ISSUER,
  CONFIDENTIAL_SPACE_OIDC_CONFIG,
  type AttestationVerification,
} from "@/lib/teeProof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The enclave image this service expects the attestation to attest. Pin it to the
// digest of the hardened runner image (sha256:...). If unset, image_digest is NOT
// checked and the verdict carries a loud note -- a deploy MUST set this for a real
// TEE-proven claim, since without it any CS workload's token would pass leg 5.
const EXPECTED_IMAGE_DIGEST = process.env.ENCLAVE_IMAGE_DIGEST ?? "";
// The audience the enclave mints the attestation token for (enclave ATTEST_AUDIENCE,
// default "honeycomb-tee-runner"). If unset here, `aud` is not asserted.
const EXPECTED_AUDIENCE = process.env.ENCLAVE_ATTEST_AUDIENCE ?? "";
// Clock-skew slack for exp/nbf/iat, seconds.
const SKEW_SECONDS = 60;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Jwk = {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
};

// --- base64url helpers (Node) ---------------------------------------------
function b64urlToBuffer(seg: string): Buffer {
  // Buffer's base64 decoder tolerates the url-safe alphabet on modern Node, but
  // normalize explicitly so the behavior is obvious and padding-safe.
  let b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  else if (pad === 1) throw new HttpError(400, "malformed base64url JWT segment");
  return Buffer.from(b64, "base64");
}

function b64urlToJson(seg: string): Record<string, unknown> {
  const text = b64urlToBuffer(seg).toString("utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

// --- JWKS discovery + fetch -----------------------------------------------
// Discover the jwks_uri from the OIDC config, then fetch the key set. We do not
// cache across requests (force-dynamic; low volume for a demo); a production
// build would honor Cache-Control max-age. Any non-200 here is a 500, not a
// silent false -- an unreachable Google endpoint is an operational failure the
// caller must see, not an "attestation invalid" verdict.
async function fetchJwks(): Promise<Jwk[]> {
  const cfgRes = await fetch(CONFIDENTIAL_SPACE_OIDC_CONFIG, {
    headers: { accept: "application/json" },
  });
  if (!cfgRes.ok) {
    throw new HttpError(
      500,
      `OIDC discovery fetch failed: ${cfgRes.status} ${CONFIDENTIAL_SPACE_OIDC_CONFIG}`,
    );
  }
  const cfg = (await cfgRes.json()) as { jwks_uri?: unknown; issuer?: unknown };
  // Defense in depth: the discovery doc's issuer must be the CS issuer we pin.
  if (typeof cfg.issuer === "string" && cfg.issuer !== CONFIDENTIAL_SPACE_ISSUER) {
    throw new HttpError(
      500,
      `OIDC discovery issuer mismatch: got ${cfg.issuer}, expected ${CONFIDENTIAL_SPACE_ISSUER}`,
    );
  }
  if (typeof cfg.jwks_uri !== "string") {
    throw new HttpError(500, "OIDC discovery doc missing jwks_uri");
  }
  const jwksRes = await fetch(cfg.jwks_uri, {
    headers: { accept: "application/json" },
  });
  if (!jwksRes.ok) {
    throw new HttpError(500, `JWKS fetch failed: ${jwksRes.status} ${cfg.jwks_uri}`);
  }
  const jwks = (await jwksRes.json()) as { keys?: unknown };
  if (!Array.isArray(jwks.keys)) {
    throw new HttpError(500, "JWKS response missing keys[]");
  }
  return jwks.keys as Jwk[];
}

// --- RS256 verify over the signed segment ----------------------------------
async function rs256Verify(
  signingInput: string,
  signature: Buffer,
  jwk: Jwk,
): Promise<boolean> {
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) {
    throw new HttpError(500, "matched JWK is not a usable RSA key (kty/n/e)");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // WebCrypto wants BufferSource backed by a plain ArrayBuffer. Node's Buffer is
  // typed as ArrayBufferLike (could be SharedArrayBuffer), so copy into a fresh
  // Uint8Array<ArrayBuffer> for both the signature and the signed input.
  const sigBytes = Uint8Array.from(signature);
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sigBytes,
    new TextEncoder().encode(signingInput),
  );
}

// Normalize eat_nonce (EAT allows a single string OR a string array).
function readEatNonce(payload: Record<string, unknown>): string[] {
  const raw = payload["eat_nonce"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  return [];
}

// image_digest at top level OR submods.container.image_digest.
function readImageDigest(payload: Record<string, unknown>): string | null {
  const top = payload["image_digest"];
  if (typeof top === "string") return top;
  const submods = payload["submods"];
  if (submods && typeof submods === "object") {
    const container = (submods as Record<string, unknown>)["container"];
    if (container && typeof container === "object") {
      const cd = (container as Record<string, unknown>)["image_digest"];
      if (typeof cd === "string") return cd;
    }
  }
  return null;
}

// aud may be a string or array per JWT spec.
function audMatches(payload: Record<string, unknown>, expected: string): boolean {
  const aud = payload["aud"];
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.some((a) => a === expected);
  return false;
}

type VerifyBody = {
  jwt?: unknown;
  nonce?: unknown; // the buyer's per-purchase nonce (bundle.nonce)
};

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => null)) as VerifyBody | null;
    if (!body || typeof body.jwt !== "string" || body.jwt.length === 0) {
      throw new HttpError(400, "body.jwt (the attestation JWT string) is required");
    }
    if (typeof body.nonce !== "string" || body.nonce.length === 0) {
      throw new HttpError(
        400,
        "body.nonce (the buyer per-purchase nonce, = bundle.nonce) is required to check eat_nonce binding",
      );
    }
    const jwt = body.jwt;
    const expectedNonce = body.nonce;

    const parts = jwt.split(".");
    if (parts.length !== 3) {
      throw new HttpError(400, "attestation is not a well-formed three-segment JWT");
    }
    const header = b64urlToJson(parts[0]);
    const payload = b64urlToJson(parts[1]);
    const signature = b64urlToBuffer(parts[2]);

    const failures: string[] = [];

    // alg must be RS256 (do not let a token downgrade the algorithm).
    if (header["alg"] !== "RS256") {
      failures.push(`unexpected JWT alg ${String(header["alg"])}, expected RS256`);
    }
    const kid = typeof header["kid"] === "string" ? (header["kid"] as string) : null;
    if (!kid) failures.push("JWT header missing kid");

    // --- leg 1: RS256 signature against Google CS JWKS ---
    let signatureValid = false;
    if (kid && header["alg"] === "RS256") {
      const keys = await fetchJwks();
      const jwk = keys.find((k) => k.kid === kid);
      if (!jwk) {
        failures.push(`no JWKS key matched kid ${kid}`);
      } else {
        signatureValid = await rs256Verify(`${parts[0]}.${parts[1]}`, signature, jwk);
        if (!signatureValid) failures.push("RS256 signature did not verify against the CS JWKS key");
      }
    }

    // --- leg 2: issuer ---
    const issuer = typeof payload["iss"] === "string" ? (payload["iss"] as string) : null;
    const issuerOk = issuer === CONFIDENTIAL_SPACE_ISSUER;
    if (!issuerOk) {
      failures.push(`iss ${String(issuer)} != ${CONFIDENTIAL_SPACE_ISSUER}`);
    }

    // --- leg 3: temporal validity ---
    const now = Math.floor(Date.now() / 1000);
    const exp = typeof payload["exp"] === "number" ? (payload["exp"] as number) : null;
    const nbf = typeof payload["nbf"] === "number" ? (payload["nbf"] as number) : null;
    const iat = typeof payload["iat"] === "number" ? (payload["iat"] as number) : null;
    let temporalOk = true;
    if (exp === null) {
      temporalOk = false;
      failures.push("JWT missing exp");
    } else if (now > exp + SKEW_SECONDS) {
      temporalOk = false;
      failures.push(`JWT expired (exp ${exp} < now ${now})`);
    }
    if (nbf !== null && now + SKEW_SECONDS < nbf) {
      temporalOk = false;
      failures.push(`JWT not yet valid (nbf ${nbf} > now ${now})`);
    }
    if (iat !== null && now + SKEW_SECONDS < iat) {
      temporalOk = false;
      failures.push(`JWT iat in the future (iat ${iat} > now ${now})`);
    }

    // --- leg 4: eat_nonce binds this purchase ---
    const eatNonce = readEatNonce(payload);
    const nonceBound = eatNonce.includes(expectedNonce);
    if (!nonceBound) {
      failures.push(
        `eat_nonce ${JSON.stringify(eatNonce)} does not contain the buyer nonce ${expectedNonce}`,
      );
    }

    // --- leg 5: image digest pins OUR enclave image ---
    const imageDigest = readImageDigest(payload);
    let imageDigestMatches = false;
    if (!EXPECTED_IMAGE_DIGEST) {
      // Not pinned: cannot claim image binding. This is a loud config gap, not a pass.
      failures.push(
        "ENCLAVE_IMAGE_DIGEST is not set on the verifier: cannot bind the attestation to the expected enclave image (leg 5 unverifiable)",
      );
    } else if (imageDigest === null) {
      failures.push("attestation has no image_digest claim to match");
    } else {
      imageDigestMatches = imageDigest === EXPECTED_IMAGE_DIGEST;
      if (!imageDigestMatches) {
        failures.push(
          `image_digest ${imageDigest} != expected ${EXPECTED_IMAGE_DIGEST}`,
        );
      }
    }

    // --- leg 6: audience (optional pin) ---
    let audienceOk = true;
    if (EXPECTED_AUDIENCE) {
      audienceOk = audMatches(payload, EXPECTED_AUDIENCE);
      if (!audienceOk) {
        failures.push(`aud does not contain expected audience ${EXPECTED_AUDIENCE}`);
      }
    }

    // verified is the AND of every load-bearing leg. image binding is required:
    // without it, a real-but-different CS workload's token could otherwise pass.
    const verified =
      signatureValid &&
      issuerOk &&
      temporalOk &&
      nonceBound &&
      imageDigestMatches &&
      audienceOk;

    // Shape the signature-leg subset to the lib's AttestationVerification type so a
    // caller can reuse it directly; `verified` is the overall gate the client passes
    // to verifyProofBundle as opts.attestationVerified.
    const attestation: AttestationVerification = {
      signatureValid,
      nonceBound,
      imageDigestMatches,
      issuerOk,
      failures,
    };

    return NextResponse.json({
      verified,
      attestation,
      claims: {
        issuer,
        eatNonce,
        imageDigest,
        exp,
        audChecked: Boolean(EXPECTED_AUDIENCE),
        imagePinned: Boolean(EXPECTED_IMAGE_DIGEST),
      },
      failures,
    });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    const message = e instanceof Error ? e.message : String(e);
    // Unexpected = operational failure (e.g. JWKS unreachable). Surface loudly as 500;
    // never collapse to a verified:false that masks an infra problem as a bad token.
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
