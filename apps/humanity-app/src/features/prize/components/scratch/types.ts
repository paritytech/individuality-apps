// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Scratch-only types shared by the card component, the engine, the pointer
 * input module, and the presentation slices. The card contract re-exports
 * the component-facing types from `components/ScratchCard.tsx`.
 */

export type ScratchOutcome = "win" | "miss";

export interface ScratchCardProps {
  outcome: ScratchOutcome;
  amountLabel: string;
  dateLabel: string;
  oddsLabel: string;
  onReveal: (outcome: ScratchOutcome) => void;
  /** Render the result already exposed, with no foil to scratch. Used when
   *  the event was settled in an earlier session, so the same card can never
   *  be scratched (or claimed) twice. */
  revealed?: boolean;
}

export interface ScratchEngineOptions {
  card: HTMLElement;
  art: HTMLImageElement;
  panel: HTMLElement;
  canvas: HTMLCanvasElement;
  holo: HTMLElement;
  debrisCanvas: HTMLCanvasElement;
  hint: HTMLElement;
  flash: HTMLElement;
  prize: HTMLElement;
  win: boolean;
  onReveal: () => void;
}

export interface ScratchEngineApi {
  reveal(): void;
  destroy(): void;
}
