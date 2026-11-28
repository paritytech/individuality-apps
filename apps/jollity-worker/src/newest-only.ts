// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Paces the answers to a gesture's moves.
 *
 * A host that paces a keyed pan sends at most one move a display frame, and
 * none while the last one is unanswered. `newestOnly` answers the newest move
 * the worker holds once the moves already delivered have been read: a move
 * offered while another waits replaces it, so a slow worker answers where the
 * finger is now and never works through a backlog.
 */
export function newestOnly<T>(answer: (value: T) => void, schedule: (flush: () => void) => void = (flush) => void setTimeout(flush, 0)) {
  let waiting: { value: T } | null = null
  const flush = () => {
    const next = waiting
    waiting = null
    if (next) answer(next.value)
  }
  return {
    offer(value: T) {
      if (!waiting) schedule(flush)
      waiting = { value }
    },
    /** Forgets the waiting value: the pan ended, and its end carries the final position. */
    drop() {
      waiting = null
    },
  }
}
