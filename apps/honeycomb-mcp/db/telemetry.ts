// ============================================================================
// Tool-call telemetry: persist every Honeycomb MCP tool invocation (forwarded
// through honeycomb-api) into Neon Postgres `tool_calls`.
//
// This is the ONE place that sees every get_job / grade_submission / etc. call —
// the plugin shim just forwards to the API, so the API's route() chokepoint is
// where telemetry belongs. A laptop cron can never capture this; it's not in the
// call path. See db/snapshot.ts for the chain-data half of persistence.
//
// Design:
//   • One long-lived pooled SQL connection per API process (tool calls are
//     frequent; open/close-per-call like recordGrade would be wasteful here).
//   • Schema applied once, lazily, on first use (idempotent CREATE IF NOT EXISTS).
//   • Writes are FIRE-AND-FORGET: record() never throws and never blocks the
//     caller's response. A telemetry failure logs to stderr and is swallowed —
//     persistence must never fail the underlying bounty/grade call. This is the
//     one sanctioned swallow (per CLAUDE.md escape hatch): the failure is still
//     surfaced via the stderr warning, just not propagated to the user request.
//   • Disabled cleanly when DATABASE_URL is unset: record() becomes a no-op so
//     the API runs identically with or without telemetry wired.
//
// "Log everything": the full request body (incl. submission source) and full
// response are captured. This DB is a complete replay log, not just metadata.
// ============================================================================

import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ToolCall = {
	tool: string;
	method: string;
	path: string;
	query?: Record<string, unknown> | null;
	request?: unknown;
	response?: unknown;
	status: number;
	latencyMs: number;
	caller?: string | null;
	remoteAddr?: string | null;
};

let sql: SQL | null = null;
let schemaReady: Promise<void> | null = null;
let disabled = false;

// Lazily open the shared connection + apply schema. Returns null when telemetry
// is disabled (no DATABASE_URL) so callers no-op cleanly.
function conn(): SQL | null {
	if (disabled) return null;
	if (sql) return sql;
	const url = process.env.DATABASE_URL;
	if (!url) {
		// First call with no DB configured: announce once, then stay quiet.
		console.error("[telemetry] DATABASE_URL unset — tool-call logging disabled");
		disabled = true;
		return null;
	}
	sql = new SQL(url);
	schemaReady = sql
		.unsafe(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"))
		.then(() => undefined)
		.catch((e) => {
			console.error("[telemetry] schema apply failed:", e?.message ?? e);
		});
	return sql;
}

// JSON-safe stringify that tolerates bigints (chain ids/budgets) and circular
// refs, so a weird payload never throws inside the telemetry path itself.
function safeJson(value: unknown): string | null {
	if (value === undefined) return null;
	try {
		const seen = new WeakSet();
		return JSON.stringify(value, (_k, v) => {
			if (typeof v === "bigint") return v.toString();
			if (typeof v === "object" && v !== null) {
				if (seen.has(v)) return "[circular]";
				seen.add(v);
			}
			return v;
		});
	} catch {
		return JSON.stringify({ unserializable: String(value).slice(0, 500) });
	}
}

// Record one tool call. Fire-and-forget: returns immediately, never throws.
// The caller does NOT await this (or awaits it only in a detached .catch).
export function record(call: ToolCall): void {
	const db = conn();
	if (!db) return;
	const q = safeJson(call.query ?? null);
	const reqBody = safeJson(call.request);
	const resBody = safeJson(call.response);
	const ok = call.status < 400;
	// Wait for the schema, then insert. Detached promise: any error is logged,
	// not thrown, so the API request that triggered this is unaffected.
	(schemaReady ?? Promise.resolve())
		.then(() =>
			db`
				INSERT INTO tool_calls (
					tool, method, path, query, request, response,
					status, ok, latency_ms, caller, remote_addr
				) VALUES (
					${call.tool}, ${call.method}, ${call.path},
					${q}::jsonb, ${reqBody}::jsonb, ${resBody}::jsonb,
					${call.status}, ${ok}, ${Math.round(call.latencyMs)},
					${call.caller ?? null}, ${call.remoteAddr ?? null}
				)
			`,
		)
		.catch((e) => {
			console.error("[telemetry] insert failed:", e?.message ?? e);
		});
}
