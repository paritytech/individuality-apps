// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The game clock (the device clock plus the peer offset), as the doorway
 * (lib/game-source.ts) last set it, for readers that are not the game. It is not
 * the chain's time. Telemetry places a journey on the chain with the block
 * number. The source writes, everyone else reads, so production code never imports
 * a debug module. The block number lives in its own variable and is read
 * directly: a new best block every ~6 s must not wake anything, and nothing
 * here notifies. (The debug view keeps its own snapshot, lib/debug/clock.ts.)
 *
 * The module name and the `chain*` names (`chainNowMs`, `ChainClock`,
 * `setChainNow`) are historical: they date from when the clock followed block
 * time. Read "chain" here as "game" everywhere except the block number and the
 * chain gap.
 */

export interface ChainClock {
  /** game seconds minus wall seconds, the value every countdown adds */
  offset: number
  /** the best block number the source last saw; null before one */
  block: number | null
}

let anchor: { offset: number } | null = null
/** the doorway's game clock in ms, once it has one (lib/game-source.ts) */
let chainNow: (() => number | null) | null = null
let block: number | null = null
/** device ms minus block ms at the last live block; null before one */
let chainGap: number | null = null

/** The doorway moved its offset. */
export function setChainOffset(offset: number | undefined): void {
  anchor = { offset: offset ?? anchor?.offset ?? 0 }
}

/** The doorway saw a new best block. */
export function setChainBlock(number: number): void {
  block = number
}

/** The clock as it stands; null until the first anchor. */
export function readChainClock(): ChainClock | null {
  return anchor ? { ...anchor, block } : null
}

/** The doorway registers its game clock (null to drop it). */
export function setChainNow(read: (() => number | null) | null): void {
  chainNow = read
}

/**
 * The game time in ms: the step-free device clock plus the peer offset, not the
 * chain's time. No wall step moves it, and it never moves back. Null before the
 * doorway registers it.
 */
export function chainNowMs(): number | null {
  return chainNow?.() ?? null
}

/**
 * The doorway measured the chain gap at a block: the step-free device clock (lib/device-clock.ts
 * `deviceNowMs`) minus the block time, ms. It does not move the game clock. Its one
 * reader is the TURN proof stamp, which the issuer judges against true time (#1397).
 */
export function setChainGapMs(gapMs: number): void {
  chainGap = gapMs
}

/** The last chain gap in ms (device minus block), or null before the first block. */
export function readChainGapMs(): number | null {
  return chainGap
}

export function resetChainClockForTests(): void {
  anchor = null
  chainNow = null
  block = null
  chainGap = null
}
