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
	"Submitted",
	"ScoreRecorded",
	"ValidityRecorded",
	"NewLeader",
	"JobResolved",
] as const;

export function db(): SQL {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL not set (keychain honeycomb_database_url; see run-with-secrets.sh)");
	return new SQL(url);
}

export async function applySchema(sql: SQL) {
	const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
	await sql.unsafe(schema);
}

// --- jobs: upsert current state ---------------------------------------------
// Upsert ONE job's full struct (getJob multicall) into `jobs`. Shared by the
// snapshot loop and the live subscriber, so both write the identical column set.
export async function upsertOneJob(sql: SQL, jobId: string) {
	const { getJob } = await import("../tools/monitor.ts");
	const j = await getJob({ jobId });
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
}

async function upsertJobs(sql: SQL, limit: number) {
	const { jobs } = await listJobs({ limit });
	// list_jobs returns the compact projection; refetch the full struct per job so we
	// persist every column (and settled/winner). get_job is one multicall each — fine
	// for a snapshot of tens of jobs.
	let written = 0;
	for (const row of jobs) {
		await upsertOneJob(sql, row.id);
		written++;
	}
	return written;
}

// --- events: append new chain logs ------------------------------------------
// Insert ONE decoded event row (the {block, tx, logIndex, ...args} shape both
// jobEvents and the subscriber produce). Idempotent on (tx_hash, log_index):
// re-seeing a log over an overlapping range, OR a subscriber/snapshot both seeing
// the same log, never duplicates. Returns 1 if inserted, 0 if already present.
export async function insertEventRow(sql: SQL, name: string, e: Record<string, unknown>) {
	const { block, tx, logIndex, jobId, agentId, winnerAgentId, ...rest } = e;
	const agent = (agentId ?? winnerAgentId ?? null) as string | null;
	const res = await sql`
		INSERT INTO events (tx_hash, log_index, block_number, event_name, job_id, agent_id, payload)
		VALUES (
			${tx as string},
			${(logIndex as number) ?? 0},
			${block as number},
			${name},
			${(jobId as string) ?? null},
			${agent},
			${JSON.stringify({ jobId, agentId, winnerAgentId, ...rest })}::jsonb
		)
		ON CONFLICT (tx_hash, log_index) DO NOTHING
	`;
	return res.count ?? 0;
}

async function appendEvents(sql: SQL, lookback?: string) {
	let inserted = 0;
	for (const name of EVENT_NAMES) {
		const { events } = await jobEvents({ eventName: name, fromBlock: lookback });
		for (const e of events) {
			inserted += await insertEventRow(sql, name, e as Record<string, unknown>);
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

// --- gcs_objects: index one off-chain content blob (spec / sealed submission) --
// Mirror of a GCS put into the DB content-layer index. Called from the put paths
// (createBounty spec upload, submitWork seal+upload) right after the bytes land in
// the bucket. Parses the gcs://<bucket>/<sha256> URI for its key, so the caller only
// has to hand over the URI it already got back from putContent/putText.
//
// Fire-and-forget by construction: this is telemetry, not the bounty itself. A
// missing DATABASE_URL or a failed write must NEVER fail a create or a submit, so
// every failure is swallowed here (logged to stderr) rather than raised. This is a
// deliberate, narrowly-scoped exception to the loud-failure rule — same posture as
// the tool_calls telemetry — and the swallowed error is still surfaced on stderr.
export async function recordGcsObject(o: {
	uri: string;
	kind: "spec" | "submission";
	contentType?: string;
	byteLen?: number;
	jobId?: string | number | null;
	agentId?: string | number | null;
	submitTx?: string | null;
	sealed?: boolean;
}) {
	if (!process.env.DATABASE_URL) {
		// No DB configured (e.g. local dev without the keychain secret). Skip quietly —
		// the content is already in GCS and on-chain; the index is best-effort.
		return;
	}
	let sql: SQL | null = null;
	try {
		// gcs://bucket/sha256 — pull the parts back out of the URI the put returned.
		const m = /^gcs:\/\/([^/]+)\/(.+)$/.exec(o.uri.trim());
		if (!m) throw new Error(`recordGcsObject: not a gcs:// URI: ${o.uri}`);
		const [, bucket, sha256] = m;
		sql = db();
		await applySchema(sql); // idempotent; ensures gcs_objects exists on first call
		await sql`
			INSERT INTO gcs_objects (
				bucket, sha256, uri, kind, content_type, byte_len,
				job_id, agent_id, submit_tx, sealed
			) VALUES (
				${bucket}, ${sha256}, ${o.uri}, ${o.kind}, ${o.contentType ?? null}, ${o.byteLen ?? null},
				${o.jobId != null ? String(o.jobId) : null},
				${o.agentId != null ? String(o.agentId) : null},
				${o.submitTx ?? null},
				${o.sealed ?? o.kind === "submission"}
			)
			ON CONFLICT (bucket, sha256) DO UPDATE SET
				-- same bytes can be re-seen for a job/agent we didn't know the first time
				-- (e.g. spec uploaded pre-create, then linked at create). Backfill the link
				-- fields without overwriting an existing value with null.
				job_id    = COALESCE(EXCLUDED.job_id,    gcs_objects.job_id),
				agent_id  = COALESCE(EXCLUDED.agent_id,  gcs_objects.agent_id),
				submit_tx = COALESCE(EXCLUDED.submit_tx, gcs_objects.submit_tx)
		`;
	} catch (e) {
		// Telemetry only — log and move on, never propagate.
		console.error("recordGcsObject failed (non-fatal):", (e as Error)?.message ?? e);
	} finally {
		if (sql) await sql.end();
	}
}

// Run one full snapshot (schema + jobs upsert + events append) against a fresh
// connection and return the counts. Exported so the always-on honeycomb-api can
// trigger it in-process via POST /snapshot (Cloud Scheduler), independent of any
// laptop or Claude session. Opens and closes its own connection each call.
export async function runSnapshot(opts: { jobsLimit?: number; lookback?: string } = {}) {
	if (opts.lookback) process.env.LOGS_LOOKBACK = opts.lookback;
	const sql = db();
	try {
		await applySchema(sql);
		const jobsUpserted = await upsertJobs(sql, opts.jobsLimit ?? 25);
		const newEvents = await appendEvents(sql);
		return { ok: true as const, jobsUpserted, newEvents };
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
	const result = await runSnapshot({ jobsLimit, lookback: lookbackArg });
	console.log(JSON.stringify(result));
}

if (import.meta.main) {
	main().catch((e) => {
		console.error("snapshot failed:", e?.message ?? e);
		process.exit(1);
	});
}
