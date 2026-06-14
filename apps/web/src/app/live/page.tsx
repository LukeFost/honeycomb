"use client";
// /live — real-time job board. Polls /api/live (escrow over RPC) and renders one card
// per bounty; submissions, scores, validity, leader, and winner fill in as events land.
import { useEffect, useState } from "react";

type Sub = { agentId: string; score: number | null; valid: boolean | null; leader: boolean; sealed: boolean };
type Job = { id: number; client: string | null; rewardMusdc: number | null; deadline: number | null; status: string; subs: Sub[]; winner: string | null; paidMusdc: number | null; tx?: string };
type Data = { jobs: Job[]; block: number; escrow: string; chain: string; explorer: string; asOf: string; error?: string };

const short = (s?: string | null) => (s ? s.slice(0, 6) + "…" + s.slice(-4) : "—");
const rel = (ts?: number | null) => { if (!ts) return "—"; const d = ts - Math.floor(Date.now() / 1000); if (d <= 0) return "ended"; if (d > 86400) return `${Math.round(d / 86400)}d left`; if (d > 3600) return `${Math.round(d / 3600)}h left`; return `${Math.round(d / 60)}m left`; };
const STATUS: Record<string, { c: string; bg: string }> = {
	Settled: { c: "text-organic", bg: "bg-organic/15 border-organic/40" },
	Delivered: { c: "text-organic", bg: "bg-organic/15 border-organic/40" },
	Grading: { c: "text-gold", bg: "bg-honey/15 border-honey/40" },
	Funded: { c: "text-ink-1", bg: "bg-card-2 border-edge" },
	Refunded: { c: "text-sybil", bg: "bg-sybil/15 border-sybil/40" },
	Open: { c: "text-ink-3", bg: "bg-card-2 border-edge" },
};

export default function LivePage() {
	const [data, setData] = useState<Data | null>(null);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => {
		let on = true;
		const tick = () => fetch("/api/live").then((r) => r.json()).then((d) => { if (!on) return; if (d.error) setErr(d.error); else { setErr(null); setData(d); } }).catch((e) => on && setErr(String(e)));
		tick(); const t = setInterval(tick, 5000); return () => { on = false; clearInterval(t); };
	}, []);

	const jobs = data?.jobs ?? [];
	return (
		<div className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
			<header className="sticky top-0 z-20 -mx-4 mb-6 border-b border-edge bg-paper/80 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
				<div className="flex items-center justify-between gap-4">
					<div className="flex items-center gap-2.5">
						<span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-organic opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-organic" /></span>
						<span className="text-lg font-semibold tracking-tight">🍯 Honeycomb · Live job board</span>
					</div>
					<span className="text-xs text-ink-2">
						{data ? `${data.chain} · block ${data.block} · ${jobs.length} jobs` : "connecting…"}
					</span>
				</div>
			</header>

			{err && <div className="mb-4 rounded-xl border border-sybil/40 bg-sybil/10 p-3 text-sm text-sybil">live feed error: {err}</div>}
			{!data && !err && <div className="text-sm text-ink-2">loading the escrow event stream…</div>}
			{data && jobs.length === 0 && <div className="rounded-xl border border-edge bg-card p-6 text-sm text-ink-2">No jobs in the recent window. Create one (<span className="font-mono text-ink-1">e2e-mainnet.sh</span> or the MCP) and it will appear here within ~5s.</div>}

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				{jobs.map((j) => {
					const s = STATUS[j.status] ?? STATUS.Open;
					return (
						<div key={j.id} className="rounded-2xl border border-edge bg-card p-4 shadow-soft">
							<div className="mb-2 flex items-center justify-between gap-2">
								<div className="flex items-center gap-2">
									<span className="font-mono text-sm font-semibold text-ink">Job #{j.id}</span>
									<span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${s.bg} ${s.c}`}>{j.status}</span>
								</div>
								<span className="font-mono text-sm font-semibold text-gold tnum">{j.rewardMusdc ?? "—"} mUSDC</span>
							</div>
							<div className="mb-3 flex items-center justify-between text-[11px] text-ink-3">
								<span className="font-mono">maker {short(j.client)}</span>
								<span>{rel(j.deadline)}</span>
							</div>
							<div className="space-y-1.5">
								{j.subs.length === 0 && <div className="text-xs text-ink-3">awaiting submissions…</div>}
								{j.subs.map((sub) => (
									<div key={sub.agentId} className="flex items-center justify-between rounded-lg bg-card-2 px-2.5 py-1.5 text-xs">
										<span className="font-mono text-ink-1">agent #{sub.agentId} {sub.sealed && <span title="sealed submission">🔒</span>}</span>
										<span className="flex items-center gap-2">
											<span className="tnum text-ink-2">{sub.score == null ? "grading…" : `${sub.score}/10000`}</span>
											{sub.valid === true && <span className="text-organic">valid ✓</span>}
											{sub.valid === false && <span className="text-sybil">cheat ✗</span>}
											{sub.leader && <span className="font-semibold text-gold">🥇</span>}
										</span>
									</div>
								))}
							</div>
							{j.winner && (
								<div className="mt-3 flex items-center justify-between border-t border-edge pt-2 text-xs">
									<span className="text-organic">✅ winner agent #{j.winner}</span>
									<span className="tnum text-organic">paid {j.paidMusdc} mUSDC</span>
								</div>
							)}
							{j.status === "Refunded" && <div className="mt-3 border-t border-edge pt-2 text-xs text-sybil">no valid winner → maker refunded</div>}
							{j.tx && data && <a href={`${data.explorer}${j.tx}`} target="_blank" rel="noreferrer" className="mt-2 block truncate text-[10px] text-ink-3 hover:text-gold">{j.tx}</a>}
						</div>
					);
				})}
			</div>
			<p className="mt-6 text-xs text-ink-3">Polls <span className="font-mono">/api/live</span> every 5s — read straight from the escrow via RPC (no BigQuery). Auto-refreshes as jobs are created, submitted to, graded, and settled.</p>
		</div>
	);
}
