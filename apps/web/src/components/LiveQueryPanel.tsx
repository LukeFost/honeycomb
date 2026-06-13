"use client";

import { useState } from "react";
import { Chip, cn, truncAddr } from "./ui";

type QueryDef = { key: string; title: string; sql: string };
type Registry = { label: string; address: string };

type LiveResult = {
  available: boolean;
  mode: "dryrun" | "run";
  project: string | null;
  start: string;
  results: { key: string; title: string; scanGb: number; billedGb: number; count: number | null; cacheHit: boolean }[];
  totalScanGb: number;
  totalBilledGb: number;
  estCostUsd: number;
  cacheHit: boolean;
  error?: string;
};

export default function LiveQueryPanel({
  dataset,
  start,
  queries,
  registries,
  validation,
}: {
  dataset: string;
  start: string;
  queries: QueryDef[];
  registries: Registry[];
  validation: { label: string; address: string; status: string; eventName: string; topic0: string };
}) {
  const [loading, setLoading] = useState<null | "dryrun" | "run">(null);
  const [result, setResult] = useState<LiveResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run(mode: "dryrun" | "run") {
    setLoading(mode);
    setErr(null);
    try {
      const res = await fetch(`/api/bigquery?mode=${mode}`, { method: "POST" });
      const data: LiveResult = await res.json();
      if (!data.available) setErr(data.error ?? "BigQuery is not available in this environment.");
      setResult(data);
    } catch {
      setErr("Request failed — is the dev server running with the service-account key in place?");
      setResult(null);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
      {/* left: provenance + SQL */}
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Chip tone="honey">BigQuery</Chip>
          <span className="font-mono text-zinc-500">{dataset}</span>
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          {registries.map((r) => (
            <a
              key={r.address}
              href={`https://etherscan.io/address/${r.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group rounded-lg border border-edge bg-black/30 px-3 py-1.5 transition-colors hover:border-honey/40"
            >
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">{r.label}</div>
              <div className="font-mono text-xs text-zinc-300 group-hover:text-honey-bright">
                <span className="text-honey">0x8004</span>
                {truncAddr(r.address).slice(6)}
              </div>
            </a>
          ))}
          <div className="rounded-lg border border-honey/20 bg-honey/[0.04] px-3 py-1.5" title={validation.topic0}>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">{validation.label}</div>
            {validation.address ? (
              <a
                href={`https://etherscan.io/address/${validation.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-honey-bright hover:underline"
              >
                {truncAddr(validation.address)}
              </a>
            ) : (
              <div className="font-mono text-xs text-honey/70">{validation.status}</div>
            )}
            <div className="font-mono text-[10px] text-zinc-600">
              {validation.eventName} · {validation.topic0.slice(0, 10)}…
            </div>
          </div>
        </div>

        <div className="space-y-3">
          {queries.map((q) => (
            <div key={q.key} className="overflow-hidden rounded-lg border border-edge">
              <div className="border-b border-edge bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-400">
                {q.title}
              </div>
              <pre className="thin-scroll overflow-x-auto bg-black/40 p-3 text-[11px] leading-relaxed text-zinc-300">
                <code>{q.sql}</code>
              </pre>
            </div>
          ))}
        </div>
      </div>

      {/* right: run controls + result */}
      <div className="flex flex-col">
        <div className="mb-3 flex gap-2">
          <button
            onClick={() => run("dryrun")}
            disabled={loading !== null}
            className="flex-1 rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-sm font-semibold text-honey-bright transition-colors hover:bg-honey/20 disabled:opacity-50"
          >
            {loading === "dryrun" ? "Estimating…" : "Estimate · dry run (free)"}
          </button>
          <button
            onClick={() => run("run")}
            disabled={loading !== null}
            className="flex-1 rounded-lg border border-edge bg-white/[0.04] px-3 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:bg-white/[0.08] disabled:opacity-50"
          >
            {loading === "run" ? "Querying…" : "Run live query"}
          </button>
        </div>

        <div className="flex-1 rounded-xl border border-edge bg-black/30 p-4">
          {!result && !err && (
            <p className="text-sm text-zinc-500">
              Run the actual SQL against Ethereum mainnet via BigQuery. A <span className="text-honey-bright">dry run</span> estimates
              bytes scanned for free; a live run executes server-side with the service-account key and returns the on-chain counts.
            </p>
          )}

          {err && (
            <div className="rounded-lg border border-sybil/30 bg-sybil/10 p-3 text-sm text-sybil">
              {err}
            </div>
          )}

          {result && result.available && (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <Chip tone={result.mode === "run" ? "organic" : "honey"}>
                  {result.mode === "run" ? "Live execution" : "Dry run"}
                </Chip>
                {result.mode === "run" && result.cacheHit && <Chip tone="honey">⚡ cached</Chip>}
                <span>
                  project <span className="font-mono text-zinc-300">{result.project ?? "—"}</span>
                </span>
                <span>
                  from <span className="font-mono text-zinc-300">{result.start}</span>
                </span>
              </div>

              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="py-1.5 font-semibold">Query</th>
                    <th className="py-1.5 text-right font-semibold">Scans</th>
                    <th className="py-1.5 text-right font-semibold">{result.mode === "run" ? "Result" : "—"}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((r) => (
                    <tr key={r.key} className="border-t border-white/[0.06]">
                      <td className="py-2 text-zinc-300">{r.title}</td>
                      <td className="py-2 text-right tabular-nums text-zinc-400 tnum">{r.scanGb.toFixed(1)} GB</td>
                      <td className="py-2 text-right tabular-nums font-semibold text-honey-bright tnum">
                        {r.count == null ? "—" : r.count.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-3 border-t border-white/[0.06] pt-3 text-xs leading-5 text-zinc-500">
                {result.mode === "dryrun" ? (
                  <span>
                    Estimate only — these queries would scan{" "}
                    <span className="tnum text-zinc-300">{result.totalScanGb.toFixed(1)} GB</span>. Dry runs are free; nothing was billed.
                  </span>
                ) : result.cacheHit ? (
                  <span>
                    <span className="text-organic">Served from cache → 0 bytes billed ($0.00).</span> Uncached, this query scans{" "}
                    <span className="tnum text-zinc-300">{result.totalScanGb.toFixed(1)} GB</span> of mainnet logs — within the 1 TiB/mo free tier.
                  </span>
                ) : (
                  <span>
                    Billed <span className="tnum text-zinc-300">{result.totalBilledGb.toFixed(1)} GB</span> ≈{" "}
                    <span className="text-zinc-300">${result.estCostUsd.toFixed(2)}</span> · within the 1 TiB/mo free tier.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
