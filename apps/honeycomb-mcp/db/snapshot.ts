// ============================================================================
// Snapshot the live BountyEscrow (Sepolia) state into Neon Postgres.
//
// Reuses the SAME read functions the MCP monitor exposes (tools/monitor.ts) so
// there is one source of truth for the chain decode:
//   • list_jobs  -> UPSERT one row per job into `jobs` (current state)
//   • job_events -> APPEND new chain logs into `events` (deduped on tx+logIndex)
//
// Grades are written separately by `recordGrade()` (imported by grade.ts / a
// caller), not snapshotted from chain — the grader output isn't fully on-chain.
//
// Run:
//   DATABASE_URL=... bun db/snapshot.ts            # all default events, 25 jobs
//   DATABASE_URL=... bun db/snapshot.ts --jobs 50 --lookback 20000
//
// DATABASE_URL comes from the keychain in production (see run-with-secrets.sh).
// No silent fallback: a missing URL or a failed write throws loudly.
// ============================================================================

import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listJobs, jobEvents } from "../tools/monitor.ts";

const EVENT_NAMES = [
	"JobCreated",
	"ScoreRecorded",
	"ValidityRecorded",
	"NewLeader",
	"JobResolved",
] as const;

function db(): SQL {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL not set (keychain honeycomb_database_url; see run-with-secrets.sh)");
	return new SQL(url);
}

async function applySchema(sql: SQL) {
	const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
	await sql.unsafe(schema);
}

// --- jobs: upsert current state ---------------------------------------------
async function upsertJobs(sql: SQL, limit: number) {
	const { jobs } = await listJobs({ limit });
	// list_jobs returns the compact projection; refetch the full struct per job so we
	// persist every column (and settled/winner). get_job is one multicall each — fine
	// for a snapshot of tens of jobs.
	const { getJob } = await import("../tools/monitor.ts");
	let written = 0;
	for (const row of jobs) {
		const j = await getJob({ jobId: row.id });
		await sql`
			INSERT INTO jobs (
				job_id, status, status_name, client, provider, evaluator,
				budget, budget_usdc, expired_at, expired_at_iso, token, tests_hash,
				spec_cid, attester_key, maker_pubkey, enclave_enc_pub, hook, is_contest,
				best_agent_id, best_score, best_score_att, best_validity_att, grade_count,
				winner_delivery_cid, settled, winner_wallet, updated_at
			) VALUES (
				${j.id}, ${j.status}, ${j.statusName}, ${j.client}, ${j.provider}, ${j.evaluator},
				${j.budget}, ${j.budgetUSDC}, ${j.expiredAt}, ${j.expiredAtISO}, ${j.token}, ${j.testsHash},
				${j.specCid}, ${j.attesterKey}, ${j.makerPubKey}, ${j.enclaveEncPub}, ${j.hook}, ${j.isContest},
				${j.bestAgentId}, ${j.bestScore}, ${j.bestScoreAtt}, ${j.bestValidityAtt}, ${j.gradeCount},
				${j.winnerDeliveryCid}, ${j.settled}, ${j.winnerWallet}, now()
			)
			ON CONFLICT (job_id) DO UPDATE SET
				status = EXCLUDED.status, status_name = EXCLUDED.status_name,
				client = EXCLUDED.client, provider = EXCLUDED.provider, evaluator = EXCLUDED.evaluator,
				budget = EXCLUDED.budget, budget_usdc = EXCLUDED.budget_usdc,
				expired_at = EXCLUDED.expired_at, expired_at_iso = EXCLUDED.expired_at_iso,
				token = EXCLUDED.token, tests_hash = EXCLUDED.tests_hash, spec_cid = EXCLUDED.spec_cid,
				attester_key = EXCLUDED.attester_key, maker_pubkey = EXCLUDED.maker_pubkey,
				enclave_enc_pub = EXCLUDED.enclave_enc_pub, hook = EXCLUDED.hook, is_contest = EXCLUDED.is_contest,
				best_agent_id = EXCLUDED.best_agent_id, best_score = EXCLUDED.best_score,
				best_score_att = EXCLUDED.best_score_att, best_validity_att = EXCLUDED.best_validity_att,
				grade_count = EXCLUDED.grade_count, winner_delivery_cid = EXCLUDED.winner_delivery_cid,
				settled = EXCLUDED.settled, winner_wallet = EXCLUDED.winner_wallet, updated_at = now()
		`;
		written++;
	}
	return written;
}

// --- events: append new chain logs ------------------------------------------
async function appendEvents(sql: SQL, lookback?: string) {
	let inserted = 0;
	for (const name of EVENT_NAMES) {
		const { events } = await jobEvents({ eventName: name, fromBlock: lookback });
		for (const e of events) {
			const { block, tx, jobId, agentId, winnerAgentId, ...rest } = e as Record<string, unknown>;
			const agent = (agentId ?? winnerAgentId ?? null) as string | null;
			// ON CONFLICT DO NOTHING makes this idempotent: re-running the snapshot over an
			// overlapping block range never duplicates a log (PK is tx_hash+log_index).
			const res = await sql`
				INSERT INTO events (tx_hash, log_index, block_number, event_name, job_id, agent_id, payload)
				VALUES (
					${tx as string},
					${(e as any).logIndex ?? 0},
					${block as number},
					${name},
					${(jobId as string) ?? null},
					${agent},
					${JSON.stringify({ jobId, agentId, winnerAgentId, ...rest })}::jsonb
				)
				ON CONFLICT (tx_hash, log_index) DO NOTHING
			`;
			inserted += res.count ?? 0;
		}
	}
	return inserted;
}

// --- grades: append one grader result (called by grade.ts wiring, not chain) -
export async function recordGrade(callback: Record<string, any>, bounty?: string) {
	const sql = db();
	try {
		const { graderLog, ...clean } = callback;
		await sql`
			INSERT INTO grades (
				job_id, agent_id, bounty, score, valid, score_digest, validity_att,
				attestation_source, signer, local_score, callback
			) VALUES (
				${callback.jobId?.toString() ?? null},
				${callback.agentId?.toString() ?? null},
				${bounty ?? null},
				${callback.score ?? null},
				${callback.valid ?? null},
				${callback.scoreDigest ?? null},
				${callback.validityAtt ?? callback.validityAttestation ?? null},
				${callback.attestationSource ?? null},
				${callback.signer ?? null},
				${callback.localScore ?? null},
				${JSON.stringify(clean)}::jsonb
			)
		`;
	} finally {
		await sql.end();
	}
}

async function main() {
	const argv = process.argv.slice(2);
	const jobsLimit = Number(argv[argv.indexOf("--jobs") + 1]) || 25;
	const lookbackArg = argv.indexOf("--lookback") >= 0 ? argv[argv.indexOf("--lookback") + 1] : undefined;
	// jobEvents takes fromBlock as an absolute block; --lookback is a convenience for
	// "tip minus N", which jobEvents already does by default, so just pass through env.
	if (lookbackArg) process.env.LOGS_LOOKBACK = lookbackArg;

	const sql = db();
	try {
		await applySchema(sql);
		const jobsWritten = await upsertJobs(sql, jobsLimit);
		const eventsWritten = await appendEvents(sql);
		console.log(JSON.stringify({ ok: true, jobsUpserted: jobsWritten, newEvents: eventsWritten }));
	} finally {
		await sql.end();
	}
}

if (import.meta.main) {
	main().catch((e) => {
		console.error("snapshot failed:", e?.message ?? e);
		process.exit(1);
	});
}
