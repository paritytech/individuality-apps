// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { CLOSED_NOTICE, REFUSED_NOTICE, REGISTER_LABEL, registerButton, seatOpenLine } from "./register-button"

describe("the register button", () => {
  it("says I'll be there, as the chat card does", () => {
    expect(REGISTER_LABEL).toBe("I'll be there")
  })
  it("shows before any tap, and when the phase is not known", () => {
    expect(registerButton("idle")).toEqual({ shown: true })
    expect(registerButton()).toEqual({ shown: true })
  })
  it.each(["reminders", "waiting-seat", "sending", "chat", "slow"] as const)("is gone with nothing in its place while the sign-up goes: %s", (phase) => {
    expect(registerButton(phase)).toEqual({ shown: false })
  })
  it.each(["alarm-required", "reminders-off"] as const)("comes back for the next tap when the host gave no game reminder, and says why: %s", (phase) => {
    expect(registerButton(phase)).toEqual({ shown: true, notice: "Enable notifications to join game." })
  })
  it("explains how to recover when the host chain client stays broken", () => {
    expect(registerButton("host-chain", "23:45")).toEqual({
      shown: false,
      notice: "The Polkadot app lost its connection to the chain. Close the Polkadot app completely and open Jollity again. You can still join until 23:45.",
    })
  })
  it("explains how to recover when the network stays unavailable", () => {
    expect(registerButton("network", "23:45")).toEqual({
      shown: false,
      notice: "Jollity can't reach the network. Check your connection, then reopen Jollity. You can still join until 23:45.",
    })
  })
  it("says the username is not registered", () => {
    expect(registerButton("name-unowned", "23:45")).toEqual({
      shown: false,
      notice: "Your username isn't registered. Open your membership card to set it up.",
    })
  })
  it("says so when registration has closed", () => {
    expect(registerButton("closed")).toEqual({ shown: false, notice: CLOSED_NOTICE })
  })
  it("says so when the chain refused for good", () => {
    expect(registerButton("refused")).toEqual({ shown: false, notice: REFUSED_NOTICE })
  })
})

describe("the seat open line works", () => {
  it("tells the player to tap I'll be there while it shows", () => {
    // Given
    const { shown } = registerButton("idle")
    // When
    const line = seatOpenLine(shown)
    // Then
    expect(line).toBe("Your seat is open. Tap I'll be there to take it.")
  })
  it.each(["sending", "closed"] as const)("names no button once it is gone: %s", (phase) => {
    // Given
    const { shown } = registerButton(phase)
    // When
    const line = seatOpenLine(shown)
    // Then
    expect(line).toBe("Your seat is open.")
  })
})
