// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pure heat-score math for the humanity card's candidate journey: the rank
 *  a score earns. The stripe's share is `@humanity/shared/card/progress-stripe.ts`,
 *  shared with the Pocket face. No React. */

export interface HeatRank {
  key: "spark" | "ignition" | "flame" | "fire" | "blaze";
  label: string;
  accent: string;
  sheen: string;
  ambient: string;
}

const HEAT_RANKS: readonly HeatRank[] = [
  { key: "spark", label: "Spark", accent: "#E0A400", sheen: "#E0A4003D", ambient: "rgba(255,216,77,0.13)" },
  { key: "ignition", label: "Ignition", accent: "#D98A0B", sheen: "#D98A0B3D", ambient: "rgba(245,158,11,0.13)" },
  { key: "flame", label: "Flame", accent: "#E06716", sheen: "#E067163D", ambient: "rgba(249,115,22,0.13)" },
  { key: "fire", label: "Fire", accent: "#C43B40", sheen: "#C43B403D", ambient: "rgba(229,72,77,0.14)" },
  { key: "blaze", label: "Blaze", accent: "#8C2332", sheen: "#8C23323D", ambient: "rgba(140,35,50,0.17)" },
];

/** Heat rank a candidate's score earns, Spark through Blaze by the share of
 *  the threshold covered; null before the first point. Matches the design
 *  prototype's `heatRank`. */
export function heatRankForScore(score: number, threshold: number): HeatRank | null {
  if (!Number.isFinite(score) || !Number.isFinite(threshold) || threshold <= 0 || score <= 0) {
    return null;
  }
  const share = Math.min(1, score / threshold);
  const index = Math.min(HEAT_RANKS.length, Math.max(1, Math.ceil(share * HEAT_RANKS.length)));
  return HEAT_RANKS[index - 1] ?? null;
}
