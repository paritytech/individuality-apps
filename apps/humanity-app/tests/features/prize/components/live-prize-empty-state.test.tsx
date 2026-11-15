// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Card failures must wait for their next refetch rather than offer a dead exit. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LivePrizeEmptyState } from "@features/prize/components/LivePrizeEmptyState.tsx";

function render(onBack?: () => void): string {
  return renderToStaticMarkup(
    createElement(LivePrizeEmptyState, { message: "Unavailable", onBack }),
  );
}

describe("LivePrizeEmptyState CTA", () => {
  it("renders no CTA while a card read recovers", () => {
    expect(render()).not.toContain(">Back<");
  });

  it("keeps the CTA for the prize-surface return path", () => {
    expect(render(vi.fn())).toContain(">Back<");
  });
});
