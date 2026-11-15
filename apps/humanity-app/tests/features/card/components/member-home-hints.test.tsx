// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The tips on the real home, in a DOM where effects run: a newcomer gets
 *  the card tip once the entrance has settled, a member never gets one,
 *  and turning the card over puts the card tip away. Motion is reduced, so
 *  the entrance settles at once. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemberHomeScreen } from "@features/card/components/MemberHomeScreen.tsx";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import { useDebugStore } from "@features/debug/debug-store.ts";
import {
  resetOnboardingHintsStoreForTests,
  startNewVisitForTests,
} from "@features/card/storage/onboarding-hints-store.ts";

vi.mock("@features/card/hooks/use-register-for-game.ts", () => ({
  useRegisterForGame: () => ({ register: () => undefined, registering: false, registeringLabel: null, error: null }),
}));
vi.mock("qrcode", () => ({ toDataURL: () => Promise.resolve("data:image/png;base64,QR") }));

beforeEach(() => {
  resetOnboardingHintsStoreForTests();
  startNewVisitForTests();
  window.localStorage.clear();
  // The card is drawn only when the debug panel shows it; these tips point at it.
  useDebugStore.setState({ cardHidden: false });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function home(state: HumanityCardState) {
  return render(
    <MemberHomeScreen
      state={state}
      accountAddress="5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
      game={null}
      gamePending={false}
      gameUnavailable={false}
      onOpenPrize={() => undefined}
      dailyPrizeAvailable={false}
      qrPayload="5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
      hints={{ enabled: true }}
    />,
  );
}

describe("MemberHomeScreen tips", () => {
  it("shows a newcomer the card tip, describing the glyph", () => {
    const view = home({ kind: "devicehood" });
    const tip = view.getByRole("tooltip");
    expect(tip.textContent).toContain("This is your card");
    expect(view.getByRole("button", { name: "Flip the card" }).getAttribute("aria-describedby")).toBe(tip.id);
  });

  it("shows no card tip while the card is hidden: there is nothing to point at", () => {
    useDebugStore.setState({ cardHidden: true });
    const view = home({ kind: "devicehood" });
    expect(view.queryByRole("button", { name: "Flip the card" })).toBeNull();
    expect(view.queryByText("This is your card")).toBeNull();
  });

  it("never shows a member a tip", () => {
    const view = home({ kind: "member", activeWeeks: 4, lastAttendedGame: 42, attendanceHistory: 0xff, window: 8 });
    expect(view.queryByRole("tooltip")).toBeNull();
  });

  it("puts the card tip away when the card turns over", async () => {
    const view = home({ kind: "devicehood" });
    expect(view.queryByRole("tooltip")).not.toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Flip the card" }));
    });
    expect(view.queryByRole("tooltip")).toBeNull();
    // Hidden while the back shows is not enough: turned home, it stays away.
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Turn the card back" }));
    });
    expect(view.queryByText("This is your card")).toBeNull();
  });
});
