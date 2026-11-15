// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCardParallax } from "@features/card/hooks/use-card-parallax.ts";

const CARD_RECT = { left: 0, top: 0, width: 200, height: 100 };

function Card() {
  const rootRef = useRef<HTMLDivElement>(null);
  useCardParallax(rootRef);
  return <div data-testid="root" ref={rootRef} />;
}

/** jsdom lays nothing out, so the card's box has to be supplied. */
function renderCard(): HTMLElement {
  const view = render(<Card />);
  const root = view.getByTestId("root");
  root.getBoundingClientRect = () => ({
    ...CARD_RECT,
    right: 200,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return root;
}

const sheenX = (root: HTMLElement) => root.style.getPropertyValue("--sheen-x");

/** jsdom has no `PointerEvent`, so a MouseEvent carries the pointer fields. */
function pointerMove(root: HTMLElement, pointerType: string, clientX: number, clientY: number) {
  const event = new MouseEvent("pointermove", { clientX, clientY, bubbles: true });
  Object.assign(event, { pointerType });
  root.dispatchEvent(event);
}

function orientation(beta: number | null, gamma: number | null) {
  const event = new Event("deviceorientation");
  Object.assign(event, { beta, gamma, alpha: 0, absolute: false });
  window.dispatchEvent(event);
}

beforeEach(() => {
  // jsdom has no matchMedia; the hook consults reduced-motion before wiring
  // anything up. Full motion.
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.stubGlobal("DeviceOrientationEvent", class extends Event {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useCardParallax", () => {
  it("drives the card from a hovering mouse", () => {
    const root = renderCard();
    pointerMove(root, "mouse", 200, 50);
    expect(sheenX(root)).toBe("95%");
  });

  // The reported bug: a finger dragging across the card moved and tilted it.
  it("ignores touch entirely", () => {
    const root = renderCard();
    pointerMove(root, "touch", 200, 50);
    expect(sheenX(root)).toBe("");
  });

  it("moves only the light, never the card's geometry", () => {
    const root = renderCard();
    pointerMove(root, "mouse", 200, 100);
    expect(root.style.getPropertyValue("--tilt-x")).toBe("1");
    expect(root.style.getPropertyValue("--tilt-y")).toBe("1");
    expect(root.style.transform).toBe("");
  });

  it("pauses the pointer light while the card is being dragged round", () => {
    const root = renderCard();
    root.dataset["dragging"] = "1";
    pointerMove(root, "mouse", 200, 50);
    expect(sheenX(root)).toBe("");
  });

  it("drives the card from an orientation reading", () => {
    const root = renderCard();
    orientation(40, 28);
    expect(sheenX(root)).toBe("95%");
  });

  it("ignores orientation events that carry no reading", () => {
    const root = renderCard();
    orientation(null, null);
    expect(sheenX(root)).toBe("");
  });
});
