// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export type Tier = string

export const DEFAULT_RARITIES = "100=common,200=uncommon,300=rare,400=legendary"

/** Parses the collection's comma-separated numeric-level rarity table. */
export function parseRarities(value?: string): Map<number, Tier> {
  const rarities = new Map<number, Tier>()
  for (const part of value?.split(",") ?? []) {
    const [rawLevel, rawName] = part.split("=")
    const levelText = rawLevel?.trim() ?? ""
    const level = Number(levelText)
    const name = rawName?.trim() ?? ""
    if (/^\d+$/.test(levelText) && Number.isSafeInteger(level) && name) rarities.set(level, name)
  }
  return rarities
}

/** Resolves numeric rarity values while preserving legacy named values. */
export function rarityName(
  rarity: string | number | null | undefined,
  rarities: ReadonlyMap<number, Tier>,
): Tier | undefined {
  if (rarity === null || rarity === undefined) return undefined
  if (typeof rarity === "number") return rarities.get(rarity)
  const value = rarity.trim()
  if (!value) return undefined
  if (/^\d+$/.test(value)) return rarities.get(Number(value))
  return value
}

function levelOf(tier: string | undefined, rarities: ReadonlyMap<number, Tier>): number | undefined {
  if (!tier) return undefined
  const wanted = tier.trim().toLowerCase()
  for (const [level, name] of rarities) if (name.trim().toLowerCase() === wanted) return level
  return undefined
}

/** Unknown tiers compare equal, matching Scarcity's conservative behavior. */
export function compareRarities(
  a: string | undefined,
  b: string | undefined,
  rarities: ReadonlyMap<number, Tier>,
): number {
  const aLevel = levelOf(a, rarities)
  const bLevel = levelOf(b, rarities)
  return aLevel === undefined || bLevel === undefined ? 0 : aLevel - bLevel
}

export function effectiveRarities(value?: string): Map<number, Tier> {
  const parsed = parseRarities(value)
  return parsed.size > 0 ? parsed : parseRarities(DEFAULT_RARITIES)
}

export function rarerThanCommonest(tier: string | undefined, rarities: ReadonlyMap<number, Tier>): boolean {
  if (!tier || rarities.size === 0) return false
  const first = [...rarities].sort(([a], [b]) => a - b)[0]?.[1]
  return compareRarities(tier, first, rarities) > 0
}
