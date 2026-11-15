// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment jsdom

/** The name screen with its page's state played by a small harness: the
 *  card previews the name in the field, claiming takes a deliberate second
 *  tap that anything making the name unavailable disarms, a failed check
 *  offers to try again, a claim that never landed is named and offered
 *  again, success names what was claimed and takes focus, and the screen
 *  without a claim on offer only says why. */
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsernameClaimScreen } from "@features/card/components/UsernameClaimScreen.tsx";
import type { UsernameUpgradeAction } from "@features/card/components/UsernameUpgradeBlock.tsx";
import type { UsernameAvailability } from "@features/card/hooks/use-username-availability.ts";
import { useDebugStore } from "@features/debug/debug-store.ts";

beforeEach(() => {
  // The card is drawn only when the debug panel shows it.
  useDebugStore.setState({ cardHidden: false });
  vi.useFakeTimers();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function action(overrides: Partial<UsernameUpgradeAction> = {}): UsernameUpgradeAction {
  return {
    identityKey: "wallet-one",
    currentUsername: "humanity.42",
    suggestedUsername: "humanity",
    pending: false,
    unknown: false,
    confirmed: false,
    onSubmit: vi.fn(),
    ...overrides,
  };
}

const card = {
  state: { kind: "member", activeWeeks: 1, lastAttendedGame: 4, attendanceHistory: 1, window: 8 } as const,
  accountAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  displayName: "humanity.42",
};

/** The page's part: it holds the typed name and answers for it. */
function Harness({
  claim,
  answer = (name) => ({ status: "available", name }),
}: {
  claim: UsernameUpgradeAction;
  answer?: (name: string) => UsernameAvailability;
}) {
  const [name, setName] = useState(claim.suggestedUsername ?? "");
  return (
    <UsernameClaimScreen
      card={card}
      name={name}
      action={claim}
      availability={answer(name)}
      onNameChange={setName}
      onBack={vi.fn()}
    />
  );
}

const pause = () => act(() => vi.advanceTimersByTime(600));

describe("the name screen", () => {
  it("previews the name in the field and claims it on a deliberate second tap", () => {
    const claim = action();
    const view = render(<Harness claim={claim} />);
    const input = screen.getByLabelText("Your name") as HTMLInputElement;
    expect(input.value).toBe("humanity");
    expect(screen.getByText("It replaces humanity.42 on your card.")).toBeTruthy();
    expect(view.container.querySelector(".idcard-name")?.textContent).toBe("humanity");

    fireEvent.click(screen.getByRole("button", { name: "Claim humanity" }));
    expect(claim.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Tap again to confirm.")).toBeTruthy();
    // A held key or a double tap is not a second decision.
    fireEvent.click(screen.getByRole("button", { name: "Confirm humanity" }));
    expect(claim.onSubmit).not.toHaveBeenCalled();
    pause();
    fireEvent.click(screen.getByRole("button", { name: "Confirm humanity" }));
    expect(claim.onSubmit).toHaveBeenLastCalledWith("humanity");

    fireEvent.change(input, { target: { value: "anothername" } });
    expect(view.container.querySelector(".idcard-name")?.textContent).toBe("anothername");
    fireEvent.click(screen.getByRole("button", { name: "Claim anothername" }));
    pause();
    fireEvent.click(screen.getByRole("button", { name: "Confirm anothername" }));
    expect(claim.onSubmit).toHaveBeenLastCalledWith("anothername");
  });

  it("disarms once the armed name is taken, and does not re-arm when it frees up", () => {
    const claim = action();
    let taken = false;
    const answer = (name: string): UsernameAvailability => (taken ? { status: "taken", name } : { status: "available", name });
    const view = render(<Harness claim={claim} answer={answer} />);
    fireEvent.click(screen.getByRole("button", { name: "Claim humanity" }));
    expect(screen.getByRole("button", { name: "Confirm humanity" })).toBeTruthy();
    taken = true;
    view.rerender(<Harness claim={claim} answer={answer} />);
    expect(screen.queryByRole("button", { name: "Confirm humanity" })).toBeNull();
    taken = false;
    view.rerender(<Harness claim={claim} answer={answer} />);
    pause();
    fireEvent.click(screen.getByRole("button", { name: "Claim humanity" }));
    expect(claim.onSubmit).not.toHaveBeenCalled();
  });

  it("ignores a held Enter, so only a fresh press can confirm", () => {
    render(<Harness claim={action()} />);
    const input = screen.getByLabelText("Your name");
    const held = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    input.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    const fresh = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(fresh);
    expect(fresh.defaultPrevented).toBe(false);
  });

  it("offers to check again when a check fails", () => {
    const retry = vi.fn();
    render(<Harness claim={action()} answer={(name) => ({ status: "error", name, retry })} />);
    expect(screen.getByText("Couldn't check availability.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Claim humanity" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names what was claimed, wears it on the card, and takes focus", () => {
    const view = render(
      <UsernameClaimScreen card={card} name="humanity" claimedName="humanity" justClaimed onBack={vi.fn()} />,
    );
    const heading = screen.getByRole("heading", { name: "Your name is humanity" });
    expect(document.activeElement).toBe(heading);
    expect(view.container.querySelector(".idcard-name")?.textContent).toBe("humanity");
    expect(screen.getByRole("button", { name: "Back to your card" })).toBeTruthy();
    expect(screen.queryByLabelText("Your name")).toBeNull();
  });

  it("celebrates a fresh claim with motion enabled without crashing", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    expect(() =>
      render(
        <UsernameClaimScreen card={card} name="humanity" claimedName="humanity" justClaimed onBack={vi.fn()} />,
      ),
    ).not.toThrow();
    expect(screen.getByRole("heading", { name: "Your name is humanity" })).toBeTruthy();
  });

  it("draws no card while the debug panel hides it, and keeps the rest of the screen", () => {
    useDebugStore.setState({ cardHidden: true });
    const view = render(<UsernameClaimScreen card={card} action={action()} name="humanity" onBack={vi.fn()} />);
    expect(view.container.querySelector(".idcard")).toBeNull();
    expect(screen.getByRole("heading", { name: "Choose your name" })).toBeTruthy();
    expect(screen.getByLabelText("Your name")).toBeTruthy();
    act(() => useDebugStore.setState({ cardHidden: false }));
    expect(view.container.querySelector(".idcard-name")?.textContent).toBe("humanity");
  });

  it("celebrates a fresh claim with the card hidden without crashing", () => {
    useDebugStore.setState({ cardHidden: true });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const view = render(
      <UsernameClaimScreen card={card} name="humanity" claimedName="humanity" justClaimed onBack={vi.fn()} />,
    );
    expect(view.container.querySelector(".idcard")).toBeNull();
    expect(screen.getByRole("heading", { name: "Your name is humanity" })).toBeTruthy();
  });

  it("says a claim still waiting to be confirmed can be left", () => {
    render(<UsernameClaimScreen card={card} action={action({ unknown: true })} name="humanity" onBack={vi.fn()} />);
    expect(screen.getByText(/You can leave this screen/)).toBeTruthy();
  });

  it("explains itself when there is no form to show, without a line about replacing", () => {
    render(<UsernameClaimScreen card={card} message="Membership comes first." onBack={vi.fn()} />);
    expect(screen.getByText("Membership comes first.")).toBeTruthy();
    expect(screen.queryByText(/It replaces/)).toBeNull();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  });

  it("names a claim that never landed above the form and offers it again", () => {
    const view = render(<Harness claim={action({ failedUsername: "marlowjones", suggestedUsername: "marlowjones" })} />);
    const notice = screen.getByText("Your last claim for marlowjones didn't go through. Try again.");
    expect(notice.getAttribute("aria-live")).toBe("polite");
    const form = view.container.querySelector("form");
    expect(form != null && notice.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("marlowjones");
    expect(screen.getByRole("button", { name: "Claim marlowjones" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Choose your name" })).toBeTruthy();
  });

  it.each([
    ["claimed", { claimedName: "marlowjones" }, {}],
    ["claiming", {}, { pending: true }],
    ["waiting", {}, { unknown: true }],
  ] as const)("says nothing about a failed claim once %s", (_state, props, overrides) => {
    render(
      <UsernameClaimScreen
        card={card}
        action={action({ failedUsername: "marlowjones", ...overrides })}
        name="marlowjones"
        onBack={vi.fn()}
        {...props}
      />,
    );
    expect(screen.queryByText(/didn't go through/)).toBeNull();
  });

  it("lets an untouched field take a suggestion that arrives late, but never over typing", () => {
    const screenWith = (claim: UsernameUpgradeAction, name: string) => (
      <UsernameClaimScreen card={card} action={claim} name={name} onBack={vi.fn()} />
    );
    const view = render(screenWith(action({ unknown: true }), "humanity"));
    view.rerender(screenWith(action({ failedUsername: "marlowjones", suggestedUsername: "marlowjones" }), "marlowjones"));
    const input = screen.getByLabelText("Your name") as HTMLInputElement;
    expect(input.value).toBe("marlowjones");

    fireEvent.change(input, { target: { value: "mychoice" } });
    view.rerender(screenWith(action(), "mychoice"));
    expect(input.value).toBe("mychoice");
  });

  it("keeps the sent name in the field once sending clears the failed suggestion", () => {
    const claim = action({ failedUsername: "marlowjones", suggestedUsername: "marlowjones" });
    const view = render(<UsernameClaimScreen card={card} action={claim} name="marlowjones" onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Claim marlowjones" }));
    pause();
    fireEvent.click(screen.getByRole("button", { name: "Confirm marlowjones" }));
    expect(claim.onSubmit).toHaveBeenLastCalledWith("marlowjones");

    view.rerender(<UsernameClaimScreen card={card} action={action({ pending: true })} name="marlowjones" onBack={vi.fn()} />);
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("marlowjones");
  });
});
