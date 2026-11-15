// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { signupFailureReason } from "./signup-failure"

describe("signupFailureReason", () => {
  it.each([
    "HostRejectedError: Host rejected the request",
    "createTransaction failed: Rejected",
    "Transaction signing was rejected.",
    "createTransaction failed: user rejected the confirmation",
  ])("calls %s signing-refused", (errorText) => {
    expect(signupFailureReason(errorText, "tx.broadcast")).toBe("signing-refused")
  })

  it.each(["HostDisconnectedError: host went away", "transaction rejected: Invalid.Payment", "operation timed out"])(
    "keeps the stage for %s",
    (errorText) => {
      expect(signupFailureReason(errorText, "tx.broadcast")).toBe("tx.broadcast")
    },
  )
})
