"use client";

// ============================================================================
// LogPanel -- a live, PUBLIC view of a deployed service's Cloud Logging output.
//
// Reads GET /api/honeycomb/logs (the server proxy passes it straight through to
// honeycomb-api/logs, which is public). No token, no dev gate: anyone on /ops --
// including a demo viewer -- can see what the services are doing. Safety is the
// API's job: it redacts secrets (API keys, bearer tokens, private-key-shaped hex)
// out of every line at the source, so what reaches this component is already safe
// to show. We just render it.
//
// HONESTY: a non-2xx is shown as a failure with the upstream error text; we never
// paint an empty list as "no logs" when the request actually failed.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { Card, Chip, SectionLabel, cn } from "@/components/ui";

type LogEntry = {
  timestamp: string | null;
  severity: string;
  text: string;
  revision: string | null;
};

type LogResponse = {
  service: string;
  project: string;
  sinceMinutes: number;
  count: number;
  entries: LogEntry[];
};

const SERVICES = ["honeycomb-api", "honeycomb-web"] as const;
const SEVERITIES = ["", "INFO", "WARNING", "ERROR"] as const;
const WINDOWS = [15, 60, 240, 1440] as const; // minutes

type FetchState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ok"; data: LogResponse }
  | { phase: "error"; message: string };

// Color the severity chip so ERROR/WARNING pop in a wall of INFO.
function sevTone(sev: string): "sybil" | "honey" | "muted" {
  const s = sev.toUpperCase();
  if (s === "ERROR" || s === "CRITICAL" || s === "ALERT" || s === "EMERGENCY") return "sybil";
  if (s === "WARNING") return "honey";
  return "muted";
}

function fmtTime(ts: string | null): string {
  if (!ts) return "—";
  // HH:MM:SS local; the date is almost always "today" in a live tail.
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour12: false });
}

export default function LogPanel() {
  const [service, setService] = useState<string>("honeycomb-api");
  const [minSeverity, setMinSeverity] = useState<string>("");
  const [sinceMinutes, setSinceMinutes] = useState<number>(60);
  const [contains, setContains] = useState<string>("");
  const [auto, setAuto] = useState<boolean>(false);
  const [state, setState] = useState<FetchState>({ phase: "idle" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const params = new URLSearchParams({
      service,
      limit: "150",
      sinceMinutes: String(sinceMinutes),
    });
    if (minSeverity) params.set("minSeverity", minSeverity);
    if (contains.trim()) params.set("contains", contains.trim());
    try {
      const res = await fetch(`/api/honeycomb/logs?${params.toString()}`, {
        cache: "no-store",
      });
      const body = (await res.json()) as LogResponse | { error?: string };
      if (!res.ok) {
        const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
        setState({ phase: "error", message: msg });
        return;
      }
      setState({ phase: "ok", data: body as LogResponse });
    } catch (e) {
      setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [service, minSeverity, sinceMinutes, contains]);

  // Initial load + reload whenever a filter changes.
  useEffect(() => {
    void load();
  }, [load]);

  // Optional auto-refresh (10s) for a live tail feel without a websocket.
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [auto, load]);

  const entries = state.phase === "ok" ? state.data.entries : [];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-3">
        <SectionLabel>Service logs</SectionLabel>
        <span className="text-xs text-ink-3">(redacted, live)</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* service toggle */}
          <select
            value={service}
            onChange={(e) => setService(e.target.value)}
            className="rounded-md border border-edge bg-card-2 px-2 py-1 text-xs text-ink-1"
            aria-label="service"
          >
            {SERVICES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {/* severity */}
          <select
            value={minSeverity}
            onChange={(e) => setMinSeverity(e.target.value)}
            className="rounded-md border border-edge bg-card-2 px-2 py-1 text-xs text-ink-1"
            aria-label="minimum severity"
          >
            {SEVERITIES.map((s) => (
              <option key={s || "all"} value={s}>
                {s || "all severities"}
              </option>
            ))}
          </select>
          {/* window */}
          <select
            value={sinceMinutes}
            onChange={(e) => setSinceMinutes(Number(e.target.value))}
            className="rounded-md border border-edge bg-card-2 px-2 py-1 text-xs text-ink-1"
            aria-label="time window"
          >
            {WINDOWS.map((m) => (
              <option key={m} value={m}>
                last {m < 60 ? `${m}m` : `${m / 60}h`}
              </option>
            ))}
          </select>
          {/* substring filter */}
          <input
            value={contains}
            onChange={(e) => setContains(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load();
            }}
            placeholder="contains…"
            className="w-28 rounded-md border border-edge bg-card-2 px-2 py-1 text-xs text-ink-1 placeholder:text-ink-3"
            aria-label="contains filter"
          />
          {/* auto-refresh */}
          <label className="flex items-center gap-1 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
            auto
          </label>
          {/* manual refresh */}
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-edge bg-card-2 px-2 py-1 text-xs font-medium text-ink-1 hover:bg-card"
          >
            {state.phase === "loading" ? "…" : "refresh"}
          </button>
        </div>
      </div>

      {state.phase === "error" ? (
        <div className="px-4 py-4 text-sm text-sybil">
          Failed to load logs: <span className="font-mono text-xs">{state.message}</span>
        </div>
      ) : state.phase === "loading" && entries.length === 0 ? (
        <div className="px-4 py-6 text-sm text-ink-2">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="px-4 py-6 text-sm text-ink-2">
          No log entries in this window.
        </div>
      ) : (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full text-xs">
            <tbody className="font-mono">
              {entries.map((e, i) => (
                <tr key={i} className="border-t border-edge align-top">
                  <td className="whitespace-nowrap px-3 py-1 text-ink-3">{fmtTime(e.timestamp)}</td>
                  <td className="px-2 py-1">
                    <Chip tone={sevTone(e.severity)}>{e.severity}</Chip>
                  </td>
                  <td className={cn("px-3 py-1 text-ink-1", "whitespace-pre-wrap break-all")}>
                    {e.text || <span className="text-ink-3">(empty)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
