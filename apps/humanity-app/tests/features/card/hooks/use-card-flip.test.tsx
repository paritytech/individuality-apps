// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The flip hook against a DOM. Under reduced motion every settle is
 *  instant: the glyph and the back turn the card, a drag commits or settles
 *  home, a vertical drag is the page's, and nothing happens on an inert
 *  card. Under full motion the animation frames are driven by hand, so the cases that
 *  only exist mid-turn are visible: a tap never freezes the card, a press
 *  mid-turn is ignored, the code survives a quick turn back, and `onFlip`
 *  counts faces landed on, not turns started. */
import { useRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Motion reads the frame clock when it loads, so the fake one goes in first.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});

import { useCardFlip } from "@features/card/hooks/use-card-flip.ts";

const toDataURL = vi.fn((payload: string) => Promise.resolve(`data:image/png;base64,${payload}`));
vi.mock("qrcode", () => ({ toDataURL: (payload: string) => toDataURL(payload) }));

const onFlip = vi.fn();

function Card({ enabled = true, payload = "5Alice" as string | null }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { flipped, qrMask, flip, rootProps } = useCardFlip(rootRef, bodyRef, {
    enabled,
    payload,
    onFlip,
  });
  return (
    <div data-testid="root" ref={rootRef} data-flipped={flipped} data-mask={qrMask ?? ""} {...rootProps}>
      <div data-testid="body" ref={bodyRef}>
        <button type="button" data-testid="glyph" onClick={flip}>
          flip
        </button>
        <button type="button" data-testid="back" onClick={flip}>
          turn back
        </button>
      </div>
    </div>
  );
}

function mount(props: { enabled?: boolean; payload?: string | null } = {}) {
  const view = render(<Card {...props} />);
  const root = view.getByTestId("root");
  root.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 330, height: 200, right: 330, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
  return { view, root, glyph: view.getByTestId("glyph"), back: view.getByTestId("back") };
}

const pointer = (type: string, x: number, y: number, timeStamp: number) => {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 });
  Object.assign(event, { pointerId: 1, pointerType: "touch" });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  return event;
};

function motion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}

beforeEach(() => {
  onFlip.mockClear();
  toDataURL.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useCardFlip under reduced motion", () => {
  beforeEach(() => motion(true));

  it("turns the card over from the glyph and back from the back, building the code once", async () => {
    const { root, glyph, back } = mount();
    expect(root.dataset["flipped"]).toBe("false");
    await act(async () => {
      fireEvent.click(glyph);
    });
    expect(root.dataset["flipped"]).toBe("true");
    expect(onFlip).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(toDataURL).toHaveBeenCalledTimes(1);
    expect(root.dataset["mask"]).toBe("data:image/png;base64,5Alice");

    await act(async () => {
      fireEvent.click(back);
    });
    expect(root.dataset["flipped"]).toBe("false");
    expect(onFlip).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(glyph);
    });
    expect(toDataURL).toHaveBeenCalledTimes(1);
  });

  it("commits a slow sideways drag past the commit angle", async () => {
    const { root } = mount();
    await act(async () => {
      root.dispatchEvent(pointer("pointerdown", 100, 50, 0));
      root.dispatchEvent(pointer("pointermove", 110, 51, 100));
      root.dispatchEvent(pointer("pointermove", 200, 52, 700));
      root.dispatchEvent(pointer("pointermove", 202, 52, 900));
      root.dispatchEvent(pointer("pointerup", 202, 52, 910));
    });
    expect(root.dataset["flipped"]).toBe("true");
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("settles a short drag home without counting a turn", async () => {
    const { root } = mount();
    await act(async () => {
      root.dispatchEvent(pointer("pointerdown", 100, 50, 0));
      root.dispatchEvent(pointer("pointermove", 112, 50, 20));
      root.dispatchEvent(pointer("pointermove", 120, 50, 300));
      root.dispatchEvent(pointer("pointerup", 120, 50, 800));
    });
    expect(root.dataset["flipped"]).toBe("false");
    expect(onFlip).not.toHaveBeenCalled();
  });

  it("hands a vertical drag to the page", async () => {
    const { root } = mount();
    await act(async () => {
      root.dispatchEvent(pointer("pointerdown", 100, 50, 0));
      root.dispatchEvent(pointer("pointermove", 103, 90, 20));
      root.dispatchEvent(pointer("pointermove", 200, 150, 40));
      root.dispatchEvent(pointer("pointerup", 200, 150, 50));
    });
    expect(root.dataset["flipped"]).toBe("false");
    expect(root.dataset["dragging"]).toBeUndefined();
  });

  it("leaves a tap to the buttons", async () => {
    const { root } = mount();
    await act(async () => {
      root.dispatchEvent(pointer("pointerdown", 150, 100, 0));
      root.dispatchEvent(pointer("pointerup", 151, 100, 30));
    });
    expect(root.dataset["flipped"]).toBe("false");
  });

  it("does nothing on an inert card", async () => {
    const { root, glyph } = mount({ enabled: false });
    await act(async () => {
      fireEvent.click(glyph);
      root.dispatchEvent(pointer("pointerdown", 100, 50, 0));
      root.dispatchEvent(pointer("pointermove", 260, 50, 60));
      root.dispatchEvent(pointer("pointerup", 260, 50, 70));
    });
    expect(root.dataset["flipped"]).toBe("false");
    expect(onFlip).not.toHaveBeenCalled();
  });

  it("builds no code without a payload, and a new code when the payload changes", async () => {
    const empty = mount({ payload: null });
    await act(async () => {
      fireEvent.click(empty.glyph);
      await Promise.resolve();
    });
    expect(toDataURL).not.toHaveBeenCalled();
    empty.view.unmount();

    const { view, root, glyph } = mount({ payload: "5Alice" });
    await act(async () => {
      fireEvent.click(glyph);
      await Promise.resolve();
    });
    expect(root.dataset["mask"]).toBe("data:image/png;base64,5Alice");
    let resolve: (url: string) => void = () => undefined;
    toDataURL.mockImplementationOnce(() => new Promise<string>((done) => (resolve = done)));
    await act(async () => {
      view.rerender(<Card payload="5Bob" />);
    });
    // The old account's code never stands in for the new one.
    expect(root.dataset["mask"]).toBe("");
    await act(async () => {
      resolve("data:image/png;base64,5Bob");
      await Promise.resolve();
    });
    expect(root.dataset["mask"]).toBe("data:image/png;base64,5Bob");
  });
});

describe("useCardFlip under full motion", () => {
  /** Move the frame clock on by `seconds`, rendering every frame on the way.
   *  Motion settles a finished animation in a microtask, which `act` flushes. */
  const advance = (seconds: number) =>
    act(async () => {
      vi.advanceTimersByTime(seconds * 1000);
    });

  beforeEach(() => {
    motion(false);
  });

  it("lets a turn land when a tap lands on the card midway", async () => {
    const { root, glyph } = mount();
    await act(async () => {
      fireEvent.click(glyph);
    });
    await advance(0.15);
    await act(async () => {
      root.dispatchEvent(pointer("pointerdown", 150, 100, 0));
      root.dispatchEvent(pointer("pointerup", 151, 100, 30));
    });
    await advance(1);
    expect(root.dataset["flipped"]).toBe("true");
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("ignores a second press while the card is still turning", async () => {
    const { root, glyph } = mount();
    await act(async () => {
      fireEvent.click(glyph);
    });
    await advance(0.1);
    await act(async () => {
      fireEvent.click(glyph);
    });
    await advance(1);
    expect(root.dataset["flipped"]).toBe("true");
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("keeps the code when the card turns back before it has loaded", async () => {
    let resolve: (url: string) => void = () => undefined;
    toDataURL.mockImplementationOnce(() => new Promise<string>((done) => (resolve = done)));
    const { root, glyph, back } = mount();
    await act(async () => {
      fireEvent.click(glyph);
    });
    await advance(1);
    await act(async () => {
      fireEvent.click(back);
    });
    await advance(1);
    expect(root.dataset["flipped"]).toBe("false");
    await act(async () => {
      resolve("data:image/png;base64,late");
      await Promise.resolve();
    });
    expect(root.dataset["mask"]).toBe("data:image/png;base64,late");
    expect(toDataURL).toHaveBeenCalledTimes(1);
  });

  it("lands a card grabbed mid-turn on the face that shows when it is let go", async () => {
    const { root, glyph } = mount();
    await act(async () => {
      fireEvent.click(glyph);
    });
    // About 100°: just past edge-on, the back showing, well short of rest.
    await advance(0.14);
    expect(root.dataset["flipped"]).toBe("true");
    await act(async () => {
      root.dispatchEvent(pointer("pointerdown", 150, 100, 0));
      root.dispatchEvent(pointer("pointermove", 158, 100, 20));
      root.dispatchEvent(pointer("pointerup", 158, 100, 400));
    });
    await advance(1);
    expect(root.dataset["flipped"]).toBe("true");
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("counts no turn for a drag that goes past the edge and comes back", async () => {
    const { root } = mount();
    await act(async () => {
      root.dispatchEvent(pointer("pointerdown", 100, 50, 0));
      root.dispatchEvent(pointer("pointermove", 110, 50, 100));
      root.dispatchEvent(pointer("pointermove", 260, 50, 700));
      root.dispatchEvent(pointer("pointermove", 112, 50, 1400));
      root.dispatchEvent(pointer("pointermove", 110, 50, 1600));
      root.dispatchEvent(pointer("pointerup", 110, 50, 1610));
    });
    await advance(1);
    expect(root.dataset["flipped"]).toBe("false");
    expect(onFlip).not.toHaveBeenCalled();
  });
});
