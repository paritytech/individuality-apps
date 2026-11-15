// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pure state-resolution helpers for the humanity card.
 *  No React dependencies — these are plain TypeScript functions. */
import type { CSSProperties } from "react";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import { progressShare } from "@humanity/shared/card/progress-stripe.ts";
import { heatRankForScore, type HeatRank } from "@features/card/domain/card-heat.ts";
import {
  BASIC_VARS,
  CAUTION_VARS,
  SUSPENDED_VARS,
  WHITE_PLASTIC_VARS,
  memberMaterialForWeeks,
} from "./card-materials.ts";

export interface CardStyle {
  vars: CSSProperties;
  /** Share of the threshold the progress stripe drawn low on the face covers,
   *  0 to 1; candidate cards only. */
  stripe: number | null;
  hasPill: boolean;
  pillText: string;
  isSash: boolean;
  isFaded: boolean;
  isSuspended: boolean;
  heatRank: HeatRank | null;
}

function cardStyle(vars: CSSProperties, flags: Partial<CardStyle> = {}): CardStyle {
  return {
    vars,
    stripe: null,
    hasPill: false,
    pillText: "",
    isSash: false,
    isFaded: false,
    isSuspended: false,
    heatRank: null,
    ...flags,
  };
}

/** The candidate card face: white plastic tinted by the heat rank the score
 *  earns, carrying the stripe that measures it against the threshold. */
function heatFace(score: number, threshold: number): CardStyle {
  const heatRank = heatRankForScore(score, threshold);
  return cardStyle(
    {
      ...WHITE_PLASTIC_VARS,
      "--c-sheen": heatRank?.sheen ?? "rgba(255,255,255,0.5)",
      "--c-score": heatRank?.accent ?? "transparent",
    } as CSSProperties,
    { stripe: progressShare(score, threshold), heatRank },
  );
}

/** Resolve CSS vars + class flags for a given card state. */
export function resolveCardStyle(state: HumanityCardState): CardStyle {
  switch (state.kind) {
    case "not-enrolled":
      return cardStyle(BASIC_VARS);
    // The empty stripe: what the games will fill, drawn before the first one.
    case "devicehood":
      return cardStyle(BASIC_VARS, {
        stripe:
          state.personhoodThreshold == null ? null : progressShare(0, state.personhoodThreshold),
      });
    case "candidate":
      return heatFace(state.score, state.personhoodThreshold);
    // A person waiting for their ring key gets the member card: they earned
    // it, and the face is what they earned. The wait is not a card face.
    case "membership-ready":
    case "member": {
      const material = memberMaterialForWeeks(state.activeWeeks);
      return cardStyle({
        ...material.base,
        "--c-sheen": material.sheen,
        "--c-holo": String(material.holo),
      } as CSSProperties);
    }
    case "caution":
      return cardStyle(CAUTION_VARS, { hasPill: true, pillText: "Caution" });
    case "suspended":
      return cardStyle(SUSPENDED_VARS, {
        hasPill: true,
        pillText: "Suspended",
        isFaded: true,
        isSuspended: true,
      });
  }
}
