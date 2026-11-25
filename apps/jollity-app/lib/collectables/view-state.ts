// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE COLLECTABLES SCREEN AS THE PAYOFF NAMES IT — the outcome the collectables screen hands
 * lib/journeys/payoff-facts `collectablesFacts` (lib/collectables/collectables-screen factsOf).
 */
import type { CollectablesEmptyReason } from "../collectables-reason"
import type { CollectablesItem } from "../game-source"

export type CollectablesViewState =
  | { kind: "loading" }
  | { kind: "no-identity" }
  /** `reason`: why it is empty, narrowed from the chain (lib/collectables-reason) */
  | { kind: "empty"; gameIndex: number | null; reason: CollectablesEmptyReason }
  | { kind: "on-the-way"; gameIndex: number | null }
  | { kind: "voting"; gameIndex: number | null }
  | { kind: "pocketed"; gameIndex: number | null }
  | { kind: "pruned"; gameIndex: number | null; unprovable: number }
  /** the bounded first read failed; later reads continue until host health decides */
  | { kind: "retrying"; gameIndex: number | null }
  /** the shared host-health recovery card stands in for the collectables screen */
  | { kind: "restart"; gameIndex: number | null; reason: "host-unanswered" | "chain-lost" }
  | {
      kind: "ready"
      gameIndex: number | null
      seed: string
      items: CollectablesItem[]
      partial?: boolean
      /** read before the game settled: the settle may add the rest of the credits */
      settling?: boolean
    }
