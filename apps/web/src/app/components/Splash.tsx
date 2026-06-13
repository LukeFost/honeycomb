"use client";

import { useEffect, useRef, useState } from "react";
import BeeScene from "./BeeScene";

const CAPTIONS: Record<number, string> = {
  1: "The honeycomb is the most geometrically efficient structure in nature — and engineering.",
  2: "Built with hundreds of creatures working together.",
  3: "Now available for anyone.",
};

export default function Splash() {
  const [settled, setSettled] = useState(false);
  const [cap, setCap] = useState<{ text: string; on: boolean }>({ text: "", on: false });
  const [typed, setTyped] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  function handleCaption(i: number) {
    setCap((prev) => (i > 0 ? { text: CAPTIONS[i] ?? "", on: true } : { text: prev.text, on: false }));
  }

  // typewriter: when a caption turns on, reveal it character by character
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (!cap.on || !cap.text) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setTyped(cap.text.length);
      return;
    }
    setTyped(0);
    let n = 0;
    timer.current = setInterval(() => {
      n += 1;
      setTyped(n);
      if (n >= cap.text.length && timer.current) clearInterval(timer.current);
    }, 32);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [cap.text, cap.on]);

  const typing = cap.on && typed < cap.text.length;

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
          {cap.text.slice(0, typed)}
          {cap.on && <span className={`hc-caret ${typing ? "hc-caret-typing" : ""}`}>▋</span>}
        </p>
      </div>

      <div className="flex-1" aria-hidden />

      {/* revealed once the story settles ("now available for anyone") */}
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
