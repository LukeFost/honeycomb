"use client";

// SummonTee -- the buyer-facing "summon a TEE" panel.
//
// FLOW (x402 402 -> sign -> retry -> verify), all in the browser:
//   1. User writes arbitrary Python (+ optional stdin), clicks "Summon TEE".
//   2. POST /api/summon { code, input }. The route answers HTTP 402 with
//      { accepts: [PaymentRequirements], nonce, nonceSig } -- the price plus a
//      server-challenged nonce and its HMAC tag. The nonce binds this quote to
//      the eventual run; nonceSig lets the route enforce it statelessly.
//   3. We build the EIP-3009 TransferWithAuthorization typed data for that USDC
//      payment (buildTransferWithAuthorizationTypedData, passing the challenged
//      quote.nonce so authorization.nonce == quote.nonce) and ask the user's
//      wallet (window.ethereum via viem custom transport) to signTypedData it.
//      The route reads that authorization.nonce back as the enclave proof nonce,
//      so committing to quote.nonce here is what binds purchase -> proof. On the
//      paid leg we ALSO echo {nonce, nonceSig}; the route requires HMAC(nonce)==
//      nonceSig AND authorization.nonce==nonce before it will verify/settle/run.
//   4. We assemble the x402 PaymentPayload { x402Version:2, accepted, payload:{
//      signature, authorization } } and re-POST /api/summon WITH the payment. We
//      send it BOTH as a base64 `X-PAYMENT` header AND as a `paymentPayload` body
//      field (belt-and-suspenders: the route may read either; both carry the same
//      object, so whichever it picks, it gets a consistent payload).
//   5. The route verifies+settles via the self-hosted facilitator, runs the code
//      in the enclave, and returns { result, proof bundle, receipt }.
//   6. We INDEPENDENTLY verify the proof client-side (verifyProofBundle +
//      bindSubmission): recompute outputHash + digest, ecrecover the signer, and
//      bind the proof to the exact code/input we submitted. We render each check.
//      Tamper any field and step 2/3 here goes red -- the proof is load-bearing.
//
// Honesty rule: we never paint a green "TEE-proven" badge for a dev/unbacked run
// (attestation null) or a run whose signature chain fails. Server error messages
// are surfaced verbatim; we never fake a success.

import { useMemo, useState } from "react";
import {
  createWalletClient,
  custom,
  getAddress,
  numberToHex,
  type Hex,
} from "viem";
import {
  buildTransferWithAuthorizationTypedData,
  verifyProofBundle,
  bindSubmission,
  decodeAttestationClaims,
  type PaymentRequirements,
  type ProofBundle,
  type VerifyProofResult,
} from "@/lib/teeProof";
import { cn, truncAddr } from "@/components/ui";

// ---------------------------------------------------------------------------
// Config -- network + explorer. Defaults to Base Sepolia (testnet first).
// NEXT_PUBLIC_* are inlined at build time; safe to read in a client component.
// ---------------------------------------------------------------------------

// CAIP-2 network the summon is priced on. Must match the route/facilitator.
const SUMMON_NETWORK =
  process.env.NEXT_PUBLIC_SUMMON_NETWORK ?? "eip155:84532";

function chainIdFromNetwork(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new Error(`bad SUMMON_NETWORK "${network}" (want eip155:<id>)`);
  return Number(m[1]);
}
const SUMMON_CHAIN_ID = chainIdFromNetwork(SUMMON_NETWORK);

// The enclave's KMS signer identity (the `score-signer` address). verifyProofBundle
// PINS the recovered signer to this -- without it, a forged bundle signed with the
// attacker's own key would pass (recovered == bundle.signer == attacker). Set this to
// the real enclave KMS address; an unset/blank value is a config error and we surface
// it loudly rather than verifying against a placeholder.
const TEE_SIGNER_RAW = process.env.NEXT_PUBLIC_TEE_SIGNER ?? "";
const TEE_SIGNER: Hex | null = (() => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(TEE_SIGNER_RAW)) return null;
  // Reject the all-zero placeholder: it is never a real KMS identity, so treat it as
  // unset and surface the config error loudly instead of "pinning" to address(0).
  if (/^0x0{40}$/.test(TEE_SIGNER_RAW)) return null;
  return getAddress(TEE_SIGNER_RAW as Hex);
})();

// Block explorer base for the settle tx link, per chain. Extend as needed.
const EXPLORERS: Record<number, { name: string; tx: (h: string) => string }> = {
  1: { name: "Etherscan", tx: (h) => `https://etherscan.io/tx/${h}` },
  84532: {
    name: "Base Sepolia",
    tx: (h) => `https://sepolia.basescan.org/tx/${h}`,
  },
  8453: { name: "BaseScan", tx: (h) => `https://basescan.org/tx/${h}` },
  11155111: {
    name: "Sepolia",
    tx: (h) => `https://sepolia.etherscan.io/tx/${h}`,
  },
};

function explorerTxUrl(chainId: number, hash: string): string | null {
  return EXPLORERS[chainId]?.tx(hash) ?? null;
}

// Seed code: prints something AND does a network call, to show network-on TEE.
const SEED_CODE = `import json, urllib.request

# A real outbound HTTPS call from inside the enclave -- proves network-on TEE.
with urllib.request.urlopen("https://api.github.com/zen", timeout=10) as r:
    zen = r.read().decode().strip()

print(json.dumps({"hello": "from the TEE", "github_zen": zen}))
`;

// ---------------------------------------------------------------------------
// 402 response shape (what /api/summon returns before payment).
// ---------------------------------------------------------------------------

type Quote = {
  accepts: PaymentRequirements[]; // one or more acceptable payment requirements
  nonce: string; // server-challenged bytes32 -> goes into authorization.nonce
  nonceSig: string; // HMAC tag over `nonce`; echoed back so the route enforces it
};

// minimal EIP-1193 provider surface we use
type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

type Phase =
  | "idle"
  | "quoting" // POST without payment, awaiting 402 quote
  | "signing" // wallet signTypedData
  | "running" // re-POST with payment, enclave executing
  | "done"
  | "error";

export default function SummonTee() {
  const [code, setCode] = useState(SEED_CODE);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<Hex | null>(null);

  // result of a completed summon
  const [bundle, setBundle] = useState<ProofBundle | null>(null);
  const [receipt, setReceipt] = useState<{
    transaction?: string;
    network?: string;
    amount?: string;
    payer?: string;
  } | null>(null);
  const [verify, setVerify] = useState<VerifyProofResult | null>(null);
  const [binding, setBinding] = useState<{
    codeHashOk: boolean;
    inputHashOk: boolean;
    failures: string[];
  } | null>(null);
  // Non-fatal: the attestation-verification call failed operationally (e.g. JWKS
  // unreachable). Shown in the panel; teeProven stays false but the run still succeeds.
  const [attError, setAttError] = useState<string | null>(null);

  const busy = phase === "quoting" || phase === "signing" || phase === "running";

  const phaseLabel = useMemo(() => {
    switch (phase) {
      case "quoting":
        return "Requesting price (402)...";
      case "signing":
        return "Waiting for wallet signature...";
      case "running":
        return "Settling payment + running in TEE...";
      default:
        return null;
    }
  }, [phase]);

  function reset() {
    setBundle(null);
    setReceipt(null);
    setVerify(null);
    setBinding(null);
    setError(null);
    setAttError(null);
  }

  async function onSummon() {
    reset();
    setPhase("quoting");

    try {
      // --- pre-flight config gate (BEFORE any payment) ---
      // expectedSigner PINS the recovered signer to the enclave's KMS identity. If it
      // is unset/malformed we cannot trust ANY proof -- and we must fail here, before
      // the 402 fetch and the USDC charge, not after settlement. A forgetful operator
      // who leaves NEXT_PUBLIC_TEE_SIGNER at its placeholder gets a loud error and
      // keeps their money, instead of paying and then hitting an unverifiable proof.
      if (!TEE_SIGNER) {
        throw new Error(
          "NEXT_PUBLIC_TEE_SIGNER is unset or malformed: cannot pin the proof to the enclave KMS signer. " +
            "Set it to the enclave's signer address (0x + 20 bytes) before summoning (no payment was made).",
        );
      }

      // --- wallet presence ---
      if (typeof window === "undefined" || !window.ethereum) {
        throw new Error(
          "No Ethereum wallet found. Install MetaMask (or another EIP-1193 wallet) to summon.",
        );
      }
      const provider = window.ethereum;

      // --- Step 2: ask for the 402 quote (no payment yet) ---
      const quoteRes = await fetch("/api/summon", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, input }),
      });

      // We EXPECT 402 here. Anything else (esp. a 200 with no payment) is wrong.
      if (quoteRes.status !== 402) {
        const msg = await readError(quoteRes);
        throw new Error(
          `expected HTTP 402 price quote, got ${quoteRes.status}: ${msg}`,
        );
      }
      const quote = (await quoteRes.json()) as Quote;
      const requirements = quote?.accepts?.find(
        (r) => r.network === SUMMON_NETWORK,
      );
      if (!requirements) {
        throw new Error(
          `no payment option for ${SUMMON_NETWORK} in the 402 quote (got ${
            quote?.accepts?.map((r) => r.network).join(", ") || "none"
          })`,
        );
      }
      if (!quote.nonce || !quote.nonceSig) {
        throw new Error(
          "402 quote did not include the challenge nonce + nonceSig (HMAC)",
        );
      }

      // --- connect wallet + enforce the summon chain ---
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (!accounts?.length) throw new Error("wallet returned no accounts");
      const from = getAddress(accounts[0]);
      setAccount(from);

      const chainIdHex = (await provider.request({
        method: "eth_chainId",
      })) as string;
      if (Number(chainIdHex) !== SUMMON_CHAIN_ID) {
        // Prompt a switch to the summon chain. Honest: if it fails, surface it.
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: numberToHex(SUMMON_CHAIN_ID) }],
          });
        } catch (switchErr) {
          throw new Error(
            `wrong network: wallet is on chain ${Number(
              chainIdHex,
            )}, summon needs chain ${SUMMON_CHAIN_ID} (${SUMMON_NETWORK}). ` +
              `Switch failed: ${errMsg(switchErr)}`,
          );
        }
        // Verify-as-you-go: some wallets resolve the switch promise without actually
        // landing on the target chain. Re-read the active chain and refuse to sign
        // typed data whose domain.chainId would not match the wallet's real chain.
        const afterHex = (await provider.request({
          method: "eth_chainId",
        })) as string;
        if (Number(afterHex) !== SUMMON_CHAIN_ID) {
          throw new Error(
            `wallet did not switch to chain ${SUMMON_CHAIN_ID} (${SUMMON_NETWORK}); ` +
              `still on chain ${Number(afterHex)}. Switch networks and retry.`,
          );
        }
      }

      // --- Step 3: build EIP-3009 typed data + sign in the wallet ---
      // Commit to the SERVER-CHALLENGED nonce: the route reads the proof nonce out
      // of authorization.nonce, so authorization.nonce MUST equal quote.nonce or the
      // purchase->proof binding is broken. The builder validates the hex shape.
      const { typedData, authorization } =
        buildTransferWithAuthorizationTypedData(requirements, from, {
          nonce: quote.nonce as Hex,
        });

      setPhase("signing");
      const walletClient = createWalletClient({
        account: from,
        transport: custom(provider),
      });
      let signature: Hex;
      try {
        signature = await walletClient.signTypedData({
          account: from,
          domain: typedData.domain,
          types: typedData.types,
          primaryType: typedData.primaryType,
          message: typedData.message,
        });
      } catch (sigErr) {
        // User rejection or wallet error -- show it, never fake a success.
        throw new Error(`signature rejected or failed: ${errMsg(sigErr)}`);
      }

      // --- Step 4: assemble x402 PaymentPayload + re-POST with payment ---
      const paymentPayload = {
        x402Version: 2 as const,
        accepted: requirements,
        payload: { signature, authorization },
      };

      // belt-and-suspenders: the route may read the base64 X-PAYMENT header OR a
      // paymentPayload body field. We send BOTH with the same object so either works.
      const xPayment = base64Json(paymentPayload);

      setPhase("running");
      const runRes = await fetch("/api/summon", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-PAYMENT": xPayment,
        },
        // Echo the challenged nonce + its HMAC tag so the route can enforce the
        // 402 challenge statelessly (it asserts HMAC(nonce)==nonceSig AND
        // authorization.nonce==nonce before verify/settle/run).
        body: JSON.stringify({
          code,
          input,
          paymentPayload,
          nonce: quote.nonce,
          nonceSig: quote.nonceSig,
        }),
      });

      if (!runRes.ok) {
        const msg = await readError(runRes);
        throw new Error(`summon failed (${runRes.status}): ${msg}`);
      }

      const data = (await runRes.json()) as {
        proof?: ProofBundle;
        bundle?: ProofBundle;
        x402Receipt?: typeof receipt;
        receipt?: typeof receipt;
        result?: unknown;
      };
      // The route may nest the bundle under `proof` or `bundle`; accept either.
      const proof = data.proof ?? data.bundle ?? null;
      if (!proof) {
        throw new Error(
          "summon response did not include a proof bundle (expected `proof` or `bundle`)",
        );
      }
      setBundle(proof);
      // The route returns the settle receipt under `x402Receipt` (route.ts ~540/551);
      // accept `receipt` as a fallback for forward/backward compat.
      setReceipt(data.x402Receipt ?? data.receipt ?? null);

      // --- Step 6: independently verify the proof ---
      // The browser verifies 3 legs itself (outputHash, digest, pinned-signer ecrecover).
      // The 4th leg -- the Confidential Space attestation JWT -- needs an RS256 check
      // against Google's JWKS, which we do in a server route (runtime nodejs). POST the
      // JWT there with the buyer nonce; the route returns a single boolean `verified`
      // that is the AND of (RS256-valid && iss && exp && eat_nonce-bound && image-digest).
      // That boolean is the ONLY input that can flip teeProven true -- a missing or
      // unverifiable attestation keeps teeProven false (honest red badge), it does not
      // fail the whole summon (the result + 3 verified legs are still real).
      let attestationVerified = false;
      if (proof.attestation != null) {
        try {
          const attRes = await fetch("/api/verify-attestation", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jwt: proof.attestation, nonce: proof.nonce }),
          });
          if (attRes.ok) {
            const attJson = (await attRes.json()) as { verified?: boolean };
            attestationVerified = attJson.verified === true;
          } else {
            // Operational failure (e.g. JWKS unreachable, or a 400 on a malformed JWT).
            // Surface it in the panel; keep attestationVerified false so we never claim
            // TEE-proven on an unchecked token.
            setAttError(
              `attestation verification call failed (${attRes.status}): ${await readError(
                attRes,
              )}`,
            );
          }
        } catch (attErr) {
          setAttError(`attestation verification request error: ${errMsg(attErr)}`);
        }
      }

      const v = await verifyProofBundle(proof, {
        expectedSigner: TEE_SIGNER,
        attestationVerified,
      });
      setVerify(v);
      // Bind the proof to the EXACT code/input we submitted (a server could sign a
      // proof for DIFFERENT code; this catches that).
      setBinding(bindSubmission(proof, code, input));

      setPhase("done");
    } catch (e) {
      setError(errMsg(e));
      setPhase("error");
    }
  }

  // ---- attestation, decoded for display (NOT a signature check) ----
  const attClaims =
    bundle?.attestation != null
      ? decodeAttestationClaims(bundle.attestation)
      : null;

  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-10 text-ink-1">
      <header className="mb-6">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold">
          Summon a TEE
        </div>
        <h2 className="text-2xl font-semibold text-ink">
          Pay USDC. Run Python. Get cryptographic proof it ran in a real TEE.
        </h2>
        <p className="mt-2 text-sm text-ink-2">
          Network on. The hashes, digest, and signer identity are recomputed and
          pinned in your browser below -- no server trust for those. The attestation
          JWT is the one leg not yet verified in-browser (marked as such). Testnet:{" "}
          <span className="font-mono text-gold">{SUMMON_NETWORK}</span>.
        </p>
      </header>

      {/* ----- editor ----- */}
      <div className="rounded-2xl border border-edge bg-card shadow-card">
        <div className="border-b border-edge px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
          Python
        </div>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          rows={10}
          className="block w-full resize-y rounded-b-2xl bg-card-2 px-4 py-3 font-mono text-[13px] leading-relaxed text-ink-1 outline-none focus:ring-2 focus:ring-honey/50"
          placeholder="print('hello from the TEE')"
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-3">
            stdin (optional)
          </span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="block w-full rounded-xl border border-edge bg-card px-3 py-2 font-mono text-sm text-ink-1 outline-none focus:ring-2 focus:ring-honey/50"
            placeholder="piped to the program's stdin"
          />
        </label>

        <button
          type="button"
          onClick={onSummon}
          disabled={busy}
          className={cn(
            "h-10 rounded-xl border border-honey/60 bg-honey px-5 text-sm font-semibold text-cocoa shadow-card transition",
            busy ? "cursor-not-allowed opacity-60" : "hover:bg-honey-bright",
          )}
        >
          {busy ? phaseLabel ?? "Working..." : "Summon TEE"}
        </button>
      </div>

      {account && (
        <p className="mt-2 text-xs text-ink-3">
          Wallet: <span className="font-mono">{truncAddr(account)}</span>
        </p>
      )}

      {/* ----- error (honest, verbatim) ----- */}
      {error && (
        <div className="mt-5 rounded-xl border border-sybil/40 bg-sybil/10 px-4 py-3 text-sm text-sybil">
          <span className="font-semibold">Failed:</span> {error}
        </div>
      )}

      {/* ----- result ----- */}
      {bundle && (
        <div className="mt-8 space-y-6">
          <ResultPanel bundle={bundle} />
          <ReceiptPanel receipt={receipt} />
          <ProofPanel
            bundle={bundle}
            verify={verify}
            binding={binding}
            attClaims={attClaims}
            attError={attError}
          />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// sub-panels
// ---------------------------------------------------------------------------

function ResultPanel({ bundle }: { bundle: ProofBundle }) {
  const r = bundle.result;
  return (
    <div className="rounded-2xl border border-edge bg-card shadow-card">
      <div className="flex items-center justify-between border-b border-edge px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-3">
          Run result
        </span>
        <span className="flex items-center gap-3 text-xs text-ink-2">
          <span>
            exit{" "}
            <span
              className={cn(
                "font-mono",
                r.exitCode === 0 ? "text-organic" : "text-sybil",
              )}
            >
              {r.exitCode}
            </span>
          </span>
          <span>{r.durationMs} ms</span>
          {r.timedOut && <span className="text-sybil">timed out</span>}
        </span>
      </div>
      <div className="grid gap-3 px-4 py-3">
        <Stream label="stdout" text={r.stdout} />
        {r.stderr ? <Stream label="stderr" text={r.stderr} tone="sybil" /> : null}
      </div>
    </div>
  );
}

function Stream({
  label,
  text,
  tone = "ink",
}: {
  label: string;
  text: string;
  tone?: "ink" | "sybil";
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        {label}
      </div>
      <pre
        className={cn(
          "overflow-auto rounded-lg bg-paper-2 px-3 py-2 font-mono text-[12px] leading-relaxed",
          tone === "sybil" ? "text-sybil" : "text-ink-1",
        )}
      >
        {text || <span className="text-ink-3">(empty)</span>}
      </pre>
    </div>
  );
}

function ReceiptPanel({
  receipt,
}: {
  receipt: {
    transaction?: string;
    network?: string;
    amount?: string;
    payer?: string;
  } | null;
}) {
  if (!receipt) return null;
  const url = receipt.transaction
    ? explorerTxUrl(SUMMON_CHAIN_ID, receipt.transaction)
    : null;
  return (
    <div className="rounded-2xl border border-edge bg-card shadow-card">
      <div className="border-b border-edge px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
        x402 receipt
      </div>
      <dl className="grid gap-2 px-4 py-3 text-sm">
        <Row k="settle tx">
          {receipt.transaction ? (
            url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-gold underline decoration-honey/50 underline-offset-2 hover:text-gold-2"
              >
                {truncAddr(receipt.transaction, 10, 8)}
              </a>
            ) : (
              <span className="font-mono text-ink-1">{receipt.transaction}</span>
            )
          ) : (
            <span className="text-ink-3">(none)</span>
          )}
        </Row>
        {receipt.amount && (
          <Row k="amount">
            <span className="font-mono text-ink-1">{receipt.amount}</span>
          </Row>
        )}
        {receipt.payer && (
          <Row k="payer">
            <span className="font-mono text-ink-1">
              {truncAddr(receipt.payer)}
            </span>
          </Row>
        )}
      </dl>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-ink-3">{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ProofPanel({
  bundle,
  verify,
  binding,
  attClaims,
  attError,
}: {
  bundle: ProofBundle;
  verify: VerifyProofResult | null;
  binding: {
    codeHashOk: boolean;
    inputHashOk: boolean;
    failures: string[];
  } | null;
  attClaims: ReturnType<typeof decodeAttestationClaims>;
  attError: string | null;
}) {
  if (!verify) return null;

  const teeProven = verify.teeProven;

  return (
    <div className="rounded-2xl border border-edge bg-card shadow-card">
      <div className="flex items-center justify-between border-b border-edge px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-3">
          Proof (verified in your browser)
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
            teeProven
              ? "border-organic/30 bg-organic/10 text-organic"
              : "border-sybil/30 bg-sybil/10 text-sybil",
          )}
        >
          {teeProven ? "TEE-proven" : "NOT TEE-proven"}
        </span>
      </div>

      <div className="grid gap-2 px-4 py-3">
        <Check
          ok={verify.outputHashOk}
          label="outputHash matches canonical output (recomputed)"
        />
        <Check
          ok={verify.digestOk}
          label="digest binds code + input + output + nonce (recomputed)"
        />
        <Check
          ok={verify.signatureOk}
          label={
            verify.recoveredSigner
              ? `signature recovers to the enclave signer ${truncAddr(verify.recoveredSigner)} (pinned)`
              : "signature recovers to the pinned enclave signer"
          }
        />
        {binding && (
          <>
            <Check ok={binding.codeHashOk} label="codeHash matches your code" />
            <Check
              ok={binding.inputHashOk}
              label="inputHash matches your input"
            />
          </>
        )}

        {/* attestation -- honest about what we did and did NOT verify */}
        <div className="mt-2 rounded-lg border border-edge bg-paper-2 px-3 py-2">
          {bundle.attestation == null ? (
            <p className="text-sm text-sybil">
              No attestation: this run is{" "}
              <span className="font-semibold">not TEE-proven</span> (dev / unbacked
              signer). A signed digest alone does not prove a real enclave.
              {bundle.attestationNote ? (
                <span className="block text-xs text-ink-2">
                  {bundle.attestationNote}
                </span>
              ) : null}
            </p>
          ) : verify.attestationStatus === "verified-bound" ? (
            <div className="text-sm text-organic">
              <p className="font-semibold">
                Confidential Space attestation verified (RS256) + nonce/image bound.
              </p>
              <p className="mt-1 text-xs text-ink-2">
                The JWT was independently verified against Google&apos;s JWKS and its
                eat_nonce/image_digest checked. Claims shown below are the verified values.
              </p>
              {attClaims && <AttClaims claims={attClaims} nonce={bundle.nonce} />}
            </div>
          ) : (
            <div className="text-sm text-sybil">
              <p className="font-semibold">
                {attError
                  ? "Attestation could not be verified (verifier error) -- not TEE-proven."
                  : "Attestation verification FAILED -- do not treat as proven."}
              </p>
              <p className="mt-1 text-xs text-ink-2">
                {attError
                  ? "The /api/verify-attestation call did not complete, so the JWT was not " +
                    "checked against Google's JWKS. This run is not TEE-proven. Claims below " +
                    "are decoded for DISPLAY ONLY and are untrusted."
                  : "The JWT was checked against Google's JWKS (RS256 signature, issuer, exp, " +
                    "eat_nonce binding, image_digest) and did NOT pass, so this run is not " +
                    "TEE-proven. Claims below are decoded for DISPLAY ONLY and are untrusted. " +
                    "See the failure list below for which check rejected it."}
              </p>
              {attError ? (
                <p className="mt-1 break-words font-mono text-[11px] text-sybil">
                  {attError}
                </p>
              ) : null}
              {bundle.attestationNote ? (
                <p className="mt-1 text-xs text-ink-2">
                  {bundle.attestationNote}
                </p>
              ) : null}
              {attClaims && <AttClaims claims={attClaims} nonce={bundle.nonce} />}
            </div>
          )}
        </div>

        {verify.failures.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-sybil">
            {verify.failures.map((f, i) => (
              <li key={i}>• {f}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AttClaims({
  claims,
  nonce,
}: {
  claims: NonNullable<ReturnType<typeof decodeAttestationClaims>>;
  nonce: string;
}) {
  const nonceInClaim = claims.eatNonce?.some((n) => n.includes(nonce)) ?? false;
  return (
    <dl className="mt-2 grid gap-1 text-xs text-ink-2">
      <div className="flex justify-between gap-3">
        <dt className="text-ink-3">issuer</dt>
        <dd className="font-mono">{claims.issuer ?? "(none)"}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-ink-3">eat_nonce binds purchase</dt>
        <dd className={nonceInClaim ? "text-organic" : "text-sybil"}>
          {nonceInClaim ? "yes" : "no"}
        </dd>
      </div>
      {claims.imageDigest && (
        <div className="flex justify-between gap-3">
          <dt className="text-ink-3">image_digest</dt>
          <dd className="font-mono">{truncAddr(claims.imageDigest, 12, 8)}</dd>
        </div>
      )}
    </dl>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span
        className={cn(
          "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white",
          ok ? "bg-organic" : "bg-sybil",
        )}
        aria-hidden="true"
      >
        {ok ? "✓" : "✗"}
      </span>
      <span className={ok ? "text-ink-1" : "text-sybil"}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Pull a human error from a non-ok response (JSON {error}/{ok,error} or text). */
async function readError(res: Response): Promise<string> {
  try {
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const j = (await res.json()) as { error?: string; message?: string };
      return j.error ?? j.message ?? JSON.stringify(j);
    }
    return (await res.text()) || res.statusText;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

/** base64-encode a JSON-serializable object for the X-PAYMENT header. */
function base64Json(obj: unknown): string {
  const json = JSON.stringify(obj);
  if (typeof btoa === "function") {
    // utf8-safe btoa
    return btoa(
      Array.from(new TextEncoder().encode(json), (b) =>
        String.fromCharCode(b),
      ).join(""),
    );
  }
  // Node fallback (SSR safety; this component is client-only but be defensive).
  return Buffer.from(json, "utf8").toString("base64");
}
