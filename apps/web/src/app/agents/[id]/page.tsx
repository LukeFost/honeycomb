// ============================================================================
// /agents/[id] -- one agent's dashboard.
//
// THREE things, as asked: what it's working on, what it's done, how much it has
// earned. Sources are split:
//   - earnings  -> honeycomb-api live chain (settled bounties this agent won)
//   - grades    -> Neon  (what it's done)
//   - activity  -> Neon  (recent tool calls carrying this agentId -> in-flight)
//
// Each panel fails independently (safe()) so one empty/erroring source never
// blanks the whole page. Earnings always tries the API even when Neon is unset.
// ============================================================================

import Link from "next/link";
import { agentGrades, agentActivity, agentEarnings } from "@/lib/agents";
import { dbEnabled } from "@/lib/neon";
import { Card, Chip, SectionLabel, truncAddr } from "@/components/ui";

export const dynamic = "force-dynamic";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<{ data: T; error: string | null }> {
  try {
    return { data: await fn(), error: null };
  } catch (e) {
    return { data: fallback, error: e instanceof Error ? e.message : String(e) };
  }
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agentId = decodeURIComponent(id);
  const wired = dbEnabled();

  const [earnings, grades, activity] = await Promise.all([
    safe(() => agentEarnings(agentId), { settledUSDC: 0, pendingUSDC: 0, jobsWon: [], source: "honeycomb-api" as const }),
    safe(() => agentGrades(agentId), []),
    safe(() => agentActivity(agentId), []),
  ]);

  const inFlight = activity.data.filter((a) => !a.ok || a.status === 0 || a.status >= 500); // best-effort "still working / errored"
  const validGrades = grades.data.filter((g) => g.valid).length;

  return (
    <main className="hc-dashboard mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/agents" className="text-xs text-ink-3 hover:text-ink-1">← all agents</Link>
          <h1 className="mt-1 font-mono text-2xl font-semibold tracking-tight text-ink">Agent #{agentId}</h1>
          <p className="mt-1 text-sm text-ink-2">Tasks, grades, and onchain earnings.</p>
        </div>
      </header>

      {/* Money earned -- the headline. From honeycomb-api (live chain). */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Earned (settled)" value={`${earnings.data.settledUSDC} USDC`} tone="honey" />
        <Kpi label="Pending (leading)" value={`${earnings.data.pendingUSDC} USDC`} tone="organic" />
        <Kpi label="Jobs won" value={earnings.data.jobsWon.filter((j) => j.settled).length} />
        <Kpi label="Grades (valid)" value={`${grades.data.length} (${validGrades})`} />
      </div>
      {earnings.error && (
        <p className="mb-4 text-xs text-sybil">earnings unavailable: <span className="font-mono">{earnings.error}</span></p>
      )}

      {/* Working on now */}
      <Card className="mb-6 overflow-hidden">
        <div className="border-b border-edge px-4 py-3"><SectionLabel>Working on (recent activity)</SectionLabel></div>
        {!wired ? (
          <Empty>Neon not configured — activity is recorded by the MCP into Neon.</Empty>
        ) : activity.error ? (
          <ErrRow label="activity" error={activity.error} />
        ) : activity.data.length === 0 ? (
          <Empty>No recent tool calls recorded for this agent.</Empty>
        ) : (
          <Table head={["When", "Tool", "Path", "Status"]}>
            {activity.data.slice(0, 25).map((a, i) => (
              <tr key={i} className="border-t border-edge">
                <Td mono>{a.calledAt.replace("T", " ").replace("Z", "")}</Td>
                <Td><Chip tone="brand">{a.tool}</Chip></Td>
                <Td mono>{a.method} {a.path}</Td>
                <Td><Chip tone={a.ok ? "organic" : "sybil"}>{a.status}</Chip></Td>
              </tr>
            ))}
          </Table>
        )}
        {inFlight.length > 0 && (
          <div className="border-t border-edge px-4 py-2 text-xs text-ink-3">
            {inFlight.length} recent call(s) errored or pending.
          </div>
        )}
      </Card>

      {/* Done -- grades */}
      <Card className="mb-6 overflow-hidden">
        <div className="border-b border-edge px-4 py-3"><SectionLabel>Done (graded submissions)</SectionLabel></div>
        {!wired ? (
          <Empty>Neon not configured — grades are recorded by the MCP into Neon.</Empty>
        ) : grades.error ? (
          <ErrRow label="grades" error={grades.error} />
        ) : grades.data.length === 0 ? (
          <Empty>No grades recorded for this agent yet.</Empty>
        ) : (
          <Table head={["When", "Job", "Bounty", "Score", "Valid", "Attestation"]}>
            {grades.data.map((g, i) => (
              <tr key={i} className="border-t border-edge">
                <Td mono>{g.gradedAt.replace("T", " ").replace("Z", "")}</Td>
                <Td mono>{g.jobId ?? "—"}</Td>
                <Td>{g.bounty ?? "—"}</Td>
                <Td mono>{g.score != null ? g.score : "—"}</Td>
                <Td><Chip tone={g.valid ? "organic" : "sybil"}>{g.valid ? "valid" : "invalid"}</Chip></Td>
                <Td>
                  {g.attestationSource === "confidential-space" ? (
                    <span className="flex items-center gap-1">
                      <Chip tone="honey">confidential-space</Chip>
                      {g.signer && <span className="font-mono text-[10px] text-ink-3">{truncAddr(g.signer)}</span>}
                    </span>
                  ) : (
                    <Chip tone="muted">{g.attestationSource ?? "local"}</Chip>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* Jobs won -- the earnings breakdown */}
      <Card className="overflow-hidden">
        <div className="border-b border-edge px-4 py-3"><SectionLabel>Bounties led / won (live chain)</SectionLabel></div>
        {earnings.data.jobsWon.length === 0 ? (
          <Empty>This agent is not leading any bounties.</Empty>
        ) : (
          <Table head={["Job", "Reward", "Status"]}>
            {earnings.data.jobsWon.map((j) => (
              <tr key={j.jobId} className="border-t border-edge">
                <Td mono>{j.jobId}</Td>
                <Td>{j.rewardUSDC} USDC</Td>
                <Td><Chip tone={j.settled ? "honey" : "organic"}>{j.settled ? "settled (paid)" : j.status}</Chip></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </main>
  );
}

// --- helpers ----------------------------------------------------------------

function Kpi({ label, value, tone = "default" }: { label: string; value: number | string; tone?: "default" | "honey" | "organic" }) {
  const valueCls =
    tone === "honey" ? "text-gold" : tone === "organic" ? "text-organic" : "text-ink";
  return (
    <Card className="px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-3">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${valueCls}`}>{value}</div>
    </Card>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-card-2 text-left text-xs uppercase tracking-wide text-ink-3">
          <tr>{head.map((h, i) => <th key={i} className="px-4 py-2 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return <td className={mono ? "px-4 py-2 font-mono text-ink-1" : "px-4 py-2 text-ink-1"}>{children}</td>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-sm text-ink-2">{children}</div>;
}

function ErrRow({ label, error }: { label: string; error: string }) {
  return (
    <div className="px-4 py-4 text-sm text-sybil">
      Failed to load {label}: <span className="font-mono text-xs">{error}</span>
    </div>
  );
}
