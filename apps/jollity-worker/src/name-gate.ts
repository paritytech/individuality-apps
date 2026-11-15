// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE NAME LINK OF THE CHAT, in the background (#456): the player's username
 * linked to the jollity account that holds their draw tickets before Register
 * signs anything, as the app does (lib/game-source.ts).
 *
 * The gate is @individuality/name-link's, the one the app runs too: a sign-up
 * never goes without the name; one link at a time, asked for from the poll
 * whenever a game is open or scheduled, and again on the ladder after any link
 * that did not end linked; a Register tap that waits on it asks at once, past
 * the ladder, and waits at most NAME_TAP_WAIT_MS (a worker cannot hold the
 * card busy for the whole registration window). This hands it the chat's
 * link, the SDK's retry ladder and the worker's log.
 *
 * The state is the worker's: a new worker asks again, and a name already
 * linked answers `already-linked` from the link's first read.
 */
import { createNameGate as createGate, type NameGate, type NameLinkResult, type NameLinkTrigger } from "@individuality/name-link"
import { registrationRetryDelay } from "@parity/product-sdk-individuality"

export function createNameGate(
  link: (trigger: NameLinkTrigger, signal: AbortSignal) => Promise<NameLinkResult>,
  log?: (kind: "info" | "error", text: string) => void,
): NameGate {
  return createGate({
    link,
    retryDelay: registrationRetryDelay,
    onOutcome: (outcome, _failures, retryInMs) => {
      if (retryInMs !== null) log?.("info", `The name link ended ${outcome ?? "out of time"}; trying again in ${retryInMs / 1000}s.`)
    },
  })
}
