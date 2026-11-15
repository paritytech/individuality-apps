// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Under-card markup and the two member rows. */
import { describe, expect, it } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DailyDollarTile,
  NameClaimRow,
  UnderCard,
} from "@features/card/components/home-blocks.tsx";

describe("UnderCard", () => {
  it("renders the subtitle node when there is a subtitle", () => {
    const html = renderToStaticMarkup(
      createElement(UnderCard, { title: "Almost a member", sub: "Keep playing" }),
    );
    expect(html).toContain("under-card-sub");
    expect(html).toContain("Keep playing");
  });

  it("is the home notice end-to-end readers find by test id", () => {
    const html = renderToStaticMarkup(
      createElement(UnderCard, { title: "Almost a member", sub: null }),
    );
    expect(html).toContain('<header class="under-card" data-testid="home-notice">');
  });

  it("omits the subtitle node entirely when there is none", () => {
    const html = renderToStaticMarkup(
      createElement(UnderCard, { title: "Membership at risk", sub: null }),
    );
    expect(html).toContain("Membership at risk");
    expect(html).not.toContain("under-card-sub");
  });

  it("renders nothing when both title and sub are null", () => {
    const html = renderToStaticMarkup(createElement(UnderCard, { title: null, sub: null }));
    expect(html).toBe("");
  });
});

describe("DailyDollarTile", () => {
  it("is one bordered, tappable row with no figure on it", () => {
    const html = renderToStaticMarkup(createElement(DailyDollarTile, { onOpen: () => undefined }));
    expect(html).toContain("<button");
    expect(html).toContain("route-card is-dollar");
    expect(html).toContain("Win a dollar today");
    expect(html).toContain("One try a day");
    expect(html).not.toMatch(/won|\$\d{2,}/);
  });
});

describe("NameClaimRow", () => {
  it("says what the name becomes", () => {
    const html = renderToStaticMarkup(
      createElement(NameClaimRow, {
        currentUsername: "marlow.42",
        onOpen: () => undefined,
      }),
    );
    expect(html).toContain("Claim your member username");
    expect(html).toContain("Choose a name to replace marlow.42");
    expect(html).not.toContain("becomes");
    expect(html).toContain("<button");
  });
});
