// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { CLOSED_NOTICE, REFUSED_NOTICE, registerButton, SLOW_NOTICE } from "./register-button"

describe("the register button", () => {
  it("is pressable before any tap, and when the phase is not known", () => {
    expect(registerButton("idle")).toEqual({ label: "Register", disabled: false })
    expect(registerButton()).toEqual({ label: "Register", disabled: false })
  })
  it("shows what the player is waiting for, and takes no more taps", () => {
    expect(registerButton("waiting-seat")).toEqual({ label: "Saving your seat…", disabled: true })
    expect(registerButton("sending")).toEqual({ label: "Joining…", disabled: true })
    expect(registerButton("chat")).toEqual({ label: "Joining…", disabled: true })
    expect(registerButton("reminders")).toEqual({ label: "Joining…", disabled: true })
  })
  it.each(["alarm-required", "reminders-off"] as const)("takes the next tap when the host gave no game reminder, and says why: %s", (phase) => {
    expect(registerButton(phase)).toEqual({
      label: "Register",
      disabled: false,
      notice: "Enable notifications to register.",
    })
  })
  it("says it is taking longer when it is", () => {
    expect(registerButton("slow")).toEqual({ label: "Joining…", disabled: true, notice: SLOW_NOTICE })
  })
  it("explains how to recover when the host chain client stays broken", () => {
    expect(registerButton("host-chain", "23:45")).toEqual({
      label: "Joining…",
      disabled: true,
      notice: "The Polkadot app lost its connection to the chain. Close the Polkadot app completely and open Jollity again. You can still join until 23:45.",
    })
  })
  it("explains how to recover when the network stays unavailable", () => {
    expect(registerButton("network", "23:45")).toEqual({
      label: "Joining…",
      disabled: true,
      notice: "Jollity can't reach the network. Check your connection, then reopen Jollity. You can still join until 23:45.",
    })
  })
  it("says the username is not registered, with Register off until it is", () => {
    expect(registerButton("name-unowned", "23:45")).toEqual({
      label: "Register",
      disabled: true,
      notice: "Your username isn't registered. Open your membership card to set it up.",
    })
  })
  it("says so when registration has closed", () => {
    expect(registerButton("closed")).toEqual({ label: "Register", disabled: true, notice: CLOSED_NOTICE })
  })
  it("says so when the chain refused for good", () => {
    expect(registerButton("refused")).toEqual({ label: "Register", disabled: true, notice: REFUSED_NOTICE })
  })
})
