// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import type { AccountsProvider } from "@humanity/shared/chain/host-api.ts";
import {
  isLiteUsernameLabel,
  parseHumanityUserId,
  resolveHumanityUserIdFromProvider,
} from "@humanity/shared/identity/humanity-user-id.ts";

function providerResult(
  result: { primaryUsername: string } | null,
): AccountsProvider {
  return {
    getUserId: () => ({
      match: (
        ok: (value: { primaryUsername: string }) => unknown,
        err: () => unknown,
      ) => Promise.resolve(result == null ? err() : ok(result)),
    }),
  } as unknown as AccountsProvider;
}

describe("resolveHumanityUserIdFromProvider", () => {
  it("uses getUserId and normalizes the primary DotNS username", async () => {
    const identity = await resolveHumanityUserIdFromProvider(
      providerResult({ primaryUsername: "Alice.dot" }),
    );

    expect(identity).toEqual({
      primaryUsername: "Alice.dot",
      username: "alice",
      isUpgraded: true,
    });
  });

  it("strips the paseo-next-v2 `.paseo` extension", async () => {
    const identity = await resolveHumanityUserIdFromProvider(
      providerResult({ primaryUsername: "Alice.paseo" }),
    );

    expect(identity).toEqual({
      primaryUsername: "Alice.paseo",
      username: "alice",
      isUpgraded: true,
    });
  });

  it("strips the Preview `.testnet` extension", async () => {
    const identity = await resolveHumanityUserIdFromProvider(
      providerResult({ primaryUsername: "Alice.42.testnet" }),
    );

    expect(identity).toEqual({
      primaryUsername: "Alice.42.testnet",
      username: "alice.42",
      isUpgraded: false,
    });
  });

  it("continues to strip the historical Preview `.test` extension", async () => {
    const identity = await resolveHumanityUserIdFromProvider(
      providerResult({ primaryUsername: "Alice.test" }),
    );

    expect(identity).toEqual({
      primaryUsername: "Alice.test",
      username: "alice",
      isUpgraded: true,
    });
  });

  it("returns null when the host rejects identity permission", async () => {
    expect(
      await resolveHumanityUserIdFromProvider(providerResult(null)),
    ).toBeNull();
  });

  it("returns null for a blank host username", async () => {
    expect(
      await resolveHumanityUserIdFromProvider(
        providerResult({ primaryUsername: "  .dot  " }),
      ),
    ).toBeNull();
  });

  it("keeps the lite `.<digits>` suffix and reports the user as lite", async () => {
    const identity = await resolveHumanityUserIdFromProvider(
      providerResult({ primaryUsername: "Alice.42.paseo" }),
    );

    expect(identity).toEqual({
      primaryUsername: "Alice.42.paseo",
      username: "alice.42",
      isUpgraded: false,
    });
  });

  it("reports a lite suffix even without a network extension", async () => {
    const identity = await resolveHumanityUserIdFromProvider(
      providerResult({ primaryUsername: "alice.42.dot" }),
    );

    expect(identity).toEqual({
      primaryUsername: "alice.42.dot",
      username: "alice.42",
      isUpgraded: false,
    });
  });

  it("does not treat a single trailing digit as a lite suffix", async () => {
    const identity = await resolveHumanityUserIdFromProvider(
      providerResult({ primaryUsername: "Alice.4.paseo" }),
    );

    expect(identity).toEqual({
      primaryUsername: "Alice.4.paseo",
      username: "alice.4",
      isUpgraded: true,
    });
  });

  it("trims surrounding whitespace before classification", async () => {
    const identity = await resolveHumanityUserIdFromProvider(
      providerResult({ primaryUsername: "  Alice.42.paseo  " }),
    );

    expect(identity).toEqual({
      primaryUsername: "  Alice.42.paseo  ",
      username: "alice.42",
      isUpgraded: false,
    });
  });
});

describe("isLiteUsernameLabel", () => {
  it("matches a DotNS stem followed by at least two digits", () => {
    expect(isLiteUsernameLabel("alice.42")).toBe(true);
    expect(isLiteUsernameLabel("alice-1.100")).toBe(true);
  });

  it("rejects full person labels, single digits, and dots in the stem", () => {
    expect(isLiteUsernameLabel("alice")).toBe(false);
    expect(isLiteUsernameLabel("alice.4")).toBe(false);
    expect(isLiteUsernameLabel("alice.bob.42")).toBe(false);
  });
});

describe("parseHumanityUserId", () => {
  it("parses a lite username with the network extension", () => {
    expect(parseHumanityUserId("Alice.42.paseo")).toEqual({
      primaryUsername: "Alice.42.paseo",
      username: "alice.42",
      isUpgraded: false,
    });
  });

  it("keeps a lite suffix without a network extension", () => {
    expect(parseHumanityUserId("alice.42.dot")).toEqual({
      primaryUsername: "alice.42.dot",
      username: "alice.42",
      isUpgraded: false,
    });
  });

  it("parses an upgraded username", () => {
    expect(parseHumanityUserId("alice.paseo")).toEqual({
      primaryUsername: "alice.paseo",
      username: "alice",
      isUpgraded: true,
    });
  });

  it("returns null for blank or extension-only usernames", () => {
    expect(parseHumanityUserId("")).toBeNull();
    expect(parseHumanityUserId("   ")).toBeNull();
    expect(parseHumanityUserId(".dot")).toBeNull();
    expect(parseHumanityUserId("  .paseo  ")).toBeNull();
  });

  it("matches the provider resolver on the same input", async () => {
    const raw = "  Alice.42.paseo  ";
    const viaProvider = await resolveHumanityUserIdFromProvider(
      providerResult({ primaryUsername: raw }),
    );
    expect(parseHumanityUserId(raw)).toEqual(viaProvider);
  });
});
