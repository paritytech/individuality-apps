// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * React shell for the daily-dollar scratch card. Renders the card DOM (art, eyebrow/date/odds/brand copy, silver prize panel, foil
 * canvas, holo layers, hint, debris, flash), then hands the interactive
 * elements to the canvas engine inside an effect. The foil surface is a
 * focusable button (Enter/Space reveal) on top of the single-pointer flow.
 * The predetermined result stays out of the accessibility tree until the foil
 * is actually gone, so no screen reader can read the outcome off the covered
 * panel.
 */

import { useEffect, useRef, useState } from "react";

import cardArt from "../../../assets/prize/scratchcard.webp";
import holoGlitter from "../../../assets/prize/holo-glitter.png";
import holoStylish from "../../../assets/prize/holo-stylish.png";

import { createScratchEngine } from "./scratch/engine.ts";
import { PCT } from "./scratch/brush.ts";
import type { ScratchCardProps, ScratchEngineApi } from "./scratch/types.ts";
import { ScratchCanvas } from "./scratch-canvas.tsx";
import "../styles/scratch.css";

export type { ScratchOutcome, ScratchCardProps } from "./scratch/types.ts";
;

const TOUCH_PATH = (
  <>
    <path d="M9.5 11.5V4.9a1.9 1.9 0 013.8 0v6.1l3.3.9a2.6 2.6 0 011.9 3l-.7 3a2.7 2.7 0 01-2.6 2.1h-3.6a5 5 0 01-4-2l-2.3-3a1.8 1.8 0 012.5-2.5l1.7 1.2z" />
    <path d="M6.2 5.2a6 6 0 011.6-2M17 3.2a6 6 0 011.6 2" opacity="0.55" />
  </>
);

export function ScratchCard(props: ScratchCardProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onRevealRef = useRef(props.onReveal);
  const engineRef = useRef<ScratchEngineApi | null>(null);
  const [engineRevealed, setEngineRevealed] = useState(false);

  useEffect(() => {
    onRevealRef.current = props.onReveal;
  });

  useEffect(() => {
    // Already settled: no engine, no foil, nothing to scratch.
    if (props.revealed === true) return;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const engine = createScratchEngine({
      card: host.querySelector(".scratch-card")!,
      art: host.querySelector(".sc-art")!,
      panel: host.querySelector(".sc-panel")!,
      canvas,
      holo: host.querySelector(".sc-holo")!,
      debrisCanvas: host.querySelector(".sc-debris")!,
      hint: host.querySelector(".sc-hint")!,
      flash: host.querySelector(".sc-flash")!,
      prize: host.querySelector(".sc-prize")!,
      win: props.outcome === "win",
      onReveal: () => {
        setEngineRevealed(true);
        onRevealRef.current(props.outcome);
      },
    });
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [props.outcome, props.revealed]);

  const resultExposed = props.revealed === true || engineRevealed;

  return (
    <div ref={hostRef} className="scratch-wrap">
      <div className="scratch-card" style={{ touchAction: "none" }}>
        <img className="sc-art" src={cardArt} alt="" draggable={false} />
        <div className="sc-eyebrow">WIN A DOLLAR</div>
        <div className="sc-date">{props.dateLabel}</div>
        <div className="sc-odds">{props.oddsLabel}</div>
        <div className="sc-brand">Polkadot</div>
        <div
          className="sc-panel"
          style={{
            left: `${PCT.left}%`,
            top: `${PCT.top}%`,
            width: `${PCT.w}%`,
            height: `${PCT.h}%`,
            borderRadius: `${PCT.rx}% / ${PCT.ry}%`,
          }}
        >
          <div className="sc-prize" aria-hidden={resultExposed ? undefined : true}>
            {props.outcome === "win" ? (
              <>
                <div className="sc-amount">{props.amountLabel}</div>
                <div className="sc-note">added to your dollars</div>
              </>
            ) : (
              <>
                <div className="sc-pity">Not today</div>
                <div className="sc-note">Tomorrow's is already waiting</div>
              </>
            )}
          </div>
          {props.revealed !== true && (
            <>
              <ScratchCanvas
                canvasRef={canvasRef}
                engineRef={engineRef}
                disabled={engineRevealed}
              />
              <div
                className="sc-holo"
                style={{
                  backgroundImage: `url(${holoGlitter}), url(${holoStylish})`,
                }}
              />
              <div className="sc-hint">
                <svg
                  className="icn"
                  width={30}
                  height={30}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {TOUCH_PATH}
                </svg>
              </div>
            </>
          )}
        </div>
        {props.revealed !== true && (
          <>
            <canvas className="sc-debris" />
            <div className="sc-flash" />
          </>
        )}
      </div>
    </div>
  );
}
