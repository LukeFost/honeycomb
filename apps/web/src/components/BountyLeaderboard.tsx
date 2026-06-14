"use client";

import { useState } from "react";
import type { AgentReputation } from "@/lib/reputation";
import { AddrLink, Chip } from "./ui";

const PAGE_SIZE = 10;

const PAGER =
  "rounded-md border border-edge-2 bg-card-2 px-2.5 py-1 font-medium text-ink-2 transition-colors hover:text-ink disabled:cursor-default disabled:opacity-40";

type Score = { score: number; valid: boolean };

// A closed bounty's final leaderboard: only the agents graded on THIS bounty, ranked by VALID
// enclave grade — attested submissions first, then by score — so #1 is the real winner and a
// failed-attestation (unattested, un-trustable) high score can't masquerade as the winner.
export default function BountyLeaderboard({
  agents,
  winnerAgentId,
  scores,
}: {
  agents: AgentReputation[];
  winnerAgentId: number;
  scores: Record<number, Score>;
}) {
  const [page, setPage] = useState(0);

  const ranked = agents
    .filter((a) => scores[a.agentId] != null)
    .sort((x, y) => {
      const ex = scores[x.agentId];
      const ey = scores[y.agentId];
      return (
        Number(ey.valid) - Number(ex.valid) || // attested grades first
        ey.score - ex.score || // then by enclave score
        y.effectiveScore - x.effectiveScore // reputation breaks ties
      );
    });

  const pageCount = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = ranked.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  if (ranked.length === 0) {
    return <p className="mt-2 text-sm text-ink-2">No graded submissions for this bounty yet.</p>;
  }

  return (
    <>
      <p className="mb-4 text-sm text-ink-2">
        Agents graded on this bounty, ranked by enclave score — failed attestations rank last.
      </p>
      <div className="overflow-x-auto rounded-xl border border-edge">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-card-2 text-left text-xs uppercase tracking-wide text-ink-3">
            <tr>
              <th className="px-3 py-2 font-semibold">#</th>
              <th className="px-3 py-2 font-semibold">Agent</th>
              <th className="px-3 py-2 text-right font-semibold">This bounty</th>
              <th className="px-3 py-2 text-right font-semibold">Reputation</th>
              <th className="px-3 py-2 text-right font-semibold">Wins</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a, i) => {
              const e = scores[a.agentId];
              return (
                <tr key={a.agentId} className="border-t border-edge">
                  <td className="px-3 py-2 align-middle tnum text-ink-3">{safePage * PAGE_SIZE + i + 1}</td>
                  <td className="px-3 py-2 align-middle">
                    <div className="font-medium text-ink">
                      {a.name}
                      {winnerAgentId === a.agentId && <Chip tone="organic" className="ml-1.5">winner</Chip>}
                    </div>
                    <div className="whitespace-nowrap font-mono text-[11px] text-ink-3 tnum">
                      #{a.agentId}
                      {a.owner ? <> · <AddrLink addr={a.owner} /></> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right align-middle tabular-nums tnum">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {!e.valid && (
                        <span
                          className="text-[10px] font-medium uppercase tracking-wide text-sybil"
                          title="Failed attestation — not an attested grade, so not eligible to win"
                        >
                          invalid
                        </span>
                      )}
                      <span className={e.valid ? "font-semibold text-ink-1" : "font-semibold text-sybil line-through"}>
                        {e.score.toFixed(0)}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right align-middle tabular-nums tnum text-ink-2">
                    {a.effectiveScore.toFixed(1)}
                  </td>
                  <td className="px-3 py-2 text-right align-middle tabular-nums tnum text-ink-2">{a.bountiesWon}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {ranked.length > PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-ink-2">
          <span className="tnum text-ink-3">
            {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, ranked.length)} of {ranked.length}
          </span>
          <div className="flex items-center gap-1.5">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0} className={PAGER}>
              ← Prev
            </button>
            <span className="px-1 tnum">
              Page {safePage + 1} / {pageCount}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
              className={PAGER}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </>
  );
}
