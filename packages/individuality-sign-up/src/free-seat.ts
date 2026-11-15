// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The flow's own bind policy, beside the SDK's (`bindGameSeat` decides what a
 * refusal means, `registrationRetryDelay` how long to wait before the next):
 *
 *  - How long one attempt may take. The SDK's bind waits for a block, but
 *    the proof prompt and the reads before it have no deadline of their own,
 *    and a dead host channel answers none of them: without one the seat reads
 *    "preparing" for ever.
 *  - Which seat read is the newest. Seat reads are async and overlap. One
 *    started before the bind landed can arrive after one started after it,
 *    and would put "preparing" back on a seat that is ready.
 */

/** one attempt's deadline: long enough for a slow block (the bind waits for
 *  a BEST block, ~12 s a block on the People chain, plus the proof and the
 *  reads before it), short enough to recover from a host channel that died
 *  under the watch */
export const BIND_TIMEOUT_MS = 120_000

/**
 * A monotonic sequence over overlapping reads: `next()` numbers a read as it
 * starts, `apply(seq)` says whether its result is still the newest — and
 * remembers it if so. A result older than the last one applied is dropped.
 */
export interface ReadSequence {
  next(): number
  apply(seq: number): boolean
}

export function readSequence(): ReadSequence {
  let issued = 0
  let applied = 0
  return {
    next: () => ++issued,
    apply(seq) {
      if (seq <= applied) return false
      applied = seq
      return true
    },
  }
}
