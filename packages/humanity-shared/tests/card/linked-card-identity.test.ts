// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { linkedCardIdentity } from "@humanity/shared/card/linked-card-identity.ts";
const host = {
  primaryUsername: "erin.35.testnet",
  username: "erin.35",
  isUpgraded: false,
};
describe("linked card identity", () => {
  it("uses the linked full name and preserves the host network suffix", () => {
    expect(
      linkedCardIdentity(host, new TextEncoder().encode("erinclaimverify")),
    ).toEqual({
      primaryUsername: "erinclaimverify.testnet",
      username: "erinclaimverify",
      isUpgraded: true,
    });
  });
  it("keeps an unsuffixed host name unsuffixed", () => {
    expect(
      linkedCardIdentity(
        { ...host, primaryUsername: "erin.35" },
        new TextEncoder().encode("erinclaimverify"),
      ).primaryUsername,
    ).toBe("erinclaimverify");
  });
  it("does not infer a claim from a missing consumer name", () => {
    expect(linkedCardIdentity(host, undefined)).toBe(host);
  });
  it.each(["", "alice.35", "Alice", "a".repeat(33)])(
    "ignores an invalid full name: %s",
    (name) => {
      expect(linkedCardIdentity(host, new TextEncoder().encode(name))).toBe(
        host,
      );
    },
  );
});
