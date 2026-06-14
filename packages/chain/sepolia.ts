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

// Strip the secret before logging an RPC URL anywhere. Drops the query string
// (Goldsky embeds the key as ?secret=...) and keeps just scheme+host+path.
export function redactRpc(url: string): string {
	try {
		const u = new URL(url);
		return u.search ? `${u.origin}${u.pathname}?<redacted>` : `${u.origin}${u.pathname}`;
	} catch {
		return "<unparseable-rpc>";
	}
}

export const SEPOLIA_RPC = resolveRpc();
