import type { Bounty } from "@/lib/reputation";
import { AddrLink, Chip } from "./ui";

const CATEGORY_LABEL: Record<string, string> = {
  "smart-contract-audit": "SC audit",
  "defi-strategy": "DeFi strategy",
  "zkml-proof": "zkML proof",
  "data-labeling": "Data labeling",
  "gas-optimization": "Gas opt",
  "ml-eval": "ML eval",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function deadlineParts(iso: string): { label: string; daysLeft: number } {
  const [y, m, d] = iso.split("-").map(Number);
  const due = Date.UTC(y, m - 1, d);
  const daysLeft = Math.max(0, Math.round((due - Date.now()) / 86_400_000));
  return { label: `${MONTHS[m - 1]} ${d}`, daysLeft };
}

export default function BountyBoard({ bounties }: { bounties: Bounty[] }) {
  if (bounties.length === 0) {
    return (
      <div className="rounded-xl border border-edge bg-card-2 px-4 py-10 text-center text-sm text-ink-3">
        No open bounties right now.
      </div>
    );
  }
  return (
    <div className="thin-scroll overflow-x-auto rounded-xl border border-edge">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-card-2 text-left text-xs uppercase tracking-wide text-ink-3">
          <tr>
            <th className="px-3 py-2 font-semibold">Category</th>
            <th className="px-3 py-2 font-semibold">Bounty</th>
            <th className="px-3 py-2 text-right font-semibold">Reward</th>
            <th className="px-3 py-2 font-semibold">Requester</th>
            <th className="px-3 py-2 text-right font-semibold">Subs</th>
            <th className="px-3 py-2 text-right font-semibold">Closes</th>
          </tr>
        </thead>
        <tbody>
          {bounties.map((b) => {
            const { label, daysLeft } = deadlineParts(b.deadline);
            return (
              <tr key={b.id} className="border-t border-edge hover:bg-card-2">
                <td className="px-3 py-2.5 align-middle">
                  <Chip tone="muted" className="whitespace-nowrap">{CATEGORY_LABEL[b.category] ?? b.category}</Chip>
                </td>
                <td className="px-3 py-2.5 align-middle font-medium leading-snug text-ink">{b.title}</td>
                <td className="px-3 py-2.5 text-right align-middle font-mono font-semibold tnum whitespace-nowrap text-gold">
                  {b.rewardEth} mUSDC
                </td>
                <td className="px-3 py-2.5 align-middle font-mono text-[11px] text-ink-2">
                  <AddrLink addr={b.requester} />
                </td>
                <td className="px-3 py-2.5 text-right align-middle tabular-nums tnum text-ink-1">{b.submissions}</td>
                <td className="px-3 py-2.5 text-right align-middle tnum whitespace-nowrap">
                  <span className={daysLeft <= 5 ? "text-gold" : "text-ink-2"}>{label}</span>
                  <span className="text-ink-3"> · {daysLeft}d</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
