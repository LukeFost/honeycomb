"use client";

import { useEffect, useRef, useState } from "react";

// ============================================================================
// HowItWorks — the story of one bounty, flowing BOTTOM → TOP on an isometric
// canvas. The user funds the escrow at the bottom; work rises through discovery
// and the swarm; the two graders sit side-by-side (parallel) and converge up to
// the contract, which settles and pays out at the top. Each node fades in only
// when the animation reaches it.
// ============================================================================

type Kind = "prism" | "hive" | "db" | "comb" | "user" | "escrow" | "monitor" | "cre";
type NodeT = { x: number; z: number; pulse: number; label: string; tag: string; logos: string[]; kind: Kind; mon?: "ai" | "score" | "bot"; appearAt: number };

// timeline (ms)
const CYCLE = 35500;
const FUND_END = 3400;
const DISCOVER_END = 6000;
const SWARM_END = 8400;
const SOL_START = 8400;
const SEG1 = 1500; // bounty → graders
const GRADE = 1300; // graders run
const SEG2 = 1500; // graders → contract
const REJECT = 1300; // invalid slides aside
const SOL_STAGGER = 4600; // strictly one at a time: next waits until the one ahead finishes
const SETTLE_START = 27000; // settle + pay the winner
const RETURN_START = 28800; // winning strategy returns to the user
const DEPLOY_START = 30500; // strategy deployed to the Uniswap bot
const solSpawn = (i: number) => SOL_START + i * SOL_STAGGER;
const SCORED = SEG1 + GRADE + SEG2; // per-solution time to reach the contract

// vertical layout: larger (x+z) = lower on screen, so the flow goes up as it
// progresses. The two graders share a height (parallel) and converge to CRE.
const NODES: NodeT[] = [
  { x: 6.0, z: 6.0, pulse: 0, label: "User", tag: "client", logos: [], kind: "user", appearAt: 0 },
  { x: 3.2, z: 3.2, pulse: 0, label: "Escrow", tag: "contract", logos: [], kind: "escrow", appearAt: 500 },
  { x: 1.0, z: 1.0, pulse: 0, label: "Bounty", tag: "ERC-8183", logos: ["uniswap"], kind: "comb", appearAt: 2600 },
  { x: 4.15, z: -1.35, pulse: 0, label: "BigQuery", tag: "discovery", logos: ["google"], kind: "db", appearAt: 3400 },
  { x: -1.35, z: 4.15, pulse: 0, label: "Hive", tag: "agents", logos: ["claudecode", "openai"], kind: "hive", appearAt: 5200 },
  { x: -3.05, z: -0.85, pulse: 0, label: "AI Tester", tag: "Chainlink · TEE", logos: ["chainlink"], kind: "monitor", mon: "ai", appearAt: 7900 },
  { x: -0.85, z: -3.05, pulse: 0, label: "Scorer", tag: "Google · TEE", logos: ["google"], kind: "monitor", mon: "score", appearAt: 7900 },
  { x: -4.0, z: -4.0, pulse: 0, label: "CRE", tag: "settlement", logos: ["chainlink"], kind: "cre", appearAt: 10800 },
  { x: -6.0, z: -6.0, pulse: 0, label: "Payout", tag: "USDC", logos: [], kind: "prism", appearAt: 26000 },
  { x: 6.5, z: 3.0, pulse: 0, label: "Uniswap Bot", tag: "runs on CRE", logos: ["uniswap", "chainlink"], kind: "monitor", mon: "bot", appearAt: 30300 },
];
const USER = 0, ESCROW = 1, BOUNTY = 2, BIGQUERY = 3, HIVE = 4, AITESTER = 5, SCORER = 6, CRE = 7, PAYOUT = 8, BOT = 9;

const STEPS = [
  { label: "Fund", tech: "BountyEscrow.sol", desc: "A user funds the escrow contract; the bounty is posted as a half-built honeycomb." },
  { label: "Discover", tech: "Google BigQuery", desc: "BigQuery indexes the on-chain job and notifies the hive that work is available." },
  { label: "Swarm", tech: "Claude + Codex agents", desc: "The hive dispatches a swarm of agents to work on the bounty." },
  { label: "Propose", tech: "encrypted strategies", desc: "Each agent submits a competing strategy — a price model — one at a time." },
  { label: "Grade", tech: "Chainlink AI + Google · TEE", desc: "Two enclaves run in parallel: one attests validity, one scores blind. Cheats that just shoot straight up are rejected — and the agent's ERC-8004 reputation takes a hit." },
  { label: "Rank", tech: "leaderboard", desc: "Valid results converge to the contract and are ranked on a leaderboard." },
  { label: "Settle & pay", tech: "Chainlink CRE → escrow", desc: "CRE settles on-chain and the escrow releases USDC to the winning agent." },
  { label: "Deploy & run", tech: "Uniswap bot on CRE", desc: "The winning strategy is returned to the user and runs live on an independent Uniswap bot via CRE." },
];

const OPTIONS = [
  { id: "A", color: "#e0930a", valid: true, score: 78 },
  { id: "B", color: "#2faa55", valid: true, score: 91 },
  { id: "C", color: "#d23f3f", valid: false, score: 0 },
  { id: "D", color: "#b65cd1", valid: true, score: 84 },
];

const ISO_COS = Math.cos(Math.PI / 6);
const ISO_SIN = Math.sin(Math.PI / 6);
const R = 0.8;
const H = 0.85;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const hash = (i: number) => { const x = Math.sin(i * 99.13) * 43758.5; return x - Math.floor(x); };
const mix = (a: number[], b: number[], t: number) => `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;

const SIDE_DARK = [120, 78, 14], SIDE_LIGHT = [216, 138, 8], TOP_BASE = [242, 179, 58], TOP_HOT = [255, 226, 150];
const BODY = "#EFA92E", DARK = "#23262d";

function chartPts(i: number, invalid: boolean) {
  const n = 12; const out: number[] = [];
  for (let k = 0; k < n; k++) {
    if (invalid) out.push(k < n - 3 ? 0.45 + (hash(i * 7 + k) - 0.5) * 0.06 : lerp(0.45, 0.98, (k - (n - 4)) / 3));
    else out.push(clamp01(0.4 + (k / n) * 0.25 + (hash(i * 5 + k) - 0.5) * 0.4));
  }
  return out;
}

export default function HowItWorks() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0, height = 0, dpr = 1, scale = 38, ox = 0, oy = 0, lastStep = -1, lastCt = 0;

    const logos: Record<string, { img: HTMLImageElement; ok: boolean }> = {};
    for (const name of ["uniswap", "chainlink", "google", "claudecode", "openai"]) {
      const img = new Image(); const rec = { img, ok: false }; img.onload = () => (rec.ok = true); img.src = `/${name}.svg`; logos[name] = rec;
    }
    const bees = Array.from({ length: 8 }, (_, i) => ({ off: i * 0.78, rad: 0.4 + (i % 3) * 0.16, r: 6 + (i % 3) * 2, phase: i * 1.7, lane: (i / 8 - 0.5) * 1.3 }));
    const rows = OPTIONS.map(() => ({ y: null as number | null }));

    const hOf = (n: NodeT) => (n.kind === "hive" ? H * 1.7 : n.kind === "db" ? H * 1.25 : H);
    const projRaw = (wx: number, wy: number, wz: number) => ({ x: (wx - wz) * ISO_COS * scale, y: ((wx + wz) * ISO_SIN - wy) * scale });
    const proj = (wx: number, wy: number, wz: number) => { const p = projRaw(wx, wy, wz); return { x: p.x + ox, y: p.y + oy }; };
    const hexCorner = (cx: number, cz: number, y: number, i: number) => { const a = (Math.PI / 3) * i + Math.PI / 6; return proj(cx + R * Math.cos(a), y, cz + R * Math.sin(a)); };
    const ground = (n: NodeT) => proj(n.x, 0, n.z);
    const anchor = (n: NodeT) => (n.kind === "comb" || n.kind === "user" ? proj(n.x, 0, n.z) : n.kind === "monitor" ? proj(n.x, 1.05, n.z) : proj(n.x, hOf(n), n.z));
    const av = (n: NodeT, ct: number) => clamp01((ct - n.appearAt) / 450);

    const COMB = (() => {
      const b = NODES[BOUNTY]; const cr = 0.32; const dx = Math.sqrt(3) * cr, dy = 1.5 * cr;
      const offs: [number, number][] = [[0, 0], [dx, 0], [-dx, 0], [dx / 2, -dy], [-dx / 2, -dy], [dx / 2, dy], [-dx / 2, dy]];
      return offs.map(([qx, qz]) => ({ x: b.x + qx, z: b.z + qz, r: cr }));
    })();

    function layout() {
      scale = Math.max(18, Math.min(36, Math.min(width / 26, height / 15)));
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      ox = 0; oy = 0;
      for (const n of NODES) {
        const p = projRaw(n.x, 0, n.z);
        minX = Math.min(minX, p.x - R * scale); maxX = Math.max(maxX, p.x + R * scale);
        minY = Math.min(minY, p.y - R * scale * 1.3); maxY = Math.max(maxY, p.y + R * scale);
      }
      ox = width / 2 - (minX + maxX) / 2 - width * 0.06;
      oy = height / 2 - (minY + maxY) / 2;
    }

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = canvas!.clientWidth; height = canvas!.clientHeight;
      canvas!.width = Math.round(width * dpr); canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0); layout();
    }

    // ---- primitives ----------------------------------------------------------
    function drawShadow(n: NodeT) {
      const c = ground(n); ctx!.save(); ctx!.translate(c.x, c.y); ctx!.scale(1, ISO_SIN);
      ctx!.beginPath(); ctx!.arc(0, 0, R * scale * 1.0, 0, Math.PI * 2); ctx!.fillStyle = "rgba(60,44,12,0.1)"; ctx!.fill(); ctx!.restore();
    }
    function drawRail(a: { x: number; y: number }, b: { x: number; y: number }, alpha: number, dashed = false, blue = false) {
      if (alpha <= 0.02) return;
      ctx!.save(); ctx!.globalAlpha = alpha; ctx!.lineCap = "round";
      ctx!.beginPath(); ctx!.moveTo(a.x, a.y); ctx!.lineTo(b.x, b.y); ctx!.strokeStyle = "rgba(120,90,30,0.13)"; ctx!.lineWidth = 6; ctx!.stroke();
      ctx!.beginPath(); ctx!.moveTo(a.x, a.y); ctx!.lineTo(b.x, b.y); ctx!.strokeStyle = blue ? "rgba(120,140,200,0.5)" : "rgba(217,138,8,0.5)"; ctx!.lineWidth = 2;
      if (dashed) ctx!.setLineDash([4, 6]); ctx!.stroke(); ctx!.setLineDash([]); ctx!.restore();
    }
    function prismTops(n: NodeT, top: number[][], bot: number[][], topColor: string) {
      const faces = Array.from({ length: 6 }, (_, i) => { const na = (Math.PI / 3) * i + Math.PI / 3; return { i, na, depth: n.x + n.z + Math.cos(na) + Math.sin(na) }; }).sort((a, b) => a.depth - b.depth);
      for (const f of faces) {
        const j = (f.i + 1) % 6; const shade = 0.4 + 0.6 * Math.max(0, Math.cos(f.na - 2.4));
        ctx!.beginPath(); ctx!.moveTo(top[f.i][0], top[f.i][1]); ctx!.lineTo(top[j][0], top[j][1]); ctx!.lineTo(bot[j][0], bot[j][1]); ctx!.lineTo(bot[f.i][0], bot[f.i][1]); ctx!.closePath();
        ctx!.fillStyle = mix(SIDE_DARK, SIDE_LIGHT, shade); ctx!.fill(); ctx!.strokeStyle = "rgba(40,26,4,0.35)"; ctx!.lineWidth = 1; ctx!.stroke();
      }
      ctx!.beginPath(); top.forEach((p, i) => (i === 0 ? ctx!.moveTo(p[0], p[1]) : ctx!.lineTo(p[0], p[1]))); ctx!.closePath();
      ctx!.fillStyle = topColor;
      if (n.pulse > 0.05) { ctx!.shadowColor = `rgba(255,200,90,${0.7 * n.pulse})`; ctx!.shadowBlur = 22 * n.pulse; }
      ctx!.fill(); ctx!.shadowBlur = 0; ctx!.strokeStyle = "rgba(60,40,8,0.55)"; ctx!.lineWidth = 1.4; ctx!.stroke();
    }
    function drawPrismH(n: NodeT, hMul: number, topColor: string) {
      const hh = H * hMul + n.pulse * 0.16;
      const top = Array.from({ length: 6 }, (_, i) => { const c = hexCorner(n.x, n.z, hh, i); return [c.x, c.y]; });
      const bot = Array.from({ length: 6 }, (_, i) => { const c = hexCorner(n.x, n.z, 0, i); return [c.x, c.y]; });
      prismTops(n, top, bot, topColor);
    }
    function drawDatabase(n: NodeT) {
      const top = proj(n.x, hOf(n) + n.pulse * 0.2, n.z); const bot = proj(n.x, 0, n.z);
      const rx = R * 0.7 * scale, ry = rx * ISO_SIN, cx = top.x;
      ctx!.fillStyle = "#2f6bdb"; ctx!.fillRect(cx - rx, top.y, rx * 2, bot.y - top.y);
      ctx!.beginPath(); ctx!.ellipse(bot.x, bot.y, rx, ry, 0, 0, Math.PI); ctx!.fill();
      ctx!.strokeStyle = "rgba(20,38,90,0.5)"; ctx!.lineWidth = 1.2;
      ctx!.beginPath(); ctx!.moveTo(cx - rx, top.y); ctx!.lineTo(bot.x - rx, bot.y); ctx!.moveTo(cx + rx, top.y); ctx!.lineTo(bot.x + rx, bot.y); ctx!.stroke();
      ctx!.beginPath(); ctx!.ellipse(top.x, top.y, rx, ry, 0, 0, Math.PI * 2); ctx!.fillStyle = mix([66, 133, 244], [150, 190, 255], n.pulse); ctx!.fill(); ctx!.strokeStyle = "rgba(20,38,90,0.5)"; ctx!.stroke();
    }
    function drawUser(n: NodeT) {
      const c = proj(n.x, 0.42, n.z); const r = R * scale * 0.5;
      ctx!.beginPath(); ctx!.arc(c.x, c.y, r, 0, Math.PI * 2); ctx!.fillStyle = mix([90, 100, 120], [140, 160, 190], n.pulse); ctx!.fill();
      ctx!.lineWidth = 2; ctx!.strokeStyle = "rgba(30,36,48,0.7)"; ctx!.stroke();
      ctx!.fillStyle = "rgba(255,255,255,0.92)";
      ctx!.beginPath(); ctx!.arc(c.x, c.y - r * 0.28, r * 0.26, 0, Math.PI * 2); ctx!.fill();
      ctx!.beginPath(); ctx!.arc(c.x, c.y + r * 0.55, r * 0.5, Math.PI, 0); ctx!.fill();
    }
    function drawEscrow(n: NodeT, funded: number) {
      const w = R * 0.7, d = R * 0.5, h = H * 0.8;
      const p = (dx: number, dz: number, y: number) => proj(n.x + dx, y, n.z + dz);
      const tA = p(-w, -d, h), tB = p(w, -d, h), tC = p(w, d, h), tD = p(-w, d, h);
      const bB = p(w, -d, 0), bC = p(w, d, 0), bD = p(-w, d, 0);
      ctx!.beginPath(); ctx!.moveTo(tB.x, tB.y); ctx!.lineTo(tC.x, tC.y); ctx!.lineTo(bC.x, bC.y); ctx!.lineTo(bB.x, bB.y); ctx!.closePath(); ctx!.fillStyle = "#b5891f"; ctx!.fill(); ctx!.strokeStyle = "rgba(40,26,4,0.4)"; ctx!.stroke();
      ctx!.beginPath(); ctx!.moveTo(tD.x, tD.y); ctx!.lineTo(tC.x, tC.y); ctx!.lineTo(bC.x, bC.y); ctx!.lineTo(bD.x, bD.y); ctx!.closePath(); ctx!.fillStyle = "#caa033"; ctx!.fill(); ctx!.stroke();
      ctx!.beginPath(); ctx!.moveTo(tA.x, tA.y); ctx!.lineTo(tB.x, tB.y); ctx!.lineTo(tC.x, tC.y); ctx!.lineTo(tD.x, tD.y); ctx!.closePath(); ctx!.fillStyle = mix([233, 169, 46], [255, 224, 130], n.pulse); ctx!.fill(); ctx!.stroke();
      const fc = p(0, d, h * 0.5);
      ctx!.fillStyle = funded > 0.4 ? "#2faa55" : "rgba(40,26,4,0.45)";
      ctx!.font = `700 ${Math.round(scale * 0.5)}px var(--font-geist-mono), monospace`; ctx!.textAlign = "center"; ctx!.textBaseline = "middle"; ctx!.fillText("$", fc.x, fc.y);
    }
    function drawMonitor(n: NodeT, content: (x: number, y: number, w: number, h: number) => void) {
      const c = proj(n.x, 1.05, n.z); const g = ground(n);
      const sw = Math.max(70, scale * 2.05), sh = sw * 0.62;
      ctx!.strokeStyle = "rgba(40,40,48,0.5)"; ctx!.lineWidth = 4; ctx!.beginPath(); ctx!.moveTo(c.x, c.y + sh / 2); ctx!.lineTo(g.x, g.y - 4); ctx!.stroke();
      ctx!.beginPath(); ctx!.ellipse(g.x, g.y, sw * 0.22, sw * 0.22 * ISO_SIN, 0, 0, Math.PI * 2); ctx!.fillStyle = "rgba(40,40,48,0.7)"; ctx!.fill();
      ctx!.beginPath(); ctx!.roundRect(c.x - sw / 2, c.y - sh / 2, sw, sh, 7);
      ctx!.fillStyle = "#23262d"; if (n.pulse > 0.05) { ctx!.shadowColor = `rgba(255,200,90,${0.6 * n.pulse})`; ctx!.shadowBlur = 20 * n.pulse; } ctx!.fill(); ctx!.shadowBlur = 0;
      const m = 5; const x = c.x - sw / 2 + m, y = c.y - sh / 2 + m, w = sw - m * 2, h = sh - m * 2;
      ctx!.beginPath(); ctx!.roundRect(x, y, w, h, 4); ctx!.fillStyle = "#0e1116"; ctx!.fill();
      ctx!.save(); ctx!.beginPath(); ctx!.roundRect(x, y, w, h, 4); ctx!.clip(); content(x, y, w, h); ctx!.restore();
    }
    function drawChartInBox(x: number, y: number, w: number, h: number, pts: number[], color: string, prog = 1) {
      ctx!.save(); ctx!.beginPath(); ctx!.rect(x, y, w, h); ctx!.clip();
      const last = Math.max(1, Math.floor(pts.length * prog));
      ctx!.beginPath();
      for (let k = 0; k < last; k++) { const px = x + (k / (pts.length - 1)) * w; const py = y + h - pts[k] * h; k === 0 ? ctx!.moveTo(px, py) : ctx!.lineTo(px, py); }
      ctx!.strokeStyle = color; ctx!.lineWidth = 2; ctx!.lineJoin = "round"; ctx!.stroke(); ctx!.restore();
    }
    function drawLogo(cx: number, cy: number, size: number, name: string) {
      const rec = logos[name]; if (!rec?.ok) return;
      const aspect = (rec.img.naturalWidth || 1) / (rec.img.naturalHeight || 1); let dw = size, dh = size; if (aspect > 1) dh = size / aspect; else dw = size * aspect;
      ctx!.drawImage(rec.img, cx - dw / 2, cy - dh / 2, dw, dh);
    }
    function drawComb(fill: number, glow: number) {
      COMB.forEach((c, i) => 
        const built = i < Math.round(fill * COMB.length);
        const corners = Array.from({ length: 6 }, (_, k) => { const a = (Math.PI / 3) * k + Math.PI / 6; return proj(c.x + c.r * Math.cos(a), 0, c.z + c.r * Math.sin(a)); });
        ctx!.beginPath(); corners.forEach((p, k) => (k === 0 ? ctx!.moveTo(p.x, p.y) : ctx!.lineTo(p.x, p.y))); ctx!.closePath();
        if (built) { ctx!.fillStyle = mix([242, 179, 58], [255, 226, 150], glow); if (glow > 0.05) { ctx!.shadowColor = `rgba(255,200,90,${glow})`; ctx!.shadowBlur = 14 * glow; } ctx!.fill(); ctx!.shadowBlur = 0; ctx!.strokeStyle = "rgba(120,80,10,0.7)"; }
        else { ctx!.fillStyle = "rgba(180,150,90,0.12)"; ctx!.fill(); ctx!.strokeStyle = "rgba(120,90,30,0.35)"; ctx!.setLineDash([3, 4]); }
        ctx!.lineWidth = 1.4; ctx!.stroke(); ctx!.setLineDash([]);
      });
    }
    function drawBee(x: number, y: number, r: number, beat: number, alpha: number) {
      ctx!.save(); ctx!.globalAlpha = alpha; ctx!.translate(x, y); const wing = 0.55 + beat * 0.5;
      for (const side of [-1, 1] as const) { ctx!.save(); ctx!.translate(side * r * 0.42, -r * 0.04); ctx!.rotate(side * wing); ctx!.beginPath(); ctx!.ellipse(side * r * 0.7, -r * 0.2, r * 0.6, r * 0.26, 0, 0, Math.PI * 2); ctx!.fillStyle = "rgba(35,38,45,0.06)"; ctx!.fill(); ctx!.lineWidth = Math.max(1, r * 0.08); ctx!.strokeStyle = "rgba(35,38,45,0.6)"; ctx!.stroke(); ctx!.restore(); }
      ctx!.beginPath(); for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i; i === 0 ? ctx!.moveTo(r * Math.cos(a), r * Math.sin(a)) : ctx!.lineTo(r * Math.cos(a), r * Math.sin(a)); } ctx!.closePath();
      ctx!.fillStyle = BODY; ctx!.fill(); ctx!.lineWidth = r * 0.16; ctx!.strokeStyle = DARK; ctx!.stroke(); ctx!.restore();
    }
    function drawSolutionToken(x: number, y: number, o: typeof OPTIONS[number], alpha = 1) {
      ctx!.save(); ctx!.globalAlpha = alpha; ctx!.translate(x, y); const r = 9;
      ctx!.shadowColor = o.color; ctx!.shadowBlur = 8; ctx!.beginPath(); ctx!.arc(0, 0, r, 0, Math.PI * 2); ctx!.fillStyle = o.color; ctx!.fill(); ctx!.shadowBlur = 0;
      ctx!.lineWidth = 1.6; ctx!.strokeStyle = "rgba(255,255,255,0.9)"; ctx!.stroke();
      ctx!.fillStyle = "#fff"; ctx!.font = "700 10px var(--font-geist-mono), monospace"; ctx!.textAlign = "center"; ctx!.textBaseline = "middle"; ctx!.fillText(o.id, 0, 0.5); ctx!.restore();
    }
    // name on top, icons BELOW the name, tag under the icons
    function drawLabel(n: NodeT) {
      const base = ground(n);
      let y = base.y + (n.kind === "comb" ? R * scale * ISO_SIN * 1.5 : R * scale * ISO_SIN) + 9;
      ctx!.textAlign = "center"; ctx!.textBaseline = "top";
      ctx!.fillStyle = "rgba(26,29,35,0.95)"; ctx!.font = "700 12px var(--font-geist-sans), system-ui, sans-serif"; ctx!.fillText(n.label, base.x, y);
      y += 16;
      if (n.logos.length) {
        const s = 18, gap = 5; const total = n.logos.length * s + (n.logos.length - 1) * gap;
        let lx = base.x - total / 2 + s / 2;
        for (const name of n.logos) { drawLogo(lx, y + s / 2, s, name); lx += s + gap; }
        y += s + 4;
      }
      ctx!.fillStyle = "rgba(120,90,20,0.8)"; ctx!.font = "600 9px var(--font-geist-mono), monospace"; ctx!.fillText(n.tag.toUpperCase(), base.x, y);
    }

    function drawLeaderboard(ct: number, rankT: number) {
      const anyScored = OPTIONS.some((o, i) => o.valid && ct >= solSpawn(i) + SCORED);
      if (!anyScored) return;
      const valid = OPTIONS.map((o, i) => ({ o, i })).filter((e) => e.o.valid);
      const pw = Math.min(232, width * 0.3), pad = 12, rowH = 28, header = 24, px = width - pw - 12, py = 12, ph = header + valid.length * rowH + pad;
      ctx!.save();
      ctx!.beginPath(); ctx!.roundRect(px, py, pw, ph, 12); ctx!.fillStyle = "rgba(255,253,248,0.94)"; ctx!.fill(); ctx!.strokeStyle = "rgba(40,26,4,0.14)"; ctx!.lineWidth = 1; ctx!.stroke();
      ctx!.fillStyle = "rgba(26,29,35,0.9)"; ctx!.font = "700 12px var(--font-geist-sans), system-ui, sans-serif"; ctx!.textAlign = "left"; ctx!.textBaseline = "middle"; ctx!.fillText("Leaderboard", px + pad, py + header / 2 + 2);
      const ranked = [...valid].sort((a, b) => b.o.score - a.o.score);
      const order = rankT > 0 ? ranked.map((e) => e.i) : valid.map((e) => e.i);
      const barMax = pw - pad * 2 - 68;
      valid.forEach(({ o, i }) => {
        const sT = solSpawn(i) + SCORED; if (ct < sT) return;
        const ti = order.indexOf(i); const ty = py + header + ti * rowH + rowH / 2;
        rows[i].y = rows[i].y == null ? ty : lerp(rows[i].y!, ty, 0.16); const y = rows[i].y!;
        if (rankT > 0.6 && i === ranked[0].i) { ctx!.beginPath(); ctx!.roundRect(px + 6, y - rowH / 2 + 2, pw - 12, rowH - 4, 7); ctx!.fillStyle = "rgba(47,170,85,0.12)"; ctx!.fill(); }
        ctx!.fillStyle = o.color; ctx!.beginPath(); ctx!.arc(px + pad + 6, y, 5.5, 0, Math.PI * 2); ctx!.fill();
        ctx!.fillStyle = "rgba(26,29,35,0.9)"; ctx!.font = "700 11px var(--font-geist-mono), monospace"; ctx!.textAlign = "left"; ctx!.fillText(o.id, px + pad + 16, y + 0.5);
        const barT = clamp01((ct - sT) / 700); const bx = px + pad + 30; const bw = barMax * (o.score / 100) * barT;
        ctx!.fillStyle = "rgba(120,90,30,0.14)"; ctx!.beginPath(); ctx!.roundRect(bx, y - 4, barMax, 8, 4); ctx!.fill();
        ctx!.fillStyle = o.color; ctx!.beginPath(); ctx!.roundRect(bx, y - 4, Math.max(2, bw), 8, 4); ctx!.fill();
        ctx!.fillStyle = "rgba(26,29,35,0.85)"; ctx!.font = "600 11px var(--font-geist-mono), monospace"; ctx!.textAlign = "right"; ctx!.fillText(String(Math.round(o.score * barT)), px + pw - pad, y + 0.5);
      });
      ctx!.restore();
    }

    // ---- loop ----------------------------------------------------------------
    let raf = 0;
    function frame(now: number) {
      const ct = reduce ? 18500 : now % CYCLE;
      if (ct < lastCt) for (const r of rows) r.y = null;
      lastCt = ct;
      const botOn = ct >= DEPLOY_START + 1500; // bot only runs once the strategy has arrived
      const st = ct < FUND_END ? 0 : ct < DISCOVER_END ? 1 : ct < SWARM_END ? 2 : ct < SOL_START + SEG1 ? 3 : ct < solSpawn(3) + SEG1 + GRADE ? 4 : ct < SETTLE_START ? 5 : ct < RETURN_START ? 6 : 7;
      if (st !== lastStep) { lastStep = st; setStep(st); }

      for (const n of NODES) n.pulse *= 0.93;
      NODES[HIVE].pulse = Math.max(NODES[HIVE].pulse, av(NODES[HIVE], ct) * (0.22 + 0.12 * Math.sin(now * 0.004)));
      if (botOn) NODES[BOT].pulse = Math.max(NODES[BOT].pulse, 0.45);

      ctx!.clearRect(0, 0, width, height);

      const combFill = ct < FUND_END ? lerp(0, 0.5, easeInOut(ct / FUND_END)) : ct > SETTLE_START ? lerp(0.5, 1, easeInOut(clamp01((ct - SETTLE_START) / 1600))) : 0.5;
      const combGlow = clamp01((ct - SETTLE_START) / 1600);
      const funded = clamp01((ct - 600) / 1200);

      for (const n of NODES) if (av(n, ct) > 0.02) drawShadow(n);
      // rails (each gated by its endpoints appearing)
      const ra = (a: number, b: number) => Math.min(av(NODES[a], ct), av(NODES[b], ct));
      drawRail(proj(NODES[USER].x, 0.5, NODES[USER].z), anchor(NODES[ESCROW]), ra(USER, ESCROW), true);
      drawRail(anchor(NODES[ESCROW]), ground(NODES[BOUNTY]), ra(ESCROW, BOUNTY));
      drawRail(ground(NODES[BOUNTY]), anchor(NODES[BIGQUERY]), ra(BOUNTY, BIGQUERY), true, true);
      drawRail(anchor(NODES[BIGQUERY]), anchor(NODES[HIVE]), ra(BIGQUERY, HIVE), true, true);
      drawRail(anchor(NODES[HIVE]), ground(NODES[BOUNTY]), ra(HIVE, BOUNTY), true);
      drawRail(ground(NODES[BOUNTY]), anchor(NODES[AITESTER]), ra(BOUNTY, AITESTER));
      drawRail(ground(NODES[BOUNTY]), anchor(NODES[SCORER]), ra(BOUNTY, SCORER));
      drawRail(anchor(NODES[AITESTER]), anchor(NODES[CRE]), ra(AITESTER, CRE));
      drawRail(anchor(NODES[SCORER]), anchor(NODES[CRE]), ra(SCORER, CRE));
      drawRail(anchor(NODES[CRE]), anchor(NODES[PAYOUT]), ra(CRE, PAYOUT));
      drawRail(proj(NODES[USER].x, 0.42, NODES[USER].z), anchor(NODES[BOT]), ra(USER, BOT), true);

      // fund coin
      if (ct < FUND_END && ct > 400) {
        const t = easeInOut(clamp01((ct - 400) / (FUND_END - 800)));
        const a = proj(NODES[USER].x, 0.5, NODES[USER].z), b = anchor(NODES[ESCROW]);
        ctx!.save(); ctx!.translate(lerp(a.x, b.x, t), lerp(a.y, b.y, t) - Math.sin(t * Math.PI) * 12); ctx!.shadowColor = "rgba(47,170,85,0.7)"; ctx!.shadowBlur = 10; ctx!.fillStyle = "#2faa55"; ctx!.beginPath(); ctx!.arc(0, 0, 6, 0, Math.PI * 2); ctx!.fill(); ctx!.fillStyle = "#fff"; ctx!.font = "700 8px monospace"; ctx!.textAlign = "center"; ctx!.textBaseline = "middle"; ctx!.fillText("$", 0, 0.5); ctx!.restore();
        NODES[USER].pulse = 1; if (t > 0.8) NODES[ESCROW].pulse = 1;
      }

      // discovery scan + query
      let query: { x: number; y: number } | null = null;
      if (ct >= FUND_END && ct < DISCOVER_END) {
        const d = ct - FUND_END;
        if (d < 700) { const rr = d / 700; const c = anchor(NODES[BIGQUERY]); ctx!.beginPath(); ctx!.ellipse(c.x, c.y, R * scale * (0.5 + rr * 1.3), R * scale * (0.5 + rr * 1.3) * ISO_SIN, 0, 0, Math.PI * 2); ctx!.strokeStyle = `rgba(66,133,244,${0.6 * (1 - rr)})`; ctx!.lineWidth = 2; ctx!.stroke(); NODES[BIGQUERY].pulse = 1; }
        const t = easeInOut(clamp01((d - 600) / (DISCOVER_END - FUND_END - 800)));
        const a = anchor(NODES[BIGQUERY]), b = anchor(NODES[HIVE]); query = { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) - Math.sin(t * Math.PI) * 8 }; if (t > 0.9) NODES[HIVE].pulse = 1;
      }

      // solutions: rise to BOTH graders in parallel, then converge to the contract
      type Tok = { x: number; y: number; o: typeof OPTIONS[number]; alpha: number };
      const toks: Tok[] = [];
      const repHits: { x: number; y: number; alpha: number }[] = [];
      let aiVerdict: { valid: boolean; oi: number } | null = null;
      let scoreRun: { o: typeof OPTIONS[number]; oi: number; prog: number } | null = null;
      OPTIONS.forEach((o, i) => {
        const sp = solSpawn(i); const el = ct - sp; if (el < 0) return;
        const bP = ground(NODES[BOUNTY]); const aiP = anchor(NODES[AITESTER]); const scP = anchor(NODES[SCORER]); const crP = anchor(NODES[CRE]);
        // one token rises up the middle between the two graders, which flank it
        const M = { x: (aiP.x + scP.x) / 2, y: (aiP.y + scP.y) / 2 };
        if (el < SEG1) {
          const lt = easeInOut(el / SEG1);
          toks.push({ x: lerp(bP.x, M.x, lt), y: lerp(bP.y, M.y, lt) - Math.sin(lt * Math.PI) * 8, o, alpha: 1 });
        } else if (el < SEG1 + GRADE) {
          aiVerdict = { valid: o.valid, oi: i }; NODES[AITESTER].pulse = 1;
          if (o.valid) { scoreRun = { o, oi: i, prog: clamp01((el - SEG1) / GRADE) }; NODES[SCORER].pulse = 1; }
          toks.push({ x: M.x, y: M.y, o, alpha: 1 });
        } else if (o.valid) {
          if (el < SEG1 + GRADE + SEG2) {
            const lt = easeInOut((el - SEG1 - GRADE) / SEG2);
            toks.push({ x: lerp(M.x, crP.x, lt), y: lerp(M.y, crP.y, lt) - Math.sin(lt * Math.PI) * 8, o, alpha: 1 });
            if (lt > 0.8) NODES[CRE].pulse = 1;
          }
        } else {
          const rel = el - SEG1 - GRADE;
          if (rel < REJECT) {
            const lt = easeInOut(clamp01(rel / REJECT)); const a = 1 - clamp01((rel - REJECT * 0.45) / (REJECT * 0.55));
            const rx = lerp(M.x, M.x - scale * 2.0, lt), ry = lerp(M.y, M.y + scale * 1.3, lt);
            toks.push({ x: rx, y: ry, o, alpha: a });
            repHits.push({ x: rx, y: ry - 18, alpha: a }); // the cheating agent loses reputation
          }
        }
      });

      // nodes far → near (smaller x+z is further back / higher → drawn first)
      const order = NODES.map((_, i) => i).sort((a, b) => NODES[a].x + NODES[a].z - (NODES[b].x + NODES[b].z));
      for (const i of order) {
        const n = NODES[i]; const a = av(n, ct); if (a <= 0.02) continue;
        ctx!.save(); ctx!.globalAlpha = a;
        if (n.kind === "comb") drawComb(combFill, combGlow);
        else if (n.kind === "db") drawDatabase(n);
        else if (n.kind === "hive") drawPrismH(n, 1.7, mix(TOP_BASE, TOP_HOT, n.pulse));
        else if (n.kind === "cre") drawPrismH(n, 1, mix([59, 91, 210], [150, 175, 255], n.pulse));
        else if (n.kind === "user") drawUser(n);
        else if (n.kind === "escrow") drawEscrow(n, funded);
        else if (n.kind === "monitor") {
          if (n.mon === "ai") drawMonitor(n, (x, y, w, h) => {
            const v = aiVerdict as { valid: boolean; oi: number } | null;
            ctx!.textAlign = "center"; ctx!.textBaseline = "middle";
            if (v) {
              const inv = !v.valid;
              drawChartInBox(x + 4, y + 3, w - 8, h * 0.52, chartPts(v.oi, inv), inv ? "#ff7a7a" : "#7fe0a0", 1);
              ctx!.fillStyle = inv ? "#ff5a5a" : "#2faa55"; ctx!.font = `800 ${Math.round(h * 0.26)}px var(--font-geist-mono), monospace`;
              ctx!.fillText(v.valid ? "VALID ✓" : "INVALID ✗", x + w / 2, y + h * 0.8);
            }
          });
          else if (n.mon === "score") drawMonitor(n, (x, y, w, h) => {
            const s = scoreRun as { o: typeof OPTIONS[number]; oi: number; prog: number } | null;
            if (s) {
              drawChartInBox(x + 4, y + 4, w - 8, h - 16, chartPts(s.oi, false), s.o.color, s.prog);
              ctx!.fillStyle = "#cfe8d6"; ctx!.font = `700 ${Math.round(h * 0.22)}px var(--font-geist-mono), monospace`; ctx!.textAlign = "left"; ctx!.textBaseline = "bottom"; ctx!.fillText(`score ${Math.round(s.o.score * s.prog)}`, x + 5, y + h - 3);
            }
          });
          else drawMonitor(n, (x, y, w, h) => {
            if (!botOn) return; // screen stays off until the strategy has arrived
            // independent Uniswap bot running the winning strategy live
            drawChartInBox(x + 4, y + 4, w - 8, h - 16, chartPts((Math.floor(now / 480) % 6) + 30, false), "#ff4da6", 1);
            ctx!.fillStyle = "#ffd0e8"; ctx!.font = `700 ${Math.round(h * 0.22)}px var(--font-geist-mono), monospace`; ctx!.textAlign = "left"; ctx!.textBaseline = "bottom"; ctx!.fillText("● LIVE", x + 5, y + h - 3);
          });
        }
        else drawPrismH(n, 1, mix(TOP_BASE, TOP_HOT, n.pulse));
        drawLabel(n);
        ctx!.restore();
      }

      if (query) { ctx!.save(); ctx!.translate(query.x, query.y); ctx!.shadowColor = "rgba(66,133,244,0.7)"; ctx!.shadowBlur = 12; ctx!.fillStyle = "#4285F4"; ctx!.beginPath(); ctx!.arc(0, 0, 5, 0, Math.PI * 2); ctx!.fill(); ctx!.restore(); }

      // bees
      if (!reduce && ct > DISCOVER_END - 200) {
        const beeAlpha = clamp01((ct - (DISCOVER_END - 200)) / 300) * (1 - clamp01((ct - (solSpawn(3) + 500)) / 1000));
        if (beeAlpha > 0.01) {
          const hiveP = anchor(NODES[HIVE]); const workP = ground(NODES[BOUNTY]);
          for (const bee of bees) {
            const bl = ct - (DISCOVER_END - 200); const go = easeInOut(clamp01(bl / (SWARM_END - DISCOVER_END))); let x: number, y: number;
            if (bl < SWARM_END - DISCOVER_END) { x = lerp(hiveP.x, workP.x, go) + bee.lane * 24 * Math.sin(go * Math.PI); y = lerp(hiveP.y, workP.y, go) - Math.sin(go * Math.PI) * 30; }
            else { const ang = now * 0.0016 + bee.off; x = workP.x + Math.cos(ang) * bee.rad * scale * 1.2; y = workP.y + Math.sin(ang) * bee.rad * scale * 0.6 - R * scale * 0.5; }
            drawBee(x, y, bee.r, Math.sin(now * 0.02 + bee.phase), beeAlpha);
          }
        }
      }

      for (const t of toks) drawSolutionToken(t.x, t.y, t.o, t.alpha);
      // the cheating agent takes a reputation hit
      for (const h of repHits) {
        ctx!.save(); ctx!.globalAlpha = h.alpha; ctx!.translate(h.x, h.y);
        ctx!.fillStyle = "#d23f3f"; ctx!.beginPath(); ctx!.roundRect(-30, -10, 60, 20, 10); ctx!.fill();
        ctx!.fillStyle = "#fff"; ctx!.font = "700 10px var(--font-geist-mono), monospace"; ctx!.textAlign = "center"; ctx!.textBaseline = "middle"; ctx!.fillText("rep −1 ↓", 0, 0.5);
        ctx!.restore();
      }

      const rankT = clamp01((ct - (solSpawn(3) + SCORED)) / 1400);
      drawLeaderboard(ct, rankT);

      const winner = [...OPTIONS].filter((o) => o.valid).sort((a, b) => b.score - a.score)[0];

      // settle: winner paid via the contract
      if (ct > SETTLE_START && ct < RETURN_START + 200) {
        NODES[CRE].pulse = Math.max(NODES[CRE].pulse, 0.6);
        const t = easeInOut(clamp01((ct - SETTLE_START - 400) / 1400));
        if (t > 0) { const a = anchor(NODES[CRE]); const b = anchor(NODES[PAYOUT]); ctx!.save(); ctx!.translate(lerp(a.x, b.x, t), lerp(a.y, b.y, t) - Math.sin(t * Math.PI) * 14); ctx!.shadowColor = "rgba(47,170,85,0.7)"; ctx!.shadowBlur = 12; ctx!.fillStyle = winner.color; ctx!.beginPath(); ctx!.arc(0, 0, 7, 0, Math.PI * 2); ctx!.fill(); ctx!.fillStyle = "#fff"; ctx!.font = "700 9px monospace"; ctx!.textAlign = "center"; ctx!.textBaseline = "middle"; ctx!.fillText("$", 0, 0.5); ctx!.restore(); if (t > 0.85) NODES[PAYOUT].pulse = 1; }
      }

      // the winning STRATEGY returns to the user, then deploys to the Uniswap bot
      if (ct > RETURN_START) {
        const uC = proj(NODES[USER].x, 0.42, NODES[USER].z);
        if (ct < DEPLOY_START) {
          const t = easeInOut(clamp01((ct - RETURN_START) / (DEPLOY_START - RETURN_START)));
          const a = anchor(NODES[CRE]);
          drawSolutionToken(lerp(a.x, uC.x, t), lerp(a.y, uC.y, t) - Math.sin(t * Math.PI) * 22, winner, 1);
          if (t > 0.85) NODES[USER].pulse = 1;
        } else {
          const t = easeInOut(clamp01((ct - DEPLOY_START) / 1600));
          const b = anchor(NODES[BOT]);
          drawSolutionToken(lerp(uC.x, b.x, t), lerp(uC.y, b.y, t) - Math.sin(t * Math.PI) * 12, winner, 1);
          if (t > 0.8) NODES[BOT].pulse = 1;
        }
      }

      raf = requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener("resize", resize);
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);

  return (
    <section id="how" className="hc-section">
      <div className="mx-auto w-full max-w-5xl px-6 py-24 sm:py-32">
        <p className="hc-eyebrow mb-3 font-mono text-[0.7rem] uppercase tracking-[0.4em]">How it works</p>
        <h2 className="hc-h2 text-3xl font-semibold tracking-tight sm:text-4xl">One bounty, bottom to top</h2>
        <p className="hc-body mt-4 max-w-2xl text-base leading-7 sm:text-lg">
          A user funds the escrow at the bottom; BigQuery finds the job and wakes the hive;
          agents propose competing models that the two enclaves grade in parallel and
          converge to the contract, which ranks them and pays the winner at the top.
        </p>

        <div className="hc-card mt-10 rounded-2xl p-2 sm:p-4">
          <div className="relative h-[560px] w-full sm:h-[700px]">
            <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 pb-2 font-mono text-[0.7rem] text-black/55">
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#2faa55" }} /> valid</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#d23f3f" }} /> invalid (cheat)</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#4285F4" }} /> BigQuery</span>
          </div>
        </div>

        <div className="mt-10">
          <ol className="flex items-start justify-between gap-1">
            {STEPS.map((s, i) => (
              <li key={s.label} className="flex flex-1 flex-col items-center text-center">
                <span className={`hc-dot ${i === step ? "hc-dot-on" : ""} ${i < step ? "hc-dot-done" : ""}`}>{i + 1}</span>
                <span className={`mt-2 text-[0.68rem] font-medium leading-tight ${i === step ? "text-[color:#1a1d23]" : "text-black/45"}`}>{s.label}</span>
              </li>
            ))}
          </ol>
          <div className="hc-card mt-6 rounded-xl p-5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold text-[color:#1a1d23]">{step + 1}. {STEPS[step].label}</span>
              <span className="font-mono text-[0.72rem] text-[color:#b9810f]">{STEPS[step].tech}</span>
            </div>
            <p className="hc-body mt-2 text-sm leading-6">{STEPS[step].desc}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
