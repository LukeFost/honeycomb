// Server-only helpers shared by the read endpoints. Every read returns a freshness stamp
// ({ data, asOf, asOfBlock }) so MCP servers / agent pollers can tell how current the
// store is; errors map BigQuery-unavailable to 503 (degraded) vs 500 (unexpected).
import { NextResponse } from "next/server";
import { BigQueryUnavailableError } from "./bqClient";

export type Freshness = { asOf: string | null; asOfBlock: number | null };

export function jsonData<T>(data: T, meta: Freshness, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ data, asOf: meta.asOf, asOfBlock: meta.asOfBlock, ...extra });
}

export function jsonError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  const status = e instanceof BigQueryUnavailableError ? 503 : 500;
  return NextResponse.json({ error: message }, { status });
}
