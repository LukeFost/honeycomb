"use client";

import { useEffect, useRef, useState } from "react";

// ============================================================================
// HowItWorks — animated story of one bounty, told on an isometric canvas.
//
//   1. Propose  — a bounty is posted; a half-built honeycomb appears.
//   2. Discover — Google BigQuery scans, sees the job, notifies the hive.
//   3. Swarm    — the hive sends Claude + Codex agents to the comb.
//   4. Ideas    — agents each propose a different approach (encrypted).
//   5. Score    — each approach runs the TEE pipeline and gets a blind score.
//   6. Rank&pay — a leaderboard ranks them; the winner is paid, comb completes.
// ============================================================================

type NodeT = { x: number; z: number; pulse: number; label: string; tag: string; logos: string[]; hive?: boolean; db?: boolean; comb?: boolean };

const NODES: NodeT[] = [
  { x: -2.96, z: 3.96, pulse: 0, label: "BigQuery", tag: "discovery", logos: ["google"], db: true },
  { x: -5.38, z: 0.98, pulse: 0, label: "Hive", tag: "agents", logos: ["claudecode", "openai"], hive: true },
  { x: 1.16, z: 4.05, pulse: 0, label: "Bounty", tag: "escrow", logos: ["uniswap"], comb: true },
  { x: -2.08, z: -0.92, pulse: 0, label: "AI Tester", tag: "TEE", logos: ["chainlink"] },
  { x: 1.07, z: -0.67, pulse: 0, label: "Scorer", tag: "TEE", logos: ["google"] },
  { x: 4.4, z: -0.8, pulse: 0, label: "Payout", tag: "USDC", logos: ["chainlink"] },
];
const BIGQUERY = 0, HIVE = 1, BOUNTY = 2, AITESTER = 3, SCORER = 4, PAYOUT = 5;

const STEPS = [
  { label: "Propose", tech: "BountyEscrow.sol · ERC-8183", desc: "A bounty is posted and funded — a half-built honeycomb waiting to be completed." },
  { label: "Discover", tech: "Google BigQuery", desc: "BigQuery indexes the on-chain job and notifies the hive that work is available." },
  { label: "Swarm", tech: "Claude + Codex agents", desc: "The hive dispatches a swarm of agents to work on the bounty." },
  { label: "Propose ideas", tech: "ciphertext → CID", desc: "Each agent submits a different approach, encrypted — only the hash is public." },
  { label: "Score", tech: "Chainlink AI · Google TEE", desc: "Every approach is validated and scored blind inside the enclaves." },
  { label: "Rank & pay", tech: "CRE → BountyEscrow", desc: "A leaderboard ranks the results; the best one wins and is paid on-chain." },
];

// the four competing approaches (deterministic scores; B wins)
const OPTIONS = [
  { id: "A", color: "#e0930a", score: 78 },
  { id: "B", color: "#2faa55", score: 91 },
  { id: "C", color: "#3b7ddb", score: 64 },
  { id: "D", color: "#b65cd1", score: 84 },
];

const ISO_COS = Math.cos(Math.PI / 6);
const ISO_SIN = Math.sin(Math.PI / 6);
const R = 0.82;
const H = 0.85;

// timeline (ms)
const CYCLE = 15500;
const PROPOSE_END = 2400;
const DISCOVER_END = 4800;
const SWARM_END = 7000;
const IDEAS_END = 8400;
const SCORE_END = 11400;
const RANK_END = 13200;
const IDEA_STAGGER = 360;
const OPT_SEG = 1450; // ms per pipeline hop for an option

function stepForTime(ct: number) {
  if (ct < PROPOSE_END) return 0;
  if (ct < DISCOVER_END) return 1;
  if (ct < SWARM_END) return 2;
  if (ct < IDEAS_END) return 3;
  if (ct < SCORE_END) return 4;
  return 5;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const mix = (a: number[], b: number[], t: number) =>
  `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;

const SIDE_DARK = [120, 78, 14];
const SIDE_LIGHT = [216, 138, 8];
const TOP_BASE = [242, 179, 58];
const TOP_HOT = [255, 226, 150];
const BODY = "#EFA92E";
const DARK = "#23262d";

export default function HowItWorks() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0, height = 0, dpr = 1, scale = 40, ox = 0, oy = 0, lastStep = -1, lastCt = 0;

    const logos: Record<string, { img: HTMLImageElement; ok: boolean }> = {};
    for (const name of ["uniswap", "chainlink", "google", "claudecode", "openai"]) {
      const img = new Image();
      const rec = { img, ok: false };
      img.onload = () => (rec.ok = true);
      img.src = `/${name}.svg`;
      logos[name] = rec;
    }

    const bees = Array.from({ length: 9 }, (_, i) => ({ off: i * 0.7, rad: 0.45 + (i % 4) * 0.16, r: 7 + (i % 3) * 2, phase: i * 1.7, lane: (i / 9 - 0.5) * 1.4 }));
    const rows = OPTIONS.map(() => ({ y: null as number | null }));

    const hOf = (n: NodeT) => (n.hive ? H * 1.7 : n.db ? H * 1.25 : H);
    const projRaw = (wx: number, wy: number, wz: number) => ({ x: (wx - wz) * ISO_COS * scale, y: ((wx + wz) * ISO_SIN - wy) * scale });
    const proj = (wx: number, wy: number, wz: number) => { const p = projRaw(wx, wy, wz); return { x: p.x + ox, y: p.y + oy }; };
    const hexCorner = (cx: number, cz: number, y: number, i: number) => { const a = (Math.PI / 3) * i + Math.PI / 6; return proj(cx + R * Math.cos(a), y, cz + R * Math.sin(a)); };
    const topCenter = (n: NodeT) => proj(n.x, n.comb ? 0 : hOf(n), n.z);

    // comb cells (flower) around the bounty
    const COMB = (() => {
      const b = NODES[BOUNTY];
      const cr = 0.42;
      const dx = Math.sqrt(3) * cr, dy = 1.5 * cr;
      const offs: [number, number][] = [[0, 0], [dx, 0], [-dx, 0], [dx / 2, -dy], [-dx / 2, -dy], [dx / 2, dy], [-dx / 2, dy]];
      return offs.map(([qx, qz]) => ({ x: b.x + qx, z: b.z + qz, r: cr }));
    })();

    function layout() {
      scale = Math.max(22, Math.min(40, width / 28));
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      ox = 0; oy = 0;
      for (const n of NODES) {
        const hh = hOf(n);
        for (let i = 0; i < 6; i++) for (const y of [0, hh]) {
          const a = (Math.PI / 3) * i + Math.PI / 6;
          const p = projRaw(n.x + R * Math.cos(a), y, n.z + R * Math.sin(a));
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
      }
      ox = width / 2 - (minX + maxX) / 2;
      oy = height / 2 - (minY + maxY) / 2 - 6;
    }

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = canvas!.clientWidth; height = canvas!.clientHeight;
      canvas!.width = Math.round(width * dpr); canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      layout();
    }

    function hexPathAt(x: number, y: number, r: number, off: number) {
      ctx!.beginPath();
      for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i + off; const px = x + r * Math.cos(a), py = y + r * Math.sin(a); if (i === 0) ctx!.moveTo(px, py); else ctx!.lineTo(px, py); }
      ctx!.closePath();
    }

    function drawShadow(n: NodeT) {
      const c = proj(n.x, 0, n.z);
      ctx!.save(); ctx!.translate(c.x, c.y); ctx!.scale(1, ISO_SIN);
      ctx!.beginPath(); ctx!.arc(0, 0, R * scale * 1.05, 0, Math.PI * 2);
      ctx!.fillStyle = "rgba(60,44,12,0.1)"; ctx!.fill(); ctx!.restore();
    }

    function drawRail(a: { x: number; y: number }, b: { x: number; y: number }, dashed = false, blue = false) {
      ctx!.lineCap = "round";
      ctx!.beginPath(); ctx!.moveTo(a.x, a.y); ctx!.lineTo(b.x, b.y);
      ctx!.strokeStyle = "rgba(120,90,30,0.14)"; ctx!.lineWidth = 7; ctx!.stroke();
      ctx!.beginPath(); ctx!.moveTo(a.x, a.y); ctx!.lineTo(b.x, b.y);
      ctx!.strokeStyle = blue ? "rgba(120,140,200,0.55)" : "rgba(217,138,8,0.5)"; ctx!.lineWidth = 2;
      if (dashed) ctx!.setLineDash([4, 6]); ctx!.stroke(); ctx!.setLineDash([]);
    }

    function drawPrism(n: NodeT) {
      const hh = (n.hive ? H * 1.7 : H) + n.pulse * 0.16;
      const top = Array.from({ length: 6 }, (_, i) => hexCorner(n.x, n.z, hh, i));
      const bot = Array.from({ length: 6 }, (_, i) => hexCorner(n.x, n.z, 0, i));
      const faces = Array.from({ length: 6 }, (_, i) => { const na = (Math.PI / 3) * i + Math.PI / 3; return { i, na, depth: n.x + n.z + Math.cos(na) + Math.sin(na) }; }).sort((a, b) => a.depth - b.depth);
      for (const f of faces) {
        const j = (f.i + 1) % 6;
        const shade = 0.4 + 0.6 * Math.max(0, Math.cos(f.na - 2.4));
        ctx!.beginPath(); ctx!.moveTo(top[f.i].x, top[f.i].y); ctx!.lineTo(top[j].x, top[j].y); ctx!.lineTo(bot[j].x, bot[j].y); ctx!.lineTo(bot[f.i].x, bot[f.i].y); ctx!.closePath();
        ctx!.fillStyle = mix(SIDE_DARK, SIDE_LIGHT, shade); ctx!.fill();
        ctx!.strokeStyle = "rgba(40,26,4,0.35)"; ctx!.lineWidth = 1; ctx!.stroke();
      }
      ctx!.beginPath(); top.forEach((p, i) => (i === 0 ? ctx!.moveTo(p.x, p.y) : ctx!.lineTo(p.x, p.y))); ctx!.closePath();
      ctx!.fillStyle = mix(TOP_BASE, TOP_HOT, n.pulse);
      if (n.pulse > 0.05) { ctx!.shadowColor = `rgba(255,200,90,${0.7 * n.pulse})`; ctx!.shadowBlur = 24 * n.pulse; }
      ctx!.fill(); ctx!.shadowBlur = 0;
      ctx!.strokeStyle = "rgba(60,40,8,0.55)"; ctx!.lineWidth = 1.4; ctx!.stroke();
    }

    function drawDatabase(n: NodeT) {
      const top = proj(n.x, hOf(n) + n.pulse * 0.2, n.z); const bot = proj(n.x, 0, n.z);
      const rx = R * 0.72 * scale, ry = rx * ISO_SIN, cx = top.x;
      ctx!.fillStyle = "#2f6bdb"; ctx!.fillRect(cx - rx, top.y, rx * 2, bot.y - top.y);
      ctx!.beginPath(); ctx!.ellipse(bot.x, bot.y, rx, ry, 0, 0, Math.PI); ctx!.fill();
      ctx!.strokeStyle = "rgba(20,38,90,0.5)"; ctx!.lineWidth = 1.2;
      ctx!.beginPath(); ctx!.moveTo(cx - rx, top.y); ctx!.lineTo(bot.x - rx, bot.y); ctx!.moveTo(cx + rx, top.y); ctx!.lineTo(bot.x + rx, bot.y); ctx!.stroke();
      ctx!.strokeStyle = "rgba(255,255,255,0.22)";
      for (const fy of [0.42, 0.74]) { const y = top.y + (bot.y - top.y) * fy; ctx!.beginPath(); ctx!.ellipse(cx, y, rx, ry, 0, 0, Math.PI); ctx!.stroke(); }
      ctx!.beginPath(); ctx!.ellipse(top.x, top.y, rx, ry, 0, 0, Math.PI * 2);
      ctx!.fillStyle = mix([66, 133, 244], [150, 190, 255], n.pulse); ctx!.fill();
      ctx!.strokeStyle = "rgba(20,38,90,0.5)"; ctx!.stroke();
    }

    // bounty as a half-built honeycomb on the ground (fill = how complete)
    function drawComb(fill: number, glow: number) {
      COMB.forEach((c, i) => {
        const center = proj(c.x, 0, c.z);
        const built = i < Math.round(fill * COMB.length);
        const corners = Array.from({ length: 6 }, (_, k) => { const a = (Math.PI / 3) * k + Math.PI / 6; return proj(c.x + c.r * Math.cos(a), 0, c.z + c.r * Math.sin(a)); });
        ctx!.beginPath(); corners.forEach((p, k) => (k === 0 ? ctx!.moveTo(p.x, p.y) : ctx!.lineTo(p.x, p.y))); ctx!.closePath();
        if (built) {
          ctx!.fillStyle = mix([242, 179, 58], [255, 226, 150], glow);
          if (glow > 0.05) { ctx!.shadowColor = `rgba(255,200,90,${glow})`; ctx!.shadowBlur = 16 * glow; }
          ctx!.fill(); ctx!.shadowBlur = 0;
          ctx!.strokeStyle = "rgba(120,80,10,0.7)";
        } else {
          ctx!.fillStyle = "rgba(180,150,90,0.12)";
          ctx!.fill();
          ctx!.strokeStyle = "rgba(120,90,30,0.35)";
          ctx!.setLineDash([3, 4]);
        }
        ctx!.lineWidth = 1.5; ctx!.stroke(); ctx!.setLineDash([]);
        void center;
      });
    }

    function drawLogo(cx: number, cy: number, size: number, name: string) {
      const rec = logos[name]; if (!rec?.ok) return;
      const g = ctx!.createRadialGradient(cx, cy, 0, cx, cy, size * 0.75);
      g.addColorStop(0, "rgba(255,253,248,0.9)"); g.addColorStop(1, "rgba(255,253,248,0)");
      ctx!.fillStyle = g; ctx!.beginPath(); ctx!.arc(cx, cy, size * 0.75, 0, Math.PI * 2); ctx!.fill();
      const aspect = (rec.img.naturalWidth || 1) / (rec.img.naturalHeight || 1);
      let dw = size, dh = size; if (aspect > 1) dh = size / aspect; else dw = size * aspect;
      ctx!.drawImage(rec.img, cx - dw / 2, cy - dh / 2, dw, dh);
    }

    function drawNodeLogos(n: NodeT) {
      if (!n.logos.length) return;
      const p = n.comb ? proj(n.x, 0, n.z) : topCenter(n);
      const yoff = n.comb ? -R * scale * 0.7 : -4;
      const single = n.logos.length === 1;
      const s = single ? R * scale * (n.db ? 0.6 : 0.7) : R * scale * 0.52;
      const gap = s * 0.62;
      n.logos.forEach((name, k) => drawLogo(single ? p.x : p.x + (k === 0 ? -gap : gap), p.y + yoff, s, name));
    }

    function drawLabel(n: NodeT) {
      const base = proj(n.x, 0, n.z);
      const y0 = base.y + (n.comb ? R * scale * ISO_SIN * 1.4 : R * scale * ISO_SIN) + 9;
      ctx!.save(); ctx!.textAlign = "center"; ctx!.textBaseline = "top";
      ctx!.fillStyle = "rgba(26,29,35,0.95)"; ctx!.font = "700 12px var(--font-geist-sans), system-ui, sans-serif";
      ctx!.fillText(n.label, base.x, y0);
      ctx!.fillStyle = "rgba(120,90,20,0.85)"; ctx!.font = "600 9.5px var(--font-geist-mono), monospace";
      ctx!.fillText(n.tag.toUpperCase(), base.x, y0 + 14);
      ctx!.restore();
    }

    function drawBee(x: number, y: number, r: number, beat: number, alpha: number) {
      ctx!.save(); ctx!.globalAlpha = alpha; ctx!.translate(x, y);
      const wing = 0.55 + beat * 0.5;
      for (const side of [-1, 1] as const) {
        ctx!.save(); ctx!.translate(side * r * 0.42, -r * 0.04); ctx!.rotate(side * wing);
        ctx!.beginPath(); ctx!.ellipse(side * r * 0.7, -r * 0.2, r * 0.6, r * 0.26, 0, 0, Math.PI * 2);
        ctx!.fillStyle = "rgba(35,38,45,0.06)"; ctx!.fill();
        ctx!.lineWidth = Math.max(1, r * 0.08); ctx!.strokeStyle = "rgba(35,38,45,0.6)"; ctx!.stroke(); ctx!.restore();
      }
      ctx!.beginPath(); for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i; if (i === 0) ctx!.moveTo(r * Math.cos(a), r * Math.sin(a)); else ctx!.lineTo(r * Math.cos(a), r * Math.sin(a)); } ctx!.closePath();
      ctx!.fillStyle = BODY; ctx!.fill(); ctx!.lineWidth = r * 0.16; ctx!.strokeStyle = DARK; ctx!.stroke(); ctx!.restore();
    }

    function drawOption(x: number, y: number, color: string, id: string, decrypted: boolean) {
      ctx!.save(); ctx!.translate(x, y);
      ctx!.shadowColor = color; ctx!.shadowBlur = 12;
      hexPathAt(0, 0, 11, Math.PI / 6); ctx!.fillStyle = "#fffdf8"; ctx!.fill();
      ctx!.lineWidth = 2; ctx!.strokeStyle = color; ctx!.stroke(); ctx!.shadowBlur = 0;
      ctx!.fillStyle = color; ctx!.font = "700 10px var(--font-geist-mono), monospace"; ctx!.textAlign = "center"; ctx!.textBaseline = "middle";
      ctx!.fillText(id, 0, 0);
      // lock indicator
      ctx!.strokeStyle = decrypted ? "#2faa55" : "#d98a08"; ctx!.lineWidth = 1.2;
      ctx!.beginPath(); ctx!.arc(0, -12, 2, decrypted ? Math.PI * 0.9 : Math.PI, decrypted ? Math.PI * 2.1 : Math.PI * 2); ctx!.stroke();
      ctx!.fillStyle = decrypted ? "#2faa55" : "#d98a08"; ctx!.fillRect(-2.4, -11.5, 4.8, 3.4);
      ctx!.restore();
    }

    // leaderboard panel (screen space, top-right)
    function drawLeaderboard(ct: number, rankT: number) {
      const scored = OPTIONS.map((o, i) => ({ o, i, t: ideaSpawn(i) + 2 * OPT_SEG }))
        .filter((e) => ct >= e.t);
      if (!scored.length) return;
      const pw = Math.min(250, width * 0.32);
      const pad = 14, rowH = 30, header = 26;
      const px = width - pw - 14, py = 16;
      const ph = header + OPTIONS.length * rowH + pad;
      ctx!.save();
      ctx!.beginPath(); ctx!.roundRect(px, py, pw, ph, 12);
      ctx!.fillStyle = "rgba(255,253,248,0.92)"; ctx!.fill();
      ctx!.strokeStyle = "rgba(40,26,4,0.14)"; ctx!.lineWidth = 1; ctx!.stroke();
      ctx!.fillStyle = "rgba(26,29,35,0.9)"; ctx!.font = "700 12px var(--font-geist-sans), system-ui, sans-serif"; ctx!.textAlign = "left"; ctx!.textBaseline = "middle";
      ctx!.fillText("Leaderboard", px + pad, py + header / 2 + 2);

      // ranking order: by score once we're past scoring, else arrival order
      const ranked = [...OPTIONS].map((o, i) => ({ o, i })).sort((a, b) => b.o.score - a.o.score);
      const order = rankT > 0 ? ranked.map((e) => e.i) : OPTIONS.map((_, i) => i);
      const barMax = pw - pad * 2 - 78;
      OPTIONS.forEach((o, i) => {
        const sT = ideaSpawn(i) + 2 * OPT_SEG;
        if (ct < sT) return;
        const targetIdx = order.indexOf(i);
        const ty = py + header + targetIdx * rowH + rowH / 2;
        rows[i].y = rows[i].y == null ? ty : lerp(rows[i].y!, ty, 0.16);
        const y = rows[i].y!;
        const isWinner = rankT > 0.6 && i === ranked[0].i;
        if (isWinner) { ctx!.beginPath(); ctx!.roundRect(px + 6, y - rowH / 2 + 2, pw - 12, rowH - 4, 7); ctx!.fillStyle = "rgba(47,170,85,0.12)"; ctx!.fill(); }
        // swatch + label
        ctx!.fillStyle = o.color; ctx!.beginPath(); ctx!.arc(px + pad + 6, y, 6, 0, Math.PI * 2); ctx!.fill();
        ctx!.fillStyle = "rgba(26,29,35,0.9)"; ctx!.font = "700 11px var(--font-geist-mono), monospace"; ctx!.textAlign = "left";
        ctx!.fillText(o.id, px + pad + 18, y + 0.5);
        // bar
        const barT = clamp01((ct - sT) / 700);
        const bx = px + pad + 34, bw = barMax * (o.score / 100) * barT;
        ctx!.fillStyle = "rgba(120,90,30,0.14)"; ctx!.beginPath(); ctx!.roundRect(bx, y - 4, barMax, 8, 4); ctx!.fill();
        ctx!.fillStyle = o.color; ctx!.beginPath(); ctx!.roundRect(bx, y - 4, Math.max(2, bw), 8, 4); ctx!.fill();
        ctx!.fillStyle = "rgba(26,29,35,0.85)"; ctx!.font = "600 11px var(--font-geist-mono), monospace"; ctx!.textAlign = "right";
        ctx!.fillText(String(Math.round(o.score * barT)), px + pw - pad, y + 0.5);
      });
      ctx!.restore();
    }

    const ideaSpawn = (i: number) => IDEAS_END - 1200 + i * IDEA_STAGGER;

    // --- loop -----------------------------------------------------------------
    let raf = 0;

    function frame(now: number) {
      const ct = reduce ? 12000 : now % CYCLE;
      if (ct < lastCt) for (const r of rows) r.y = null; // cycle wrapped → reset rows
      lastCt = ct;

      const st = stepForTime(ct);
      if (st !== lastStep) { lastStep = st; setStep(st); }

      for (const n of NODES) n.pulse *= 0.93;
      NODES[HIVE].pulse = Math.max(NODES[HIVE].pulse, 0.22 + 0.12 * Math.sin(now * 0.004));

      ctx!.clearRect(0, 0, width, height);

      // comb fill: 0 → 0.5 during propose, → 1 during payout
      const combFill = ct < PROPOSE_END ? lerp(0, 0.5, easeInOut(ct / PROPOSE_END)) : ct > RANK_END ? lerp(0.5, 1, easeInOut(clamp01((ct - RANK_END) / (CYCLE - RANK_END)))) : 0.5;
      const combGlow = clamp01((ct - RANK_END) / (CYCLE - RANK_END));

      for (const n of NODES) drawShadow(n);
      drawRail(topCenter(NODES[BIGQUERY]), topCenter(NODES[HIVE]), true, true);
      drawRail(topCenter(NODES[HIVE]), proj(NODES[BOUNTY].x, 0, NODES[BOUNTY].z), true);
      drawRail(proj(NODES[BOUNTY].x, 0, NODES[BOUNTY].z), topCenter(NODES[AITESTER]));
      drawRail(topCenter(NODES[AITESTER]), topCenter(NODES[SCORER]));
      drawRail(topCenter(NODES[SCORER]), topCenter(NODES[PAYOUT]));

      // discovery: BigQuery scans then a query packet travels to the hive
      let query: { x: number; y: number } | null = null;
      if (ct >= PROPOSE_END && ct < DISCOVER_END) {
        const d = ct - PROPOSE_END;
        if (d < 700) { // scan ring
          const rr = (d / 700);
          const c = topCenter(NODES[BIGQUERY]);
          ctx!.beginPath(); ctx!.ellipse(c.x, c.y, R * scale * (0.6 + rr * 1.4), R * scale * (0.6 + rr * 1.4) * ISO_SIN, 0, 0, Math.PI * 2);
          ctx!.strokeStyle = `rgba(66,133,244,${0.6 * (1 - rr)})`; ctx!.lineWidth = 2; ctx!.stroke();
          NODES[BIGQUERY].pulse = 1;
        }
        const t = easeInOut(clamp01((d - 600) / (DISCOVER_END - PROPOSE_END - 800)));
        const a = topCenter(NODES[BIGQUERY]); const b = topCenter(NODES[HIVE]);
        query = { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) - Math.sin(t * Math.PI) * 8 };
        if (t > 0.9) NODES[HIVE].pulse = 1;
      }

      // options travelling the pipeline (bounty → AI Tester → Scorer)
      const optTokens: { x: number; y: number; color: string; id: string; dec: boolean }[] = [];
      OPTIONS.forEach((o, i) => {
        const sp = ideaSpawn(i);
        const el = ct - sp;
        if (el < 0 || el > 2 * OPT_SEG) return;
        const path = [proj(NODES[BOUNTY].x, 0, NODES[BOUNTY].z), topCenter(NODES[AITESTER]), topCenter(NODES[SCORER])];
        const seg = Math.min(1, Math.floor(el / OPT_SEG));
        const lt = easeInOut(clamp01((el - seg * OPT_SEG) / OPT_SEG));
        const a = path[seg], b = path[seg + 1];
        const x = lerp(a.x, b.x, lt), y = lerp(a.y, b.y, lt) - Math.sin(lt * Math.PI) * 10;
        if (lt > 0.8) NODES[seg === 0 ? AITESTER : SCORER].pulse = 1;
        optTokens.push({ x, y, color: o.color, id: o.id, dec: seg >= 1 });
      });

      const order = NODES.map((_, i) => i).sort((a, b) => NODES[a].x + NODES[a].z - (NODES[b].x + NODES[b].z));
      for (const i of order) {
        if (NODES[i].comb) drawComb(combFill, combGlow);
        else if (NODES[i].db) drawDatabase(NODES[i]);
        else drawPrism(NODES[i]);
        drawNodeLogos(NODES[i]);
      }
      for (const n of NODES) drawLabel(n);

      if (query) { ctx!.save(); ctx!.translate(query.x, query.y); ctx!.shadowColor = "rgba(66,133,244,0.7)"; ctx!.shadowBlur = 12; ctx!.fillStyle = "#4285F4"; ctx!.beginPath(); ctx!.arc(0, 0, 5, 0, Math.PI * 2); ctx!.fill(); ctx!.restore(); }

      // bees: swarm hive → bounty during SWARM, then orbit while agents work
      if (!reduce && ct > DISCOVER_END - 200) {
        const beeAlpha = clamp01((ct - (DISCOVER_END - 200)) / 300) * (1 - clamp01((ct - (SCORE_END + 200)) / 700));
        if (beeAlpha > 0.01) {
          const hiveP = topCenter(NODES[HIVE]); const workP = proj(NODES[BOUNTY].x, 0, NODES[BOUNTY].z);
          for (const bee of bees) {
            const bl = ct - (DISCOVER_END - 200);
            const go = easeInOut(clamp01(bl / (SWARM_END - DISCOVER_END)));
            let x: number, y: number;
            if (bl < SWARM_END - DISCOVER_END) { x = lerp(hiveP.x, workP.x, go) + bee.lane * 26 * Math.sin(go * Math.PI); y = lerp(hiveP.y, workP.y, go) - Math.sin(go * Math.PI) * 34; }
            else { const ang = now * 0.0016 + bee.off; x = workP.x + Math.cos(ang) * bee.rad * scale * 1.2; y = workP.y + Math.sin(ang) * bee.rad * scale * 0.6 - R * scale * 0.5; }
            drawBee(x, y, bee.r, Math.sin(now * 0.02 + bee.phase), beeAlpha);
          }
          NODES[BOUNTY].pulse = Math.max(NODES[BOUNTY].pulse, 0.25);
        }
      }

      for (const t of optTokens) drawOption(t.x, t.y, t.color, t.id, t.dec);

      // leaderboard builds as options are scored, then ranks
      const rankT = clamp01((ct - SCORE_END) / (RANK_END - SCORE_END));
      drawLeaderboard(ct, rankT);

      // winner flies to payout, comb completes
      if (ct > RANK_END) {
        const w = [...OPTIONS].sort((a, b) => b.score - a.score)[0];
        const t = easeInOut(clamp01((ct - RANK_END) / 1200));
        const a = { x: width - Math.min(250, width * 0.32) - 14 + 30, y: 16 + 26 + 15 };
        const b = topCenter(NODES[PAYOUT]);
        drawOption(lerp(a.x, b.x, t), lerp(a.y, b.y, t) - Math.sin(t * Math.PI) * 14, w.color, w.id, true);
        if (t > 0.85) NODES[PAYOUT].pulse = 1;
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
        <h2 className="hc-h2 text-3xl font-semibold tracking-tight sm:text-4xl">One bounty, start to payout</h2>
        <p className="hc-body mt-4 max-w-2xl text-base leading-7 sm:text-lg">
          A bounty is posted as a half-built honeycomb. BigQuery finds it and wakes the hive;
          a swarm of agents proposes competing approaches that run the confidential pipeline,
          get ranked on a leaderboard, and the winner is paid — completing the comb.
        </p>

        <div className="hc-card mt-10 rounded-2xl p-2 sm:p-4">
          <div className="relative h-[460px] w-full sm:h-[540px]">
            <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 pb-2 font-mono text-[0.7rem] text-black/55">
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "#d98a08" }} /> encrypted</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "#2faa55" }} /> decrypted in a TEE</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#4285F4" }} /> BigQuery</span>
          </div>
        </div>

        {/* stepper */}
        <div className="mt-10">
          <ol className="flex items-start justify-between gap-1">
            {STEPS.map((s, i) => (
              <li key={s.label} className="flex flex-1 flex-col items-center text-center">
                <span className={`hc-dot ${i === step ? "hc-dot-on" : ""} ${i < step ? "hc-dot-done" : ""}`}>{i + 1}</span>
                <span className={`mt-2 text-[0.7rem] font-medium leading-tight sm:text-xs ${i === step ? "text-[color:#1a1d23]" : "text-black/45"}`}>{s.label}</span>
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
