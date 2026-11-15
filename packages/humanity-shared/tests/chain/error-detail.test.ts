// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  describeError,
  dispatchErrorText,
  hostError,
  validityErrorText,
} from "@humanity/shared/chain/error-detail.ts";

/** The exact sentence the seat card shows; it must survive as the outer link. */
const CANNED = "We couldn't reserve your weekly game seat. Try again shortly.";
/** The host wrapper's own message, one level below the canned copy. */
const HOST_WRAPPER = "The host could not build a V5 transaction.";
/** The refusal measured at `host_create_transaction` in commit 8e6f750. */
const HOST_REFUSAL = {
  tag: "PermissionDenied",
  value: { reason: "foreign product account" },
};

describe("describeError", () => {
  it("renders the real seat-bind failure outermost first", () => {
    const thrown = new Error(CANNED, {
      cause: new Error(HOST_WRAPPER, { cause: HOST_REFUSAL }),
    });

    expect(describeError(thrown)).toBe(
      `${CANNED} <- ${HOST_WRAPPER} <- PermissionDenied: foreign product account`,
    );
  });

  it("names an error that has a name and leaves a plain Error bare", () => {
    const named = new Error("ring key missing");
    named.name = "RingVrfError";

    expect(describeError(named)).toBe("RingVrfError: ring key missing");
    expect(describeError(new Error("plain trouble"))).toBe("plain trouble");
  });

  it("appends the decoded validity payload PAPI hangs off InvalidTxError", () => {
    const invalid = Object.assign(new Error("Invalid transaction"), {
      name: "InvalidTxError",
      error: { type: "Invalid", value: { type: "Payment" } },
    });

    expect(describeError(invalid)).toBe(
      "InvalidTxError: Invalid transaction [Invalid.Payment]",
    );
  });

  it("collapses a canned message wrapped around itself to one link", () => {
    const doubled = new Error(CANNED, { cause: new Error(CANNED) });

    expect(describeError(doubled)).toBe(CANNED);
  });

  it("terminates on a self-referential cause instead of looping", () => {
    const cyclic = new Error("loops back on itself");
    cyclic.cause = cyclic;

    expect(describeError(cyclic)).toBe("loops back on itself");
  });

  it("truncates a chain deeper than the cause-depth cap", () => {
    let deepest: Error = new Error("link 8");
    for (let level = 7; level >= 1; level -= 1) {
      deepest = new Error(`link ${level}`, { cause: deepest });
    }

    const links = describeError(deepest).split(" <- ");

    expect(links).toEqual([
      "link 1",
      "link 2",
      "link 3",
      "link 4",
      "link 5",
      "link 6",
    ]);
  });

  it("renders every non-Error thrown value without throwing", () => {
    expect(describeError(undefined)).toBe("no error reported");
    expect(describeError(null)).toBe("null");
    expect(describeError("string rejection")).toBe("string rejection");
    expect(describeError(42)).toBe("42");
    expect(describeError({ code: 7 })).toBe('{"code":7}');
  });

  it("truncates a link longer than the length cap and marks the cut", () => {
    const link = describeError(new Error("x".repeat(400)));

    expect(link).toHaveLength(240);
    expect(link.endsWith("…")).toBe(true);
  });
});

describe("hostError", () => {
  it("reads the tag and the permission layer's reason", () => {
    expect(hostError(HOST_REFUSAL)).toBe(
      "PermissionDenied: foreign product account",
    );
  });

  it("reads a bare tag with no reason payload", () => {
    expect(hostError({ tag: "Unavailable" })).toBe("Unavailable");
  });

  it("walks TrUAPI's CallError envelopes to the variant that means something", () => {
    // `CallError<D>`'s `Domain` variant carries the call's own error, wrapped
    // in a `V1` version envelope. Reporting only the outer tag said "Domain"
    // for all six distinct ring-VRF refusals.
    expect(
      hostError({ tag: "Domain", value: { tag: "V1", value: { tag: "NotAllowlisted" } } }),
    ).toBe("Domain.V1.NotAllowlisted");
  });

  it("keeps the reason of a payload-carrying leaf variant", () => {
    expect(
      hostError({
        tag: "Domain",
        value: { tag: "V1", value: { tag: "Unknown", value: { reason: "ring read timed out" } } },
      }),
    ).toBe("Domain.V1.Unknown: ring read timed out");
  });

  it("falls back to String for values that are not host results", () => {
    expect(hostError("plain refusal")).toBe("plain refusal");
    expect(hostError(undefined)).toBe("undefined");
  });
});

describe("dispatchErrorText", () => {
  it("says nothing about a successful result", () => {
    expect(dispatchErrorText({ ok: true })).toBe("");
  });

  it("reads a Module error as Pallet.ErrorName", () => {
    expect(
      dispatchErrorText({
        ok: false,
        dispatchError: {
          type: "Module",
          value: { type: "PeopleLite", value: { type: "InvalidProof" } },
        },
      }),
    ).toBe("PeopleLite.InvalidProof");
  });

  it("keeps a non-Module error as its single established word", () => {
    expect(
      dispatchErrorText({
        ok: false,
        dispatchError: { type: "Token", value: { type: "FundsUnavailable" } },
      }),
    ).toBe("Token");
  });

  it("distinguishes a failure that never reached inclusion", () => {
    expect(dispatchErrorText({ ok: false })).toBe(
      "rejected before inclusion (no dispatch error)",
    );
  });

  it("admits when the payload cannot be decoded", () => {
    expect(dispatchErrorText({ ok: false, dispatchError: "boom" })).toBe(
      "unknown error",
    );
  });
});

describe("validityErrorText", () => {
  it("reads a nested validity payload as Invalid.Payment", () => {
    expect(
      validityErrorText({ type: "Invalid", value: { type: "Payment" } }),
    ).toBe("Invalid.Payment");
  });

  it("admits when the payload carries no tags", () => {
    expect(validityErrorText({ reason: "stale" })).toBe(
      "unknown validity error",
    );
  });
});
