// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Card face materials — CSS custom-property palettes plus the pure
 *  week-to-material mapping. A rank is expressed purely as material (base
 *  gradient, sheen, holo); the mockup names (Fresh, Returning, ...) never
 *  appear in UI text. No React dependencies. */
import type { CSSProperties } from "react";

/** The Person card (Devicehood), the `basic` rank: the
 *  candidate's white plastic with every ink in grey and a thin light edge,
 *  so it reads as plain until the first game warms it. */
export const BASIC_VARS = {
  "--c-b1": "#DEDFE3",
  "--c-b2": "#BBBCC0",
  "--c-bg": "linear-gradient(160deg, #DEDFE3 0%, #BBBCC0 100%)",
  "--c-ink": "#8C8F98",
  "--c-ink2": "#8C8F98",
  "--c-sheen": "rgba(255,255,255,0.5)",
  "--c-holo": "0",
  "--c-grain": "0.07",
  "--c-av-bg": "rgba(16,17,20,0.07)",
  "--c-av-fg": "#9BA0A4",
  "--c-border": "#F4F4F5",
  "--c-bw": "1px",
  "--c-score": "transparent",
} as CSSProperties;

export const WHITE_PLASTIC_VARS = {
  "--c-b1": "#DEDFE3",
  "--c-b2": "#BBBCC0",
  "--c-bg": "linear-gradient(160deg, #DEDFE3 0%, #BBBCC0 100%)",
  "--c-ink": "#101114",
  "--c-ink2": "#6F727A",
  "--c-holo": "0",
  "--c-grain": "0.07",
  "--c-av-bg": "#C9CBCF",
  "--c-av-fg": "#6F727A",
  "--c-border": "transparent",
  "--c-bw": "0px",
} as CSSProperties;

/** Silver foil ramp (silverBase) — a fresh member
 *  holds what is recognizably the app's member card. */
export const SILVER_BASE_VARS = {
  "--c-b1": "#DCDEE0",
  "--c-b2": "#AEA6A5",
  "--c-bg":
    "linear-gradient(151deg, #B2B3B3 0%, #DCDEE0 30%, #C5D3ED 48%, #F7F5F4 62%, #F6DCC5 80%, #AEA6A5 100%)",
  "--c-ink": "#0B0C0F",
  "--c-ink2": "#6F727A",
  "--c-holo": "0",
  "--c-grain": "0.14",
  "--c-av-bg": "#2C2E34",
  "--c-av-fg": "#F4F4F5",
  "--c-border": "rgba(244,244,245,0.65)",
  "--c-bw": "0px",
  "--c-score": "transparent",
} as CSSProperties;

/** Dark-silver base (weeks 13-51); the surface gradient falls back to a
 *  b1-b2 ramp (darkSilverBase). */
export const DARK_SILVER_BASE_VARS = {
  "--c-b1": "#83878E",
  "--c-b2": "#5C6067",
  "--c-ink": "#F4F4F5",
  "--c-ink2": "rgba(244,244,245,0.62)",
  "--c-holo": "0",
  "--c-grain": "0.16",
  "--c-av-bg": "#2C2E34",
  "--c-av-fg": "#F4F4F5",
  "--c-border": "rgba(244,244,245,0.65)",
  "--c-bw": "0px",
  "--c-score": "transparent",
} as CSSProperties;

/** Black base (weeks 52+); the light 1px edge is part of the mockup's
 *  black card, not a decoration layered on afterwards. */
export const BLACK_BASE_VARS = {
  "--c-b1": "#17181C",
  "--c-b2": "#0C0D10",
  "--c-ink": "#F4F4F5",
  "--c-ink2": "rgba(244,244,245,0.62)",
  "--c-holo": "0",
  "--c-grain": "0.18",
  "--c-av-bg": "#2C2E34",
  "--c-av-fg": "#F4F4F5",
  "--c-border": "rgba(244,244,245,0.65)",
  "--c-bw": "1px",
  "--c-score": "transparent",
} as CSSProperties;

/** Caution: the card goes grey with an orange edge and the sash. Not gold —
 *  gold is the game's, and a warning is not a prize. */
export const CAUTION_VARS = {
  "--c-b1": "#B9BBBE",
  "--c-b2": "#97999D",
  "--c-bg": "linear-gradient(160deg, #B9BBBE 0%, #97999D 100%)",
  "--c-ink": "#101114",
  "--c-ink2": "#41444B",
  "--c-sheen": "rgba(255,255,255,0.15)",
  "--c-holo": "0",
  "--c-grain": "0.07",
  "--c-av-bg": "#8C8F98",
  "--c-av-fg": "#F4F4F5",
  "--c-border": "#F59E0B",
  "--c-bw": "3px",
  "--c-score": "transparent",
} as CSSProperties;

export const SUSPENDED_VARS = {
  "--c-b1": "#8A8C90",
  "--c-b2": "#707276",
  "--c-bg": "linear-gradient(160deg, #8A8C90 0%, #707276 100%)",
  "--c-ink": "#101114",
  "--c-ink2": "#202126",
  "--c-sheen": "rgba(255,255,255,0.08)",
  "--c-holo": "0",
  "--c-grain": "0.06",
  "--c-av-bg": "#8C8F98",
  "--c-av-fg": "#F4F4F5",
  "--c-border": "#D9363E",
  "--c-bw": "3px",
  "--c-score": "transparent",
} as CSSProperties;

export interface MemberMaterial {
  /** First active week this tier applies from. */
  weeks: number;
  base: CSSProperties;
  sheen: string;
  holo: number;
}

/** The member ramp: silver foil
 *  (weeks 1-12), dark silver (13-51), then black whose holo escalates
 *  past 52. Sheen alone carries the tier identity. */
export const MEMBER_MATERIALS: readonly [MemberMaterial, ...MemberMaterial[]] = [
  { weeks: 1, base: SILVER_BASE_VARS, sheen: "rgba(255,255,255,0.5)", holo: 0 },
  { weeks: 2, base: SILVER_BASE_VARS, sheen: "rgba(244,114,182,0.42)", holo: 0 },
  { weeks: 4, base: SILVER_BASE_VARS, sheen: "rgba(45,212,191,0.4)", holo: 0 },
  { weeks: 8, base: SILVER_BASE_VARS, sheen: "rgba(139,92,246,0.42)", holo: 0 },
  { weeks: 13, base: DARK_SILVER_BASE_VARS, sheen: "rgba(255,255,255,0.24)", holo: 0 },
  { weeks: 26, base: DARK_SILVER_BASE_VARS, sheen: "rgba(232,160,144,0.4)", holo: 0 },
  { weeks: 39, base: DARK_SILVER_BASE_VARS, sheen: "rgba(109,58,93,0.5)", holo: 0 },
  { weeks: 52, base: BLACK_BASE_VARS, sheen: "rgba(255,255,255,0.12)", holo: 0 },
  { weeks: 78, base: BLACK_BASE_VARS, sheen: "rgba(255,255,255,0.1)", holo: 0.35 },
  { weeks: 104, base: BLACK_BASE_VARS, sheen: "rgba(255,255,255,0.1)", holo: 0.5 },
  { weeks: 208, base: BLACK_BASE_VARS, sheen: "rgba(255,255,255,0.1)", holo: 0.65 },
  { weeks: 312, base: BLACK_BASE_VARS, sheen: "rgba(255,255,255,0.1)", holo: 0.8 },
  { weeks: 416, base: BLACK_BASE_VARS, sheen: "rgba(255,255,255,0.1)", holo: 0.9 },
];

/** Material for a member's active-week count. Anything below the first
 *  tier stays on fresh silver — a member card is always silver, and an
 *  unreachable game history must not demote the card. */
export function memberMaterialForWeeks(activeWeeks: number): MemberMaterial {
  if (!Number.isFinite(activeWeeks) || activeWeeks < MEMBER_MATERIALS[0].weeks) {
    return MEMBER_MATERIALS[0];
  }
  let material = MEMBER_MATERIALS[0];
  for (const tier of MEMBER_MATERIALS) {
    if (activeWeeks >= tier.weeks) material = tier;
  }
  return material;
}

/** The materials the story ladder's swatches wear: the rung each earns. */
export const SWATCH_BACKGROUNDS = {
  person: BASIC_VARS["--c-bg" as keyof typeof BASIC_VARS] as string,
  candidate: WHITE_PLASTIC_VARS["--c-bg" as keyof typeof WHITE_PLASTIC_VARS] as string,
  member: SILVER_BASE_VARS["--c-bg" as keyof typeof SILVER_BASE_VARS] as string,
} as const;
