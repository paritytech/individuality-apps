// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The player's name on the prize draw: the DotNS reader (./dotns-names.ts),
 * the link of a username to the playing account with its deposit in PGAS and
 * the read of a link already there (./link.ts), and the gate a sign-up waits
 * on until the name is linked (./name-gate.ts).
 */
export {
  DOTNS_CONTRACTS,
  dotnsNames,
  fullUsernameSet,
  peopleNames,
  reviveCall,
  usernameOwner,
  type ContractCall,
  type NameLookup,
  type NameReason,
  type PeopleName,
} from "./dotns-names"
export { linkName, type LinkOutcome, type LinkStage, type NameLink } from "./link"
export {
  createNameGate,
  NAME_LINK_GRACE_MS,
  NAME_LINK_TIMEOUT_MS,
  NAME_TAP_RETRY_MS,
  NAME_TAP_WAIT_MS,
  NAME_UNOWNED_RECHECK_MS,
  NAME_UNOWNED_RETRY_MS,
  type NameGate,
  type NameGateOptions,
  type NameLinkResult,
  type NameLinkTrigger,
} from "./name-gate"
