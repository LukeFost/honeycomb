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

function fromKeychain(): string | undefined {
	try {
		const out = execFileSync(
			"security",
			["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		return out.length > 0 ? out : undefined;
	} catch {
		// security missing (non-mac) or item not found — fall through.
		return undefined;
	}
}

export const SEPOLIA_RPC =
	process.env.SEPOLIA_RPC ??
	process.env.RPC ??
	fromKeychain() ??
	PUBLIC_FALLBACK;
