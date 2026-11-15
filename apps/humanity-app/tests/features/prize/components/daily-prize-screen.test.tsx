// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The claim is already in flight when the screen opens; a failed one
 *  returns the dollar CTA without surfacing chain details. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DailyPrizeScreen } from "@features/prize/components/DailyPrizeScreen.tsx";

function renderWin(claim: { pending: boolean; unknown: boolean; claimed: boolean; failed: boolean }): string {
  return renderToStaticMarkup(
    createElement(DailyPrizeScreen, {
      ticket: {
        outcome: "win",
        amountLabel: "$1",
        dateLabel: "TODAY",
        oddsLabel: "Odds today: 1 in 1",
      },
      claim: { ...claim, onClaim: vi.fn() },
      onDone: vi.fn(),
      revealed: true,
    }),
  );
}

function renderFailedClaim(): string {
  return renderWin({ pending: false, unknown: false, claimed: false, failed: true });
}

function renderUnrevealedWin(): string {
  return renderToStaticMarkup(
    createElement(DailyPrizeScreen, {
      ticket: {
        outcome: "win",
        amountLabel: "$1",
        dateLabel: "TUESDAY 25 AUGUST",
        oddsLabel: "",
      },
      claim: {
        pending: false,
        unknown: false,
        claimed: false,
        failed: false,
        onClaim: vi.fn(),
      },
      onDone: vi.fn(),
    }),
  );
}

describe("DailyPrizeScreen reveal gate", () => {
  it("keeps the result and claim action unavailable until the foil is scratched", () => {
    const html = renderUnrevealedWin();

    expect(html).not.toContain("Your dollars");
    expect(html).not.toContain(">Nice<");
    expect(html).not.toContain(">Claim $1<");
    expect(html).toContain('class="sc-prize" aria-hidden="true"');
  });

  it("mounts the reveal flash and debris only while the foil can still be scratched", () => {
    // Without an engine nothing ever sets the flash opacity, so a settled
    // card must not render it at all.
    const unrevealed = renderUnrevealedWin();
    expect(unrevealed).toContain('class="sc-flash"');
    expect(unrevealed).toContain('class="sc-debris"');
    const settled = renderFailedClaim();
    expect(settled).not.toContain("sc-flash");
    expect(settled).not.toContain("sc-debris");
  });
});

describe("DailyPrizeScreen exits", () => {
  it("offers no way out before the reveal: the scratch cannot be abandoned", () => {
    const html = renderUnrevealedWin();

    expect(html).not.toContain("scratch-close");
    expect(html).not.toContain("Back to your card");
    expect(html).not.toContain("<button");
  });

  it("pairs a failed claim's retry with a way to leave", () => {
    const html = renderFailedClaim();

    expect(html).toContain(">Claim $1<");
    expect(html).toContain(">Not now<");
  });

  it("offers Not now only beside a retry", () => {
    const html = renderWin({ pending: false, unknown: false, claimed: true, failed: false });

    expect(html).toContain(">Nice<");
    expect(html).not.toContain(">Not now<");
  });
});

describe("DailyPrizeScreen claim CTA", () => {
  it("returns a failed claim to a clickable CTA without chain copy", () => {
    const html = renderFailedClaim();

    expect(html).toContain(">Claim $1<");
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("Claim submitted.");
    expect(html).not.toContain("Final confirmation is taking longer than expected.");
    expect(html).not.toContain("Try again shortly.");
  });

  it("never blocks on the claim: an in-flight, unknown or idle claim still lets the user leave", () => {
    for (const claim of [
      { pending: true, unknown: false, claimed: false, failed: false },
      { pending: false, unknown: true, claimed: false, failed: false },
      { pending: false, unknown: false, claimed: false, failed: false },
      { pending: false, unknown: false, claimed: true, failed: false },
    ]) {
      const html = renderWin(claim);
      expect(html).toContain(">Nice<");
      expect(html).not.toContain('disabled=""');
      expect(html).not.toContain("Claiming");
    }
  });
});
