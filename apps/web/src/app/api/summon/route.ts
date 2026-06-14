// ============================================================================
// POST /api/summon -- the x402 "summon a TEE" route handler.
//
// THE 402 ROUND-TRIP (two HTTP calls from the browser, ONE server-challenged
// nonce binds the payment and the proof):
//
//   (1) UNPAID POST  { code, input? }  ->  HTTP 402
//         The route mints a fresh random bytes32 `nonce` AND an HMAC tag
//         `nonceSig = HMAC-SHA256(SUMMON_NONCE_HMAC_SECRET, nonce)`, returning a
//         standard x402 challenge: { x402Version:2, accepts:[PaymentRequirements],
//         nonce, nonceSig }. The buyer's wallet signs an EIP-3009 USDC
//         transferWithAuthorization whose `authorization.nonce` MUST equal this
//         `nonce`. The HMAC makes the challenge self-authenticating so the paid
//         leg can verify the route issued it WITHOUT any server-side nonce store
//         (stateless).
//
//   (2) PAID re-POST { code, input?, nonce, nonceSig } + X-PAYMENT header -> 200
//         The route decodes the X402 PaymentPayload, then:
//           a. ENFORCE THE CHALLENGE: recompute HMAC(secret, nonce) and assert it
//              equals the echoed nonceSig (constant-time) -> proves the route
//              issued this nonce. Then assert authorization.nonce === nonce ->
//              proves the buyer committed the challenged nonce into the payment
//              signature. Mismatch on either -> 402 (do NOT verify/settle/run).
//           b. POST facilitator /verify  -> if !isValid, 402 (do NOT run).
//           c. POST facilitator /settle  -> if !success, 502 (do NOT run).
//              On success it captures the real on-chain tx hash.
//           d. POST enclave /run { code, input, nonce } where `nonce` is the
//              challenged value (== authorization.nonce, see binding note).
//           e. return { result, proof:<bundle>, x402Receipt }.
//
// NONCE BINDING (one server-challenged nonce ties the 402, the payment, and the
// proof together):
//   The challenge nonce is minted in step (1) and HMAC-bound to the server. The
//   buyer must place it in the EIP-3009 `authorization.nonce` (also the USDC
//   on-chain replay-protection field), so the SAME value is:
//     - signed by the buyer in the payment authorization (the wallet commits to it),
//     - re-derived as the enclave proof nonce on the paid leg, AND
//     - bound into the proof bundle's eat_nonce + digest.
//   The paid leg REJECTS (402) unless (a) the echoed nonceSig is a valid HMAC over
//   the echoed nonce (the route really issued it) and (b) authorization.nonce ===
//   that nonce. There is no server-side nonce store: the HMAC carries the issuance
//   proof statelessly. Net: the challenged 402 nonce IS the nonce sent to the
//   enclave /run, enforced, not two independent randoms.
//   Why this is correct: a different code/input/nonce changes the proof digest
//   (step 2/3 of client verification), a replayed payment fails on-chain, and a
//   forged/mismatched challenge nonce fails the HMAC or the equality check above.
//   We surface the settlement tx in x402Receipt so the buyer can audit it.
//
// HONEST FAILURE: we NEVER return a 200 with an unprovable or unpaid result.
//   - !isValid    -> 402 (payment invalid, code not run)
//   - !settle     -> 502 (payment failed, code not run)
//   - enclave !2xx-> surface enclave status + error (run failed / unprovable)
//   No secrets ever appear in responses or logs (we log only non-secret context).
//
// PACKAGE.JSON DEPS THIS ROUTE NEEDS (the mount+deps agent adds them; do NOT
// run install here):
//   - google-auth-library  (Node-only; lazily imported ONLY when
//     ENCLAVE_ID_TOKEN_AUDIENCE is set, to mint a Google identity token for the
//     Confidential Space enclave). Also add to next.config.ts
//     serverExternalPackages since it pulls Node built-ins.
//   - viem is NOT required by this route (we do no on-chain decoding here; the
//     browser SummonPanel + teeProof.ts own all viem usage). If a future change
//     needs to validate the nonce hex shape with viem, add viem too.
//
// Route convention matches apps/web/src/app/api/health/route.ts exactly.
// ============================================================================

import { NextResponse } from "next/server";
import type {
  PaymentRequirements,
  Eip3009Authorization,
} from "@/lib/teeProof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-network config. Testnet vs mainnet is ONE env flip (SUMMON_NETWORK).
// USDC address + EIP-712 domain (name/version) differ per chain, so we key them
// here. amount + payTo come from env so price/recipient are not hard-coded.

type NetworkConfig = {
  /** USDC (or settlement token) contract address -- the EIP-712 verifyingContract. */
  asset: string;
  /** EIP-712 domain name for that token's transferWithAuthorization. */
  domainName: string;
  /** EIP-712 domain version. */
  domainVersion: string;
};

// Verified addresses/domains from the env brief:
//   Base Sepolia USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e, domain name "USDC".
//   ETH mainnet  USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, domain name "USD Coin".
// Both USDC deployments use EIP-712 domain version "2".
const NETWORK_CONFIG: Record<string, NetworkConfig> = {
  "eip155:84532": {
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    domainName: "USDC",
    domainVersion: "2",
  },
  "eip155:1": {
    asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    domainName: "USD Coin",
    domainVersion: "2",
  },
};

const X402_VERSION = 2;

// env (all with safe testnet-first defaults; only SUMMON_PAY_TO is required).

/** Read config from env, throwing loudly on anything missing/unsupported. */
function readConfig(): {
  network: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  facilitatorUrl: string;
  enclaveUrl: string;
  enclaveAudience: string | null;
  nonceHmacSecret: string;
  net: NetworkConfig;
} {
  const network = process.env.SUMMON_NETWORK ?? "eip155:84532";
  const net = NETWORK_CONFIG[network];
  if (!net) {
    throw new Error(
      `unsupported SUMMON_NETWORK "${network}". Known: ${Object.keys(NETWORK_CONFIG).join(", ")}.`,
    );
  }

  const amount = process.env.SUMMON_PRICE_ATOMIC ?? "10000"; // 0.01 USDC (6 decimals)
  if (!/^\d+$/.test(amount) || amount === "0") {
    throw new Error(
      `SUMMON_PRICE_ATOMIC must be a positive integer atomic-units string, got "${amount}".`,
    );
  }

  const payTo = process.env.SUMMON_PAY_TO;
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    throw new Error(
      "SUMMON_PAY_TO is required and must be a 0x-prefixed 20-byte address (the USDC recipient).",
    );
  }

  const maxTimeoutSeconds = Number(process.env.SUMMON_MAX_TIMEOUT_SECONDS ?? "300");
  if (!Number.isFinite(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new Error("SUMMON_MAX_TIMEOUT_SECONDS must be a positive number.");
  }

  const facilitatorUrl = (process.env.FACILITATOR_URL ?? "http://localhost:4021").replace(/\/+$/, "");
  const enclaveUrl = process.env.ENCLAVE_URL;
  if (!enclaveUrl) {
    throw new Error("ENCLAVE_URL is required (the TEE daemon base URL, e.g. http://VM_IP:8000).");
  }

  // When set, we mint a Google ID token with this audience and send it to the
  // enclave as a Bearer (Confidential Space ingress auth). Unset => dev, no auth.
  const enclaveAudience = process.env.ENCLAVE_ID_TOKEN_AUDIENCE ?? null;

  // HMAC key that makes the 402 challenge nonce self-authenticating (stateless
  // enforcement). REQUIRED: without it the route cannot prove it issued a nonce,
  // so we refuse to run rather than ship an unenforced (decorative) challenge.
  const nonceHmacSecret = process.env.SUMMON_NONCE_HMAC_SECRET;
  if (!nonceHmacSecret || nonceHmacSecret.length < 16) {
    throw new Error(
      "SUMMON_NONCE_HMAC_SECRET is required and must be >= 16 chars (it HMAC-signs " +
        "the 402 challenge nonce so the paid leg can enforce it statelessly).",
    );
  }

  return {
    network,
    amount,
    payTo,
    maxTimeoutSeconds,
    facilitatorUrl,
    enclaveUrl: enclaveUrl.replace(/\/+$/, ""),
    enclaveAudience,
    nonceHmacSecret,
    net,
  };
}

// --- helpers ---

/** An HTTP-status-carrying error; the handler maps it to NextResponse.json(...,{status}). */
class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Generate a fresh 0x-prefixed 32-byte (bytes32) hex nonce via Node crypto. */
function randomNonce32(): string {
  // crypto is available as a Node global under runtime "nodejs".
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * HMAC-SHA256(secret, nonce) as lowercase hex. This is the self-authenticating
 * tag returned with the 402 challenge: the paid leg recomputes it to prove the
 * route issued `nonce` (no server-side nonce store needed).
 */
async function nonceSignature(secret: string, nonce: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(nonce));
  let hex = "";
  for (const b of new Uint8Array(mac)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Constant-time equality over two equal-length hex strings (timing-safe MAC compare). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Build the x402 PaymentRequirements (one challenge entry) from config. */
function buildPaymentRequirements(cfg: ReturnType<typeof readConfig>): PaymentRequirements {
  return {
    scheme: "exact",
    network: cfg.network,
    asset: cfg.net.asset as PaymentRequirements["asset"],
    amount: cfg.amount,
    payTo: cfg.payTo as PaymentRequirements["payTo"],
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    extra: { name: cfg.net.domainName, version: cfg.net.domainVersion },
  };
}

/**
 * Extract the x402 PaymentPayload from the request.
 *
 * PRIMARY channel: the `X-PAYMENT` header, base64-encoding the PaymentPayload
 * JSON (the x402 convention). We ALSO accept a JSON body field `paymentPayload`
 * (already-parsed object) for robustness / easier client debugging. Header wins
 * if both are present. Returns null when neither is present (the unpaid leg).
 */
function extractPaymentPayload(
  req: Request,
  body: { paymentPayload?: unknown },
): unknown | null {
  const header = req.headers.get("x-payment");
  if (header && header.trim() !== "") {
    let decoded: string;
    try {
      // base64 -> utf8 (atob is available; Buffer also works under node runtime).
      decoded = Buffer.from(header, "base64").toString("utf8");
    } catch (e) {
      throw new HttpError(400, `X-PAYMENT header is not valid base64: ${errMsg(e)}`);
    }
    try {
      return JSON.parse(decoded);
    } catch (e) {
      throw new HttpError(400, `X-PAYMENT header did not base64-decode to JSON: ${errMsg(e)}`);
    }
  }
  if (body.paymentPayload != null) {
    return body.paymentPayload;
  }
  return null;
}

/**
 * Pull the EIP-3009 authorization out of a decoded PaymentPayload. The verified
 * v2 EVM-exact payload shape is { signature, authorization } under payload.payload.
 * We read defensively and throw a 400 (not a 500) on a malformed buyer payload.
 */
function authorizationFromPayload(paymentPayload: unknown): Eip3009Authorization {
  const pp = paymentPayload as Record<string, unknown> | null;
  const inner = pp?.payload as Record<string, unknown> | undefined;
  const auth = inner?.authorization as Eip3009Authorization | undefined;
  if (!auth || typeof auth.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) {
    throw new HttpError(
      400,
      "payment payload is missing a valid EIP-3009 authorization.nonce (0x + 32 bytes).",
    );
  }
  return auth;
}

/** POST JSON to a URL, returning { status, json }. Network errors throw. */
async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body (e.g. an enclave 500 with a plain-text reason). Keep raw.
      parsed = { error: text };
    }
  }
  return { status: res.status, json: parsed };
}

/**
 * Mint a Google identity token for the enclave audience (Confidential Space
 * ingress). google-auth-library is Node-only, so we import it lazily and ONLY
 * when an audience is configured. Throws loudly if minting fails (we do not run
 * the code without the auth the enclave requires).
 */
async function mintEnclaveIdToken(audience: string): Promise<string> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  // getRequestHeaders() returns { Authorization: "Bearer <jwt>" } in some lib versions
  // and a fetch-style Headers (with .get()) in others. Probe structurally for a .get
  // method; cast through unknown so the lib's own Headers type does not collide with
  // the DOM Headers lib type under tsc.
  const maybeGettable = headers as unknown as {
    get?: (name: string) => string | null;
  };
  const authHeader =
    typeof maybeGettable.get === "function"
      ? maybeGettable.get("Authorization") ?? maybeGettable.get("authorization")
      : (headers as unknown as Record<string, string>).Authorization ??
        (headers as unknown as Record<string, string>).authorization;
  if (!authHeader) {
    throw new Error("google-auth-library returned no Authorization header for the enclave audience.");
  }
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("minted enclave ID token was empty.");
  return token;
}

// --- handler ---

export async function POST(req: Request) {
  try {
    // --- parse + validate the body (code is always required) ---
    let body: {
      code?: unknown;
      input?: unknown;
      paymentPayload?: unknown;
      nonce?: unknown;
      nonceSig?: unknown;
    };
    try {
      body = (await req.json()) ?? {};
    } catch {
      throw new HttpError(
        400,
        "request body must be JSON: { code, input?, paymentPayload?, nonce?, nonceSig? }.",
      );
    }
    if (typeof body.code !== "string" || body.code.length === 0) {
      throw new HttpError(400, "field `code` is required and must be a non-empty string.");
    }
    if (body.input != null && typeof body.input !== "string") {
      throw new HttpError(400, "field `input`, when present, must be a string.");
    }
    const code = body.code;
    const input = (body.input as string | undefined) ?? "";

    const cfg = readConfig();

    // --- is this the unpaid initial POST or the paid re-POST? ---
    const paymentPayload = extractPaymentPayload(req, body);

    if (paymentPayload == null) {
      // -------- UNPAID: return the 402 challenge --------
      // Mint the per-request nonce that the buyer MUST place in authorization.nonce,
      // plus an HMAC tag binding it to this route. The HMAC makes the challenge
      // self-authenticating: the paid leg recomputes it to prove we issued this
      // nonce, so we enforce the challenge WITHOUT a server-side nonce store.
      const nonce = randomNonce32();
      const nonceSig = await nonceSignature(cfg.nonceHmacSecret, nonce);
      const requirements = buildPaymentRequirements(cfg);
      return NextResponse.json(
        {
          x402Version: X402_VERSION,
          accepts: [requirements],
          // The buyer must sign authorization.nonce === nonce AND echo {nonce,
          // nonceSig} back on the paid leg (both are checked there).
          nonce,
          nonceSig,
          // Human hint (not load-bearing): how to pay.
          error: "payment required: sign the EIP-3009 authorization using the returned nonce, echo {nonce, nonceSig}, then re-POST with the X-PAYMENT header.",
        },
        { status: 402 },
      );
    }

    // -------- PAID: enforce challenge -> verify -> settle -> run --------
    const requirements = buildPaymentRequirements(cfg);

    // ENFORCE THE 402 CHALLENGE (stateless, via HMAC). The buyer echoes the nonce
    // we issued plus its HMAC tag; we (a) prove we issued it by recomputing the
    // HMAC, then (b) prove the buyer committed it into the signed payment by
    // requiring authorization.nonce === that nonce. This is what makes the
    // challenged 402 nonce the SAME nonce bound to the payment AND the proof --
    // not two independent randoms. Any failure -> 402, before verify/settle/run.
    const authorization = authorizationFromPayload(paymentPayload);
    const challengeNonce = body.nonce;
    const challengeSig = body.nonceSig;
    if (typeof challengeNonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(challengeNonce)) {
      throw new HttpError(
        402,
        "missing/invalid `nonce` echo: re-POST the exact `nonce` (0x + 32 bytes) returned in the 402 challenge.",
      );
    }
    if (typeof challengeSig !== "string" || !/^[0-9a-f]{64}$/.test(challengeSig)) {
      throw new HttpError(
        402,
        "missing/invalid `nonceSig` echo: re-POST the exact `nonceSig` (HMAC hex) returned in the 402 challenge.",
      );
    }
    const expectedSig = await nonceSignature(cfg.nonceHmacSecret, challengeNonce);
    if (!timingSafeEqualHex(expectedSig, challengeSig)) {
      // The HMAC does not verify: this nonce was not issued by this route.
      throw new HttpError(402, "nonce challenge failed: nonceSig is not a valid HMAC over nonce.");
    }
    if (authorization.nonce.toLowerCase() !== challengeNonce.toLowerCase()) {
      // The buyer signed a different nonce than the one challenged: binding broken.
      throw new HttpError(
        402,
        "nonce binding failed: authorization.nonce does not equal the challenged 402 nonce.",
      );
    }
    // The challenged, buyer-committed nonce is the proof nonce.
    const nonce = challengeNonce;

    // 1) VERIFY (no run if invalid).
    const verifyRes = await postJson(`${cfg.facilitatorUrl}/verify`, {
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: requirements,
    });
    if (verifyRes.status !== 200) {
      throw new HttpError(
        502,
        `facilitator /verify returned ${verifyRes.status}: ${verifyRes.json?.error ?? "unknown error"}`,
      );
    }
    if (!verifyRes.json?.isValid) {
      // Honest: invalid payment -> 402, do NOT run the code.
      return NextResponse.json(
        {
          ok: false,
          error: "payment not valid",
          invalidReason: verifyRes.json?.invalidReason ?? "unspecified",
        },
        { status: 402 },
      );
    }

    // 2) SETTLE (no run if settlement fails). Captures the real on-chain tx hash.
    const settleRes = await postJson(`${cfg.facilitatorUrl}/settle`, {
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: requirements,
    });
    if (settleRes.status !== 200) {
      throw new HttpError(
        502,
        `facilitator /settle returned ${settleRes.status}: ${settleRes.json?.error ?? "unknown error"}`,
      );
    }
    if (!settleRes.json?.success) {
      // Payment failed at settlement -> 502, do NOT run the code.
      return NextResponse.json(
        {
          ok: false,
          error: "payment settlement failed",
          errorReason: settleRes.json?.errorReason ?? "unspecified",
        },
        { status: 502 },
      );
    }
    // SettleResponse guarantees a tx hash on success. If the facilitator reports
    // success without one, surface the anomaly loudly rather than serving a
    // receipt the buyer cannot audit on-chain (honest-failure: no quiet hole).
    const transaction: string | undefined = settleRes.json?.transaction;
    if (typeof transaction !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(transaction)) {
      throw new HttpError(
        502,
        "settlement reported success but returned no valid transaction hash (cannot issue an auditable receipt).",
      );
    }
    const payer: string | undefined = settleRes.json?.payer ?? authorization.from;
    const amount: string | undefined = settleRes.json?.amount ?? requirements.amount;

    // 3) RUN in the enclave. Mint a Google ID token only if an audience is set.
    const enclaveHeaders: Record<string, string> = {};
    if (cfg.enclaveAudience) {
      const idToken = await mintEnclaveIdToken(cfg.enclaveAudience);
      enclaveHeaders.Authorization = `Bearer ${idToken}`;
    }

    const runRes = await postJson(
      `${cfg.enclaveUrl}/run`,
      { code, input, nonce },
      enclaveHeaders,
    );
    if (runRes.status !== 200) {
      // Surface the enclave's status + reason honestly. Payment already settled,
      // but the run/proof did not complete -- the buyer sees exactly why (and the
      // settlement tx, so they can audit the charge against a failed run).
      return NextResponse.json(
        {
          ok: false,
          error: `enclave /run returned ${runRes.status}`,
          enclaveStatus: runRes.status,
          enclaveError: runRes.json?.error ?? runRes.json ?? "unknown enclave error",
          x402Receipt: { transaction, network: cfg.network, payer, amount },
        },
        { status: 502 },
      );
    }

    // 4) Success. The enclave 200 body IS the proof bundle (proof.build_bundle).
    return NextResponse.json(
      {
        result: runRes.json?.result ?? null,
        proof: runRes.json,
        x402Receipt: { transaction, network: cfg.network, payer, amount },
      },
      { status: 200 },
    );
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    // Unexpected failure: surface it loudly (no secrets in the message). 500.
    const message = errMsg(e);
    console.error("[summon] unhandled error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
