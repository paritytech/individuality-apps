// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE CHEST AS THE PAYOFF NAMES IT — the outcome the chest screen hands
 * lib/journeys/payoff-facts `chestFacts` (lib/chest/chest-screen factsOf).
 */
import type { ChestEmptyReason } from "../chest-reason"
import type { ChestItem } from "../game-source"

export type ChestViewState =
  | { kind: "loading" }
  | { kind: "no-identity" }
  /** `reason`: why it is empty, narrowed from the chain (lib/chest-reason) */
  | { kind: "empty"; gameIndex: number | null; reason: ChestEmptyReason }
  | { kind: "on-the-way"; gameIndex: number | null }
  | { kind: "pocketed"; gameIndex: number | null }
  | { kind: "pruned"; gameIndex: number | null; unprovable: number }
  /** the bounded first read failed; later reads continue until host health decides */
  | { kind: "retrying"; gameIndex: number | null }
  /** the shared host-health recovery card stands in for the chest */
  | { kind: "restart"; gameIndex: number | null; reason: "host-unanswered" | "chain-lost" }
  | {
      kind: "ready"
      gameIndex: number | null
      seed: string
      items: ChestItem[]
      partial?: boolean
      /** read before the game settled: the settle may add the rest of the credits */
      settling?: boolean
    }
