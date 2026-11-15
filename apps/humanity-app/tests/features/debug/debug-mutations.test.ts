// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** These triggers sign real transactions, so what is pinned here is the ways a
 *  debug submission can silently diverge from production: a prefill that drifts
 *  from what the real screen would submit, and a draw reference that resolves to
 *  something the operator did not mean.
 *
 *  A draw is identified only by the people-airdrops `NextDrawIndex` — no game
 *  index, no per-game airdrop index — so the reference tests are the whole
 *  argument surface for `register` and `claim`. */
import { describe, expect, it } from "vitest";

import {
  parseBaseUnits,
  parseDrawRef,
  parseDrawRefs,
  upgradeTarget,
} from "@features/debug/debug-mutations.ts";
import { buildDrawEventId } from "@humanity/shared/airdrops/chain/draw-event-id.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";

const OWNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

function card(primaryUsername: string): HumanityCardResult {
  return {
    kind: "card",
    primaryUsername,
    accountAddress: OWNER,
  } as unknown as HumanityCardResult;
}

describe("upgradeTarget", () => {
  it("prefills the lite owner and label the real screen would submit", () => {
    expect(upgradeTarget(card("bob.02"))).toEqual({
      kind: "ready",
      expectedLiteAddress: OWNER,
      currentLiteUsername: "bob.02",
    });
  });

  // `Resources.UsernameOwnerOf` is keyed by the bare label, so a prefill that
  // kept the network extension would look right and be rejected on chain.
  it("strips the network DotNS extension from the lite label", () => {
    expect(upgradeTarget(card("bob.02.paseo"))).toMatchObject({
      currentLiteUsername: "bob.02",
    });
    expect(upgradeTarget(card("Bob.02.TEST"))).toMatchObject({
      currentLiteUsername: "bob.02",
    });
  });

  it("blocks an already-upgraded card rather than burning a rejected signature", () => {
    expect(upgradeTarget(card("bob"))).toMatchObject({
      kind: "blocked",
      reason: expect.stringContaining("already a full person"),
    });
  });

  it("blocks and names the kind when no card resolved", () => {
    expect(upgradeTarget(undefined)).toEqual({
      kind: "blocked",
      reason: "no card resolved (unresolved)",
    });
    expect(upgradeTarget({ kind: "account-unavailable" } as HumanityCardResult)).toEqual({
      kind: "blocked",
      reason: "no card resolved (account-unavailable)",
    });
  });

  it("blocks a username that normalizes to nothing", () => {
    expect(upgradeTarget(card(".paseo")).kind).toBe("blocked");
  });
});

describe("parseBaseUnits", () => {
  it("accepts a positive integer with optional underscore separators", () => {
    expect(parseBaseUnits(" 1_000_000 ")).toEqual({ ok: true, amount: 1_000_000n });
    expect(parseBaseUnits("7")).toEqual({ ok: true, amount: 7n });
  });

  it.each([
    ["", "required"],
    ["0", "positive"],
    ["1.5", "whole number"],
    ["$1", "whole number"],
    ["-3", "whole number"],
  ])("rejects %j with a reason mentioning %s", (raw, reason) => {
    const parsed = parseBaseUnits(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toContain(reason);
  });
});

describe("parseDrawRef", () => {
  it("derives the event id from a bare draw index with the app's own builder", () => {
    expect(parseDrawRef("7")).toEqual({
      ok: true,
      eventId: buildDrawEventId(7n),
      drawIndex: 7n,
    });
  });

  it("accepts index zero", () => {
    expect(parseDrawRef("0")).toMatchObject({ ok: true, drawIndex: 0n });
  });

  it("accepts a full event id this pallet minted and recovers its index", () => {
    const eventId = buildDrawEventId(1234n);
    expect(parseDrawRef(eventId)).toEqual({ ok: true, eventId, drawIndex: 1234n });
  });

  it("trims surrounding whitespace", () => {
    expect(parseDrawRef("  12  ")).toMatchObject({ ok: true, drawIndex: 12n });
  });

  // `Airdrop.Events` also holds the game-tied airdrops under a different
  // prefix, so an id from those must not resolve here — claiming against it
  // would target the wrong draw entirely.
  it("rejects a well-formed id that this pallet did not mint", () => {
    const foreign = `0x${"11".repeat(32)}`;
    expect(parseDrawRef(foreign)).toEqual({
      ok: false,
      problem: "not a people-airdrops draw event id",
    });
  });

  it("rejects a hex id of the wrong width", () => {
    expect(parseDrawRef(`0x${"ab".repeat(16)}`).ok).toBe(false);
  });

  it("rejects a draw index beyond u64", () => {
    const beyond = (1n << 64n).toString();
    expect(parseDrawRef(beyond)).toEqual({
      ok: false,
      problem: `draw index out of u64 range: ${beyond}`,
    });
  });

  it.each(["", "   ", "-1", "1.5", "nine", "0x", "abc"])(
    "rejects %j rather than coercing it",
    (raw) => {
      expect(parseDrawRef(raw).ok).toBe(false);
    },
  );
});

describe("parseDrawRefs", () => {
  it("resolves a whitespace- or comma-separated list in order", () => {
    expect(parseDrawRefs("3, 4  5")).toEqual({
      ok: true,
      eventIds: [buildDrawEventId(3n), buildDrawEventId(4n), buildDrawEventId(5n)],
    });
  });

  it("mixes indices and full event ids", () => {
    const eventId = buildDrawEventId(9n);
    expect(parseDrawRefs(`2 ${eventId}`)).toEqual({
      ok: true,
      eventIds: [buildDrawEventId(2n), eventId],
    });
  });

  // A repeat would spend a second registration on a draw the chain already
  // holds, which fails and pays.
  it("drops duplicates, including an index repeated as its event id", () => {
    expect(parseDrawRefs(`4 4 ${buildDrawEventId(4n)}`)).toEqual({
      ok: true,
      eventIds: [buildDrawEventId(4n)],
    });
  });

  // An upper-case paste must canonicalise, or dedupe compares unequal and the
  // draw registers twice — which fails and pays.
  it("treats an upper-case event id as the same draw", () => {
    const eventId = buildDrawEventId(4n);
    expect(parseDrawRefs(`4 ${eventId.toUpperCase().replace("0X", "0x")}`)).toEqual({
      ok: true,
      eventIds: [eventId],
    });
  });

  it("names the offending entry when one is unusable", () => {
    expect(parseDrawRefs("3 nope 5")).toEqual({
      ok: false,
      problem: expect.stringContaining("nope"),
    });
  });

  it("rejects an empty list", () => {
    expect(parseDrawRefs("   ").ok).toBe(false);
  });
});
