"use client";

import { useEffect, useRef, useState } from "react";
import BeeScene from "./BeeScene";

type Seg = { t: string; s?: "i" | "b" };

const CAPTIONS: Record<number, Seg[]> = {
  1: [{ t: "The honeycomb is the most geometrically efficient structure in nature — and engineering." }],
  2: [{ t: "Built with hundreds of creatures working together." }],
  3: [
    { t: "Now available for " },
    { t: "anyone", s: "i" },
    { t: " for " },
    { t: "anything", s: "b" },
  ],
};

const segLen = (segs: Seg[]) => segs.reduce((n, s) => n + s.t.length, 0);

// render segments revealed up to `count` characters, preserving styles
function renderTyped(segs: Seg[], count: number) {
  let remaining = count;
  const out: React.ReactNode[] = [];
  for (let k = 0; k < segs.length && remaining > 0; k++) {
    const seg = segs[k];
    const piece = seg.t.slice(0, remaining);
    remaining -= piece.length;
    if (seg.s === "i") out.push(<em key={k}>{piece}</em>);
    else if (seg.s === "b") out.push(<strong key={k}>{piece}</strong>);
    else out.push(<span key={k}>{piece}</span>);
  }
  return out;
}

export default function Splash() {
  const [settled, setSettled] = useState(false);
  const [cap, setCap] = useState<{ segs: Seg[]; len: number; on: boolean }>({
    segs: [],
    len: 0,
    on: false,
  });
  const [typed, setTyped] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  function handleCaption(i: number) {
    setCap((prev) =>
      i > 0
        ? { segs: CAPTIONS[i] ?? [], len: segLen(CAPTIONS[i] ?? []), on: true }
        : { ...prev, on: false },
    );
  }

  // typewriter: reveal the active caption character by character
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (!cap.on || !cap.len) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setTyped(cap.len);
      return;
    }
    setTyped(0);
    let n = 0;
    timer.current = setInterval(() => {
      n += 1;
      setTyped(n);
      if (n >= cap.len && timer.current) clearInterval(timer.current);
    }, 32);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [cap.segs, cap.len, cap.on]);

  const typing = cap.on && typed < cap.len;

  return (
    <section className="hc-root relative flex h-screen min-h-[640px] flex-col overflow-hidden">
      <BeeScene onCaption={handleCaption} onSettle={() => setSettled(true)} />

      {/* Title — at the top */}
      <header className="relative z-10 flex flex-col items-center pt-12 text-center sm:pt-16">
        <p className="hc-eyebrow mb-3 font-mono text-[0.7rem] uppercase tracking-[0.4em]">
          ETHGlobal New York 2026
        </p>
        <h1 className="hc-title text-5xl font-semibold tracking-tight sm:text-7xl">
          Honeycomb
        </h1>
      </header>

      {/* Narrative captions — lower third, typed out */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-6 pb-[24vh]">
        <p className={`hc-cap ${cap.on ? "hc-in" : ""} max-w-2xl text-center text-2xl font-medium leading-snug sm:text-3xl`}>
          {renderTyped(cap.segs, typed)}
          {cap.on && <span className={`hc-caret ${typing ? "hc-caret-typing" : ""}`}>▋</span>}
        </p>
      </div>

      <div className="flex-1" aria-hidden />

      {/* revealed once the story settles */}
      <footer
        className={`hc-fade ${settled ? "hc-in" : ""} relative z-10 flex flex-col items-center px-6 pb-10 text-center`}
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <a className="hc-btn hc-btn-primary" href="#improvement">
            See how it works
          </a>
          <a
            className="hc-btn hc-btn-ghost"
            href="https://ethglobal.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Read the pitch
          </a>
        </div>

        <a href="#improvement" className="hc-scroll mt-9 font-mono text-[0.7rem] uppercase tracking-[0.3em]">
          scroll ↓
        </a>
      </footer>
    </section>
  );
}
