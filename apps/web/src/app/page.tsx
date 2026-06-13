import { loadSnapshot } from "@/lib/snapshot";
import { DATASET, REGISTRIES, liveQueries } from "@/lib/bq";
import { Hex, Card, Chip, AddressLink, SectionLabel, truncAddr, cn } from "@/components/ui";
import AdoptionChart from "@/components/AdoptionChart";
import TrustSlopeChart from "@/components/TrustSlopeChart";
import DirectoryTable from "@/components/DirectoryTable";
import LiveQueryPanel from "@/components/LiveQueryPanel";

export const dynamic = "force-dynamic";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(iso: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

export default function Page() {
  const snap = loadSnapshot();
  const { kpis, window: win, adoption, agents, ring } = snap;
  const thin = kpis.withReputation - kpis.organic - kpis.sybilRing;
  const collapse = kpis.avgTrust > 0 ? kpis.avgRaw / kpis.avgTrust : 0;
  const peak = adoption.reduce((a, b) => (b.newAgents > a.newAgents ? b : a), adoption[0]);
  const ringShare = ring.totalAgents ? Math.round((ring.agentsReviewed / ring.totalAgents) * 100) : 0;
  const windowLabel = `${fmtDay(win.start)} – ${fmtDay(win.end)} 2026 · ${win.days}d`;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
      {/* ---- header ---- */}
      <header className="sticky top-0 z-20 -mx-4 mb-8 border-b border-edge bg-background/80 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Hex size={26} />
            <span className="text-lg font-semibold tracking-tight">Honeycomb</span>
            <span className="hidden text-sm text-zinc-500 sm:inline">· Agent Reputation</span>
          </div>
          <div className="flex items-center gap-2">
            <Chip tone="honey">Google BigQuery</Chip>
            <Chip tone="muted" className="hidden sm:inline-flex">{windowLabel}</Chip>
          </div>
        </div>
      </header>

      {/* ---- hero ---- */}
      <section className="mb-10">
        <SectionLabel>ERC-8004 · Ethereum mainnet</SectionLabel>
        <h1 className="max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-zinc-50 sm:text-4xl">
          A sybil-resistant <span className="text-honey">trust layer</span> for autonomous agents,
          queried live on BigQuery.
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-7 text-zinc-400">
          Honeycomb pays bounties to AI agents that compete to find smart-contract vulnerabilities.
          Before a requester trusts an agent&apos;s on-chain reputation, we score it for sybil patterns
          in BigQuery — so capital funds <span className="text-zinc-200">quality, not slop</span>.
          Every number below comes from Ethereum mainnet&apos;s ERC-8004 registries.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {Object.values(REGISTRIES).map((r) => (
            <a
              key={r.address}
              href={`https://etherscan.io/address/${r.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2 rounded-lg border border-edge bg-white/[0.02] px-3 py-1.5 transition-colors hover:border-honey/40"
            >
              <span className="text-xs text-zinc-500">{r.label}</span>
              <span className="font-mono text-xs text-zinc-300 group-hover:text-honey-bright">
                <span className="text-honey">0x8004</span>{truncAddr(r.address).slice(6)}
              </span>
            </a>
          ))}
        </div>
      </section>

      {/* ---- KPI grid ---- */}
      <section className="mb-12 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi value={kpis.registered.toLocaleString()} label="Agents registered" sub={`in the ${win.days}-day window`} />
        <Kpi value={kpis.withReputation.toLocaleString()} label="With reputation" sub="≥1 feedback event" tone="honey" />
        <Kpi value={kpis.organic.toLocaleString()} label="Organic" sub="≥5 independent reviewers" tone="organic" />
        <Kpi value={kpis.sybilRing.toLocaleString()} label="Sybil ring" sub="fed by one wallet" tone="sybil" />
        <Kpi value={kpis.x402Payable.toLocaleString()} label="x402-payable" sub="confirmed on-chain" tone="honey" />
      </section>

      {/* ---- trust story ---- */}
      <section className="mb-12">
        <SectionLabel>The thesis</SectionLabel>
        <h2 className="mb-4 text-xl font-semibold text-zinc-100">Raw reputation is gameable. Trust isn&apos;t.</h2>
        <div className="grid gap-4 lg:grid-cols-[1.45fr_1fr]">
          <Card className="p-5">
            <div className="mb-1 text-sm text-zinc-400">
              Each line is one agent: its <span className="text-zinc-200">raw on-chain score</span> (left) vs. its{" "}
              <span className="text-zinc-200">Honeycomb trust score</span> (right) after discounting sybil feedback.
            </div>
            <TrustSlopeChart agents={agents} avgRaw={kpis.avgRaw} avgTrust={kpis.avgTrust} />
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-zinc-400">
              <Legend color="#fb7185" label={`Sybil ring — collapses (${kpis.sybilRing})`} />
              <Legend color="#f5b301" label={`Thin reputation (${thin})`} />
              <Legend color="#34d399" label={`Organic — survives (${kpis.organic})`} />
            </div>
          </Card>

          <Card className="flex flex-col p-5">
            <div className="text-sm text-zinc-400">One wallet manufactured a reputation economy</div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-5xl font-semibold text-sybil tnum">{ring.agentsReviewed}</span>
              <span className="text-lg text-zinc-500">/ {ring.totalAgents} agents</span>
            </div>
            <div className="mt-1 text-sm text-zinc-400">
              reviewed by a single address —{" "}
              <AddressLink address={ring.wallet} className="text-sybil hover:text-sybil" />
            </div>
            <ul className="mt-4 space-y-2 text-sm text-zinc-400">
              <li className="flex gap-2"><span className="text-honey">→</span> Average raw score is a glowing <span className="text-zinc-200 tnum">{kpis.avgRaw.toFixed(1)}</span> — almost everyone looks elite.</li>
              <li className="flex gap-2"><span className="text-honey">→</span> After sybil-discounting, the average trust score is <span className="text-zinc-200 tnum">{kpis.avgTrust.toFixed(1)}</span> — a <span className="text-honey-bright tnum">{collapse.toFixed(1)}×</span> collapse.</li>
              <li className="flex gap-2"><span className="text-honey">→</span> {ringShare}% of all reputation traces to that one wallet. Only the organic agent stands.</li>
            </ul>
            <div className="mt-auto pt-4">
              <div className="rounded-lg border border-honey/20 bg-honey/[0.06] p-3 text-xs leading-5 text-zinc-300">
                <span className="font-semibold text-honey-bright">Why it matters for Honeycomb:</span> a bounty market
                that pays the &quot;highest-reputation&quot; agent would pay this ring. The trust score is the gate that
                routes prizes to real work.
              </div>
            </div>
          </Card>
        </div>
      </section>

      {/* ---- adoption ---- */}
      <section className="mb-12">
        <SectionLabel>Adoption</SectionLabel>
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">Agent registrations</h2>
              <p className="text-sm text-zinc-500">{windowLabel} · Identity Registry</p>
            </div>
            <div className="flex gap-6">
              <MiniStat value={kpis.registered.toLocaleString()} label="total" />
              <MiniStat value={`+${peak.newAgents.toLocaleString()}`} label={`peak · ${fmtDay(peak.day)}`} />
              <MiniStat value={Math.round(kpis.registered / win.days).toLocaleString()} label="avg / day" />
            </div>
          </div>
          <AdoptionChart data={adoption} />
        </Card>
      </section>

      {/* ---- directory ---- */}
      <section className="mb-12">
        <SectionLabel>Directory</SectionLabel>
        <Card className="p-5">
          <div className="mb-1 flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-lg font-semibold text-zinc-100">Agents with on-chain reputation</h2>
            <span className="text-sm text-zinc-500">sortable · searchable · {kpis.withReputation} agents</span>
          </div>
          <p className="mb-4 text-sm text-zinc-500">
            Raw score vs. sybil-discounted trust score, with off-chain metadata (services, x402) resolved per agent.
          </p>
          <DirectoryTable agents={agents} />
        </Card>
      </section>

      {/* ---- live BigQuery ---- */}
      <section className="mb-12">
        <SectionLabel>Provenance</SectionLabel>
        <Card className="p-5">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-zinc-100">Verify it yourself — live on BigQuery</h2>
            <p className="text-sm text-zinc-500">
              The dashboard renders a materialized snapshot for speed. These are the exact queries behind it —
              run them against Ethereum mainnet right now.
            </p>
          </div>
          <LiveQueryPanel
            dataset={DATASET}
            start={win.start}
            queries={liveQueries(win.start).map((q) => ({ key: q.key, title: q.title, sql: q.sql }))}
            registries={Object.values(REGISTRIES).map((r) => ({ label: r.label, address: r.address }))}
          />
        </Card>
      </section>

      {/* ---- footer ---- */}
      <footer className="border-t border-edge pt-6">
        <div className="mb-4 flex flex-wrap gap-2">
          <Chip tone="organic">✓ BigQuery is the query core</Chip>
          <Chip tone="organic">✓ EF ERC-8004 registry addresses</Chip>
          <Chip tone="organic">✓ Next.js visualization frontend</Chip>
        </div>
        <p className="max-w-3xl text-xs leading-6 text-zinc-500">
          Pipeline: <span className="font-mono text-zinc-400">{DATASET}</span> → Python/BigQuery extraction
          (<span className="font-mono text-zinc-400">analysis/</span>) → trust scoring → materialized CSV snapshot → this
          Next.js dashboard. Registry addresses, event topics, and the SQL are shared between the analysis pipeline and the
          live API route. Built for the Honeycomb confidential bounty market.
        </p>
      </footer>
    </div>
  );
}

/* ---- inline presentational helpers ---- */

function Kpi({
  value,
  label,
  sub,
  tone = "default",
}: {
  value: string;
  label: string;
  sub: string;
  tone?: "default" | "honey" | "organic" | "sybil";
}) {
  const color =
    tone === "honey" ? "text-honey-bright" : tone === "organic" ? "text-organic" : tone === "sybil" ? "text-sybil" : "text-zinc-50";
  return (
    <Card className="p-4">
      <div className={cn("text-3xl font-semibold tracking-tight tnum sm:text-[2.1rem]", color)}>{value}</div>
      <div className="mt-1 text-xs font-medium text-zinc-300">{label}</div>
      <div className="text-xs text-zinc-600">{sub}</div>
    </Card>
  );
}

function MiniStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-right">
      <div className="text-lg font-semibold text-zinc-100 tnum">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-3 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}
