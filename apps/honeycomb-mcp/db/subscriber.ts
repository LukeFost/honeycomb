// ============================================================================
// Live chain-event subscriber: the "hook that watches" for on-chain data.
//
// Bounty lifecycle events (JobCreated / ScoreRecorded / ValidityRecorded /
// NewLeader / JobResolved) happen ON the Sepolia escrow, NOT through our API —
// a maker funds from their own wallet, a CRE attestor records via the relay, a
// settlement fires from the contract. None of those are HTTP calls we could hook.
// So to capture them event-driven (nothing missed, no polling interval), we hold
// an eth_subscribe WebSocket to the node and get pushed every matching log the
// instant it's mined.
//
// This is the chain-data counterpart to:
//   • telemetry.ts  — every API tool call, recorded inline
//   • grade.ts       — every grade, recorded inline
// All three write to the same Neon DB. This one is the only stream that needs a
// listener, because its events originate off-server.
//
// Requires a REAL WebSocket node (SEPOLIA_WS / keychain honeycomb_sepolia_ws);
// the default Goldsky HTTP RPC cannot do eth_subscribe. Throws loudly if absent.
//
// Resilience:
//   • Backfill on start: one runSnapshot() before subscribing, so anything mined
//     while this process was down is caught. The events PK dedups the overlap.
//   • viem's webSocket transport auto-reconnects on drop; on each (re)subscribe we
//     also re-run the backfill via onError->resubscribe so a gap during a
//     disconnect is closed.
//   • Per-log try/catch: one malformed log can never kill the stream.
//
// Run:  DATABASE_URL=... bun db/subscriber.ts        (long-lived; Ctrl-C to stop)
// ============================================================================

import { createPublicClient, webSocket } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { SEPOLIA_WS, MAINNET_WS, redactRpc } from "@honeycomb/chain/sepolia";
import { ESCROW, ESCROW_ABI, MAINNET } from "../chain.ts";

// Subscribe on the SAME chain the rest of the engine targets (chain.ts MAINNET).
// ESCROW already flips with that flag; the WS node and viem chain must follow it
// or we'd point a Sepolia socket at the mainnet escrow (watching forever, seeing
// nothing). One source of truth: HONEYCOMB_CHAIN=mainnet.
const WATCH_CHAIN = MAINNET ? mainnet : sepolia;
const WATCH_WS = MAINNET ? MAINNET_WS : SEPOLIA_WS;
import { db, applySchema, runSnapshot, upsertOneJob, insertEventRow } from "./snapshot.ts";
import type { SQL } from "bun";

const WATCHED_EVENTS = [
	"JobCreated",
	"ScoreRecorded",
	"ValidityRecorded",
	"NewLeader",
	"JobResolved",
] as const;

// Normalize a viem decoded log into the {block, tx, logIndex, ...args} shape that
// insertEventRow expects — identical to what tools/monitor.ts jobEvents produces,
// so the subscriber and the snapshot write byte-for-byte compatible event rows.
function shapeLog(log: any): Record<string, unknown> {
	const out: Record<string, unknown> = {
		block: Number(log.blockNumber),
		tx: log.transactionHash,
		logIndex: Number(log.logIndex ?? 0),
	};
	const args = (log.args ?? {}) as Record<string, unknown>;
	for (const [k, v] of Object.entries(args)) out[k] = typeof v === "bigint" ? v.toString() : v;
	return out;
}

// Persist one live log: append the event row + refresh the affected job's current
// state (a ScoreRecorded/NewLeader changes bestScore/gradeCount; JobResolved sets
// settled/winner). Both idempotent. Errors are logged, not thrown, so the stream
// survives a transient DB blip on a single log.
async function handleLog(sql: SQL, name: string, log: any) {
	try {
		const e = shapeLog(log);
		const inserted = await insertEventRow(sql, name, e);
		const jobId = e.jobId as string | undefined;
		if (jobId !== undefined) {
			await upsertOneJob(sql, jobId).catch((err) =>
				console.error(`[subscriber] upsertOneJob(${jobId}) failed:`, err?.message ?? err),
			);
		}
		if (inserted) {
			console.error(`[subscriber] +${name} job=${jobId ?? "?"} tx=${String(e.tx).slice(0, 12)}… block=${e.block}`);
		}
	} catch (err: any) {
		console.error(`[subscriber] handleLog(${name}) failed:`, err?.message ?? err);
	}
}

// Wire up the backfill + live watchers and RETURN without blocking. The returned
// `stop()` closes the subscriptions and the DB connection. Shared by two callers:
//   • the standalone CLI (main, below) which then awaits forever + handles signals
//   • the always-on honeycomb-api which CO-LOCATES the subscriber in its process
//     (server.ts boot) — it owns the event loop via Bun.serve, so this function
//     must not install signal handlers or call process.exit (that's the host's job).
// Throws if no WS node is configured — the caller decides whether that's fatal
// (the CLI exits; the API logs and keeps serving the other two streams).
export async function startSubscriber(): Promise<{ stop: () => Promise<void> }> {
	if (!WATCH_WS) {
		const svc = MAINNET ? "honeycomb_mainnet_rpc_wss (or HONEYCOMB_WS)" : "honeycomb_sepolia_ws (or SEPOLIA_WS)";
		throw new Error(
			`no WebSocket RPC configured for ${WATCH_CHAIN.name} (set keychain ${svc}). ` +
				"The default HTTP RPC cannot do eth_subscribe — the subscriber needs a real WS node (Alchemy/Infura).",
		);
	}

	const sql = db();
	await applySchema(sql);
	console.error(`[subscriber] DB ready; chain=${WATCH_CHAIN.name} WS = ${redactRpc(WATCH_WS)}`);

	// Backfill anything mined while we were down. Overlap is harmless (events PK dedups).
	try {
		const bf = await runSnapshot({ jobsLimit: 50 });
		console.error(`[subscriber] backfill: jobsUpserted=${bf.jobsUpserted} newEvents=${bf.newEvents}`);
	} catch (err: any) {
		console.error("[subscriber] backfill failed (continuing to live subscribe):", err?.message ?? err);
	}

	const client = createPublicClient({
		chain: WATCH_CHAIN,
		transport: webSocket(WATCH_WS, {
			// viem auto-reconnects the socket; keep retrying rather than giving up.
			reconnect: { attempts: Number.MAX_SAFE_INTEGER, delay: 2_000 },
			retryCount: 10,
		}),
	});

	// One watchEvent per event name. viem maps each to an eth_subscribe("logs",...)
	// over the WS transport, pushing matching logs as they're mined. onError fires on
	// a transport drop; viem reconnects underneath, and we re-backfill to close any
	// gap that opened during the disconnect.
	const unwatchers = WATCHED_EVENTS.map((name) => {
		const eventAbi = ESCROW_ABI.find((x) => x.type === "event" && x.name === name);
		if (!eventAbi) throw new Error(`event ${name} missing from ESCROW_ABI`);
		return client.watchEvent({
			address: ESCROW,
			event: eventAbi as any,
			onLogs: (logs) => {
				for (const log of logs) void handleLog(sql, name, log);
			},
			onError: (err) => {
				console.error(`[subscriber] watch(${name}) error (will reconnect):`, err?.message ?? err);
				// Close the gap a disconnect may have opened. Detached; dedup makes it safe.
				runSnapshot({ jobsLimit: 50 })
					.then((bf) => console.error(`[subscriber] reconnect backfill: newEvents=${bf.newEvents}`))
					.catch(() => {});
			},
		});
	});

	console.error(`[subscriber] LIVE — watching ${WATCHED_EVENTS.length} events on ${ESCROW}`);

	return {
		stop: async () => {
			console.error("[subscriber] shutting down…");
			for (const off of unwatchers) {
				try {
					off();
				} catch {}
			}
			await sql.end().catch(() => {});
		},
	};
}

// Fire-and-forget boot for an embedding host (honeycomb-api). No-op unless BOTH
// DATABASE_URL and SEPOLIA_WS are set, so a read-only/local API run or the plugin
// shim never tries to subscribe. Never throws into the caller and never touches
// process exit — a subscriber failure must not take down the API serving the other
// two streams; it's surfaced loudly on stderr instead.
export function startSubscriberIfConfigured(): void {
	if (!process.env.DATABASE_URL || !WATCH_WS) {
		const wsHint = MAINNET ? "honeycomb_mainnet_rpc_wss" : "SEPOLIA_WS";
		console.error(
			`[subscriber] not started (need DATABASE_URL + ${wsHint}); chain stream relies on POST /snapshot until configured`,
		);
		return;
	}
	startSubscriber().catch((e) =>
		console.error("[subscriber] failed to start (API still serving):", e?.message ?? e),
	);
}

async function main() {
	const { stop } = await startSubscriber();
	// Standalone CLI owns the event loop: install signal handlers and run forever.
	const shutdown = () => {
		stop().finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	await new Promise(() => {}); // run forever
}

if (import.meta.main) {
	main().catch((e) => {
		console.error("subscriber failed:", e?.message ?? e);
		process.exit(1);
	});
}
