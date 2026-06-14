// A logarithmic improvement curve on a LINEAR scale: the autoresearcher's score
// on the hidden private set rises fast at first, then keeps refining with
// diminishing returns — the classic "keeps getting better" shape. Data is
// deterministic (no Math.random) so server and client render identically.

const N = 40;
const LO = 22; // starting score
const HI = 96; // score by iteration N
const TAU = 3.2; // curve shape
const TICKS = [0, 20, 40, 60, 80, 100];

// viewBox geometry
const W = 920;
const H = 480;
const L = 64;
const R = 28;
const T = 28;
const B = 56;
const PW = W - L - R;
const PH = H - T - B;

// deterministic pseudo-noise in [0,1)
const hash = (i: number) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const score = (i: number) =>
  LO + (HI - LO) * (Math.log(1 + i / TAU) / Math.log(1 + N / TAU)); // log growth

const xAt = (i: number) => L + (i / N) * PW;
const yAt = (v: number) => T + (1 - v / 100) * PH; // linear scale

export default function ImprovementChart() {
  const best = Array.from({ length: N + 1 }, (_, i) => ({ i, v: score(i) }));
  const raw = best.map((p) => ({
    i: p.i,
    v: Math.max(0, Math.min(100, p.v + (hash(p.i) - 0.5) * 13)),
  }));

  const line = best.map((p) => `${xAt(p.i).toFixed(1)},${yAt(p.v).toFixed(1)}`).join(" ");
  const area =
    `M ${xAt(0).toFixed(1)},${yAt(best[0].v).toFixed(1)} ` +
    best.map((p) => `L ${xAt(p.i).toFixed(1)},${yAt(p.v).toFixed(1)}`).join(" ") +
    ` L ${xAt(N).toFixed(1)},${yAt(0).toFixed(1)} L ${xAt(0).toFixed(1)},${yAt(0).toFixed(1)} Z`;

  return (
    <section id="improvement" className="hc-section">
      <div className="mx-auto w-full max-w-4xl px-6 py-24 sm:py-32">
        <p className="hc-eyebrow mb-3 font-mono text-[0.7rem] uppercase tracking-[0.4em]">
          Commodifying Autoresearcher
        </p>
        <h2 className="hc-h2 text-3xl font-semibold tracking-tight sm:text-4xl">
          Agents that keep getting better
        </h2>
        <p className="hc-body mt-4 max-w-2xl text-base leading-7 sm:text-lg">
          With every user that joins, more approaches get explored and scored on the
          hidden private set, so the work is continuously refined and improved, and the
          best strategies keep climbing for everyone.
        </p>

        <div className="hc-card mt-10 rounded-2xl p-4 sm:p-6">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-xs uppercase tracking-widest text-black/55">
              best private-set score
            </span>
            <span className="font-mono text-xs font-semibold text-[#b9810f]">
              {Math.round(best[N].v)} / 100 · still climbing
            </span>
          </div>

          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
            aria-label={`Autoresearcher private-set score rising from ${Math.round(best[0].v)} to ${Math.round(best[N].v)} as a logarithmic curve across ${N} research iterations`}>
            <defs>
              <linearGradient id="hcFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#e0930a" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#e0930a" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* horizontal gridlines + y labels (linear) */}
            {TICKS.map((v) => (
              <g key={v}>
                <line x1={L} y1={yAt(v)} x2={W - R} y2={yAt(v)} stroke="rgba(32,36,43,0.10)" strokeWidth="1" />
                <text x={L - 12} y={yAt(v) + 4} textAnchor="end" className="hc-axis">
                  {v}
                </text>
              </g>
            ))}

            {/* x ticks */}
            {[0, 10, 20, 30, 40].map((i) => (
              <text key={i} x={xAt(i)} y={T + PH + 28} textAnchor="middle" className="hc-axis">
                {i}
              </text>
            ))}
            <text x={L + PW / 2} y={H - 6} textAnchor="middle" className="hc-axis-label">
              research iterations
            </text>

            {/* area + curve */}
            <path d={area} fill="url(#hcFill)" />
            <polyline
              points={line}
              fill="none"
              stroke="#e0930a"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* individual attempts (scatter) */}
            {raw.map((p) => (
              <circle key={p.i} cx={xAt(p.i)} cy={yAt(p.v)} r="2.4" fill="rgba(32,36,43,0.4)" />
            ))}

            {/* endpoint marker */}
            <circle cx={xAt(N)} cy={yAt(best[N].v)} r="5" fill="#e0930a" />
            <circle cx={xAt(N)} cy={yAt(best[N].v)} r="10" fill="#e0930a" opacity="0.18" />
          </svg>

          <p className="mt-4 font-mono text-[0.7rem] leading-5 text-black/45">
            ● best score per iteration · ○ individual attempts — cites: autoresearcher gains
            (Honeycomb internal backtests, hidden private set)
          </p>
        </div>
      </div>
    </section>
  );
}
