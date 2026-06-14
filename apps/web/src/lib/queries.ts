// Server-only read layer over the materialized honeycomb.* store. Every query here hits
// a small derived table/view (~MB) — never the raw mainnet logs — so these are safe to
// call per request behind the short-TTL cache (see cache.ts). The SQL itself lives in
// bq.ts (the single source of truth); this module just types + shapes the results.
import { agentTrustSelectSql, storeMetaSql } from "./bq";
import { queryRows } from "./bqClient";

/** A row of honeycomb.agent_trust, as BigQuery returns it (snake_case columns). */
export type AgentTrustRow = {
  agent_id: number;
  owner: string | null;
  name: string | null;
  avg_score: number;
  feedback_count: number;
  unique_clients: number;
  independent_clients: number;
  reviewer_ring: number;
  trust_mult: number;
  trust_score: number;
  flags: string;
  x402_resolved: boolean;
  services: string | null;
  agent_uri: string | null;
};

/** Freshness of the store: newest event seen + when the loop last ran. */
export type StoreMeta = { asOf: string | null; asOfBlock: number | null; lastRefresh: string | null };

export function queryAgentTrust(): Promise<AgentTrustRow[]> {
  return queryRows<AgentTrustRow>(agentTrustSelectSql());
}

type MetaRow = {
  as_of_block: number | null;
  as_of: { value: string } | null; // BigQuery TIMESTAMP → { value: ISO string }
  last_refresh: { value: string } | null;
};

export async function queryStoreMeta(): Promise<StoreMeta> {
  const [r] = await queryRows<MetaRow>(storeMetaSql());
  return {
    asOfBlock: r?.as_of_block != null ? Number(r.as_of_block) : null,
    asOf: r?.as_of?.value ?? null,
    lastRefresh: r?.last_refresh?.value ?? null,
  };
}
