// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export type CollectablesPicks = ReadonlyMap<string, number>

/** The host storage key of Jollity under which the collectables screen keeps the collection picked for each claim. */
export const JOLLITY_PICKS_KEY = "jollity.chest"
/** The key of the stash product under which Scarcity keeps its own picks, which win over Jollity's. */
export const STASH_PICKS_KEY = "stash.picks"

export function normalizeCreditHash(hash: string): string | null {
  const normalized = hash.trim().replace(/^0x/i, "").toLowerCase()
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null
}

/**
 * The JSON a host keeps under a key of another product, from the hex string its storage answers.
 *
 * The app reads the picks of Scarcity through product-sdk-host and the chat
 * worker through truapi, and both get the stored bytes back as hex.
 */
export function storedJSON(hex: string): unknown {
  const digits = hex.replace(/^0x/i, "")
  const bytes = new Uint8Array(digits.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16)
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** Keeps only the canonical wire entries accepted by Scarcity. */
export function parseCollectablesPicks(value: unknown): Map<string, number> {
  const picks = new Map<string, number>()
  if (typeof value !== "object" || value === null) return picks
  for (const [rawHash, rawPick] of Object.entries(value)) {
    const hash = normalizeCreditHash(rawHash)
    const collectionId = (rawPick as { collectionId?: unknown } | null)?.collectionId
    if (hash && typeof collectionId === "number" && Number.isInteger(collectionId) && collectionId >= 0) {
      picks.set(hash, collectionId)
    }
  }
  return picks
}

/** The shared JSON wire shape, with canonical prefixed credit hashes. */
export function collectablesValue(picks: ReadonlyMap<string, number>): Record<string, { collectionId: number }> {
  const value: Record<string, { collectionId: number }> = {}
  for (const [rawHash, collectionId] of picks) {
    const hash = normalizeCreditHash(rawHash)
    if (hash && Number.isInteger(collectionId) && collectionId >= 0) value[`0x${hash}`] = { collectionId }
  }
  return value
}

export function indexFor(hash: string, size: number): number {
  if (!Number.isInteger(size) || size <= 0) return 0
  const normalized = normalizeCreditHash(hash)
  if (!normalized) return 0
  let value = 0
  for (let offset = 0; offset < 16; offset += 2) {
    value = (value * 31 + Number.parseInt(normalized.slice(offset, offset + 2), 16)) >>> 0
  }
  return value % size
}

export function defaultCollectionFor(hash: string, offered: readonly number[]): number | undefined {
  if (offered.length === 0) return undefined
  return offered[indexFor(hash, offered.length)]
}

export interface CollectionSources {
  swap?: number
  jollity?: number
  favourite?: number
}

/** Scarcity's selection precedence over one explicit ordered offered snapshot. */
export function collectionFor(
  hash: string,
  offered: readonly number[],
  sources: CollectionSources = {},
): number | undefined {
  for (const candidate of [sources.swap, sources.jollity, sources.favourite]) {
    if (candidate !== undefined && offered.includes(candidate)) return candidate
  }
  return defaultCollectionFor(hash, offered)
}
