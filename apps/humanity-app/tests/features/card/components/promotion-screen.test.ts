// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The promotion never claims a name on its own: it offers the flow when a
 *  name is on offer, and only a way back otherwise. Its card stays inert.
 *  Every style says the same words; the card-less one draws no card, and
 *  reduced motion lands on the settled member state. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PromotionScreen } from "@features/card/components/PromotionScreen.tsx";
import {
  DEFAULT_PROMOTION_STYLE,
  PROMOTION_STYLES,
  type PromotionStyle,
} from "@features/card/domain/promotion-style.ts";
import type * as MotionHooks from "@shared/hooks/motion.ts";

const motionMode = vi.hoisted(() => ({ reduced: false }));
const panel = vi.hoisted(() => ({ built: true }));
// A server render reads a zustand store's initial state, never a later
// `setState`, so the panel's picks are stood in for here.
const debug = vi.hoisted(() => ({ promotionStyle: "card-less", cardHidden: false }));
vi.mock("@features/debug/debug-store.ts", () => ({
  useDebugStore: <T,>(select: (state: typeof debug) => T): T => select(debug),
}));
vi.mock("@humanity/shared/config/debug-panel.ts", () => ({
  get DEBUG_PANEL() {
    return panel.built;
  },
}));
vi.mock("@shared/hooks/motion.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof MotionHooks>()),
  useReducedMotion: () => motionMode.reduced,
}));

function renderPromotion(onChooseName?: () => void): string {
  return renderToStaticMarkup(
    createElement(PromotionScreen, {
      fromState: { kind: "candidate", score: 4, personhoodThreshold: 5, gamesRemaining: 1 },
      toState: { kind: "member", activeWeeks: 1, lastAttendedGame: 7, attendanceHistory: 1, window: 8 },
      accountAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      displayName: "dave.42",
      onChooseName,
      onDismiss: () => undefined,
    }),
  );
}

function renderStyle(style: PromotionStyle, onChooseName?: () => void): string {
  debug.promotionStyle = style;
  return renderPromotion(onChooseName);
}

beforeEach(() => {
  motionMode.reduced = false;
  panel.built = true;
});

describe("PromotionScreen", () => {
  it("offers the name flow when a name is on offer, without claiming it", () => {
    const html = renderPromotion(vi.fn());
    expect(html).toContain("You&#x27;re a member");
    expect(html).toContain("Choose your name");
    expect(html).toContain("Not now");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Claiming");
  });

  it("offers only a way back when no name is on offer", () => {
    const html = renderPromotion(undefined);
    expect(html).toContain("Back to your card");
    expect(html).not.toContain("Choose your name");
  });

  it("keeps its card inert: the promotion flips a card of its own", () => {
    const html = renderStyle("current", vi.fn());
    expect(html).toContain("idcard");
    expect(html).not.toContain("is-interactive");
    expect(html).not.toContain('aria-label="Flip the card"');
  });

  it("uses no chain words and no rank names", () => {
    const text = renderPromotion(vi.fn()).replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/personhood|devicehood|\blite\b|score|unlocks/i);
  });

  it.each(PROMOTION_STYLES.map(({ id }) => id))("says the same words in the %s style", (style) => {
    const offered = renderStyle(style, vi.fn());
    expect(offered).toContain("You&#x27;re a member");
    expect(offered).toContain("Members can claim a username without the number.");
    expect(offered).toContain("Choose your name");
    expect(offered).toContain("Not now");

    const plain = renderStyle(style, undefined);
    expect(plain).toContain("Members get a daily chance to win a dollar.");
    expect(plain).toContain("Back to your card");
  });

  it("draws a card in the card styles, while the card-less one draws only its medallion", () => {
    for (const style of ["current", "fit", "sweep"] as const) {
      expect(renderStyle(style, vi.fn())).toContain('class="idcard');
    }
    const cardless = renderStyle("card-less", vi.fn());
    expect(cardless).not.toContain("idcard");
    expect(cardless).toContain("promotion-medal");
  });

  it("stages the default style in a build without the panel, whatever was picked", () => {
    panel.built = false;
    const picked = DEFAULT_PROMOTION_STYLE === "fit" ? "sweep" : "fit";
    const html = renderStyle(picked, vi.fn());
    expect(html).not.toContain(`is-${picked}`);
    expect(html).toContain(DEFAULT_PROMOTION_STYLE === "card-less" ? "is-cardless" : `is-${DEFAULT_PROMOTION_STYLE}`);
  });

  it("starts the card styles on the old card, so the turn has something to change", () => {
    for (const style of ["current", "fit", "sweep"] as const) {
      expect(renderStyle(style, vi.fn())).toContain('sr-only" data-testid="card-label">Candidate<');
    }
  });

  it("shows reduced motion the settled member card at once, with no turn to wait for", () => {
    motionMode.reduced = true;
    for (const style of ["current", "fit", "sweep"] as const) {
      const html = renderStyle(style, vi.fn());
      expect(html).toContain('sr-only" data-testid="card-label">Member<');
      expect(html).not.toContain('sr-only" data-testid="card-label">Candidate<');
    }
    expect(renderStyle("card-less", vi.fn())).toContain("promotion-medal");
  });
});
