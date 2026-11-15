// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
// This suite mounts a React hook and dispatches window events, so it needs a
// DOM; the project default is `environment: "node"` (see vite.config.ts). Do
// not remove.

/** The debug panel ships in production with no visible affordance, so the
 *  summon gestures are the only way in: they must stay exactly as specified.
 *  Five taps in the top third of the viewport inside 1.5s, or Cmd/Ctrl+D,
 *  toggle the panel; Escape closes it. A tap anywhere lower is a real tap by
 *  a real player and resets the buffer, so ordinary use never summons it. */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { renderHook } from "@testing-library/react";

import { useDebugSummon } from "@features/debug/use-debug-summon.ts";

const VIEWPORT_HEIGHT = 900;
/** Inside the top third (`900 / 3 = 300`). */
const TOP_Y = 100;
/** Below the top third: an ordinary tap. */
const BELOW_Y = 600;
const START_MS = 1_800_000_000_000;

interface MountedSummon {
  toggle: Mock<() => void>;
  close: Mock<() => void>;
  unmount: () => void;
}

function mount(): MountedSummon {
  const toggle = vi.fn<() => void>();
  const close = vi.fn<() => void>();
  const { unmount } = renderHook(() => useDebugSummon({ toggle, close }));
  return { toggle, close, unmount };
}

/** jsdom 26 has no `PointerEvent` constructor. A `MouseEvent` typed
 *  `pointerdown` carries `clientY` and dispatches through the same listener,
 *  which is all the gesture reads. */
function tapAt(clientY: number): void {
  window.dispatchEvent(
    new MouseEvent("pointerdown", { clientY, bubbles: true, cancelable: true }),
  );
}

function tapTop(times = 1): void {
  for (let index = 0; index < times; index += 1) {
    tapAt(TOP_Y);
    vi.advanceTimersByTime(50);
  }
}

function pressKey(
  key: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  Object.defineProperty(window, "innerHeight", {
    value: VIEWPORT_HEIGHT,
    configurable: true,
  });
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useDebugSummon", () => {
  it("leaves taps on the card out of the count, and ends the run", () => {
    const { toggle } = mount();
    const card = document.createElement("div");
    card.setAttribute("data-summon-ignore", "");
    document.body.append(card);

    tapTop(4);
    card.dispatchEvent(new MouseEvent("pointerdown", { clientY: TOP_Y, bubbles: true }));
    for (let index = 0; index < 5; index += 1) {
      card.dispatchEvent(new MouseEvent("pointerdown", { clientY: TOP_Y, bubbles: true }));
      vi.advanceTimersByTime(50);
    }
    expect(toggle).not.toHaveBeenCalled();

    tapTop(4);
    expect(toggle).not.toHaveBeenCalled();
    tapTop();
    expect(toggle).toHaveBeenCalledTimes(1);
    card.remove();
  });

  it("toggles on the fifth top-third tap inside the window, not before", () => {
    const { toggle, close } = mount();

    tapTop(4);
    expect(toggle).not.toHaveBeenCalled();

    tapTop();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("needs five fresh taps after a toggle, so a sixth tap does nothing", () => {
    const { toggle } = mount();

    tapTop(5);
    expect(toggle).toHaveBeenCalledTimes(1);

    tapTop();
    expect(toggle).toHaveBeenCalledTimes(1);

    tapTop(3);
    expect(toggle).toHaveBeenCalledTimes(1);

    tapTop();
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it("forgets taps older than the 1.5s window", () => {
    const { toggle } = mount();

    tapTop(4);
    vi.advanceTimersByTime(1_600);
    tapTop();

    expect(toggle).not.toHaveBeenCalled();
  });

  it("resets the buffer when a tap lands below the top third", () => {
    const { toggle } = mount();

    tapTop(3);
    tapAt(BELOW_Y);
    tapTop(2);

    expect(toggle).not.toHaveBeenCalled();
  });

  it("toggles on Cmd+D and Ctrl+D, swallowing the browser default", () => {
    const { toggle, close } = mount();

    const meta = pressKey("d", { metaKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(meta.defaultPrevented).toBe(true);

    const ctrl = pressKey("d", { ctrlKey: true });
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(ctrl.defaultPrevented).toBe(true);

    const plain = pressKey("d");
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(plain.defaultPrevented).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it("closes on Escape without toggling", () => {
    const { toggle, close } = mount();

    pressKey("Escape");

    expect(close).toHaveBeenCalledTimes(1);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", () => {
    const { toggle, close, unmount } = mount();

    unmount();
    tapTop(5);
    pressKey("d", { metaKey: true });
    pressKey("Escape");

    expect(toggle).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
