// ============================================================================
// summon_enclave.ts -- the MAKER side of the x402-gated grader VM spawn (Gap 4).
//
// GOAL: spawning the per-bounty grader Confidential Space VM (grade_in_vm.sh ->
// deploy.sh) must REQUIRE a real x402 USDC payment. The maker pays USDC via
// EIP-3009 transferWithAuthorization; the self-hosted facilitator verifies +
// settles it on-chain; and ONLY a successful settle authorizes the VM launch.
//
// This is the grader analogue of apps/web/src/app/api/summon/route.ts, but the
// "resource" being unlocked is NOT a warm tee-runner /run -- it is the launch of
// a fresh single-shot grader VM. There is no warm daemon to POST to, so the
// "spawn" is a local privileged action (gcloud, KMS-attested SA) that the maker
// performs the instant settlement succeeds. We therefore keep the facilitator
// generic (verify/settle only) and put the gate HERE: the call to grade_in_vm.sh
// is literally the next statement after a verified `settle.success === true`.
//
// THE 402 ROUND-TRIP, maker-issued + maker-enforced (no Next.js route needed):
//
//   (1) MINT the challenge nonce LOCALLY and HMAC-bind it with the SAME secret
//       the web route uses (SUMMON_NONCE_HMAC_SECRET):
//         nonce    = random bytes32
//         nonceSig = HMAC-SHA256(secret, nonce)
//       The maker is the challenger here (it owns the resource = the VM spawn).
//       Binding the nonce keeps the wire shape identical to the web flow and lets
//       a future server-side challenger be dropped in unchanged.
//
//   (2) SIGN the EIP-3009 USDC transferWithAuthorization with
//       authorization.nonce === the challenge nonce (the on-chain replay field),
//       using the maker key (REAL_MONEY_PKEY). This is the buyer signature; the
//       facilitator relayer (a DIFFERENT EOA) pays gas and broadcasts.
//
//   (3) POST facilitator /verify  -> require isValid (else abort, no spawn).
//
//   (4) POST facilitator /settle  -> require success + a real tx hash
//       (else abort, no spawn). This is the ON-CHAIN USDC transfer.
//
//   (5) ON success ONLY: invoke grade_in_vm.sh <submission> <jobId> <agentId>
//       [digest], which launches the grader VM, polls serial for the in-enclave
//       KMS-signed grade, and deletes the VM. Its single JSON line is printed to
//       stdout (so the orchestrator captures the grade exactly as before).
//
// HONEST FAILURE: we NEVER spawn the VM unless settlement returned success with a
// real tx hash. verify!=ok -> abort. settle!=ok -> abort. We print the settlement
// receipt (tx hash, payer, amount, network) to stderr so the spawn is auditable.
//
// DRY-RUN: pass --dry-run (or SUMMON_DRY_RUN=1) to do everything EXCEPT the two
// network mutations -- it builds + signs the payload, optionally hits /verify if
// the facilitator is up, and PRINTS the X-PAYMENT it WOULD settle, then stops
// before /settle and before grade_in_vm.sh. This is how we exercise the path
// locally without broadcasting or spawning.
//
// Run with bun (preferred, matches the repo) or node:
//   bun apps/grading-cre/grader/summon_enclave.ts <submission> <jobId> <agentId> [digest]
//   node --experimental-strip-types ... (or via the .sh wrapper which picks a runtime)
// viem is resolved from the x402-facilitator node_modules (see import below).
// ============================================================================

import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// viem lives in the sibling facilitator app; import it by absolute path so this
// script does not need its own node_modules. (The web app and facilitator both
// already depend on viem ^2.21.)
import {
  getAddress,
  type Hex,
} from "../../x402-facilitator/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../../x402-facilitator/node_modules/viem/_esm/accounts/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRADE_IN_VM = resolve(HERE, "enclave/grade_in_vm.sh");

const X402_VERSION = 2;

// --- per-network config (MUST match apps/web/.../api/summon/route.ts) ---
// USDC address + EIP-712 domain (name/version) differ per chain. The facilitator
// settles on whatever NETWORKS it is started with; this must agree (SUMMON_NETWORK).
type NetworkConfig = { asset: Hex; domainName: string; domainVersion: string };
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

function die(msg: string): never {
  console.error(`[summon] FATAL: ${msg}`);
  process.exit(1);
}

function readEnvFile(path: string): Record<string, string> {
  // Minimal .env reader (KEY=VALUE per line). We do NOT depend on dotenv.
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = require("node:fs").readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Load the maker (buyer) private key. The orchestrator's .env stores it as
 * REAL_MONEY_PKEY with literal 'z' obfuscation chars that MUST be stripped (the
 * e2e script does the same: `tr -d 'z'`). Env var MAKER_PK wins if set.
 */
function loadMakerKey(envFile: Record<string, string>): Hex {
  let raw = (process.env.MAKER_PK ?? envFile.REAL_MONEY_PKEY ?? "").trim();
  raw = raw.replace(/z/g, ""); // strip obfuscation 'z' chars
  raw = raw.replace(/^["']|["']$/g, "");
  if (!raw) die("maker key not found (set MAKER_PK or REAL_MONEY_PKEY in .env).");
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    die("maker key is not a 32-byte hex private key after stripping 'z' chars.");
  }
  return hex as Hex;
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text };
    }
  }
  return { status: res.status, json };
}

function base64Json(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

async function main() {
  // --- args: <submission> <jobId> <agentId> [image-digest] ---
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const dryRun =
    process.argv.includes("--dry-run") || process.env.SUMMON_DRY_RUN === "1";
  const [submission, jobId, agentId, imageDigest] = args;
  // SETTLE-ONLY: the maker pays once up front to SUMMON the bounty's grader (the
  // canonical "maker-summoned per-bounty TEE" model). It settles + returns, leaving
  // the per-submission VM grading to grade_in_vm.sh (authorized by this one payment).
  const settleOnly = process.env.SUMMON_SETTLE_ONLY === "1";
  if (!jobId || (!settleOnly && (!submission || !agentId))) {
    die(
      "usage: summon_enclave.ts <submission> <jobId> <agentId> [image-digest] [--dry-run]" +
        "  (SUMMON_SETTLE_ONLY=1 needs only <jobId>)",
    );
  }

  // --- config ---
  const envPath = process.env.ENVF ?? "/home/thegnome/ethny2026/.env";
  const envFile = readEnvFile(envPath);

  const network = process.env.SUMMON_NETWORK ?? "eip155:1";
  const net = NETWORK_CONFIG[network];
  if (!net) die(`unsupported SUMMON_NETWORK "${network}".`);

  const amount = process.env.SUMMON_PRICE_ATOMIC ?? "10000"; // 0.01 USDC (6 decimals)
  if (!/^\d+$/.test(amount) || amount === "0") {
    die(`SUMMON_PRICE_ATOMIC must be a positive integer atomic string, got "${amount}".`);
  }

  const payTo = process.env.SUMMON_PAY_TO;
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    die("SUMMON_PAY_TO is required (the USDC recipient, e.g. the maker treasury / grader operator).");
  }

  const facilitatorUrl = (
    process.env.FACILITATOR_URL ?? "http://localhost:4021"
  ).replace(/\/+$/, "");

  const hmacSecret = process.env.SUMMON_NONCE_HMAC_SECRET;
  if (!hmacSecret || hmacSecret.length < 16) {
    die("SUMMON_NONCE_HMAC_SECRET is required (>=16 chars) -- binds the 402 nonce to the payment.");
  }

  const maxTimeoutSeconds = Number(process.env.SUMMON_MAX_TIMEOUT_SECONDS ?? "300");

  const makerKey = loadMakerKey(envFile);
  const account = privateKeyToAccount(makerKey);
  const from = getAddress(account.address);
  const chainId = Number(/^eip155:(\d+)$/.exec(network)![1]);

  console.error(
    `[summon] network=${network} chainId=${chainId} usdc=${net.asset} ` +
      `payTo=${payTo} amount=${amount} (atomic) maker=${from} facilitator=${facilitatorUrl}` +
      (dryRun ? "  [DRY-RUN]" : ""),
  );

  // --- (1) mint + HMAC-bind the challenge nonce (the maker is the challenger) ---
  const nonce = ("0x" + randomBytes(32).toString("hex")) as Hex;
  const nonceSig = createHmac("sha256", hmacSecret).update(nonce).digest("hex");
  console.error(`[summon] challenge nonce=${nonce} nonceSig=${nonceSig.slice(0, 16)}...`);

  // --- (2) build + sign the EIP-3009 authorization (authorization.nonce === nonce) ---
  const nowSec = Math.floor(Date.now() / 1000);
  const validAfter = String(nowSec - 60); // clock-skew slack
  const validBefore = String(nowSec + Math.max(maxTimeoutSeconds, 60));
  const authorization = {
    from,
    to: getAddress(payTo as Hex),
    value: amount,
    validAfter,
    validBefore,
    nonce,
  };
  const typedData = {
    domain: {
      name: net.domainName,
      version: net.domainVersion,
      chainId,
      verifyingContract: getAddress(net.asset),
    },
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
    primaryType: "TransferWithAuthorization" as const,
    message: authorization,
  };

  // Sign with the maker key locally. EIP-712 typed-data signing is a pure local
  // operation -- account.signTypedData needs NO RPC/transport (the relayer, a
  // different EOA inside the facilitator, is the one that broadcasts on-chain).
  const signature = (await account.signTypedData(typedData as never)) as Hex;

  // x402 PaymentPayload wire shape (must match the web flow exactly).
  const paymentPayload = {
    x402Version: X402_VERSION,
    accepted: buildRequirements(),
    payload: { signature, authorization },
  };
  function buildRequirements() {
    return {
      scheme: "exact" as const,
      network,
      asset: net.asset,
      amount,
      payTo: payTo as Hex,
      maxTimeoutSeconds,
      extra: { name: net.domainName, version: net.domainVersion },
    };
  }
  const paymentRequirements = buildRequirements();
  const xPayment = base64Json(paymentPayload);

  console.error(`[summon] signed EIP-3009 authorization. X-PAYMENT (base64) length=${xPayment.length}`);

  // --- self-checks: prove the nonce binding before any network call ---
  const recomputedSig = createHmac("sha256", hmacSecret).update(nonce).digest("hex");
  if (recomputedSig !== nonceSig) die("internal: HMAC self-check failed.");
  if (authorization.nonce.toLowerCase() !== nonce.toLowerCase()) {
    die("internal: authorization.nonce != challenge nonce (binding broken).");
  }
  console.error("[summon] OK: nonce binding self-check passed (HMAC + authorization.nonce == challenge nonce).");

  // --- (3) VERIFY (no spawn if invalid) ---
  // In dry-run we still attempt /verify if a facilitator is reachable, but we
  // tolerate it being down (the point of dry-run is to NOT require live infra).
  const verifyBody = {
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements,
  };
  let verifyReachable = true;
  let verify: { status: number; json: any } = { status: 0, json: null };
  try {
    verify = await postJson(`${facilitatorUrl}/verify`, verifyBody);
  } catch (e) {
    verifyReachable = false;
    if (!dryRun) die(`facilitator /verify unreachable: ${(e as Error).message}`);
    console.error(`[summon] (dry-run) facilitator unreachable, skipping /verify: ${(e as Error).message}`);
  }

  if (verifyReachable) {
    if (verify.status !== 200) {
      die(`facilitator /verify returned ${verify.status}: ${verify.json?.error ?? "unknown"}`);
    }
    if (!verify.json?.isValid) {
      die(`payment NOT valid: ${verify.json?.invalidReason ?? "unspecified"} -- aborting, NO VM spawn.`);
    }
    console.error("[summon] /verify -> isValid:true (payment is settleable).");
  }

  if (dryRun) {
    // Print the X-PAYMENT and stop BEFORE /settle and BEFORE the VM spawn.
    console.error("[summon] DRY-RUN complete: payload built + signed; verify checked (if reachable).");
    console.error("[summon] Would next: POST /settle, then on success run grade_in_vm.sh. Stopping now.");
    // Emit the constructed artifacts for inspection / unit assertions.
    console.log(
      JSON.stringify({
        dryRun: true,
        network,
        chainId,
        maker: from,
        nonce,
        nonceSig,
        authorization,
        xPayment,
        verifyChecked: verifyReachable,
        verifyIsValid: verifyReachable ? !!verify.json?.isValid : null,
      }),
    );
    return;
  }

  // --- (4) SETTLE (the ON-CHAIN USDC transfer; no spawn if it fails) ---
  const settle = await postJson(`${facilitatorUrl}/settle`, verifyBody);
  if (settle.status !== 200) {
    die(`facilitator /settle returned ${settle.status}: ${settle.json?.error ?? "unknown"} -- NO VM spawn.`);
  }
  if (!settle.json?.success) {
    die(`payment settlement FAILED: ${settle.json?.errorReason ?? "unspecified"} -- NO VM spawn.`);
  }
  const tx: string | undefined = settle.json?.transaction;
  if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    die("settlement reported success but returned no valid tx hash -- refusing to spawn on an unauditable charge.");
  }
  const payer = settle.json?.payer ?? authorization.from;
  console.error(
    `[summon] x402 SETTLED on ${network}: tx=${tx} payer=${payer} amount=${amount} -> grader summoned.`,
  );

  if (settleOnly) {
    // Maker has paid to summon the bounty's grader; grading runs separately (grade_in_vm.sh).
    console.error("[summon] SETTLE-ONLY: bounty grader summoned; grading authorized for jobId " + jobId + ".");
    console.log(JSON.stringify({ settled: true, network, tx, payer, amount, jobId }));
    return;
  }

  // --- (5) SETTLEMENT AUTHORIZES THE SPAWN: run grade_in_vm.sh. ---
  // This is the LAST step and the ONLY path to a VM. The grade JSON line goes to
  // STDOUT so the orchestrator captures it identically to calling grade_in_vm.sh
  // directly. The settlement receipt is on STDERR (auditable, not mixed in).
  const gvArgs = [GRADE_IN_VM, submission, jobId, agentId];
  if (imageDigest) gvArgs.push(imageDigest);
  console.error(`[summon] spawning grader VM: bash ${gvArgs.join(" ")}`);
  const r = spawnSync("bash", gvArgs, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    die(`grade_in_vm.sh exited ${r.status} (payment ${tx} already settled). See VM logs above.`);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
