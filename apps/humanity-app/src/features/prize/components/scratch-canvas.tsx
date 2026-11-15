// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Public scratch-foil canvas. Keeps the focusable canvas and keyboard reveal
 * path separate from the card shell while sharing its DOM and engine refs.
 */

import type { KeyboardEvent, RefObject } from "react";

import type { ScratchEngineApi } from "./scratch/types.ts";

export interface ScratchCanvasProps {
  /** Shared DOM ref used by the parent to initialize the drawing engine. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Engine handle used by the keyboard reveal path. */
  engineRef: RefObject<ScratchEngineApi | null>;
  /**
   * When true the foil is semantically unavailable — no role, no tab stop,
   * no keyboard handler, no ARIA announcement. The canvas stays mounted so
   * its visual fade-out animation can complete uninterrupted.
   */
  disabled?: boolean;
}

/** Foil canvas element rendered inside the prize panel. */
export function ScratchCanvas({ canvasRef, engineRef, disabled }: ScratchCanvasProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      engineRef.current?.reveal();
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className="sc-foil"
      role={disabled ? undefined : "button"}
      aria-label={disabled ? undefined : "Scratch to reveal"}
      tabIndex={disabled ? -1 : 0}
      aria-hidden={disabled ? true : undefined}
      onKeyDown={onKeyDown}
    />
  );
}
