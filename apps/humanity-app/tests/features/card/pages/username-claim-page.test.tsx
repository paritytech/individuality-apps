// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment jsdom

/** The live name page over mocked reads: success outlives the card read
 *  catching up (the claim turns the target into "already claimed" and the
 *  form's action goes away), a claim that never landed is named and offered
 *  again, a wallet switch starts from that wallet's own default, availability
 *  is asked for the wallet's own lite identity, and leaving the page by any
 *  road is a "not now" for the visit. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UsernameUpgradeAction } from "@features/card/components/UsernameUpgradeBlock.tsx";
import { useDebugStore } from "@features/debug/debug-store.ts";

const mocks = vi.hoisted(() => ({
  card: undefined as unknown,
  upgrade: undefined as unknown,
  dismiss: vi.fn(),
  navigate: vi.fn(),
  availability: vi.fn((name: string) => ({ status: "available", name })),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => ({}),
}));
vi.mock("@features/card/hooks/use-humanity-card.ts", () => ({
  useHumanityCard: () => ({ data: mocks.card, isPending: false, error: null }),
}));
vi.mock("@features/card/hooks/use-username-upgrade-action.ts", () => ({
  useUsernameUpgradeAction: () => mocks.upgrade,
}));
vi.mock("@features/card/hooks/use-username-availability.ts", async (original) => ({
  ...(await original<typeof import("@features/card/hooks/use-username-availability.ts")>()),
  useUsernameAvailability: mocks.availability,
}));
vi.mock("@features/card/hooks/use-full-personhood.ts", () => ({
  useFullPersonhood: () => ({ data: false, isPending: false, error: null }),
}));
vi.mock("@shared/navigation/humanity-action-session.tsx", () => ({
  useHumanityActionSession: () => ({ dismiss: mocks.dismiss, dismissed: [], refreshing: false }),
}));

import { UsernameClaimPage } from "@features/card/pages/UsernameClaimPage.tsx";

const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const member = { kind: "member", activeWeeks: 3, lastAttendedGame: 42, attendanceHistory: 0xff, window: 8 } as const;

function cardNamed(primaryUsername: string) {
  return {
    kind: "card",
    accountAddress: ACCOUNT,
    primaryUsername,
    state: member,
    snapshot: { isUpgradedIdentity: false, participant: { recognition: "NotRecognized" } },
  };
}

function offer(overrides: Partial<UsernameUpgradeAction> = {}) {
  return {
    target: {
      kind: "available",
      accountAddress: ACCOUNT,
      currentLiteUsername: "marlow.42",
      suggestedUsername: "marlow",
    },
    action: {
      identityKey: ACCOUNT,
      suggestedUsername: "marlow",
      pending: false,
      unknown: false,
      confirmed: false,
      onSubmit: vi.fn(),
      ...overrides,
    },
  };
}

beforeEach(() => {
  // The card previews the name only when the debug panel shows it; the
  // store's default is hidden.
  useDebugStore.setState({ cardHidden: false });
  mocks.dismiss.mockClear();
  mocks.availability.mockClear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("UsernameClaimPage", () => {
  it("keeps saying the name is claimed once the card read catches up, and on a later visit", () => {
    mocks.card = cardNamed("marlow.42");
    mocks.upgrade = offer({ confirmed: true });
    const view = render(<UsernameClaimPage />);
    expect(screen.getByRole("heading", { name: "Your name is marlow" })).toBeTruthy();

    // The card now carries the bare name: the target is claimed, and the
    // form's action has gone away.
    mocks.card = cardNamed("marlow");
    mocks.upgrade = { target: { kind: "already-claimed" }, action: undefined };
    view.rerender(<UsernameClaimPage />);
    expect(screen.getByRole("heading", { name: "Your name is marlow" })).toBeTruthy();
    expect(screen.queryByText("Choose your name")).toBeNull();
    expect(screen.queryByText(/no numbers to drop/)).toBeNull();
    expect(screen.getByRole("button", { name: "Back to your card" })).toBeTruthy();
  });

  it("starts from the new wallet's own default after a switch", () => {
    mocks.card = cardNamed("marlow.42");
    mocks.upgrade = offer();
    const view = render(<UsernameClaimPage />);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "mychoice" } });
    expect(screen.getByRole("button", { name: "Claim mychoice" })).toBeTruthy();

    const other = offer();
    other.action.identityKey = "5Other";
    other.action.suggestedUsername = "someone";
    mocks.upgrade = other;
    view.rerender(<UsernameClaimPage />);
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("someone");
    expect(screen.getByRole("button", { name: "Claim someone" })).toBeTruthy();
  });

  it("offers a claim that never landed again, named and prefilled", () => {
    mocks.card = cardNamed("marlow.42");
    mocks.upgrade = offer({ failedUsername: "marlowjones", suggestedUsername: "marlowjones" });
    const view = render(<UsernameClaimPage />);
    expect(screen.getByText("Your last claim for marlowjones didn't go through. Try again.")).toBeTruthy();
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("marlowjones");
    expect(view.container.querySelector(".idcard-name")?.textContent).toBe("marlowjones");
    expect(screen.getByRole("button", { name: "Claim marlowjones" })).toBeTruthy();
  });

  it("keeps previewing the sent name once sending clears the failed suggestion", () => {
    vi.useFakeTimers();
    mocks.card = cardNamed("marlow.42");
    mocks.upgrade = offer({ failedUsername: "marlowjones", suggestedUsername: "marlowjones" });
    const view = render(<UsernameClaimPage />);
    fireEvent.click(screen.getByRole("button", { name: "Claim marlowjones" }));
    act(() => vi.advanceTimersByTime(600));
    fireEvent.click(screen.getByRole("button", { name: "Confirm marlowjones" }));

    mocks.upgrade = offer({ pending: true });
    view.rerender(<UsernameClaimPage />);
    expect(view.container.querySelector(".idcard-name")?.textContent).toBe("marlowjones");
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("marlowjones");
  });

  it("asks availability on behalf of the wallet's lite identity", () => {
    mocks.card = cardNamed("marlow.42");
    mocks.upgrade = offer();
    render(<UsernameClaimPage />);
    expect(mocks.availability).toHaveBeenLastCalledWith("marlow", true, ACCOUNT);
  });

  it("counts leaving by any road as not now for this visit", () => {
    mocks.card = cardNamed("marlow.42");
    mocks.upgrade = offer();
    const view = render(<UsernameClaimPage />);
    view.unmount();
    expect(mocks.dismiss).toHaveBeenCalledWith("claim-username");
  });
});
