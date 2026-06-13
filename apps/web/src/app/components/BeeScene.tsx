"use client";

import { useEffect, useRef } from "react";

// ============================================================================
// BeeScene — interactive splash narrative.
//
// A bee sleeps with a "tap to wake" prompt. On tap the story plays:
//   1. caption: "...most geometrically efficient structure..."  (then fades)
//   2. the bee flies to a honeycomb, which fades in
//   3. caption: "Built with hundreds of creatures working together" — the swarm
//      sweeps in FROM THE LEFT and builds the comb (cells fill with honey)
//   4. caption: "Now available for anyone" — content reveals, scene settles
//
// The canvas owns the master clock (ms from tap) and reports the current caption
// index + the settle moment to the page. Honors reduced motion.
// ============================================================================

type Sheet = { img: HTMLImageElement; cols: number; rows: number; frames: number; loaded: boolean };

type Other = {
  ang: number;
  angSpeed: number;
  rx: number;
  ry: number;
  pos: { x: number; y: number };
  scale: number;
  flapOffset: number;
  delay: number; // ms after SWARM_START before this bee streams in
  alpha: number;
};

type Cell = { x: number; y: number; r: number };

// timeline (ms from tap)
const WAKE_DUR = 1700; // play the 6 waking frames
const TO_COMB_END = 4000; // bee has flown to the honeycomb
const SWARM_START = 4500; // swarm begins arriving from the left
const CAP2_END = 7900;
const SETTLE = 8400; // "now available" + reveal

const HERO_H = 160;
const HERO_ALPHA = 1;
const OTHER_ALPHA = 0.9;

function loadSheet(src: string, cols: number, rows: number): Sheet {
  const img = new Image();
  const sheet: Sheet = { img, cols, rows, frames: cols * rows, loaded: false };
  img.onload = () => {
    sheet.loaded = true;
  };
  img.src = src;
  return sheet;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
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
  onCaptionRef.current = onCaption;
  onSettleRef.current = onSettle;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const wake = loadSheet("/bee-waking.png", 3, 2);
    const fly = loadSheet("/bee_fly.png", 3, 2);

    let width = 0;
    let height = 0;
    let dpr = 1;

    let others: Other[] = [];
    const comb = { x: 0, y: 0, cells: [] as Cell[] };

    const state = {
      phase: "sleep" as "sleep" | "running",
      tapTime: 0,
      firedSettle: false,
      lastCaption: -1,
    };

    const hero = {
      rest: { x: 0, y: 0 },
      pos: { x: 0, y: 0 },
      ang: rand(0, Math.PI * 2),
      angSpeed: 0.0007,
      rx: 64,
      ry: 38,
    };

    // --- build ----------------------------------------------------------------

    function buildComb() {
      comb.x = width * 0.5;
      comb.y = height * 0.46;
      const r = Math.max(20, Math.min(30, width / 42));
      const dx = Math.sqrt(3) * r;
      const dy = 1.5 * r;
      // flower: centre + 6 neighbours (pointy-top axial offsets)
      const offsets: [number, number][] = [
        [0, 0],
        [dx, 0],
        [-dx, 0],
        [dx / 2, -dy],
        [-dx / 2, -dy],
        [dx / 2, dy],
        [-dx / 2, dy],
      ];
      comb.cells = offsets.map(([ox, oy]) => ({ x: comb.x + ox, y: comb.y + oy, r }));
    }

    function buildOthers() {
      const n = Math.max(18, Math.min(34, Math.round(width / 48)));
      others = [];
      for (let i = 0; i < n; i++) {
        others.push({
          ang: rand(0, Math.PI * 2),
          angSpeed: rand(0.0005, 0.0013) * (Math.random() < 0.5 ? 1 : -1),
          rx: rand(55, Math.max(90, width * 0.16)),
          ry: rand(40, 120),
          // start off the LEFT edge, varied height → they sweep in from the left
          pos: { x: -rand(30, width * 0.5), y: rand(height * 0.12, height * 0.82) },
          scale: rand(0.05, 0.09),
          flapOffset: Math.floor(rand(0, 6)),
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
      hero.rest = { x: width * 0.5, y: height * 0.62 };
      if (state.phase === "sleep") hero.pos = { ...hero.rest };
      buildComb();
      buildOthers();
    }

    // --- draw helpers ---------------------------------------------------------

    function drawSprite(sheet: Sheet, frame: number, x: number, y: number, scale: number, alpha = 1) {
      if (!sheet.loaded || alpha <= 0) return;
      const fw = sheet.img.naturalWidth / sheet.cols;
      const fh = sheet.img.naturalHeight / sheet.rows;
      const sx = (frame % sheet.cols) * fw;
      const sy = Math.floor(frame / sheet.cols) * fh;
      const dw = fw * scale;
      const dh = fh * scale;
      ctx!.globalAlpha = alpha;
      ctx!.drawImage(sheet.img, sx, sy, fw, fh, x - dw / 2, y - dh / 2, dw, dh);
      ctx!.globalAlpha = 1;
    }

    function hexPath(x: number, y: number, r: number) {
      ctx!.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6; // pointy-top
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        if (i === 0) ctx!.moveTo(px, py);
        else ctx!.lineTo(px, py);
      }
      ctx!.closePath();
    }

    function drawComb(combAlpha: number, fill: number) {
      if (combAlpha <= 0.01) return;
      for (const c of comb.cells) {
        // honey fill rising from the bottom
        if (fill > 0.01) {
          ctx!.save();
          hexPath(c.x, c.y, c.r - 1);
          ctx!.clip();
          const top = c.y + c.r - fill * (c.r * 2);
          const g = ctx!.createLinearGradient(0, top, 0, c.y + c.r);
          g.addColorStop(0, `rgba(255,176,32,${0.55 * combAlpha})`);
          g.addColorStop(1, `rgba(255,176,32,${0.18 * combAlpha})`);
          ctx!.fillStyle = g;
          ctx!.fillRect(c.x - c.r, top, c.r * 2, c.r * 2);
          ctx!.restore();
        }
        hexPath(c.x, c.y, c.r);
        ctx!.lineWidth = 1.5;
        ctx!.strokeStyle = `rgba(255,196,64,${(0.3 + 0.5 * fill) * combAlpha})`;
        if (fill > 0.85) {
          ctx!.shadowColor = `rgba(255,196,64,${0.6 * combAlpha})`;
          ctx!.shadowBlur = 14;
        }
        ctx!.stroke();
        ctx!.shadowBlur = 0;
      }
    }

    const heroScale = () => HERO_H / (wake.img.naturalHeight / wake.rows || 512);

    function drawTapPrompt(now: number) {
      const pulse = reduce ? 1 : 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(now * 0.005));
      ctx!.save();
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";
      ctx!.globalAlpha = pulse;
      ctx!.fillStyle = "rgba(255,255,255,0.92)";
      ctx!.font = "600 14px var(--font-geist-mono), monospace";
      ctx!.fillText("▸ tap to wake", hero.pos.x, hero.pos.y + HERO_H * 0.62);
      ctx!.restore();
    }

    // --- caption schedule -----------------------------------------------------

    function captionPhase(since: number) {
      if (state.phase !== "running") return 0;
      if (since < 300) return 0;
      if (since < TO_COMB_END) return 1; // efficiency line (during wake + flight)
      if (since < SWARM_START) return 0; // gap
      if (since < CAP2_END) return 2; // built with hundreds
      if (since < SETTLE) return 0; // gap
      return 3; // now available
    }

    // --- loop -----------------------------------------------------------------
    let raf = 0;

    function frame(now: number) {
      const since = state.phase === "running" ? now - state.tapTime : 0;

      // emit caption changes
      const cp = captionPhase(since);
      if (cp !== state.lastCaption) {
        state.lastCaption = cp;
        onCaptionRef.current?.(cp);
      }
      // reveal page content + hand pointer events back, once, at settle
      if (state.phase === "running" && since >= SETTLE && !state.firedSettle) {
        state.firedSettle = true;
        canvas!.style.pointerEvents = "none";
        canvas!.style.cursor = "default";
        onSettleRef.current?.();
      }

      ctx!.clearRect(0, 0, width, height);

      // honeycomb fades in as the bee approaches; fills as the swarm builds it
      const combAlpha = clamp01((since - WAKE_DUR) / (TO_COMB_END - WAKE_DUR));
      const fill = clamp01((since - SWARM_START) / (SETTLE - SWARM_START));
      drawComb(state.phase === "running" ? combAlpha : 0, fill);

      // swarm streams in from the left, then orbits the comb
      const flap = Math.floor(now / 80) % 6;
      for (const o of others) {
        o.ang += o.angSpeed * 16;
        const started = state.phase === "running" && since >= SWARM_START + o.delay;
        if (started) {
          const tx = comb.x + Math.cos(o.ang) * o.rx;
          const ty = comb.y + Math.sin(o.ang) * o.ry;
          o.pos.x = lerp(o.pos.x, tx, 0.025);
          o.pos.y = lerp(o.pos.y, ty, 0.025);
          o.alpha = lerp(o.alpha, OTHER_ALPHA, 0.05);
        }
        if (o.alpha > 0.01) {
          const f = (Math.floor(now / 90) + o.flapOffset) % 6;
          drawSprite(fly, f, o.pos.x, o.pos.y, o.scale, o.alpha);
        }
      }

      // hero
      const sc = heroScale();
      if (state.phase === "sleep") {
        hero.pos.x = hero.rest.x;
        hero.pos.y = hero.rest.y + (reduce ? 0 : Math.sin(now * 0.002) * 3);
        drawSprite(wake, 0, hero.pos.x, hero.pos.y, sc, HERO_ALPHA);
        drawTapPrompt(now);
      } else if (since < WAKE_DUR) {
        const frameIdx = Math.min(5, Math.floor((since / WAKE_DUR) * 6));
        drawSprite(wake, frameIdx, hero.pos.x, hero.pos.y, sc, HERO_ALPHA);
      } else if (since < TO_COMB_END) {
        // fly from the cell up to the honeycomb, shrinking, flapping
        const t = easeInOut(clamp01((since - WAKE_DUR) / (TO_COMB_END - WAKE_DUR)));
        const arc = Math.sin(t * Math.PI) * 40;
        hero.pos.x = lerp(hero.rest.x, comb.x, t);
        hero.pos.y = lerp(hero.rest.y, comb.y, t) - arc;
        drawSprite(fly, flap, hero.pos.x, hero.pos.y, lerp(sc, sc * 0.5, t), HERO_ALPHA);
      } else {
        // settled — orbit the comb with the swarm
        hero.ang += hero.angSpeed * 16;
        const tx = comb.x + Math.cos(hero.ang) * hero.rx;
        const ty = comb.y + Math.sin(hero.ang) * hero.ry;
        hero.pos.x = lerp(hero.pos.x, tx, 0.04);
        hero.pos.y = lerp(hero.pos.y, ty, 0.04);
        drawSprite(fly, flap, hero.pos.x, hero.pos.y, sc * 0.5, HERO_ALPHA);
      }

      raf = requestAnimationFrame(frame);
    }

    // --- tap to wake ----------------------------------------------------------
    function onPointerDown(e: PointerEvent) {
      if (state.phase !== "sleep") return;
      const rect = canvas!.getBoundingClientRect();
      const dx = e.clientX - rect.left - hero.pos.x;
      const dy = e.clientY - rect.top - hero.pos.y;
      if (Math.hypot(dx, dy) < HERO_H * 0.95) {
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
      // skip straight to the settled scene
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
