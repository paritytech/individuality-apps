// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { describeError, dispatchErrorText, hostErrorText, validityErrorText } from "./error-detail"

describe("hostErrorText", () => {
  it("walks the CallError → version → variant chain", () => {
    expect(hostErrorText({ tag: "Domain", value: { tag: "V1", value: { tag: "NotAllowlisted" } } })).toBe(
      "Domain.V1.NotAllowlisted",
    )
  })
  it("appends the leaf's reason", () => {
    expect(
      hostErrorText({ tag: "Domain", value: { tag: "V1", value: { tag: "Unknown", value: { reason: "product_id must not be empty" } } } }),
    ).toBe("Domain.V1.Unknown: product_id must not be empty")
  })
  it("stringifies anything that is not a tagged enum", () => {
    expect(hostErrorText("UnableToSign")).toBe("UnableToSign")
  })
})

describe("dispatchErrorText", () => {
  it("names Module errors Pallet.Error", () => {
    expect(dispatchErrorText({ type: "Module", value: { type: "Game", value: { type: "UseInviteButAlreadyPlaying" } } })).toBe(
      "Game.UseInviteButAlreadyPlaying",
    )
  })
  it("keeps single-word variants and names the never-included case", () => {
    expect(dispatchErrorText({ type: "Token", value: { type: "FundsUnavailable" } })).toBe("Token")
    expect(dispatchErrorText(undefined)).toBe("rejected before inclusion (no dispatch error)")
  })
})

describe("describeError", () => {
  it("names a likely resume interruption without blaming protocol-version skew and keeps the raw cause", () => {
    const interrupted = new Error("TrUAPI host connection interrupted")
    const wrapper = new Error(
      "Could not process the host response. The usual cause is a protocol-version skew.",
      { cause: interrupted },
    )
    expect(describeError(wrapper)).toBe(
      "The host channel was interrupted (the app likely resumed). <- TrUAPI host connection interrupted",
    )
    expect(describeError(wrapper)).not.toContain("protocol-version skew")
  })

  it("renders the cause chain outermost first and pulls papi's validity payload in", () => {
    const invalid = Object.assign(new Error("Invalid"), {
      name: "InvalidTxError",
      error: { type: "Invalid", value: { type: "Custom", value: 175 } },
    })
    const wrapped = new Error("sign-up did not land", { cause: invalid })
    expect(describeError(wrapped)).toBe("sign-up did not land <- InvalidTxError: Invalid [Invalid.Custom]")
    expect(validityErrorText(invalid.error)).toBe("Invalid.Custom")
  })
  it("collapses a message wrapped around itself and survives a cycle", () => {
    const inner = new Error("same")
    const outer = new Error("same", { cause: inner })
    ;(inner as { cause?: unknown }).cause = outer
    expect(describeError(outer)).toBe("same")
  })
})
