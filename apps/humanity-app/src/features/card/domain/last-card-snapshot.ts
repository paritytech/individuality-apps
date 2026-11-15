// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  isHumanityCardStateKind,
  type HumanityCardState,
} from "@humanity/shared/card/humanity-card-state.ts";

/** Versioned durable boundary for a resolved card read. */
export const LAST_CARD_SCHEMA_VERSION = 1;

/**
 * The persisted card is only checked for the identity needed to safely choose
 * it, and for a state this build can render: the snapshot outlives the build
 * that wrote it, and a state name retired since (`lite`, for one)
 * would reach the card face with nothing behind it. The rest of the payload
 * remains opaque here: domain code must not depend on the card's chain-layer
 * representation.
 */
export interface LastCardPayload {
  kind: "card";
  primaryUsername: string;
  accountAddress: string;
  state: { kind: HumanityCardState["kind"] };
}

/** The last resolved card, scoped to the username that produced it. */
export interface LastCardSnapshot {
  version: number;
  savedAt: number;
  username: string;
  card: LastCardPayload;
}

/** Serializes a successful card read for its synchronous durable fallback. */
export function serializeLastCard(
  username: string,
  card: LastCardPayload,
  savedAt: number,
): string {
  return JSON.stringify({
    version: LAST_CARD_SCHEMA_VERSION,
    savedAt,
    username,
    card,
  } satisfies LastCardSnapshot);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parses untrusted durable data without allowing a corrupt browser cache to
 * affect the card render path.
 */
export function parseLastCard(raw: string | null): LastCardSnapshot | null {
  if (raw == null || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null) return null;
    const snapshot = parsed as Partial<LastCardSnapshot>;
    if (
      snapshot.version !== LAST_CARD_SCHEMA_VERSION ||
      !isNonBlankString(snapshot.username) ||
      typeof snapshot.savedAt !== "number" ||
      !Number.isFinite(snapshot.savedAt) ||
      typeof snapshot.card !== "object" ||
      snapshot.card == null
    ) {
      return null;
    }
    const card = snapshot.card as Partial<LastCardPayload>;
    if (
      card.kind !== "card" ||
      !isNonBlankString(card.primaryUsername) ||
      !isNonBlankString(card.accountAddress)
    ) {
      return null;
    }
    const state: unknown = card.state;
    if (
      typeof state !== "object" ||
      state == null ||
      !isHumanityCardStateKind((state as { kind?: unknown }).kind)
    ) {
      return null;
    }
    return snapshot as LastCardSnapshot;
  } catch {
    return null;
  }
}
