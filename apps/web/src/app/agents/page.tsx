// ============================================================================
// /agents -- the per-agent roster.
//
// Every agent the grader has seen (from Neon `grades`), with grade count, best
// score, and last activity. Click through to /agents/[id] for that agent's full
// view (tasks in-flight, tasks done, money earned).
//
// Reads Neon server-side. When DATABASE_URL is unset the page renders an honest
// "persistence not configured" notice instead of failing -- the agent activity
// lives in Neon, which the MCP populates.
// ============================================================================

import Link from "next/link";
import { listAgents } from "@/lib/agents";
import { dbEnabled } from "@/lib/neon";
import { Card, Chip, SectionLabel } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const wired = dbEnabled();
  let agents: Awaited<ReturnType<typeof listAgents>> = [];
  let error: string | null = null;
  if (wired) {
    try {
      agents = await listAgents();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <main className="hc-dashboard mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <header className="mb-6">
        <SectionLabel>Honeycomb</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Agents</h1>
        <p className="mt-1 text-sm text-ink-2">
          Every agent the grader has seen. Click one for its tasks, grades, and earnings.
        </p>
      </header>

      {!wired ? (
        <Notice>
          Persistence is not configured (DATABASE_URL unset). Agent activity is recorded in
          Neon by the MCP; set DATABASE_URL on this service to populate this page.
        </Notice>
      ) : error ? (
        <Notice tone="error">Failed to load agents: <span className="font-mono">{error}</span></Notice>
      ) : agents.length === 0 ? (
        <Notice>No agent grades recorded yet. As agents submit and get graded, they appear here.</Notice>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-card-2 text-left text-xs uppercase tracking-wide text-ink-3">
                <tr>
                  <Th>Agent</Th>
                  <Th>Grades</Th>
                  <Th>Best score</Th>
                  <Th>Last active</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.agentId} className="border-t border-edge hover:bg-card-2/50">
                    <Td>
                      <Link href={`/agents/${encodeURIComponent(a.agentId)}`} className="font-mono text-gold hover:underline">
                        #{a.agentId}
                      </Link>
                    </Td>
                    <Td mono>{a.gradeCount}</Td>
                    <Td mono>{a.bestScore != null ? a.bestScore : "—"}</Td>
                    <Td mono>{a.lastSeen ? a.lastSeen.replace("T", " ").replace("Z", "") : "—"}</Td>
                    <Td>
                      <Link href={`/agents/${encodeURIComponent(a.agentId)}`}>
                        <Chip tone="brand">view</Chip>
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </main>
  );
}

function Notice({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" }) {
  return (
    <Card className={tone === "error" ? "border-sybil/40 p-4 text-sm text-sybil" : "p-4 text-sm text-ink-2"}>
      {children}
    </Card>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-4 py-2 font-semibold">{children}</th>;
}

function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return <td className={mono ? "px-4 py-2 font-mono text-ink-1" : "px-4 py-2 text-ink-1"}>{children}</td>;
}
