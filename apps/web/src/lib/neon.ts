// ============================================================================
// Neon (Postgres) read client for apps/web -- SERVER-ONLY.
//
// The per-agent dashboard (/agents, /agents/[id]) reads the SAME Neon database
// the Honeycomb MCP writes to (apps/honeycomb-mcp/db/schema.sql): the `grades`,
// `events`, `jobs`, and `tool_calls` tables. This is read-only; the MCP owns all
// writes. We only SELECT.
//
// RUNTIME NOTE: apps/web runs on Node (node:22-slim, `node server.js`), not Bun,
// so we cannot use the MCP's `import { SQL } from "bun"`. We use
// @neondatabase/serverless -- an HTTP driver that needs no pooled socket, which
// suits Cloud Run scale-to-zero (no connection to keep warm or drain).
//
// DEPENDENCY (flagged): the tables this reads are created by a teammate's Neon
// lane (apps/honeycomb-mcp/db/*), which as of 2026-06-14 is NOT yet committed to
// main. The schema is live in the Neon instance and applied; this code is built
// against it. If that schema changes before it lands, these queries may need a
// matching update.
//
// CONFIG: DATABASE_URL. When unset, dbEnabled() is false and callers render an
// honest "persistence not configured" state instead of throwing -- the rest of
// the dashboard (which uses honeycomb-api / BigQuery) is unaffected.
// ============================================================================

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | null = null;

/** True when DATABASE_URL is configured and the Neon client can be used. */
export function dbEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * The tagged-template SQL function. Throws if DATABASE_URL is unset -- callers
 * should gate on dbEnabled() first (the pages do) so this only runs when wired.
 */
export function sql(): NeonQueryFunction<false, false> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set; Neon persistence is unavailable (set it to enable /agents data)");
  }
  if (!_sql) _sql = neon(url);
  return _sql;
}
