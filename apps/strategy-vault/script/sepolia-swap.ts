#!/usr/bin/env bun
// ============================================================================
// sepolia-swap.ts — run the StrategyVault live swap on Sepolia.
//
// Pulls the funded deployer key from the macOS Keychain and hands it to
// `forge script SepoliaSwap.s.sol --broadcast` via the REAL_MONEY_PKEY env var.
// The key is loaded in-process and passed only to the forge subprocess: it is
// NEVER written to disk, never logged, never echoed. The script prints only the
// derived public address and the on-chain results.
//
//   Default (broadcast a real swap of 0.001 WETH -> USDC):
//     bun run script/sepolia-swap.ts
//   Dry run (simulate, no broadcast):
//     bun run script/sepolia-swap.ts --dry
//   Override amount (18dp wei):
//     AMOUNT_IN=2000000000000000 bun run script/sepolia-swap.ts
// ============================================================================

const KEYCHAIN_SERVICE = "rfq-cfd-deployer-pk";
const DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

/** Pull the private key from macOS Keychain. Never logged, never returned to disk. */
function getDeployerKey(): string {
	const proc = Bun.spawnSync([
		"security",
		"find-generic-password",
		"-s",
		KEYCHAIN_SERVICE,
		"-w",
	]);
	const key = new TextDecoder().decode(proc.stdout).trim();
	if (!key) {
		throw new Error(
			`${KEYCHAIN_SERVICE} not found in Keychain. ` +
				`Store it first (security add-generic-password -s ${KEYCHAIN_SERVICE} -a "$USER" -w).`,
		);
	}
	if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
		throw new Error(`${KEYCHAIN_SERVICE} is not a 0x-prefixed 32-byte hex key.`);
	}
	return key;
}

const dry = process.argv.includes("--dry");
// Any args after a literal `--` are forwarded verbatim to forge (e.g. --gas-estimate-multiplier 110).
const passIdx = process.argv.indexOf("--");
const forgePassthrough = passIdx === -1 ? [] : process.argv.slice(passIdx + 1);
const rpc = process.env.SEPOLIA_RPC_URL ?? DEFAULT_RPC;
const pk = getDeployerKey();

const args = [
	"script",
	"script/SepoliaSwap.s.sol",
	"--rpc-url",
	rpc,
	...forgePassthrough,
];
if (!dry) args.push("--broadcast");

console.log(`[sepolia-swap] ${dry ? "DRY RUN (no broadcast)" : "BROADCAST"} via ${rpc}`);
console.log(`[sepolia-swap] key loaded from Keychain service "${KEYCHAIN_SERVICE}" (value hidden)`);

// Hand the key to forge ONLY through the subprocess env. It never lands on disk.
const proc = Bun.spawn(["forge", ...args], {
	cwd: new URL("..", import.meta.url).pathname, // app root (strategy-vault/)
	env: { ...process.env, REAL_MONEY_PKEY: pk },
	stdout: "inherit",
	stderr: "inherit",
});
const code = await proc.exited;
process.exit(code);
