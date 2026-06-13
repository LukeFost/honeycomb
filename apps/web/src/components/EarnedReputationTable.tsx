import type { AgentReputation, RepBasis } from "@/lib/reputation";
import { Chip, cn, truncAddr } from "./ui";

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

function scoreColor(score: number, basis: RepBasis): string {
  if (basis !== "earned") return "text-zinc-400";
  if (score >= 70) return "text-organic";
  if (score >= 40) return "text-honey-bright";
  return "text-sybil";
}

export default function EarnedReputationTable({ agents }: { agents: AgentReputation[] }) {
  return (
    <div className="thin-scroll overflow-x-auto rounded-xl border border-edge">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-[#141416] text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-semibold">Agent</th>
            <th className="px-3 py-2 text-right font-semibold">Reputation</th>
            <th className="px-3 py-2 text-right font-semibold">Global ERC-8004</th>
            <th className="px-3 py-2 text-right font-semibold">Enclave avg</th>
            <th className="px-3 py-2 text-right font-semibold">Wins</th>
            <th className="px-3 py-2 text-right font-semibold">Indep. req.</th>
            <th className="px-3 py-2 font-semibold">Signals</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.agentId} className="border-t border-white/[0.05] hover:bg-white/[0.02]">
              <td className="px-3 py-2">
                <div className="font-medium text-zinc-100">{a.name}</div>
                <div className="font-mono text-[11px] text-zinc-500 tnum">
                  #{a.agentId} · {truncAddr(a.owner)}
                </div>
              </td>
              <td className="px-3 py-2 text-right">
                <div className={cn("text-lg font-semibold tabular-nums tnum", scoreColor(a.effectiveScore, a.basis))}>
                  {a.effectiveScore.toFixed(1)}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-zinc-600">{BASIS_LABEL[a.basis]}</div>
              </td>
              <td className="px-3 py-2 text-right tabular-nums tnum text-zinc-400">
                {a.globalTrust == null ? <span className="text-zinc-600">—</span> : a.globalTrust.toFixed(0)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums tnum text-zinc-400">
                {a.avgEnclaveScore == null ? <span className="text-zinc-600">—</span> : a.avgEnclaveScore.toFixed(0)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums tnum text-zinc-300">
                {a.bountiesWon}
                <span className="text-zinc-600">/{a.bountiesEntered}</span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums tnum">
                <span className={a.independentRequesters >= 3 ? "text-organic" : a.independentRequesters >= 1 ? "text-honey-bright" : "text-zinc-600"}>
                  {a.independentRequesters}
                </span>
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {a.flags.map((f) => (
                    <Chip key={f} tone={FLAG_TONE[f] ?? "muted"}>{f}</Chip>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
