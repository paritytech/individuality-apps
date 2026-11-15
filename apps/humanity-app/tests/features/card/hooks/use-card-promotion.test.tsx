// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The promotion is known in the very render that first sees the member
 *  card, so nothing gated on it (the name screen's auto-open) can act in
 *  between; and it latches once, until dismissed. */
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useCardPromotion, type CardPromotionResult } from "@features/card/hooks/use-card-promotion.ts";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";

const candidate: HumanityCardState = { kind: "candidate", score: 5, personhoodThreshold: 6, gamesRemaining: 1 };
const member: HumanityCardState = { kind: "member", activeWeeks: 6, lastAttendedGame: 42, attendanceHistory: 0xff, window: 8 };

const renders: { kind: string; promoted: boolean }[] = [];
let latest: CardPromotionResult | null = null;
function Probe({ state }: { state: HumanityCardState | undefined }) {
  latest = useCardPromotion(state);
  renders.push({ kind: state?.kind ?? "none", promoted: latest.promotion != null });
  return null;
}

describe("useCardPromotion", () => {
  it("knows about the promotion in the first render that sees the member card", () => {
    renders.length = 0;
    const view = render(<Probe state={candidate} />);
    view.rerender(<Probe state={member} />);
    const firstMemberRender = renders.find((entry) => entry.kind === "member");
    expect(firstMemberRender?.promoted).toBe(true);
  });

  it("latches once and stays away after it is dismissed", () => {
    const view = render(<Probe state={candidate} />);
    view.rerender(<Probe state={member} />);
    expect(latest?.promotion).toMatchObject({ from: candidate, to: member });
    act(() => latest!.dismiss());
    expect(latest?.promotion).toBeNull();
    view.rerender(<Probe state={{ ...member }} />);
    expect(latest?.promotion).toBeNull();
  });

  it("ignores a card that is still loading", () => {
    const view = render(<Probe state={candidate} />);
    view.rerender(<Probe state={undefined} />);
    view.rerender(<Probe state={member} />);
    expect(latest?.promotion).toMatchObject({ from: candidate, to: member });
  });
});
