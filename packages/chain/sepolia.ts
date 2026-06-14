// ============================================================================
// Canonical Sepolia (chain 11155111) RPC for the whole monorepo.
//
// One source of truth so every app hits the same node. The real endpoint is a
// SECRET (Goldsky edge URL with an embedded key) and MUST NOT live in source.
// It is stored in the macOS login Keychain:
//
//   account: honeycomb   service: honeycomb_sepolia_rpc
//   read:    security find-generic-password -s honeycomb_sepolia_rpc -w
//
// Resolution order (first hit wins):
//   1. SEPOLIA_RPC env  — canonical var; set this in CI / non-mac / overrides
//   2. RPC env          — legacy var several scripts already read; kept for compat
//   3. Keychain         — the Goldsky secret, on Luke's mac (no plaintext file)
//   4. public fallback  — keyless, rate-limited; lets a fresh checkout still run
//
// The Keychain lookup is best-effort: if `security` is absent (Linux/CI) or the
// item is missing, we fall through to the public node rather than throwing, so
// the constant is always defined. Set SEPOLIA_RPC explicitly in those envs.
// ============================================================================

import { execFileSync } from "node:child_process";

export const SEPOLIA_CHAIN_ID = 11155111;

const KEYCHAIN_SERVICE = "honeycomb_sepolia_rpc";
const PUBLIC_FALLBACK = "https://ethereum-sepolia-rpc.publicnode.com";

// Treat blank/whitespace env vars as UNSET. `??` only catches undefined, so a
// stray `SEPOLIA_RPC=` in a .env would otherwise win as "" and viem's http("")
// would silently target nothing. Trim the chosen value too.
function envRpc(name: string): string | undefined {
	const v = process.env[name];
	return v && v.trim() ? v.trim() : undefined;
}

// best-effort keychain read. Distinguishes "security absent / item genuinely
// missing" (legit silent fallback) from "keychain locked / access denied"
// (surfaced on stderr per the loud-over-quiet norm — a real broadcast must not
// silently degrade to the public node). Returns undefined either way so the
// constant is always defined.
function fromKeychain(): string | undefined {
	try {
		const out = execFileSync(
			"security",
			["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		).trim();
		return out.length > 0 ? out : undefined;
	} catch (e: any) {
		// ENOENT = `security` binary absent (Linux/CI). Exit 44 = item not in
		// keychain. Both are the expected silent-fallback cases. Anything else
		// (locked keychain, permission denied) gets a one-line warning.
		const notFound = e?.code === "ENOENT" || e?.status === 44;
		if (!notFound) {
			const detail = (e?.stderr?.toString().trim() || e?.message || String(e)).split("\n")[0];
			console.warn(`[chain] keychain read of ${KEYCHAIN_SERVICE} failed, falling back to public node: ${detail}`);
		}
		return undefined;
	}
}

// Resolve in order: SEPOLIA_RPC env -> RPC env -> keychain -> public.
// `RPC` is a very generic name other tools set for unrelated reasons; if that
// branch wins over the keychain secret, say so on stderr so a stray value can't
// silently redirect a real broadcast.
function resolveRpc(): string {
	const explicit = envRpc("SEPOLIA_RPC");
	if (explicit) return explicit;
	const legacy = envRpc("RPC");
	if (legacy) {
		console.warn(`[chain] using legacy RPC env (${redactRpc(legacy)}); set SEPOLIA_RPC to silence this`);
		return legacy;
	}
	return fromKeychain() ?? PUBLIC_FALLBACK;
}

// Strip the secret before logging an RPC URL anywhere. Providers embed the key
// in DIFFERENT places: Goldsky as ?secret=... (query), Alchemy as /v2/<key> and
// Infura as /ws/v3/<key> (path). So redact BOTH: keep scheme+host and only the
// short structural path segments (v2, ws, v3, standard, evm, chain ids), and mask
// any segment that looks like an opaque key. Always drop the query string.
export function redactRpc(url: string): string {
	try {
		const u = new URL(url);
		const segs = u.pathname.split("/").filter(Boolean);
		const safe = segs.map((s) =>
			// keep short/structural segments; mask anything long or high-entropy (a key).
			/^[a-z0-9]{1,8}$/i.test(s) ? s : "<redacted>",
		);
		const path = safe.length ? `/${safe.join("/")}` : "";
		return u.search ? `${u.origin}${path}?<redacted>` : `${u.origin}${path}`;
	} catch {
		return "<unparseable-rpc>";
	}
}

export const SEPOLIA_RPC = resolveRpc();

// --- WebSocket RPC (eth_subscribe) ------------------------------------------
// The HTTP RPC above (Goldsky edge) is HTTP-ONLY — it rejects wss:// upgrades, so
// it cannot serve eth_subscribe. The live event subscriber (db/subscriber.ts)
// needs a real WS node, kept as a SEPARATE secret so the HTTP path is untouched:
//
//   account: honeycomb   service: honeycomb_sepolia_ws
//   value:   wss://eth-sepolia.g.alchemy.com/v2/<key>   (Alchemy/Infura both work)
//
// Resolution: SEPOLIA_WS env -> keychain honeycomb_sepolia_ws -> undefined.
// Unlike the HTTP RPC there is NO public fallback: a keyless public node won't
// hold a reliable subscription, and silently degrading a "nothing-missed" watcher
// to a flaky endpoint would defeat its purpose. The subscriber throws loudly when
// this is undefined rather than pretend to watch.
const WS_KEYCHAIN_SERVICE = "honeycomb_sepolia_ws";

function fromKeychainWs(): string | undefined {
	try {
		const out = execFileSync(
			"security",
			["find-generic-password", "-s", WS_KEYCHAIN_SERVICE, "-w"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		).trim();
		return out.length > 0 ? out : undefined;
	} catch (e: any) {
		const notFound = e?.code === "ENOENT" || e?.status === 44;
		if (!notFound) {
			const detail = (e?.stderr?.toString().trim() || e?.message || String(e)).split("\n")[0];
			console.warn(`[chain] keychain read of ${WS_KEYCHAIN_SERVICE} failed: ${detail}`);
		}
		return undefined;
	}
}

// undefined when no WS endpoint is configured — callers decide whether that's fatal.
export const SEPOLIA_WS: string | undefined = envRpc("SEPOLIA_WS") ?? fromKeychainWs();

// --- Mainnet WebSocket RPC --------------------------------------------------
// Same story on mainnet: the Goldsky HTTP edge (honeycomb_mainnet_rpc_http) is
// HTTP-only, so the live subscriber needs a separate WS node. Stored alongside
// the HTTP secret:
//
//   account: honeycomb   service: honeycomb_mainnet_rpc_wss
//   value:   wss://eth-mainnet.g.alchemy.com/v2/<key>
//
// Resolution: HONEYCOMB_WS env -> keychain honeycomb_mainnet_rpc_wss -> undefined.
// No public fallback, for the same reason as Sepolia: a flaky keyless socket
// silently degrades a "nothing-missed" watcher. The subscriber throws loudly
// when the WS for the active chain is undefined rather than pretend to watch.
const MAINNET_WS_KEYCHAIN_SERVICE = "honeycomb_mainnet_rpc_wss";

function fromKeychainMainnetWs(): string | undefined {
	try {
		const out = execFileSync(
			"security",
			["find-generic-password", "-s", MAINNET_WS_KEYCHAIN_SERVICE, "-w"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		).trim();
		return out.length > 0 ? out : undefined;
	} catch (e: any) {
		const notFound = e?.code === "ENOENT" || e?.status === 44;
		if (!notFound) {
			const detail = (e?.stderr?.toString().trim() || e?.message || String(e)).split("\n")[0];
			console.warn(`[chain] keychain read of ${MAINNET_WS_KEYCHAIN_SERVICE} failed: ${detail}`);
		}
		return undefined;
	}
}

export const MAINNET_WS: string | undefined = envRpc("HONEYCOMB_WS") ?? fromKeychainMainnetWs();
