// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* the URL, read once. A scene gets this and takes what it knows; nothing here
   knows any param's name. int() clamps and keeps 0 as a value (?swing=0);
   pick() takes the value only if it is one the caller lists. */

export function readUrl(search = location.search) {
  const q = new URLSearchParams(search)
  return {
    q,
    has: (k) => q.has(k),
    get: (k) => q.get(k),
    int(k, lo, hi, d) {
      const v = parseInt(q.get(k), 10)
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d
    },
    pick: (k, list, d) => (q.has(k) && list.includes(q.get(k)) ? q.get(k) : d),
  }
}
