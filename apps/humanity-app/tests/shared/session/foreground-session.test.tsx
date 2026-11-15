// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  freshness,
  resetForegroundSessionForTests,
  useForegroundSession,
} from "@shared/session/foreground-session.ts";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function pageShow(persisted: boolean) {
  act(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted }));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  resetForegroundSessionForTests();
});

afterEach(() => {
  cleanup();
  setVisibility("visible");
  vi.useRealTimers();
});

describe("useForegroundSession", () => {
  it("begins with the load and again on each return into view, not on the hiding", () => {
    const { result } = renderHook(() => useForegroundSession());
    expect(result.current).toEqual({ id: 1, startedAt: 1_000_000 });

    vi.setSystemTime(1_005_000);
    setVisibility("hidden");
    expect(result.current.id).toBe(1);

    vi.setSystemTime(1_010_000);
    setVisibility("visible");
    expect(result.current).toEqual({ id: 2, startedAt: 1_010_000 });
  });

  it("begins on a restore from the back-forward cache, not on the first load's pageshow", () => {
    const { result } = renderHook(() => useForegroundSession());

    pageShow(false);
    expect(result.current.id).toBe(1);

    vi.setSystemTime(1_020_000);
    pageShow(true);
    expect(result.current).toEqual({ id: 2, startedAt: 1_020_000 });
  });
});

describe("freshness", () => {
  const session = { id: 3, startedAt: 2_000 };

  it("is fresh once data landed since the session began", () => {
    expect(freshness({ dataUpdatedAt: 2_000, errorUpdatedAt: 0 }, session)).toBe("fresh");
    expect(freshness({ dataUpdatedAt: 2_500, errorUpdatedAt: 2_600 }, session)).toBe("fresh");
  });

  it("is failed when only an error landed since", () => {
    expect(freshness({ dataUpdatedAt: 1_000, errorUpdatedAt: 2_100 }, session)).toBe("failed");
  });

  it("is checking while data and error both predate the session", () => {
    expect(freshness({ dataUpdatedAt: 1_999, errorUpdatedAt: 1_500 }, session)).toBe("checking");
    expect(freshness({ dataUpdatedAt: 0, errorUpdatedAt: 0 }, session)).toBe("checking");
  });
});
