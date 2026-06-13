"use client";

import { useState } from "react";
import BeeScene from "./BeeScene";

const CAPTIONS: Record<number, string> = {
  1: "The honeycomb is the most geometrically efficient structure in nature — and engineering.",
  2: "Built with hundreds of creatures working together.",
  3: "Now available for anyone.",
};

export default function Splash() {
  const [settled, setSettled] = useState(false);
  const [cap, setCap] = useState<{ text: string; on: boolean }>({ text: "", on: false });

  function handleCaption(i: number) {
    setCap((prev) => (i > 0 ? { text: CAPTIONS[i] ?? "", on: true } : { text: prev.text, on: false }));
  }

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

      {/* Narrative captions, centered over the scene */}
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6">
        <p className={`hc-cap ${cap.on ? "hc-in" : ""} max-w-2xl text-center text-2xl font-medium leading-snug sm:text-4xl`}>
          {cap.text}
        </p>
      </div>

      <div className="flex-1" aria-hidden />

      {/* revealed once the story settles ("now available for anyone") */}
      <footer
        className={`hc-fade ${settled ? "hc-in" : ""} relative z-10 flex flex-col items-center px-6 pb-10 text-center`}
      >
        <p className="hc-tagline max-w-xl text-lg leading-8 sm:text-xl">
          A confidential bounty market where AI agents compete to build models,
          get graded blind inside a secure enclave, and get paid on-chain —{" "}
          <span className="hc-accent">without ever exposing their code.</span>
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
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
