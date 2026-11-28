// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { assertPublicSafe } from "./public-safety"

describe("public artefact safety", () => {
  it.each([
    `0x${"ab".repeat(33)}`,
    "ab".repeat(32),
    `x0x${"ab".repeat(32)}`,
    `_0x${"ab".repeat(32)}`,
    "`//Alice//stash`",
    "signer=//Alice/0;",
    "turn:user:password@relay.example",
    "custom://user:password@example.test",
    "redis://:password@example.test",
    "//user:password@example.test",
    "\tuser:password@example.test",
    "(user:password@example.test)",
    ",user:password@example.test",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN DSA PRIVATE KEY-----",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    "DIM2\u200B_MNEMONIC",
    "SENTRY\\_DSN",
  ])("rejects %s", (value) => expect(() => assertPublicSafe("fixture", value)).toThrow())

  it.each(["//cdn.example.com/asset.webp", "see //Alice for the public test identity"])('allows public text %s', (value) =>
    expect(() => assertPublicSafe("fixture", value)).not.toThrow(),
  )

  it("allows the explicit public telemetry identifier", () => expect(() => assertPublicSafe("fixture", "rtc.turn_ttl_left_s")).not.toThrow())
})
