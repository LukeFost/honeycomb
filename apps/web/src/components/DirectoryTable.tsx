"use client";

import { useMemo, useState } from "react";
import type { TrustAgent, TrustCategory } from "@/lib/snapshot";
import { Chip, cn } from "./ui";

type SortKey = "name" | "avgScore" | "trustScore" | "uniqueClients" | "independentClients";

const CATEGORY: Record<TrustCategory, { label: string; tone: "organic" | "honey" | "sybil" }> = {
  organic: { label: "Organic", tone: "organic" },
  thin: { label: "Thin", tone: "honey" },
  sybil: { label: "Sybil ring", tone: "sybil" },
};

const FILTERS: Array<{ key: "all" | TrustCategory; label: string }> = [
  { key: "all", label: "All" },
  { key: "organic", label: "Organic" },
  { key: "thin", label: "Thin" },
  { key: "sybil", label: "Sybil ring" },
];

export default function DirectoryTable({ agents }: { agents: TrustAgent[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | TrustCategory>("all");
  const [sortKey, setSortKey] = useState<SortKey>("trustScore");
  const [asc, setAsc] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let r = agents.filter((a) => {
      if (filter !== "all" && a.category !== filter) return false;
      if (!q) return true;
      return (
        (a.name ?? "").toLowerCase().includes(q) ||
        String(a.agentId).includes(q) ||
        a.services.some((s) => s.toLowerCase().includes(q))
      );
    });
    r = [...r].sort((a, b) => {
      let cmp: number;
      if (sortKey === "name") {
        cmp = (a.name ?? `#${a.agentId}`).localeCompare(b.name ?? `#${b.agentId}`);
      } else {
        cmp = a[sortKey] - b[sortKey];
      }
      return asc ? cmp : -cmp;
    });
    return r;
  }, [agents, query, filter, sortKey, asc]);

  const onSort = (k: SortKey) => {
    if (k === sortKey) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(k === "name"); // text ascending, numbers descending by default
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agent, id, or service…"
          className="w-full max-w-xs rounded-lg border border-edge bg-black/40 px-3 py-1.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-honey/50"
        />
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                filter === f.key
                  ? "border-honey/40 bg-honey/15 text-honey-bright"
                  : "border-edge bg-white/[0.02] text-zinc-400 hover:text-zinc-200",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-zinc-500 tnum">{rows.length} agents</span>
      </div>

      <div className="thin-scroll max-h-[460px] overflow-auto rounded-xl border border-edge">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-[#141416] text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <Th onClick={() => onSort("name")} active={sortKey === "name"} asc={asc}>Agent</Th>
              <Th onClick={() => onSort("avgScore")} active={sortKey === "avgScore"} asc={asc} num>Raw</Th>
              <Th onClick={() => onSort("trustScore")} active={sortKey === "trustScore"} asc={asc} num>Trust</Th>
              <Th onClick={() => onSort("uniqueClients")} active={sortKey === "uniqueClients"} asc={asc} num>Reviewers</Th>
              <Th onClick={() => onSort("independentClients")} active={sortKey === "independentClients"} asc={asc} num>Indep.</Th>
              <th className="px-3 py-2 font-semibold">Services</th>
              <th className="px-3 py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const cat = CATEGORY[a.category];
              return (
                <tr key={a.agentId} className="border-t border-white/[0.05] hover:bg-white/[0.02]">
                  <td className="px-3 py-2">
                    <div className="font-medium text-zinc-100">{a.name ?? `Agent #${a.agentId}`}</div>
                    <div className="font-mono text-[11px] text-zinc-500 tnum">#{a.agentId}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-400 tnum">{a.avgScore}</td>
                  <td className="px-3 py-2 text-right tabular-nums tnum">
                    <span className={cn("font-semibold", scoreColor(a.category))}>{a.trustScore}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-400 tnum" title={`${a.feedbackCount} feedback events`}>
                    {a.uniqueClients}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums tnum">
                    <span className={a.independentClients >= 5 ? "text-organic" : a.independentClients >= 1 ? "text-honey-bright" : "text-zinc-600"}>
                      {a.independentClients}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {a.x402 && <Chip tone="honey">x402</Chip>}
                      {a.services.map((s) => (
                        <Chip key={s} tone="muted">{s}</Chip>
                      ))}
                      {!a.x402 && a.services.length === 0 && <span className="text-xs text-zinc-600">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Chip tone={cat.tone} className="whitespace-nowrap">{cat.label}</Chip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function scoreColor(c: TrustCategory): string {
  return c === "organic" ? "text-organic" : c === "sybil" ? "text-sybil" : "text-honey-bright";
}

function Th({
  children,
  onClick,
  active,
  asc,
  num,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  asc: boolean;
  num?: boolean;
}) {
  return (
    <th className={cn("px-3 py-2 font-semibold", num && "text-right")}>
      <button
        onClick={onClick}
        className={cn("inline-flex items-center gap-1 hover:text-zinc-200", active && "text-honey-bright")}
      >
        {children}
        <span className="text-[9px]">{active ? (asc ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}
