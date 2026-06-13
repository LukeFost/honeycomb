import type { TrustAgent, TrustCategory } from "@/lib/snapshot";

// A slope chart: each agent is a line from its RAW on-chain score (left) to its
// Honeycomb TRUST score (right). The sybil ring (101 agents fed by one wallet) starts
// near 100 and collapses; only the organic agent holds. This is the project's thesis in
// one picture — raw reputation is gameable, the BigQuery trust layer is not.

const W = 760;
const H = 380;
const leftX = 152;
const rightX = 600;
const topY = 40;
const botY = 330;

const y = (score: number) => botY - (Math.max(0, Math.min(100, score)) / 100) * (botY - topY);

const STYLE: Record<TrustCategory, { stroke: string; width: number; opacity: number }> = {
  sybil: { stroke: "#fb7185", width: 1, opacity: 0.22 },
  thin: { stroke: "#f5b301", width: 1.6, opacity: 0.8 },
  organic: { stroke: "#34d399", width: 2.6, opacity: 1 },
};

export default function TrustSlopeChart({
  agents,
  avgRaw,
  avgTrust,
}: {
  agents: TrustAgent[];
  avgRaw: number;
  avgTrust: number;
}) {
  if (agents.length === 0) return null;

  // draw order: sybil (background) -> thin -> organic (foreground)
  const order: TrustCategory[] = ["sybil", "thin", "organic"];
  const sorted = [...agents].sort(
    (a, b) => order.indexOf(a.category) - order.indexOf(b.category),
  );
  const organic = agents.filter((a) => a.category === "organic");
  const ticks = [0, 25, 50, 75, 100];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Raw reputation vs Honeycomb trust score">
      {/* column headers */}
      <text x={leftX} y={24} textAnchor="middle" fill="#a1a1aa" fontSize="12" fontWeight={600}>
        RAW on-chain score
      </text>
      <text x={rightX} y={24} textAnchor="middle" fill="#a1a1aa" fontSize="12" fontWeight={600}>
        Honeycomb TRUST score
      </text>

      {/* axes + ticks */}
      {[leftX, rightX].map((ax) => (
        <line key={ax} x1={ax} y1={topY} x2={ax} y2={botY} stroke="rgba(255,255,255,0.14)" />
      ))}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={leftX} y1={y(t)} x2={rightX} y2={y(t)} stroke="rgba(255,255,255,0.04)" />
          <text x={leftX - 12} y={y(t) + 3} textAnchor="end" className="tnum" fill="#71717a" fontSize="10">
            {t}
          </text>
          <text x={rightX + 12} y={y(t) + 3} textAnchor="start" className="tnum" fill="#71717a" fontSize="10">
            {t}
          </text>
        </g>
      ))}

      {/* one slope line per agent */}
      {sorted.map((a) => {
        const s = STYLE[a.category];
        return (
          <line
            key={a.agentId}
            x1={leftX}
            y1={y(a.avgScore)}
            x2={rightX}
            y2={y(a.trustScore)}
            stroke={s.stroke}
            strokeWidth={s.width}
            strokeOpacity={s.opacity}
            strokeLinecap="round"
          >
            <title>{`${a.name ?? `Agent #${a.agentId}`}: raw ${a.avgScore} → trust ${a.trustScore}`}</title>
          </line>
        );
      })}

      {/* organic endpoints + label (the survivor) */}
      {organic.map((a) => (
        <g key={`o-${a.agentId}`}>
          <circle cx={leftX} cy={y(a.avgScore)} r={4} fill="#34d399" />
          <circle cx={rightX} cy={y(a.trustScore)} r={5} fill="#34d399" stroke="#0a0a0b" strokeWidth={2} />
          <text x={rightX + 28} y={y(a.trustScore) - 4} fill="#34d399" fontSize="12" fontWeight={600}>
            {a.name ?? `Agent #${a.agentId}`}
          </text>
          <text x={rightX + 28} y={y(a.trustScore) + 11} fill="#6ee7b7" fontSize="10">
            organic · {a.independentClients} independent reviewers
          </text>
        </g>
      ))}

      {/* average collapse line — the headline */}
      <line
        x1={leftX}
        y1={y(avgRaw)}
        x2={rightX}
        y2={y(avgTrust)}
        stroke="#ffcf4d"
        strokeWidth={2.6}
        strokeDasharray="6 4"
      />
      <circle cx={leftX} cy={y(avgRaw)} r={4} fill="#ffcf4d" />
      <circle cx={rightX} cy={y(avgTrust)} r={4} fill="#ffcf4d" />
      <text x={leftX - 12} y={y(avgRaw) - 8} textAnchor="end" fill="#ffcf4d" fontSize="11" fontWeight={600}>
        avg {avgRaw.toFixed(1)}
      </text>
      <text x={(leftX + rightX) / 2} y={y((avgRaw + avgTrust) / 2) - 10} textAnchor="middle" fill="#ffcf4d" fontSize="11" fontWeight={600}>
        mean reputation collapses
      </text>
      <text x={rightX + 28} y={y(avgTrust) + 4} textAnchor="start" fill="#ffcf4d" fontSize="11" fontWeight={600}>
        avg {avgTrust.toFixed(1)}
      </text>
    </svg>
  );
}
