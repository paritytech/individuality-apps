// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

vi.mock("@humanity/shared/identity/product-domain.ts", () => ({
  productDomain: () => "peopl.paseo",
}));

import { pocketCardDeeplink, pocketScratchDeeplink } from "@humanity/shared/pocket/pocket-card-link.ts";

describe("pocketCardDeeplink", () => {
  it("asks the host to expand this product's card", () => {
    expect(pocketCardDeeplink()).toBe("polkadotapp://pocket/open?product=peopl.paseo&card=humanity");
  });
});

describe("pocketScratchDeeplink", () => {
  it("is the card's link asking the app to open the scratch", () => {
    expect(pocketScratchDeeplink()).toBe(
      "polkadotapp://pocket/open?product=peopl.paseo&card=humanity&open=scratch",
    );
  });
});
