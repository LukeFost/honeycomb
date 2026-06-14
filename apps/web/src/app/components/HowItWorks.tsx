"use client";

import { useEffect, useRef } from "react";

// ============================================================================
// HowItWorks — isometric 3D pipeline diagram (canvas, no 3D library).
//
// Service nodes are extruded hexagonal prisms (honeycomb cells with height),
// laid out on an isometric ground plane. "Request" packets appear at the first
// node and flow along the wires through each service; a node lights up as a
// packet passes — several requests are in flight at once.
// ============================================================================

type Node = { x: number; z: number; label: string; pulse: number };
type Token = { p: number }; // progress along the chain, 0 .. nSeg

const STEPS = [
  { label: "Request", desc: "A user posts a funded bounty" },
  { label: "Agents", desc: "Agents submit encrypted models" },
  { label: "AI Tester", desc: "TEE checks the code is legit" },
  { label: "Scorer", desc: "TEE grades it on hidden data" },
  { label: "Settle", desc: "Chainlink CRE settles on-chain" },
  { label: "Payout", desc: "The winner is paid, rep updated" },
];

// world positions chosen so the chain reads left→right on screen (≈constant
// x+z) with a gentle alternating depth so it still feels 3D.
const POS: [number, number][] = [
  [-1.78, 3.98],
  [0.08, 3.53],
  [0.53, 1.68],
  [2.38, 1.23],
  [2.83, -0.63],
  [4.68, -1.08],
];

const ISO_COS = Math.cos(Math.PI / 6); // 30°
const ISO_SIN = Math.sin(Math.PI / 6);
const R = 0.95; // hex radius (world)
const H = 0.95; // prism height (world)
const SEG_MS = 760; // ms per hop
const SPAWN_MS = 1100;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const mix = (a: number[], b: number[], t: number) =>
  `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(
    lerp(a[2], b[2], t),
  )})`;

const SIDE_DARK = [120, 78, 14];
const SIDE_LIGHT = [216, 138, 8];
const TOP_BASE = [242, 179, 58];
const TOP_HOT = [255, 226, 150];

export default function HowItWorks() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let scale = 42;
    let ox = 0;
    let oy = 0;

    const nodes: Node[] = POS.map(([x, z], i) => ({ x, z, label: STEPS[i].label, pulse: 0 }));
    let tokens: Token[] = [];
    let spawnTimer = 0;

    const projRaw = (wx: number, wy: number, wz: number) => ({
      x: (wx - wz) * ISO_COS * scale,
      y: ((wx + wz) * ISO_SIN - wy) * scale,
    });
    const proj = (wx: number, wy: number, wz: number) => {
      const p = projRaw(wx, wy, wz);
      return { x: p.x + ox, y: p.y + oy };
    };
    const hexCorner = (cx: number, cz: number, y: number, i: number) => {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      return proj(cx + R * Math.cos(a), y, cz + R * Math.sin(a));
    };
    const topCenter = (n: Node) => proj(n.x, H, n.z);

    function layout() {
      scale = Math.max(26, Math.min(46, width / 22));
      // compute bbox of all geometry (corners top+bottom) to center it
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      ox = 0;
      oy = 0;
      for (const n of nodes) {
        for (let i = 0; i < 6; i++) {
          for (const y of [0, H]) {
            const a = (Math.PI / 3) * i + Math.PI / 6;
            const p = projRaw(n.x + R * Math.cos(a), y, n.z + R * Math.sin(a));
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
          }
        }
      }
      ox = width / 2 - (minX + maxX) / 2;
      oy = height / 2 - (minY + maxY) / 2;
    }

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = canvas!.clientWidth;
      height = canvas!.clientHeight;
      canvas!.width = Math.round(width * dpr);
      canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      layout();
    }

    // --- drawing --------------------------------------------------------------

    function drawShadow(n: Node) {
      const c = proj(n.x, 0, n.z);
      ctx!.save();
      ctx!.translate(c.x, c.y);
      ctx!.scale(1, ISO_SIN);
      ctx!.beginPath();
      ctx!.arc(0, 0, R * scale * 1.05, 0, Math.PI * 2);
      ctx!.fillStyle = "rgba(60,44,12,0.12)";
      ctx!.fill();
      ctx!.restore();
    }

    function drawWire(a: Node, b: Node) {
      const p1 = topCenter(a);
      const p2 = topCenter(b);
      ctx!.beginPath();
      ctx!.moveTo(p1.x, p1.y);
      ctx!.lineTo(p2.x, p2.y);
      ctx!.strokeStyle = "rgba(120,90,30,0.28)";
      ctx!.lineWidth = 2;
      ctx!.setLineDash([5, 6]);
      ctx!.stroke();
      ctx!.setLineDash([]);
    }

    function drawPrism(n: Node) {
      const lift = n.pulse * 0.18;
      const top = Array.from({ length: 6 }, (_, i) => hexCorner(n.x, n.z, H + lift, i));
      const bot = Array.from({ length: 6 }, (_, i) => hexCorner(n.x, n.z, 0, i));

      // side faces, far → near
      const faces = Array.from({ length: 6 }, (_, i) => {
        const normalAng = (Math.PI / 3) * i + Math.PI / 3;
        const depth = n.x + n.z + Math.cos(normalAng) + Math.sin(normalAng);
        return { i, normalAng, depth };
      }).sort((a, b) => a.depth - b.depth);

      for (const f of faces) {
        const j = (f.i + 1) % 6;
        // light from upper-left
        const shade = 0.4 + 0.6 * Math.max(0, Math.cos(f.normalAng - 2.4));
        ctx!.beginPath();
        ctx!.moveTo(top[f.i].x, top[f.i].y);
        ctx!.lineTo(top[j].x, top[j].y);
        ctx!.lineTo(bot[j].x, bot[j].y);
        ctx!.lineTo(bot[f.i].x, bot[f.i].y);
        ctx!.closePath();
        ctx!.fillStyle = mix(SIDE_DARK, SIDE_LIGHT, shade);
        ctx!.fill();
        ctx!.strokeStyle = "rgba(40,26,4,0.35)";
        ctx!.lineWidth = 1;
        ctx!.stroke();
      }

      // top face
      ctx!.beginPath();
      top.forEach((p, i) => (i === 0 ? ctx!.moveTo(p.x, p.y) : ctx!.lineTo(p.x, p.y)));
      ctx!.closePath();
      ctx!.fillStyle = mix(TOP_BASE, TOP_HOT, n.pulse);
      if (n.pulse > 0.05) {
        ctx!.shadowColor = `rgba(255,200,90,${0.7 * n.pulse})`;
        ctx!.shadowBlur = 24 * n.pulse;
      }
      ctx!.fill();
      ctx!.shadowBlur = 0;
      ctx!.strokeStyle = "rgba(60,40,8,0.55)";
      ctx!.lineWidth = 1.4;
      ctx!.stroke();
    }

    function drawLabel(n: Node, i: number) {
      const base = proj(n.x, 0, n.z);
      ctx!.save();
      ctx!.textAlign = "center";
      ctx!.textBaseline = "top";
      ctx!.fillStyle = "rgba(32,36,43,0.92)";
      ctx!.font = "700 13px var(--font-geist-sans), system-ui, sans-serif";
      ctx!.fillText(`${i + 1}. ${n.label}`, base.x, base.y + R * scale * ISO_SIN + 8);
      ctx!.restore();
    }

    function drawToken(t: Token) {
      const seg = Math.min(STEPS.length - 2, Math.floor(t.p));
      const lt = clamp01(t.p - seg);
      const a = topCenter(nodes[seg]);
      const b = topCenter(nodes[seg + 1]);
      const hop = Math.sin(lt * Math.PI) * 16; // little arc between nodes
      const x = lerp(a.x, b.x, lt);
      const y = lerp(a.y, b.y, lt) - hop - 10;

      ctx!.save();
      ctx!.shadowColor = "rgba(255,210,110,0.9)";
      ctx!.shadowBlur = 16;
      // glowing request packet (small diamond)
      ctx!.translate(x, y);
      ctx!.rotate(Math.PI / 4);
      ctx!.fillStyle = "#fff4d6";
      ctx!.fillRect(-5, -5, 10, 10);
      ctx!.fillStyle = "#ffb020";
      ctx!.fillRect(-3, -3, 6, 6);
      ctx!.restore();
    }

    // --- loop -----------------------------------------------------------------
    let raf = 0;
    let last = 0;

    function frame(now: number) {
      if (!last) last = now;
      const dt = Math.min(60, now - last);
      last = now;

      if (!reduce) {
        // spawn requests
        spawnTimer -= dt;
        if (spawnTimer <= 0) {
          tokens.push({ p: 0 });
          nodes[0].pulse = 1;
          spawnTimer = SPAWN_MS;
        }
        // advance tokens, pulse nodes on arrival
        for (const t of tokens) {
          const before = Math.floor(t.p);
          t.p += dt / SEG_MS;
          const after = Math.floor(t.p);
          if (after !== before && after < nodes.length) nodes[after].pulse = 1;
        }
        tokens = tokens.filter((t) => t.p < STEPS.length - 1);
        for (const n of nodes) n.pulse *= 0.93;
      } else if (tokens.length === 0) {
        for (const n of nodes) n.pulse = 0.25;
      }

      ctx!.clearRect(0, 0, width, height);

      for (const n of nodes) drawShadow(n);
      for (let i = 0; i < nodes.length - 1; i++) drawWire(nodes[i], nodes[i + 1]);

      // nodes far → near
      const order = nodes.map((_, i) => i).sort((a, b) => nodes[a].x + nodes[a].z - (nodes[b].x + nodes[b].z));
      for (const i of order) drawPrism(nodes[i]);
      for (let i = 0; i < nodes.length; i++) drawLabel(nodes[i], i);

      if (!reduce) for (const t of tokens) drawToken(t);

      raf = requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener("resize", resize);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <section id="how" className="hc-section">
      <div className="mx-auto w-full max-w-5xl px-6 py-24 sm:py-32">
        <p className="hc-eyebrow mb-3 font-mono text-[0.7rem] uppercase tracking-[0.4em]">
          How it works
        </p>
        <h2 className="hc-h2 text-3xl font-semibold tracking-tight sm:text-4xl">
          Requests flow through confidential services
        </h2>
        <p className="hc-body mt-4 max-w-2xl text-base leading-7 sm:text-lg">
          A request appears, agents respond, two trusted enclaves judge it blind, and
          Chainlink settles the payout on-chain — every step verifiable, the code and the
          tests never exposed.
        </p>

        <div className="hc-card mt-10 rounded-2xl p-2 sm:p-4">
          <div className="relative h-[380px] w-full sm:h-[460px]">
            <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />
          </div>
        </div>

        {/* accessible / fallback step list */}
        <ol className="mt-8 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.label} className="flex gap-3">
              <span className="hc-step-num font-mono text-sm font-semibold">{i + 1}</span>
              <span className="hc-body text-sm leading-6">
                <span className="font-semibold text-[color:#1a1d23]">{s.label}.</span> {s.desc}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
