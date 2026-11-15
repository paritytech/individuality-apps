// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The spinner shows only once a wait has outlasted its delay. */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoadSpinner } from "@shared/components/LoadSpinner.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LoadSpinner", () => {
  it("draws nothing until the delay has passed, then the spinner", () => {
    vi.useFakeTimers();
    const view = render(<LoadSpinner afterMs={2_500} />);
    expect(view.container.querySelector(".load-spinner")).toBeNull();

    act(() => vi.advanceTimersByTime(2_499));
    expect(view.container.querySelector(".load-spinner")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(view.container.querySelector(".load-spinner")).not.toBeNull();
  });

  it("never shows for a wait that ends first", () => {
    vi.useFakeTimers();
    const view = render(<LoadSpinner afterMs={2_500} />);
    act(() => vi.advanceTimersByTime(1_000));
    view.unmount();
    act(() => vi.advanceTimersByTime(5_000));
    expect(document.querySelector(".load-spinner")).toBeNull();
  });
});
