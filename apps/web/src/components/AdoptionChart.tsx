"use client";

import { useState } from "react";
import type { AdoptionPoint } from "@/lib/snapshot";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDay(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

// viewBox geometry (the SVG scales to its container width)
const W = 760;
const H = 280;
const M = { top: 16, right: 14, bottom: 30, left: 44 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

export default function AdoptionChart({ data }: { data: AdoptionPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) return null;

  const n = data.length;
  const maxCum = Math.max(...data.map((d) => d.cumulative), 1);
  const maxNew = Math.max(...data.map((d) => d.newAgents), 1);

  const x = (i: number) => M.left + (n === 1 ? PW / 2 : (i / (n - 1)) * PW);
  const yCum = (v: number) => M.top + PH - (v / maxCum) * PH;
  // daily bars occupy the lower 45% of the plot so they read as a secondary series
  const barTop = (v: number) => M.top + PH - (v / maxNew) * (PH * 0.45);

  const linePts = data.map((d, i) => `${x(i)},${yCum(d.cumulative)}`).join(" ");
  const areaPts = `${M.left},${M.top + PH} ${linePts} ${M.left + PW},${M.top + PH}`;
  const barW = Math.max(2, (PW / n) * 0.5);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxCum * f));
  const xTickIdx = Array.from(new Set([0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1]));

  const hv = hover != null ? data[hover] : null;

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Agent registrations over time">
        <defs>
          <linearGradient id="adopt-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f5b301" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#f5b301" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* horizontal gridlines + y labels */}
        {yTicks.map((v, i) => {
          const yy = yCum(v);
          return (
            <g key={i}>
              <line x1={M.left} y1={yy} x2={M.left + PW} y2={yy} stroke="rgba(255,255,255,0.06)" />
              <text x={M.left - 8} y={yy + 3} textAnchor="end" className="tnum" fill="#71717a" fontSize="11">
                {v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}
              </text>
            </g>
          );
        })}

        {/* daily-new bars (secondary series) */}
        {data.map((d, i) => (
          <rect
            key={i}
            x={x(i) - barW / 2}
            y={barTop(d.newAgents)}
            width={barW}
            height={M.top + PH - barTop(d.newAgents)}
            fill="#f5b301"
            opacity={hover === i ? 0.55 : 0.16}
            rx={1}
          />
        ))}

        {/* cumulative area + line */}
        <polygon points={areaPts} fill="url(#adopt-fill)" />
        <polyline points={linePts} fill="none" stroke="#ffcf4d" strokeWidth={2} strokeLinejoin="round" />

        {/* hover guideline + marker */}
        {hv && (
          <g>
            <line x1={x(hover!)} y1={M.top} x2={x(hover!)} y2={M.top + PH} stroke="rgba(255,255,255,0.18)" />
            <circle cx={x(hover!)} cy={yCum(hv.cumulative)} r={4} fill="#ffcf4d" stroke="#0a0a0b" strokeWidth={2} />
          </g>
        )}

        {/* x labels */}
        {xTickIdx.map((i) => (
          <text key={i} x={x(i)} y={H - 10} textAnchor="middle" fill="#71717a" fontSize="11">
            {fmtDay(data[i].day)}
          </text>
        ))}

        {/* invisible hover columns */}
        {data.map((_, i) => (
          <rect
            key={i}
            x={i === 0 ? M.left : x(i) - (PW / (n - 1)) / 2}
            y={M.top}
            width={PW / Math.max(1, n - 1)}
            height={PH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
          />
        ))}
      </svg>

      {hv && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg border border-edge bg-black/85 px-3 py-2 text-xs shadow-xl"
          style={{
            left: `calc(${(x(hover!) / W) * 100}% + 8px)`,
            transform: x(hover!) > W * 0.7 ? "translateX(-110%)" : "none",
          }}
        >
          <div className="mb-1 font-medium text-zinc-200">{fmtDay(hv.day)}</div>
          <div className="flex items-center justify-between gap-4 text-zinc-400">
            <span>New agents</span>
            <span className="tnum font-medium text-honey-bright">+{hv.newAgents.toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between gap-4 text-zinc-400">
            <span>Cumulative</span>
            <span className="tnum font-medium text-zinc-100">{hv.cumulative.toLocaleString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}
