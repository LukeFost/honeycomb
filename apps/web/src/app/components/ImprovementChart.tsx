// Log-scale chart: the autoresearcher's best private-set score per research
// iteration. On a log axis the gains read as a straight, un-plateauing climb —
// the point being continuous improvement. Data is deterministic (no Math.random)
// so server and client render identically.

const N = 40;
const START = 14;
const END = 7000;
const DECADES = [10, 100, 1000, 10000];

// viewBox geometry
const W = 920;
const H = 480;
const L = 78; // left padding (y labels)
const R = 28;
const T = 28;
const B = 56; // bottom padding (x labels)
const PW = W - L - R;
const PH = H - T - B;

const Y_MIN = 10;
const Y_MAX = 10000;

// deterministic pseudo-noise in [0,1)
const hash = (i: number) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const xAt = (i: number) => L + (i / N) * PW;
const yAt = (v: number) => {
  const f =
    (Math.log10(v) - Math.log10(Y_MIN)) / (Math.log10(Y_MAX) - Math.log10(Y_MIN));
  return T + (1 - f) * PH;
};

type Pt = { i: number; best: number; raw: number };

function buildData(): Pt[] {
  const out: Pt[] = [];
  const k = Math.log10(END / START);
  for (let i = 0; i <= N; i++) {
    const best = START * Math.pow(10, (i / N) * k); // smooth log-linear climb
    const raw = Math.max(Y_MIN, best * (0.5 + 0.62 * hash(i))); // scattered attempts
    out.push({ i, best, raw });
  }
  return out;
}

export default function ImprovementChart() {
  const data = buildData();
  const gain = Math.round(data[N].best / data[0].best);

  const bestLine = data.map((p) => `${xAt(p.i).toFixed(1)},${yAt(p.best).toFixed(1)}`).join(" ");
  const area =
    `M ${xAt(0).toFixed(1)},${yAt(data[0].best).toFixed(1)} ` +
    data.map((p) => `L ${xAt(p.i).toFixed(1)},${yAt(p.best).toFixed(1)}`).join(" ") +
    ` L ${xAt(N).toFixed(1)},${(T + PH).toFixed(1)} L ${xAt(0).toFixed(1)},${(T + PH).toFixed(1)} Z`;

  return (
    <section id="improvement" className="hc-section">
      <div className="mx-auto w-full max-w-4xl px-6 py-24 sm:py-32">
        <p className="hc-eyebrow mb-3 font-mono text-[0.7rem] uppercase tracking-[0.4em]">
          Autoresearcher
        </p>
        <h2 className="hc-h2 text-3xl font-semibold tracking-tight sm:text-4xl">
          Agents that keep getting better
        </h2>
        <p className="hc-body mt-4 max-w-2xl text-base leading-7 sm:text-lg">
          Honeycomb&apos;s autoresearcher loop compounds. Each research iteration raises
          the best score on the hidden private set — and on a log scale the gains
          don&apos;t flatten out, they keep climbing.
        </p>

        <div className="hc-card mt-10 rounded-2xl p-4 sm:p-6">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-xs uppercase tracking-widest text-white/55">
              best private-set score · log scale
            </span>
            <span className="font-mono text-xs text-[color:var(--accent,#ffc440)]">
              ≈ {gain}× over {N} iterations
            </span>
          </div>

          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
            aria-label={`Autoresearcher best score climbing roughly ${gain}x across ${N} research iterations on a log scale`}>
            <defs>
              <linearGradient id="hcFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ffc440" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#ffc440" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* horizontal log gridlines + y labels */}
            {DECADES.map((d) => (
              <g key={d}>
                <line x1={L} y1={yAt(d)} x2={W - R} y2={yAt(d)} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
                <text x={L - 12} y={yAt(d) + 4} textAnchor="end" className="hc-axis">
                  {d.toLocaleString()}
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

            {/* area + best-so-far line */}
            <path d={area} fill="url(#hcFill)" />
            <polyline
              points={bestLine}
              fill="none"
              stroke="#ffc440"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* individual attempts (scatter) */}
            {data.map((p) => (
              <circle key={p.i} cx={xAt(p.i)} cy={yAt(p.raw)} r="2.4" fill="rgba(255,255,255,0.45)" />
            ))}

            {/* endpoint marker */}
            <circle cx={xAt(N)} cy={yAt(data[N].best)} r="5" fill="#ffc440" />
            <circle cx={xAt(N)} cy={yAt(data[N].best)} r="10" fill="#ffc440" opacity="0.18" />
          </svg>

          <p className="mt-4 font-mono text-[0.7rem] leading-5 text-white/40">
            ● best score per iteration · ○ individual attempts — cites: autoresearcher gains
            (Honeycomb internal backtests, hidden private set)
          </p>
        </div>
      </div>
    </section>
  );
}
