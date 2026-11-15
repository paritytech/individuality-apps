// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  LAST_CARD_SCHEMA_VERSION,
  parseLastCard,
  serializeLastCard,
} from "@features/card/domain/last-card-snapshot.ts";

const card = {
  kind: "card" as const,
  primaryUsername: "alice.42.paseo",
  accountAddress: "5Alice",
  state: { kind: "member" as const },
};

describe("last-card snapshot", () => {
  it("round-trips a resolved card", () => {
    const raw = serializeLastCard("alice.42", card, 1_780_000_000);

    expect(parseLastCard(raw)).toEqual({
      version: LAST_CARD_SCHEMA_VERSION,
      savedAt: 1_780_000_000,
      username: "alice.42",
      card,
    });
  });

  it("rejects absent and malformed input without throwing", () => {
    expect(parseLastCard(null)).toBeNull();
    expect(parseLastCard("")).toBeNull();
    expect(() => parseLastCard("{")).not.toThrow();
    expect(parseLastCard("{")).toBeNull();
  });

  it("rejects incompatible or incomplete snapshots without throwing", () => {
    const invalid = [
      JSON.stringify({
        version: LAST_CARD_SCHEMA_VERSION + 1,
        savedAt: 1,
        username: "alice.42",
        card,
      }),
      JSON.stringify({
        version: LAST_CARD_SCHEMA_VERSION,
        savedAt: 1,
        username: " ",
        card,
      }),
      JSON.stringify({
        version: LAST_CARD_SCHEMA_VERSION,
        savedAt: 1,
        username: "alice.42",
        card: { kind: "account-unavailable" },
      }),
    ];

    for (const raw of invalid) {
      expect(() => parseLastCard(raw)).not.toThrow();
      expect(parseLastCard(raw)).toBeNull();
    }
  });

  it("rejects a snapshot whose state this build cannot render", () => {
    // `lite` was a card state until 2026-09-04. A browser that last resolved
    // a card on that build still holds it, and the face would be handed a
    // state with no material behind it.
    const stale: Record<string, unknown>[] = [
      { ...card, state: { kind: "lite" } },
      { ...card, state: {} },
      { ...card, state: null },
      { kind: card.kind, primaryUsername: card.primaryUsername, accountAddress: card.accountAddress },
    ];
    for (const payload of stale) {
      const raw = JSON.stringify({
        version: LAST_CARD_SCHEMA_VERSION,
        savedAt: 1,
        username: "alice.42",
        card: payload,
      });
      expect(parseLastCard(raw), JSON.stringify(payload["state"])).toBeNull();
    }
  });
});
