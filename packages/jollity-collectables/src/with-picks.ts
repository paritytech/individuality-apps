// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ChestItem } from "./chest"
import { normalizeCreditHash, type ChestPicks } from "./picks"

/** Deals each claim as the item of its picked collection, or as it came when that collection is not on offer. */
export function withPicks(items: ChestItem[], picks: ChestPicks, stashPicks: ChestPicks = new Map()): ChestItem[] {
  return items.map((item) => {
    const hash = normalizeCreditHash(item.hash)
    if (!hash) return item
    const stash = stashPicks.get(hash)
    const jollity = picks.get(hash)
    const storedStashChoice = stash === undefined ? undefined : item.choices.find((choice) => choice.collectionId === stash)
    const stashChoice = storedStashChoice ?? (item.selectionSource === "stash" ? item.choices[0] : undefined)
    const jollityChoice = jollity === undefined ? undefined : item.choices.find((choice) => choice.collectionId === jollity)
    const picked = stashChoice ?? jollityChoice
    if (!picked) return item
    return {
      ...item,
      name: picked.name,
      tier: picked.tier,
      rarity: picked.rarity,
      image: picked.image,
      collection: picked.collection,
      selectionSource: stashChoice ? "stash" : "jollity",
      choices: [picked, ...item.choices.filter((choice) => choice !== picked)],
    }
  })
}

/** Scarcity owns its selected collection; Jollity must not fork that choice. */
export function canChangePick(item: ChestItem): boolean {
  return item.selectionSource !== "stash"
}
