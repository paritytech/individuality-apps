// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Pure argument derivation for the debug panel's mutation triggers.
 *
 * The username upgrade is prefilled from what the page already published,
 * using the same derivation as the real call site — a retyped address is the
 * commonest way a debug repro quietly stops reproducing the bug.
 *
 * The people-airdrops triggers take a draw reference instead. A draw is
 * identified solely by the pallet's `NextDrawIndex` at scheduling time, so
 * there is no game index and no per-game airdrop index to supply, and nothing
 * the page reads can stand in for a draw the operator has in mind.
 *
 * React-free so the mapping stays unit-testable, and chain-free so the panel
 * can still only act on state the page itself saw.
 */
import { buildDrawEventId } from "@humanity/shared/airdrops/chain/draw-event-id.ts";
import { parsePeopleAirdropsEventId } from "@humanity/shared/chain/individuality.ts";
import type { Hex32 } from "@individuality/daily-dollar";
import { parseHumanityUserId } from "@humanity/shared/identity/humanity-user-id.ts";

import type { DebugPageInput } from "./debug-view.ts";

/**
 * Why a mutation cannot be triggered from the state currently on screen.
 * Reported instead of a disabled button with no explanation: "why is this
 * greyed out" is the question a debug panel exists to answer.
 */
export interface MutationBlocked {
  kind: "blocked";
  reason: string;
}

export type UpgradeTarget =
  | {
      kind: "ready";
      /** Lite account that owns the current name — `Resources.register_person`
       *  is rejected outright if this is not the owner. */
      expectedLiteAddress: string;
      /** Extension-stripped lite label, as `upgradeLiteUsername` expects. */
      currentLiteUsername: string;
    }
  | MutationBlocked;

/**
 * Mirrors `PrizeLiveHomeBlock`'s derivation: the lite address is the card's own
 * account, and the current label is the parsed username with its DotNS
 * extension stripped. An already-upgraded card is reported as blocked rather
 * than offered — submitting it would burn a real signature on a call the
 * runtime rejects.
 */
export function upgradeTarget(card: DebugPageInput["card"]): UpgradeTarget {
  if (card == null || card.kind !== "card") {
    return { kind: "blocked", reason: `no card resolved (${card?.kind ?? "unresolved"})` };
  }
  const identity = parseHumanityUserId(card.primaryUsername);
  if (identity == null) {
    return { kind: "blocked", reason: `unparseable username "${card.primaryUsername}"` };
  }
  if (identity.isUpgraded) {
    return { kind: "blocked", reason: "already a full person — nothing to upgrade" };
  }
  return {
    kind: "ready",
    expectedLiteAddress: card.accountAddress,
    currentLiteUsername: identity.username,
  };
}

export type DrawRefParse =
  | { ok: true; eventId: Hex32; drawIndex: bigint }
  | { ok: false; problem: string };

/**
 * A bare index is accepted because that is the number a scheduler shows.
 *
 * A pasted id is checked because the game's airdrops share `Airdrop.Events`,
 * and one of those would claim against the wrong draw.
 */
export function parseDrawRef(raw: string): DrawRefParse {
  const text = raw.trim();
  if (text === "") return { ok: false, problem: "draw index or event id is required" };

  if (/^\d+$/.test(text)) {
    try {
      const drawIndex = BigInt(text);
      return { ok: true, eventId: buildDrawEventId(drawIndex), drawIndex };
    } catch {
      return { ok: false, problem: `draw index out of u64 range: ${text}` };
    }
  }

  const drawIndex = parsePeopleAirdropsEventId(text);
  if (drawIndex == null) {
    return {
      ok: false,
      problem: text.startsWith("0x")
        ? "not a people-airdrops draw event id"
        : "expected a draw index or an 0x… event id",
    };
  }
  // Lowercased to the canonical form `buildDrawEventId` emits: every
  // downstream comparison (standing lookup, claim status, dedupe) is by
  // string equality, so an upper-case paste would read as a different draw.
  return { ok: true, eventId: text.toLowerCase() as Hex32, drawIndex };
}

export type BaseUnitsParse =
  | { ok: true; amount: bigint }
  | { ok: false; problem: string };

/** A positive integer in the purse's base units — the shape `topUp` takes,
 *  so the operator types exactly what is sent. Underscores are allowed as
 *  digit separators (`1_000_000`). */
export function parseBaseUnits(raw: string): BaseUnitsParse {
  const text = raw.trim().replace(/_/g, "");
  if (text === "") return { ok: false, problem: "amount in base units is required" };
  if (!/^\d+$/.test(text)) {
    return { ok: false, problem: "expected a whole number of base units" };
  }
  const amount = BigInt(text);
  if (amount === 0n) return { ok: false, problem: "amount must be positive" };
  return { ok: true, amount };
}

export type DrawRefsParse =
  | { ok: true; eventIds: Hex32[] }
  | { ok: false; problem: string };

/**
 * Resolve a whitespace- or comma-separated list of draw references, for
 * `register`, which takes every open draw at once. No client-side cap:
 * `registerForDraws` chunks the list to the runtime's `MaxRegisterBatch`
 * itself, so imposing a second bound here could only disagree with it.
 */
export function parseDrawRefs(raw: string): DrawRefsParse {
  const parts = raw.trim().split(/[\s,]+/).filter((part) => part !== "");
  if (parts.length === 0) {
    return { ok: false, problem: "at least one draw index or event id is required" };
  }
  const eventIds: Hex32[] = [];
  for (const part of parts) {
    const parsed = parseDrawRef(part);
    if (!parsed.ok) return { ok: false, problem: `${part}: ${parsed.problem}` };
    // A duplicate would spend a second registration attempt on a draw the
    // chain already holds, which fails and pays.
    if (!eventIds.includes(parsed.eventId)) eventIds.push(parsed.eventId);
  }
  return { ok: true, eventIds };
}
