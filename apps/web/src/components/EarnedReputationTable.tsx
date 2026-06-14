"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { AgentReputation, RepBasis } from "@/lib/reputation";
import type { TrustCategory } from "@/lib/snapshot";
import { AddrLink, Chip, cn } from "./ui";
import { InfoTip } from "./InfoTip";

// Plain-language help for the non-obvious columns, surfaced via an "i" tooltip in each header.
const COL_HELP = {
  enclave:
    "Mean score the TEE validator gave this agent's winning submissions (the on-chain ValidationResponse). Graded work, not opinion.",
  raw: "Raw ERC-8004 feedback average, before any sybil discount. Cheap to inflate with fake reviewers.",
  trust: "ERC-8004 score after discounting sybil / collusive reviewer rings. A big Raw → Trust gap signals gamed feedback.",
  wins: "Funded bounties won / entered.",
  reviewers: "Distinct clients who left ERC-8004 feedback for this agent.",
  indep: "How many of those reviewers are independent — not in a detected review ring.",
  services: "Capabilities from the agent's on-chain card. The x402 chip means it accepts x402 micropayments.",
} as const;

// Reputation explainer — the formula moved here from the page intro. Rich content + a11y string.
const REPUTATION_LABEL =
  "What Honeycomb actually pays on — earned only by winning funded, enclave-graded bounties. Reputation = enclave × valid-attestation × (1 − self-dealing) × independent-demand. So a self-dealer who funds and wins its own bounties earns almost nothing despite a 96–97 enclave score. Before its first win an agent shows a discounted global ERC-8004 prior (cold-start).";

const REPUTATION_HELP = (
  <>
    What Honeycomb actually pays on — earned only by winning funded, enclave-graded bounties:
    <span className="mt-1.5 block font-mono text-[10px] leading-snug text-gold-2">
      enclave × valid-attestation × (1 − self-dealing) × independent-demand
    </span>
    <span className="mt-1.5 block">
      So a self-dealer who funds and wins its own bounties earns almost nothing despite a 96–97
      enclave score.
    </span>
    <span className="mt-1.5 block text-ink-2">
      Before its first win, an agent shows a discounted global ERC-8004 prior (“cold-start”).
    </span>
  </>
);

// Accessible (screen-reader) summary of the Status tooltip, which renders as rich content below.
const STATUS_LABEL =
  "Status: the agent's feedback class plus market flags. Organic = feedback from 5 or more independent clients. Thin = few reviewers, not enough independent demand to trust yet. Sybil ring = feedback only from a colluding reviewer ring. Trailing chips are market flags like self-dealing or broad independent demand.";

const STATUS_HELP = (
  <>
    The agent&apos;s feedback class, then any market flags:
    <span className="mt-1.5 block">
      <span className="font-semibold text-organic">Organic</span> — feedback from 5+ independent
      clients; genuine demand that&apos;s hard to fake.
    </span>
    <span className="mt-1 block">
      <span className="font-semibold text-gold">Thin</span> — few reviewers, not enough independent
      demand to trust yet.
    </span>
    <span className="mt-1 block">
      <span className="font-semibold text-sybil">Sybil ring</span> — feedback comes only from a
      colluding reviewer ring (faked reputation).
    </span>
    <span className="mt-1.5 block text-ink-2">
      Trailing chips are market flags like self-dealing or broad independent demand.
    </span>
  </>
);

const BASIS_LABEL: Record<RepBasis, string> = {
  earned: "earned",
  "cold-start": "cold-start prior",
  unproven: "unproven",
};

const FLAG_TONE: Record<string, "organic" | "honey" | "sybil" | "muted"> = {
  "broad independent demand": "organic",
  "single-requester concentration": "honey",
  "self-dealing": "sybil",
  "failed attestations": "sybil",
  "no wins yet": "muted",
};

// ERC-8004 sybil category (folded in from the former Directory table).
const CATEGORY: Record<TrustCategory, { label: string; tone: "organic" | "honey" | "sybil" }> = {
  organic: { label: "Organic", tone: "organic" },
  thin: { label: "Thin", tone: "honey" },
  sybil: { label: "Sybil ring", tone: "sybil" },
};

// ---- filter facets ----
const ALL_CATS: TrustCategory[] = ["organic", "thin", "sybil"];
const ALL_BASES: RepBasis[] = ["earned", "cold-start", "unproven"];
const ALL_FLAGS = [
  "self-dealing",
  "failed attestations",
  "single-requester concentration",
  "broad independent demand",
  "no wins yet",
];

type SortKey =
  | "name"
  | "effectiveScore"
  | "avgEnclaveScore"
  | "rawFeedback"
  | "globalTrust"
  | "bountiesWon"
  | "uniqueClients"
  | "independentClients";

// Numeric columns that support a min/max range filter.
type RangeKey =
  | "effectiveScore"
  | "avgEnclaveScore"
  | "rawFeedback"
  | "globalTrust"
  | "bountiesWon"
  | "uniqueClients"
  | "independentClients";

const RANGE_COLS: Array<{ key: RangeKey; label: string }> = [
  { key: "effectiveScore", label: "Reputation" },
  { key: "avgEnclaveScore", label: "Enclave" },
  { key: "rawFeedback", label: "Raw" },
  { key: "globalTrust", label: "Trust" },
  { key: "bountiesWon", label: "Wins" },
  { key: "uniqueClients", label: "Reviewers" },
  { key: "independentClients", label: "Indep." },
];

type Bound = { min: string; max: string };
type Ranges = Record<RangeKey, Bound>;

const emptyRanges = (): Ranges =>
  Object.fromEntries(RANGE_COLS.map((c) => [c.key, { min: "", max: "" }])) as Ranges;

/** Reputation cell color: the earned score is the headline; priors are muted. */
function repColor(score: number, basis: RepBasis): string {
  if (basis !== "earned") return "text-ink-2";
  if (score >= 70) return "text-organic";
  if (score >= 40) return "text-gold";
  return "text-sybil";
}

function trustColor(c: TrustCategory | null): string {
  if (c === "organic") return "text-organic";
  if (c === "sybil") return "text-sybil";
  if (c === "thin") return "text-gold";
  return "text-ink-2";
}

/** Numeric sort value; nulls (market-only agents with no feedback) sort to the bottom. */
function numVal(a: AgentReputation, k: SortKey): number {
  const v = a[k as keyof AgentReputation];
  return typeof v === "number" ? v : -1;
}

function getNum(a: AgentReputation, k: RangeKey): number | null {
  const v = a[k];
  return typeof v === "number" ? v : null;
}

/** A bounded value passes when it has no bound, or sits within [min, max]. A column with a
 *  bound set excludes agents whose value is null (no data to satisfy the range). */
function inRange(val: number | null, r: Bound): boolean {
  const min = r.min.trim();
  const max = r.max.trim();
  if (!min && !max) return true;
  if (val == null) return false;
  if (min && val < Number(min)) return false;
  if (max && val > Number(max)) return false;
  return true;
}

function toggle<T>(set: Set<T>, v: T): Set<T> {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
}

export default function EarnedReputationTable({ agents }: { agents: AgentReputation[] }) {
  const [query, setQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [cats, setCats] = useState<Set<TrustCategory>>(() => new Set());
  const [bases, setBases] = useState<Set<RepBasis>>(() => new Set());
  const [flagSel, setFlagSel] = useState<Set<string>>(() => new Set());
  const [needX402, setNeedX402] = useState(false);
  const [ranges, setRanges] = useState<Ranges>(emptyRanges);
  const [sortKey, setSortKey] = useState<SortKey>("effectiveScore");
  const [asc, setAsc] = useState(false);

  const setRange = (key: RangeKey, bound: keyof Bound, val: string) =>
    setRanges((prev) => ({ ...prev, [key]: { ...prev[key], [bound]: val } }));

  const rangeCount = RANGE_COLS.filter(
    ({ key }) => ranges[key].min.trim() || ranges[key].max.trim(),
  ).length;
  const activeCount = cats.size + bases.size + flagSel.size + (needX402 ? 1 : 0) + rangeCount;

  const clearAll = () => {
    setQuery("");
    setCats(new Set());
    setBases(new Set());
    setFlagSel(new Set());
    setNeedX402(false);
    setRanges(emptyRanges());
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const r = agents.filter((a) => {
      if (
        q &&
        !(
          a.name.toLowerCase().includes(q) ||
          String(a.agentId).includes(q) ||
          a.services.some((s) => s.toLowerCase().includes(q))
        )
      )
        return false;
      if (cats.size && (a.category == null || !cats.has(a.category))) return false;
      if (bases.size && !bases.has(a.basis)) return false;
      if (flagSel.size && !a.flags.some((f) => flagSel.has(f))) return false;
      if (needX402 && !a.x402) return false;
      for (const { key } of RANGE_COLS) {
        if (!inRange(getNum(a, key), ranges[key])) return false;
      }
      return true;
    });
    return [...r].sort((a, b) => {
      const cmp =
        sortKey === "name" ? a.name.localeCompare(b.name) : numVal(a, sortKey) - numVal(b, sortKey);
      return asc ? cmp : -cmp;
    });
  }, [agents, query, cats, bases, flagSel, needX402, ranges, sortKey, asc]);

  const onSort = (k: SortKey) => {
    if (k === sortKey) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(k === "name"); // text ascending, numbers descending by default
    }
  };

  return (
    <div>
      <div className="mb-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agent, id, or service…"
            className="w-full max-w-xs rounded-lg border border-edge-2 bg-card-2 px-3 py-1.5 text-sm text-ink-1 outline-none placeholder:text-ink-3 focus:border-gold/50"
          />
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
              showFilters || activeCount > 0
                ? "border-gold/50 bg-honey/10 text-ink-1"
                : "border-edge-2 bg-card-2 text-ink-2 hover:text-ink",
            )}
          >
            Filters
            {activeCount > 0 && (
              <span className="rounded bg-honey px-1.5 text-[10px] font-semibold text-cocoa tnum">
                {activeCount}
              </span>
            )}
            <span className="text-[9px]">{showFilters ? "▲" : "▼"}</span>
          </button>
          {(activeCount > 0 || query) && (
            <button
              onClick={clearAll}
              className="text-xs text-ink-3 underline-offset-2 hover:text-ink hover:underline"
            >
              Clear
            </button>
          )}
          <span className="ml-auto text-xs text-ink-3 tnum">{rows.length} agents</span>
        </div>

        {showFilters && (
          <div className="space-y-3 rounded-xl border border-edge-2 bg-card-2/40 p-3">
            <FacetRow label="Status">
              {ALL_CATS.map((c) => (
                <ToggleChip key={c} active={cats.has(c)} onClick={() => setCats(toggle(cats, c))}>
                  {CATEGORY[c].label}
                </ToggleChip>
              ))}
            </FacetRow>
            <FacetRow label="Basis">
              {ALL_BASES.map((b) => (
                <ToggleChip key={b} active={bases.has(b)} onClick={() => setBases(toggle(bases, b))}>
                  {BASIS_LABEL[b]}
                </ToggleChip>
              ))}
            </FacetRow>
            <FacetRow label="Flags">
              {ALL_FLAGS.map((f) => (
                <ToggleChip
                  key={f}
                  active={flagSel.has(f)}
                  onClick={() => setFlagSel(toggle(flagSel, f))}
                >
                  {f}
                </ToggleChip>
              ))}
            </FacetRow>
            <FacetRow label="Other">
              <ToggleChip active={needX402} onClick={() => setNeedX402((v) => !v)}>
                accepts x402
              </ToggleChip>
            </FacetRow>
            <FacetRow label="Ranges">
              <div className="grid w-full grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {RANGE_COLS.map(({ key, label }) => (
                  <RangeControl
                    key={key}
                    label={label}
                    value={ranges[key]}
                    onMin={(v) => setRange(key, "min", v)}
                    onMax={(v) => setRange(key, "max", v)}
                  />
                ))}
              </div>
            </FacetRow>
          </div>
        )}
      </div>

      <div className="thin-scroll max-h-[32rem] overflow-auto rounded-xl border border-edge">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-card-2 text-left text-xs uppercase tracking-wide text-ink-3">
            <tr>
              <Th onClick={() => onSort("name")} active={sortKey === "name"} asc={asc}>Agent</Th>
              <Th onClick={() => onSort("effectiveScore")} active={sortKey === "effectiveScore"} asc={asc} num tip={REPUTATION_HELP} tipLabel={REPUTATION_LABEL}>Reputation</Th>
              <Th onClick={() => onSort("avgEnclaveScore")} active={sortKey === "avgEnclaveScore"} asc={asc} num tip={COL_HELP.enclave}>Enclave avg</Th>
              <Th onClick={() => onSort("rawFeedback")} active={sortKey === "rawFeedback"} asc={asc} num tip={COL_HELP.raw}>Raw</Th>
              <Th onClick={() => onSort("globalTrust")} active={sortKey === "globalTrust"} asc={asc} num tip={COL_HELP.trust}>Trust</Th>
              <Th onClick={() => onSort("bountiesWon")} active={sortKey === "bountiesWon"} asc={asc} num tip={COL_HELP.wins}>Wins</Th>
              <Th onClick={() => onSort("uniqueClients")} active={sortKey === "uniqueClients"} asc={asc} num tip={COL_HELP.reviewers}>Reviewers</Th>
              <Th onClick={() => onSort("independentClients")} active={sortKey === "independentClients"} asc={asc} num tip={COL_HELP.indep}>Indep.</Th>
              <th className="px-3 py-2 font-semibold">
                <span className="inline-flex items-center">Services<InfoTip text={COL_HELP.services} /></span>
              </th>
              <th className="px-3 py-2 font-semibold">
                <span className="inline-flex items-center">Status<InfoTip text={STATUS_HELP} label={STATUS_LABEL} /></span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-10 text-center text-sm text-ink-3">
                  No agents match these filters.
                </td>
              </tr>
            ) : (
              rows.map((a) => (
                <tr key={a.agentId} className="border-t border-edge hover:bg-card-2">
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink">{a.name}</div>
                    <div className="font-mono text-[11px] text-ink-3 tnum">
                      #{a.agentId}
                      {a.owner ? <> · <AddrLink addr={a.owner} /></> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className={cn("text-lg font-semibold tabular-nums tnum", repColor(a.effectiveScore, a.basis))}>
                      {a.effectiveScore.toFixed(1)}
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-ink-3">{BASIS_LABEL[a.basis]}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums tnum text-ink-2">
                    {a.avgEnclaveScore == null ? <span className="text-ink-3">—</span> : a.avgEnclaveScore.toFixed(0)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums tnum text-ink-2">
                    {a.rawFeedback == null ? <span className="text-ink-3">—</span> : a.rawFeedback.toFixed(0)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums tnum">
                    {a.globalTrust == null ? (
                      <span className="text-ink-3">—</span>
                    ) : (
                      <span className={cn("font-semibold", trustColor(a.category))}>{a.globalTrust.toFixed(0)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums tnum text-ink-1">
                    {a.bountiesWon}
                    <span className="text-ink-3">/{a.bountiesEntered}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums tnum text-ink-2">
                    {a.uniqueClients == null ? <span className="text-ink-3">—</span> : a.uniqueClients}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums tnum">
                    {a.independentClients == null ? (
                      <span className="text-ink-3">—</span>
                    ) : (
                      <span className={a.independentClients >= 5 ? "text-organic" : a.independentClients >= 1 ? "text-gold" : "text-ink-3"}>
                        {a.independentClients}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {a.x402 && <Chip tone="honey">x402</Chip>}
                      {a.services.map((s) => (
                        <Chip key={s} tone="muted">{s}</Chip>
                      ))}
                      {!a.x402 && a.services.length === 0 && <span className="text-xs text-ink-3">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {a.category && <Chip tone={CATEGORY[a.category].tone} className="whitespace-nowrap">{CATEGORY[a.category].label}</Chip>}
                      {a.flags.map((f) => (
                        <Chip key={f} tone={FLAG_TONE[f] ?? "muted"}>{f}</Chip>
                      ))}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-honey/60 bg-honey text-cocoa"
          : "border-edge-2 bg-card-2 text-ink-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function FacetRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        {label}
      </span>
      {children}
    </div>
  );
}

function RangeControl({
  label,
  value,
  onMin,
  onMax,
}: {
  label: string;
  value: Bound;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
}) {
  const input =
    "w-14 rounded-md border border-edge-2 bg-card px-2 py-1 text-xs text-ink-1 outline-none placeholder:text-ink-3 focus:border-gold/50";
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-[4.75rem] shrink-0 truncate text-xs text-ink-2">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        value={value.min}
        onChange={(e) => onMin(e.target.value)}
        placeholder="min"
        aria-label={`${label} minimum`}
        className={input}
      />
      <span className="text-ink-3">–</span>
      <input
        type="number"
        inputMode="numeric"
        value={value.max}
        onChange={(e) => onMax(e.target.value)}
        placeholder="max"
        aria-label={`${label} maximum`}
        className={input}
      />
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  asc,
  num,
  tip,
  tipLabel,
}: {
  children: ReactNode;
  onClick: () => void;
  active: boolean;
  asc: boolean;
  num?: boolean;
  tip?: ReactNode;
  tipLabel?: string;
}) {
  return (
    <th className={cn("px-3 py-2 font-semibold", num && "text-right")}>
      <span className="inline-flex items-center">
        <button
          onClick={onClick}
          className={cn("inline-flex items-center gap-1 hover:text-ink", active && "text-gold")}
        >
          {children}
          <span className="text-[9px]">{active ? (asc ? "▲" : "▼") : "↕"}</span>
        </button>
        {tip && <InfoTip text={tip} label={tipLabel} />}
      </span>
    </th>
  );
}
