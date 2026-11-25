// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Whether the home shows I'll be there, and the line above it, from the
 * sign-up phase the source puts on the status (lib/game-source.ts `signup`).
 *
 * It works like the chat card. A tap hides the button at once, and while the
 * source sees the sign-up through the home shows nothing more. Only a sign-up
 * that went wrong says so. The game reminder is the one thing only the player
 * can fix, so a sign-up the host gave no reminder for brings I'll be there
 * back with the notice, and the next tap asks the host again.
 */
import { cardCopy } from "@jollity/worker/card"
import type { SignupPhase } from "@individuality/sign-up"

export interface RegisterButton {
  shown: boolean
  /** a line for the footer, when something went wrong or the reminder is missing */
  notice?: string
}

export const REGISTER_LABEL = cardCopy.ILL_BE_THERE
export const CLOSED_NOTICE = "This game is about to start. See you at the next one."
export const REFUSED_NOTICE = "We couldn't sign you up for this game."
const HOST_CHAIN_NOTICE = "The Polkadot app lost its connection to the chain. Close the Polkadot app completely and open Jollity again."
const NAME_UNOWNED_NOTICE = cardCopy.NAME_UNOWNED
const NETWORK_NOTICE = "Jollity can't reach the network. Check your connection, then reopen Jollity."

export function seatOpenLine(buttonOnScreen: boolean): string {
  return buttonOnScreen ? `Your seat is open. Tap ${REGISTER_LABEL} to take it.` : "Your seat is open."
}

const recoveryNotice = (message: string, closesAt?: string) =>
  `${message}${closesAt ? ` You can still join until ${closesAt}.` : ""}`

export function registerButton(phase: SignupPhase = "idle", registrationClosesAt?: string): RegisterButton {
  switch (phase) {
    case "idle":
      return { shown: true }
    case "alarm-required":
    case "reminders-off":
      return { shown: true, notice: cardCopy.NOTIFICATIONS_REQUIRED }
    case "reminders":
    case "waiting-seat":
    case "sending":
    case "chat":
    case "slow":
      return { shown: false }
    case "host-chain":
      return { shown: false, notice: recoveryNotice(HOST_CHAIN_NOTICE, registrationClosesAt) }
    case "network":
      return { shown: false, notice: recoveryNotice(NETWORK_NOTICE, registrationClosesAt) }
    case "name-unowned":
      return { shown: false, notice: NAME_UNOWNED_NOTICE }
    case "closed":
      return { shown: false, notice: CLOSED_NOTICE }
    case "refused":
      return { shown: false, notice: REFUSED_NOTICE }
  }
}
