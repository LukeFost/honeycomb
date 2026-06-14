"use client";

import { useEffect, useRef } from "react";

// ============================================================================
// BeeScene — interactive splash narrative, fully VECTOR bee (no sprite sheets).
//
// Story on tap:
//   • The bee sleeps ON a small honeycomb (a few cells) with a "tap to wake".
//   1. caption: "...most geometrically efficient structure..."  (then fades)
//   2. caption: "Built with hundreds of creatures working together" — the swarm
//      sweeps in FROM THE LEFT, the honeycomb EXPANDS (cells grow outward + fill
//      with honey), and the whole scene ZOOMS OUT a bit.
//   3. caption: "Now available for anyone for anything" — content reveals.
// ============================================================================

type Other = {
  ang: number;
  angSpeed: number;
  rx: number;
  ry: number;
  pos: { x: number; y: number };
  r: number;
  phase: number;
  delay: number;
  alpha: number;
};

type Cell = { fx: number; fy: number; ring: number; r: number };

// timeline (ms from tap) — paced 20% slower so the captions are easier to read
const WAKE_DUR = 2040;
const CAP1_END = 4800;
const SWARM_START = 5400; // swarm arrives + comb expands + zoom-out begin
const CAP2_END = 9480;
const SETTLE = 10080;

const E_BASE = 0.3; // how much comb is shown while the bee sleeps on it
const ZOOM_OUT = 0.8; // final camera scale

const HERO_R = 44;
const HERO_ALPHA = 1;
const OTHER_ALPHA = 0.9;

const BODY = "#EFA92E";
const DARK = "#23262d";
const WING_STROKE = "rgba(35,38,45,0.6)";
const WING_FILL = "rgba(35,38,45,0.05)";

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

export default function BeeScene({
  onCaption,
  onSettle,
}: {
  onCaption?: (index: number) => void;
  onSettle?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onCaptionRef = useRef(onCaption);
  const onSettleRef = useRef(onSettle);
  // Keep the callback refs current without touching them during render. The animation
  // loop (below) reads .current at fire-time, so it always sees the latest props.
  useEffect(() => {
    onCaptionRef.current = onCaption;
    onSettleRef.current = onSettle;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let dpr = 1;

    let others: Other[] = [];
    const comb = { x: 0, y: 0, size: 20, cells: [] as Cell[] };

    const state = {
      phase: "sleep" as "sleep" | "running",
      tapTime: 0,
      firedSettle: false,
      lastCaption: -1,
    };

    const hero = {
      rest: { x: 0, y: 0 },
      pos: { x: 0, y: 0 },
      ang: -Math.PI / 2,
      angSpeed: 0.0008,
      rx: 70,
      ry: 44,
    };

    // --- build ---

    function buildComb() {
      comb.x = width * 0.5;
      comb.y = height * 0.5;
      const size = Math.max(14, Math.min(22, width / 60));
      comb.size = size;
      comb.cells = [];
      for (let q = -2; q <= 2; q++) {
        for (let r = -2; r <= 2; r++) {
          const ring = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
          if (ring > 2) continue;
          const ox = size * Math.sqrt(3) * (q + r / 2);
          const oy = size * 1.5 * r;
          comb.cells.push({ fx: comb.x + ox, fy: comb.y + oy, ring, r: size });
        }
      }
    }

    function buildOthers() {
      const n = Math.max(18, Math.min(34, Math.round(width / 48)));
      others = [];
      for (let i = 0; i < n; i++) {
        others.push({
          ang: rand(0, Math.PI * 2),
          angSpeed: rand(0.0005, 0.0013) * (Math.random() < 0.5 ? 1 : -1),
          rx: rand(70, Math.max(110, width * 0.2)),
          ry: rand(55, 150),
          pos: { x: -rand(30, width * 0.5), y: rand(height * 0.1, height * 0.85) }, // off the LEFT
          r: rand(9, 16),
          phase: rand(0, Math.PI * 2),
          delay: i * 70,
          alpha: 0,
        });
      }
    }

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = canvas!.clientWidth;
      height = canvas!.clientHeight;
      canvas!.width = Math.round(width * dpr);
      canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildComb();
      hero.rest = { x: comb.x, y: comb.y };
      if (state.phase === "sleep") hero.pos = { ...hero.rest };
      buildOthers();
    }

    // --- geometry -------------------------------------------------------------

    function hexPath(x: number, y: number, r: number, offset: number) {
      ctx!.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + offset;
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        if (i === 0) ctx!.moveTo(px, py);
        else ctx!.lineTo(px, py);
      }
      ctx!.closePath();
    }

    function ringScale(ring: number, e: number) {
      if (ring === 0) return 1;
      if (ring === 1) return clamp01(e / 0.5);
      return clamp01((e - 0.45) / 0.55);
    }

    // --- the vector bee -------------------------------------------------------
    function drawBee(
      x: number,
      y: number,
      r: number,
      beat: number,
      spread: number,
      eyesOpen: boolean,
      alpha: number,
    ) {
      ctx!.save();
      ctx!.globalAlpha = alpha;
      ctx!.translate(x, y);
      ctx!.lineJoin = "round";
      ctx!.lineCap = "round";

      const wingAng = 0.06 + spread * 0.5 + beat * spread * 0.5;
      for (const side of [-1, 1] as const) {
        ctx!.save();
        ctx!.translate(side * r * 0.42, -r * 0.04);
        ctx!.rotate(side * wingAng);
        ctx!.beginPath();
        ctx!.ellipse(side * r * 0.72, -r * 0.22, r * 0.62, r * 0.28, 0, 0, Math.PI * 2);
        ctx!.fillStyle = WING_FILL;
        ctx!.fill();
        ctx!.lineWidth = Math.max(1, r * 0.05);
        ctx!.strokeStyle = WING_STROKE;
        ctx!.stroke();
        ctx!.restore();
      }

      hexPath(0, 0, r, 0);
      ctx!.fillStyle = BODY;
      ctx!.fill();
      ctx!.lineWidth = r * 0.14;
      ctx!.strokeStyle = DARK;
      ctx!.stroke();

      ctx!.save();
      hexPath(0, 0, r * 0.99, 0);
      ctx!.clip();
      ctx!.fillStyle = DARK;
      const sh = r * 0.2;
      ctx!.fillRect(-r, r * 0.12, r * 2, sh);
      ctx!.fillRect(-r, r * 0.12 + sh * 1.75, r * 2, sh);
      ctx!.restore();

      const ey = -r * 0.42;
      const ex = r * 0.3;
      ctx!.fillStyle = DARK;
      ctx!.strokeStyle = DARK;
      if (eyesOpen) {
        ctx!.beginPath();
        ctx!.arc(-ex, ey, r * 0.11, 0, Math.PI * 2);
        ctx!.arc(ex, ey, r * 0.11, 0, Math.PI * 2);
        ctx!.fill();
      } else {
        ctx!.lineWidth = r * 0.09;
        ctx!.beginPath();
        ctx!.moveTo(-ex - r * 0.13, ey);
        ctx!.lineTo(-ex + r * 0.13, ey);
        ctx!.moveTo(ex - r * 0.13, ey);
        ctx!.lineTo(ex + r * 0.13, ey);
        ctx!.stroke();
      }

      ctx!.restore();
    }

    // --- honeycomb (expands from the centre) ----------------------------------
    function drawComb(e: number, fill: number) {
      for (const c of comb.cells) {
        const sc = ringScale(c.ring, e);
        if (sc <= 0.01) continue;
        const x = lerp(comb.x, c.fx, sc);
        const y = lerp(comb.y, c.fy, sc);
        const r = c.r * sc;

        if (fill > 0.01) {
          ctx!.save();
          hexPath(x, y, r - 1, Math.PI / 6);
          ctx!.clip();
          const top = y + r - fill * (r * 2);
          const g = ctx!.createLinearGradient(0, top, 0, y + r);
          g.addColorStop(0, `rgba(255,176,32,0.55)`);
          g.addColorStop(1, `rgba(255,176,32,0.18)`);
          ctx!.fillStyle = g;
          ctx!.fillRect(x - r, top, r * 2, r * 2);
          ctx!.restore();
        }

        hexPath(x, y, r, Math.PI / 6);
        ctx!.lineWidth = 1.6;
        ctx!.strokeStyle = `rgba(190,124,12,${(0.4 + 0.5 * fill) * sc})`;
        if (fill > 0.85) {
          ctx!.shadowColor = `rgba(217,138,8,0.5)`;
          ctx!.shadowBlur = 14;
        }
        ctx!.stroke();
        ctx!.shadowBlur = 0;
      }
    }

    function drawTapPrompt(now: number) {
      const pulse = reduce ? 1 : 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(now * 0.005));
      ctx!.save();
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";
      ctx!.globalAlpha = pulse;
      ctx!.fillStyle = "rgba(35,38,45,0.9)";
      ctx!.font = "600 14px var(--font-geist-mono), monospace";
      ctx!.fillText("▸ tap to wake", hero.pos.x, hero.pos.y + HERO_R * 2.2);
      ctx!.restore();
    }

    // --- caption schedule -----------------------------------------------------
    function captionPhase(since: number) {
      if (state.phase !== "running") return 0;
      if (since < 360) return 0;
      if (since < CAP1_END) return 1;
      if (since < SWARM_START) return 0;
      if (since < CAP2_END) return 2;
      if (since < SETTLE) return 0;
      return 3;
    }

    // --- loop ---
    let raf = 0;

    function frame(now: number) {
      const since = state.phase === "running" ? now - state.tapTime : 0;
      const running = state.phase === "running";

      const cp = captionPhase(since);
      if (cp !== state.lastCaption) {
        state.lastCaption = cp;
        onCaptionRef.current?.(cp);
      }
      if (running && since >= SETTLE && !state.firedSettle) {
        state.firedSettle = true;
        canvas!.style.pointerEvents = "none";
        canvas!.style.cursor = "default";
        onSettleRef.current?.();
      }

      ctx!.clearRect(0, 0, width, height);

      // expansion + zoom both ride the swarm phase
      const t = running ? clamp01((since - SWARM_START) / (SETTLE - SWARM_START)) : 0;
      const e = lerp(E_BASE, 1, t);
      const fill = t;
      const cam = lerp(1, ZOOM_OUT, t);

      ctx!.save();
      ctx!.translate(comb.x, comb.y);
      ctx!.scale(cam, cam);
      ctx!.translate(-comb.x, -comb.y);

      drawComb(e, fill);

      // swarm streams in from the left, then orbits the comb
      for (const o of others) {
        o.ang += o.angSpeed * 16;
        const started = running && since >= SWARM_START + o.delay;
        if (started) {
          const tx = comb.x + Math.cos(o.ang) * o.rx;
          const ty = comb.y + Math.sin(o.ang) * o.ry;
          o.pos.x = lerp(o.pos.x, tx, 0.025);
          o.pos.y = lerp(o.pos.y, ty, 0.025);
          o.alpha = lerp(o.alpha, OTHER_ALPHA, 0.05);
        }
        if (o.alpha > 0.01) {
          const beat = Math.sin(now * 0.02 + o.phase);
          drawBee(o.pos.x, o.pos.y, o.r, beat, 1, true, o.alpha);
        }
      }

      // hero
      const beat = Math.sin(now * 0.02);
      if (!running) {
        hero.pos.x = hero.rest.x;
        hero.pos.y = hero.rest.y + (reduce ? 0 : Math.sin(now * 0.002) * 3);
        drawBee(hero.pos.x, hero.pos.y, HERO_R, 0, 0, false, HERO_ALPHA);
        drawTapPrompt(now);
      } else if (since < WAKE_DUR) {
        const w = clamp01(since / WAKE_DUR);
        drawBee(hero.pos.x, hero.pos.y, HERO_R, beat * w, w, w > 0.45, HERO_ALPHA);
      } else {
        // lift off the comb and orbit it among the swarm
        const ot = clamp01((since - WAKE_DUR) / 1080);
        const rr = HERO_R * lerp(1, 0.62, ot);
        const orbit = 0.6 + 0.7 * e; // orbit widens as the comb expands
        hero.ang += hero.angSpeed * 16;
        const tx = comb.x + Math.cos(hero.ang) * hero.rx * orbit;
        const ty = comb.y + Math.sin(hero.ang) * hero.ry * orbit;
        hero.pos.x = lerp(hero.pos.x, tx, 0.05);
        hero.pos.y = lerp(hero.pos.y, ty, 0.05);
        drawBee(hero.pos.x, hero.pos.y, rr, beat, 1, true, HERO_ALPHA);
      }

      ctx!.restore();

      raf = requestAnimationFrame(frame);
    }

    // --- tap to wake ----------------------------------------------------------
    function onPointerDown(e: PointerEvent) {
      if (state.phase !== "sleep") return;
      const rect = canvas!.getBoundingClientRect();
      const dx = e.clientX - rect.left - hero.pos.x;
      const dy = e.clientY - rect.top - hero.pos.y;
      if (Math.hypot(dx, dy) < HERO_R * 2.4) {
        state.phase = "running";
        state.tapTime = performance.now();
      }
    }

    resize();
    canvas.style.cursor = "pointer";
    canvas.style.pointerEvents = "auto";
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", resize);

    if (reduce) {
      state.phase = "running";
      state.tapTime = performance.now() - (SETTLE + 1000);
      for (const o of others) o.alpha = OTHER_ALPHA;
    }

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />;
}
