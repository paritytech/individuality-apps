// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The tips across visits: the first visit runs them one after another and
 *  waits for a late target, a reload counts what was up as seen, a later
 *  visit gets one tip after the gap, a tip whose target leaves retires, and
 *  StrictMode's rehearsal unmount retires nothing. */
import { StrictMode, createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HINT_GAP_MS, NO_TARGETS, type HintTargets } from "@features/card/domain/onboarding-hints.ts";
import { useOnboardingHint } from "@features/card/hooks/use-onboarding-hint.ts";
import {
  readOnboardingHints,
  resetOnboardingHintsStoreForTests,
  startNewVisitForTests,
} from "@features/card/storage/onboarding-hints-store.ts";

const START = 1_800_000_000_000;
const everything: HintTargets = { card: true, register: true, stripe: true };

beforeEach(() => {
  resetOnboardingHintsStoreForTests();
  startNewVisitForTests();
  window.localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

const mount = (targets: HintTargets) =>
  renderHook((props: { targets: HintTargets }) => useOnboardingHint(props.targets, { enabled: true }), {
    initialProps: { targets },
  });

describe("useOnboardingHint, the first visit", () => {
  it("runs the tips one after another and retires each", () => {
    const view = mount(everything);
    expect(view.result.current.active).toBe("card");
    act(() => view.result.current.retire());
    expect(view.result.current.active).toBe("stripe");
    act(() => view.result.current.retire());
    expect(view.result.current.active).toBe("register");
    act(() => view.result.current.retire());
    expect(view.result.current.active).toBeNull();
    expect(Object.keys(readOnboardingHints().retired).sort()).toEqual(["card", "register", "stripe"]);
  });

  it("gives the register tip its turn once the game read lands", () => {
    const view = mount({ ...NO_TARGETS, card: true });
    act(() => view.result.current.retire());
    expect(view.result.current.active).toBeNull();
    view.rerender({ targets: { ...NO_TARGETS, card: true, register: true } });
    expect(view.result.current.active).toBe("register");
  });

  it("retires a tip whose target leaves the screen, and moves on", () => {
    const view = mount({ ...NO_TARGETS, register: true, stripe: true });
    expect(view.result.current.active).toBe("stripe");
    act(() => view.result.current.retire());
    expect(view.result.current.active).toBe("register");
    // The person registered in the game: the button is "Registered" now.
    view.rerender({ targets: { ...NO_TARGETS, stripe: true } });
    expect(view.result.current.active).toBeNull();
    expect(readOnboardingHints().retired.register).toBe(START);
  });

  it("retires the register tip when the person registers while another tip is up", () => {
    const view = mount(everything);
    expect(view.result.current.active).toBe("card");
    act(() => view.result.current.retireId("register"));
    expect(view.result.current.active).toBe("card");
    act(() => view.result.current.retire());
    expect(view.result.current.active).toBe("stripe");
    act(() => view.result.current.retire());
    expect(view.result.current.active).toBeNull();
  });
});

describe("useOnboardingHint, later visits", () => {
  it("counts a tip left up when the app closed as seen, and waits out the gap", () => {
    const first = mount(everything);
    expect(first.result.current.active).toBe("card");
    // The webview closes: nothing unmounts, nothing runs.
    startNewVisitForTests();

    vi.setSystemTime(START + 60_000);
    const soon = mount(everything);
    expect(soon.result.current.active).toBeNull();
    expect(readOnboardingHints().retired.card).toBe(START);

    startNewVisitForTests();
    vi.setSystemTime(START + HINT_GAP_MS);
    const later = mount(everything);
    expect(later.result.current.active).toBe("stripe");
    act(() => later.result.current.retire());
    expect(later.result.current.active).toBeNull();
  });
});

describe("useOnboardingHint under StrictMode", () => {
  it("keeps the first tip up through the rehearsal unmount", () => {
    const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);
    const view = renderHook(() => useOnboardingHint(everything, { enabled: true }), { wrapper });
    expect(view.result.current.active).toBe("card");
    expect(readOnboardingHints().retired).toEqual({});
  });
});

describe("useOnboardingHint off and in fixtures", () => {
  it("shows nothing while disabled, and remembers nothing for a fixture", () => {
    const off = renderHook(() => useOnboardingHint(everything, { enabled: false }));
    expect(off.result.current.active).toBeNull();
    const fixture = renderHook(() =>
      useOnboardingHint(everything, { enabled: true, persist: false, only: "register" }),
    );
    expect(fixture.result.current.active).toBe("register");
    expect(readOnboardingHints().lastShown).toBeNull();
  });
});
