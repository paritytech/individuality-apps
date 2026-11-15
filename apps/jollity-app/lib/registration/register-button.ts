// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What the Register button says and whether it takes a tap, from the sign-up
 * phase the source puts on the status (lib/game-source.ts `signup`). A pure
 * function, so the screen renders one value and every state is testable.
 *
 * The first tap counts and the source sees the sign-up through, retrying
 * while the player can do nothing about what goes wrong, so the button never
 * goes back to "tap again": it shows what the player is waiting for. Once a
 * sign-up is under way it takes no more taps. The game reminder is the one
 * thing only the player can fix, so a sign-up the host gave no reminder for
 * leaves Register live with the notice, and the next tap asks the host again.
 */
import { cardCopy } from "@jollity/worker/card"
import type { SignupPhase } from "@individuality/sign-up"

export interface RegisterButton {
  label: string
  disabled: boolean
  /** a line to show with the button, when there is something to say */
  notice?: string
}

export const SLOW_NOTICE = "This is taking longer than usual. We're still trying."
export const CLOSED_NOTICE = "This game is about to start. See you at the next one."
export const REFUSED_NOTICE = "We couldn't sign you up for this game."
const HOST_CHAIN_NOTICE = "The Polkadot app lost its connection to the chain. Close the Polkadot app completely and open Jollity again."
const NAME_UNOWNED_NOTICE = cardCopy.NAME_UNOWNED
const NETWORK_NOTICE = "Jollity can't reach the network. Check your connection, then reopen Jollity."

const recoveryNotice = (message: string, closesAt?: string) =>
  `${message}${closesAt ? ` You can still join until ${closesAt}.` : ""}`

export function registerButton(phase: SignupPhase = "idle", registrationClosesAt?: string): RegisterButton {
  switch (phase) {
    case "idle":
      return { label: "Register", disabled: false }
    case "reminders":
      return { label: "Joining…", disabled: true }
    case "alarm-required":
    case "reminders-off":
      return { label: "Register", disabled: false, notice: cardCopy.NOTIFICATIONS_REQUIRED }
    case "waiting-seat":
      return { label: "Saving your seat…", disabled: true }
    case "sending":
    case "chat":
      return { label: "Joining…", disabled: true }
    case "slow":
      return { label: "Joining…", disabled: true, notice: SLOW_NOTICE }
    case "host-chain":
      return { label: "Joining…", disabled: true, notice: recoveryNotice(HOST_CHAIN_NOTICE, registrationClosesAt) }
    case "network":
      return { label: "Joining…", disabled: true, notice: recoveryNotice(NETWORK_NOTICE, registrationClosesAt) }
    case "name-unowned":
      return { label: "Register", disabled: true, notice: NAME_UNOWNED_NOTICE }
    case "closed":
      return { label: "Register", disabled: true, notice: CLOSED_NOTICE }
    case "refused":
      return { label: "Register", disabled: true, notice: REFUSED_NOTICE }
  }
}
