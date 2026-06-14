// ============================================================================
// /ops -- the honeycomb-api operations dashboard.
//
// Distinct from /dashboard (which reads BigQuery directly). /ops talks to the
// DEPLOYED honeycomb-api over HTTP, so it shows the API's live view of the
// chain: recent jobs, decoded events, and -- in local dev only -- the write
// controls (grade a submission, open a bounty).
//
// ONE page, TWO faces, decided by HONEYCOMB_DEV:
//   - deployed (no flag): read-only. KPIs + jobs + events. No token in scope.
//   - local dev (HONEYCOMB_DEV=1): the read view PLUS the OpsConsole write panel.
//
// All reads happen here (server-side) so the page renders with data and no
// secrets reach the client. Writes go through the browser -> /api/honeycomb
// proxy, which injects the token server-side (see that route + lib/honeycomb.ts).
// ============================================================================

import { apiGet, isDevMode } from "@/lib/honeycomb";
import { Card, Chip, SectionLabel, truncAddr } from "@/components/ui";
import OpsConsole from "@/components/OpsConsole";

export const dynamic = "force-dynamic";

type Job = {
  jobId?: string | number;
  client?: string;
  reward?: string | number;
  rewardUSDC?: string | number;
  deadline?: string | number;
  status?: string;
  leader?: string;
  leadingScore?: string | number;
  resolved?: boolean;
  [k: string]: unknown;
};

type EventRow = {
  eventName?: string;
  jobId?: string | number;
  blockNumber?: string | number;
  txHash?: string;
  [k: string]: unknown;
};

/** Best-effort: read a route, returning { data } or { error } so one failed
 *  fetch degrades that panel instead of 500-ing the whole page. The error is
 *  shown in the panel (loud, not swallowed). */
async function safeGet<T>(path: string): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await apiGet<T>(path), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    // tolerate { jobs: [...] } / { events: [...] } / { items: [...] } envelopes
    for (const k of ["jobs", "events", "items", "results", "data"]) {
      const inner = (v as Record<string, unknown>)[k];
      if (Array.isArray(inner)) return inner as T[];
    }
  }
  return [];
}

export default async function OpsPage() {
  const dev = isDevMode();

  const [jobsRes, eventsRes] = await Promise.all([
    safeGet<unknown>("/jobs?limit=25"),
    safeGet<unknown>("/events"),
  ]);

  const jobs = asArray<Job>(jobsRes.data);
  const events = asArray<EventRow>(eventsRes.data);
  const openJobs = jobs.filter((j) => !j.resolved && j.status !== "resolved");
  const resolvedJobs = jobs.length - openJobs.length;

  return (
    <main className="hc-dashboard mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionLabel>honeycomb-api</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Operations</h1>
          <p className="mt-1 text-sm text-ink-2">
            Live view from the deployed API — jobs, events
            {dev ? ", and the local write console." : "."}
          </p>
        </div>
        <Chip tone={dev ? "brand" : "muted"}>
          {dev ? "dev mode — write enabled" : "read-only"}
        </Chip>
      </header>

      {/* KPIs */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Jobs" value={jobs.length} />
        <Kpi label="Open" value={openJobs.length} tone="organic" />
        <Kpi label="Resolved" value={resolvedJobs} />
        <Kpi label="Events" value={events.length} />
      </div>

      {/* Dev-only write console */}
      {dev && (
        <div className="mb-6">
          <OpsConsole />
        </div>
      )}

      {/* Jobs */}
      <Card className="mb-6 overflow-hidden">
        <div className="border-b border-edge px-4 py-3">
          <SectionLabel>Recent jobs</SectionLabel>
        </div>
        {jobsRes.error ? (
          <ErrRow label="jobs" error={jobsRes.error} />
        ) : jobs.length === 0 ? (
          <EmptyRow>No jobs returned.</EmptyRow>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-card-2 text-left text-xs uppercase tracking-wide text-ink-3">
                <tr>
                  <Th>Job</Th>
                  <Th>Client</Th>
                  <Th>Reward</Th>
                  <Th>Leader</Th>
                  <Th>Score</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j, i) => {
                  const resolved = Boolean(j.resolved) || j.status === "resolved";
                  return (
                    <tr key={String(j.jobId ?? i)} className="border-t border-edge">
                      <Td mono>{String(j.jobId ?? "—")}</Td>
                      <Td mono>{j.client ? truncAddr(String(j.client)) : "—"}</Td>
                      <Td>{fmtReward(j)}</Td>
                      <Td mono>{j.leader ? truncAddr(String(j.leader)) : "—"}</Td>
                      <Td mono>{j.leadingScore != null ? String(j.leadingScore) : "—"}</Td>
                      <Td>
                        <Chip tone={resolved ? "muted" : "organic"}>
                          {resolved ? "resolved" : "open"}
                        </Chip>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Events */}
      <Card className="overflow-hidden">
        <div className="border-b border-edge px-4 py-3">
          <SectionLabel>Recent events</SectionLabel>
        </div>
        {eventsRes.error ? (
          <ErrRow label="events" error={eventsRes.error} />
        ) : events.length === 0 ? (
          <EmptyRow>No events returned.</EmptyRow>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-card-2 text-left text-xs uppercase tracking-wide text-ink-3">
                <tr>
                  <Th>Event</Th>
                  <Th>Job</Th>
                  <Th>Block</Th>
                  <Th>Tx</Th>
                </tr>
              </thead>
              <tbody>
                {events.slice(0, 50).map((ev, i) => (
                  <tr key={i} className="border-t border-edge">
                    <Td>
                      <Chip tone="honey">{ev.eventName ?? "event"}</Chip>
                    </Td>
                    <Td mono>{ev.jobId != null ? String(ev.jobId) : "—"}</Td>
                    <Td mono>{ev.blockNumber != null ? String(ev.blockNumber) : "—"}</Td>
                    <Td mono>{ev.txHash ? truncAddr(String(ev.txHash)) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </main>
  );
}

// --- inline presentational helpers (page-local, matches dashboard/page.tsx) ---

function Kpi({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | string;
  tone?: "default" | "organic";
}) {
  return (
    <Card className="px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-3">
        {label}
      </div>
      <div
        className={
          tone === "organic"
            ? "mt-1 text-2xl font-semibold text-organic"
            : "mt-1 text-2xl font-semibold text-ink"
        }
      >
        {value}
      </div>
    </Card>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2 font-semibold">{children}</th>;
}

function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td className={mono ? "px-4 py-2 font-mono text-ink-1" : "px-4 py-2 text-ink-1"}>
      {children}
    </td>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-sm text-ink-2">{children}</div>;
}

function ErrRow({ label, error }: { label: string; error: string }) {
  return (
    <div className="px-4 py-4 text-sm text-sybil">
      Failed to load {label}: <span className="font-mono text-xs">{error}</span>
    </div>
  );
}

function fmtReward(j: Job): string {
  const r = j.rewardUSDC ?? j.reward;
  if (r == null) return "—";
  return `${r} USDC`;
}
