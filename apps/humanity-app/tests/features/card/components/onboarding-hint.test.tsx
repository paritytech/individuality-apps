// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The tip lands centred on its target, inside the column, below unless
 *  there is no room; it describes its target while up; tapping it, its
 *  cross, or Escape puts it away, but not a tap in its first moments. */
import { useRef } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OnboardingHint, placeHint } from "@features/card/components/OnboardingHint.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const column = { left: 0, top: 0, width: 390, height: 844 };

describe("placeHint", () => {
  it("sits below the target, centred on it, with the arrow on its centre line", () => {
    const placement = placeHint({ left: 95, top: 300, width: 200, height: 54 }, column, { width: 180, height: 44 });
    expect(placement.side).toBe("below");
    expect(placement.top).toBe(364);
    expect(placement.left).toBe(105);
    expect(placement.arrow).toBe(90);
  });

  it("keeps inside the column edges and moves the arrow to the target instead", () => {
    const placement = placeHint({ left: 340, top: 20, width: 32, height: 32 }, column, { width: 200, height: 44 });
    expect(placement.left).toBe(178);
    expect(placement.arrow).toBe(178);
  });

  it("sits above when asked to and there is room, and below when there is not", () => {
    const above = placeHint({ left: 16, top: 200, width: 358, height: 7 }, column, { width: 280, height: 70 }, "above");
    expect(above.side).toBe("above");
    expect(above.top).toBe(120);
    const cramped = placeHint({ left: 16, top: 30, width: 358, height: 7 }, column, { width: 280, height: 70 }, "above");
    expect(cramped.side).toBe("below");
  });

  it("goes above a target near the bottom", () => {
    const placement = placeHint({ left: 16, top: 790, width: 358, height: 54 }, column, { width: 180, height: 44 });
    expect(placement.side).toBe("above");
    expect(placement.top).toBe(736);
  });
});

function Column({ onDismiss }: { onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" data-hint="register">
        Register
      </button>
      <OnboardingHint
        id="register"
        title="This opens the weekly game"
        body="Register there and play at game time."
        columnRef={ref}
        onDismiss={onDismiss}
      />
    </div>
  );
}

describe("OnboardingHint", () => {
  it("shows a title and a line, and goes away on tap, cross, or Escape", () => {
    const onDismiss = vi.fn();
    const view = render(<Column onDismiss={onDismiss} />);
    expect(view.getByRole("tooltip").id).toBe("onboarding-hint");
    expect(view.getByText("This opens the weekly game")).toBeTruthy();
    vi.advanceTimersByTime(500);
    fireEvent.click(view.getByText("Register there and play at game time."));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByLabelText("Dismiss this tip"));
    expect(onDismiss).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(3);
  });
});

describe("OnboardingHint, for screen readers and quick taps", () => {
  it("describes its target while up and puts the target back as it was", () => {
    const view = render(<Column onDismiss={vi.fn()} />);
    const target = view.getByRole("button", { name: "Register" });
    expect(target.getAttribute("aria-describedby")).toBe("onboarding-hint");
    expect(view.getByRole("tooltip").getAttribute("aria-live")).toBe("polite");
    view.unmount();
    expect(target.hasAttribute("aria-describedby")).toBe(false);
  });

  it("ignores a tap in its first moments, meant for the tip before it", () => {
    const onDismiss = vi.fn();
    const view = render(<Column onDismiss={onDismiss} />);
    fireEvent.click(view.getByRole("tooltip"));
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    fireEvent.click(view.getByRole("tooltip"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
