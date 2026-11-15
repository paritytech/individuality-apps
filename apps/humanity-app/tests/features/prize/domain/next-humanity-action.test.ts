// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  humanityActionQueriesReady,
  nextHumanityAction,
} from "@features/prize/domain/next-humanity-action.ts";

const usernameTarget = {
  kind: "available" as const,
  accountAddress: "5Alice",
  currentLiteUsername: "alice.42",
  suggestedUsername: "alice",
};

describe("nextHumanityAction", () => {
  it("waits until the card has resolved", () => {
    expect(
      nextHumanityAction({ ready: false, usernameTarget, dismissed: [] }),
    ).toBeNull();
  });

  it("opens the username claim when one is on offer", () => {
    expect(
      nextHumanityAction({ ready: true, usernameTarget, dismissed: [] }),
    ).toBe("claim-username");
  });

  it("never opens anything else on its own", () => {
    expect(
      nextHumanityAction({
        ready: true,
        usernameTarget: { kind: "not-ready" },
        dismissed: [],
      }),
    ).toBeNull();
  });

  it("does not reopen an action dismissed in this foreground session", () => {
    expect(
      nextHumanityAction({
        ready: true,
        usernameTarget,
        dismissed: ["claim-username"],
      }),
    ).toBeNull();
  });
});

describe("humanityActionQueriesReady", () => {
  it("waits for the card read alone", () => {
    expect(humanityActionQueriesReady({ card: { isPending: true } })).toBe(false);
    expect(humanityActionQueriesReady({ card: { isPending: false } })).toBe(true);
  });
});
