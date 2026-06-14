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
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {bounties.map((b) => {
        const { label, daysLeft } = deadlineParts(b.deadline);
        return (
          <div key={b.id} className="flex flex-col rounded-xl border border-edge bg-card-2 p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Chip tone="muted">{CATEGORY_LABEL[b.category] ?? b.category}</Chip>
              <span className="font-mono text-sm font-semibold text-gold tnum">{b.rewardEth} ETH</span>
            </div>
            <div className="mb-3 text-sm font-medium leading-snug text-ink">{b.title}</div>
            <div className="mt-auto flex items-center justify-between text-[11px] text-ink-2">
              <AddrLink addr={b.requester} className="font-mono" />
              <span className="tnum">{b.submissions} subs</span>
              <span className={daysLeft <= 5 ? "text-gold" : ""}>closes {label} · {daysLeft}d</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
