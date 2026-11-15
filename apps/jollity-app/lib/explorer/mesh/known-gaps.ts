// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Known differences (P1b and L1, room.ts checkLiveness): a monitor that
 * finds a difference whose detail contains an entry's `match` (or, for an
 * `exact` entry, equals it) reports it
 * as that gap, with its issue number, and not as a violation. Every entry
 * needs a filed issue. A P1b entry is always exact, one PC and one pair of remotes.
 */
export interface KnownGap {
  property: "P1b" | "L1"
  /** a substring of the monitor's detail, or with `exact` the whole detail */
  match: string
  exact?: boolean
  issue: number
  note: string
}

/** Empty: the three lastAttemptAt gaps once listed here (#1458) closed when
 *  every fact, completions included, carried Mesh's clock. */
export const KNOWN_GAPS: KnownGap[] = []

/** The gap a monitor's finding matches. */
export function findGap(property: KnownGap["property"], detail: string, gaps: readonly KnownGap[] = KNOWN_GAPS): KnownGap | undefined {
  return gaps.find((entry) => entry.property === property && (entry.exact ? detail === entry.match : detail.includes(entry.match)))
}

/** throws on an entry that is not a well-formed gap; above all, on one whose issue is not a positive integer */
export function validateGaps(gaps: readonly unknown[]): void {
  gaps.forEach((gap, index) => {
    const entry = gap as Partial<KnownGap> | null
    if (!entry || typeof entry !== "object") throw new Error(`known gap ${index}: not an object`)
    if (entry.property !== "P1b" && entry.property !== "L1") throw new Error(`known gap ${index}: property must be P1b or L1`)
    if (entry.property === "P1b" && entry.exact !== true) throw new Error(`known gap ${index}: a P1b gap must be exact (one PC, one pair of remotes)`)
    if (entry.property === "L1" && entry.exact !== true) throw new Error(`known gap ${index}: an L1 gap must be exact (one stuck shape)`)
    if (typeof entry.match !== "string" || entry.match.length === 0) throw new Error(`known gap ${index}: match must be a non-empty string`)
    if (typeof entry.issue !== "number" || !Number.isInteger(entry.issue) || entry.issue <= 0) throw new Error(`known gap ${index}: issue must be a positive integer (got ${String(entry.issue)})`)
    if (typeof entry.note !== "string") throw new Error(`known gap ${index}: note must be a string`)
  })
}

validateGaps(KNOWN_GAPS)
