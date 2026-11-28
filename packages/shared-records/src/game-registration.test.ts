// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { ENDED_TTL_MS, liveGameRegistration, parseGameRegistration, REGISTERING_TTL_MS, registrationInFlight, SENT_TTL_MS } from "./game-registration"

const NOW = 1_700_000_000_000
const base = { gameIndex: 7, surface: "chat", attempt: NOW - 5_000 } as const

describe("parseGameRegistration", () => {
  it("keeps a well-formed record of any age, and drops a malformed one", () => {
    const old = { ...base, phase: "registered", at: NOW - ENDED_TTL_MS * 1_000 } as const
    expect(parseGameRegistration(old)).toEqual(old)
    expect(parseGameRegistration({ ...old, surface: "humanity" })).toEqual({ ...old, surface: "humanity" })
    expect(parseGameRegistration({ ...old, gameIndex: 7.5 })).toBeNull()
    expect(parseGameRegistration({ ...old, phase: "done" })).toBeNull()
    expect(parseGameRegistration(null)).toBeNull()
  })
})

describe("liveGameRegistration", () => {
  it("keeps a fresh record of every phase, from either surface", () => {
    for (const phase of ["registering", "sent", "registered", "failed"] as const) {
      const record = { ...base, phase, at: NOW - 1_000 }
      expect(liveGameRegistration(record, NOW)).toEqual(record)
      expect(liveGameRegistration({ ...record, surface: "app" }, NOW)).toEqual({ ...record, surface: "app" })
    }
  })

  it("keeps the reason of a failed sign-up and nothing else that is not in the shape", () => {
    expect(liveGameRegistration({ ...base, phase: "failed", at: NOW, reason: "window-closed", extra: 1 }, NOW)).toEqual({
      ...base,
      phase: "failed",
      at: NOW,
      reason: "window-closed",
    })
    expect(liveGameRegistration({ ...base, phase: "failed", at: NOW, reason: 7 }, NOW)).toEqual({ ...base, phase: "failed", at: NOW })
  })

  it("drops a record older than the lifetime of its phase: one on its way a stopped surface left, one ended the chain has since caught up with", () => {
    expect(liveGameRegistration({ ...base, phase: "registering", at: NOW - REGISTERING_TTL_MS }, NOW)).not.toBeNull()
    expect(liveGameRegistration({ ...base, phase: "registering", at: NOW - REGISTERING_TTL_MS - 1 }, NOW)).toBeNull()
    expect(liveGameRegistration({ ...base, phase: "sent", at: NOW - SENT_TTL_MS }, NOW)).not.toBeNull()
    expect(liveGameRegistration({ ...base, phase: "sent", at: NOW - SENT_TTL_MS - 1 }, NOW)).toBeNull()
    for (const phase of ["registered", "failed"] as const) {
      expect(liveGameRegistration({ ...base, phase, at: NOW - ENDED_TTL_MS }, NOW)).not.toBeNull()
      expect(liveGameRegistration({ ...base, phase, at: NOW - ENDED_TTL_MS - 1 }, NOW)).toBeNull()
    }
  })

  it("drops a cleared or malformed record, and the record of the old chat-only contract", () => {
    expect(liveGameRegistration(null, NOW)).toBeNull()
    expect(liveGameRegistration(undefined, NOW)).toBeNull()
    expect(liveGameRegistration(7, NOW)).toBeNull()
    expect(liveGameRegistration({ ...base, phase: "registering", at: NOW, gameIndex: "7" }, NOW)).toBeNull()
    expect(liveGameRegistration({ ...base, phase: "registering", at: NOW, gameIndex: 7.5 }, NOW)).toBeNull()
    expect(liveGameRegistration({ ...base, phase: "busy", at: NOW }, NOW)).toBeNull()
    expect(liveGameRegistration({ ...base, phase: "registering", at: NOW, surface: "web" }, NOW)).toBeNull()
    expect(liveGameRegistration({ ...base, phase: "registering" }, NOW)).toBeNull()
    expect(liveGameRegistration({ gameIndex: 7, phase: "sent", at: NOW, attempt: 1 }, NOW)).toBeNull()
    expect(liveGameRegistration({ gameIndex: 7, phase: "registering", surface: "chat", at: NOW }, NOW)).toBeNull()
  })
})

describe("registrationInFlight", () => {
  it("is true for the two phases that age out and false for the ended ones and for no record", () => {
    expect(registrationInFlight({ phase: "registering" })).toBe(true)
    expect(registrationInFlight({ phase: "sent" })).toBe(true)
    expect(registrationInFlight({ phase: "registered" })).toBe(false)
    expect(registrationInFlight({ phase: "failed" })).toBe(false)
    expect(registrationInFlight(null)).toBe(false)
  })
})
