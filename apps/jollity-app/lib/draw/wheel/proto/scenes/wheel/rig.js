// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE OUTCOME DIAL'S WALK — which draw comes next, when the page has been
   told how it must come out.

   A draw is `${base}/${no}`, hashed by the chain's own rule (draw.js). With
   no outcome wanted it is simply the next in the sequence. With one wanted
   (a win, or a loss) it walks the same sequence from there and stops at the
   first draw that comes out that way for your ticket (ticket 0) — so every
   entropy it hands back is still a genuine member of the sequence; the draw
   number just skips the others. It never touches the seed: a new seed is a
   new ticket list, and your disc would move right after the coin landed on
   it. One hash and a binary search a try — at 6 in 420 that is ~70.

   A module of its own (entropyFrom, wantFor and fresh), so the slit page
   (slit/scene.js) can run it. The one import is draw.js, which takes none,
   so this loads bare in node. */

import { targetFor, ranksFor } from './draw.js'

/* the outcome dial as the walk reads it: must win, must lose, or either */
export const wantFor = (outcome) => (outcome === 'only wins' ? true : outcome === 'only lost' ? false : null)

/* a seed or an entropy nobody chose: 16 hex digits of real randomness */
export const fresh = () => {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return [...b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/* ring     draw.js's buildRing — the ticket list
   base     the entropy base: draw `no` is `${base}/${no}`
   from     the first draw number to try
   want     true (a win), false (a loss) or null (whatever comes)
   winners  how many the wedge takes
   alive()  false once the caller has moved on (a new list mid-walk): it stops
   → { no, entropy, target } */
export async function entropyWalk({ ring, base, from, want, winners, tries = 20000, alive = () => true }) {
  const plain = async (i) => {
    const entropy = `${base}/${i}`
    return { no: i, entropy, target: await targetFor(entropy) }
  }
  if (want == null || !ring || ring.n < 1) return plain(from)
  const slot = ring.idxOf[0]
  const n = ring.n
  const w = Math.max(1, Math.min(winners, n))
  for (let i = from; i < from + tries; i++) {
    const r = await plain(i)
    if (!alive()) break
    if (((slot - ranksFor(ring, r.target, w).cut + n) % n < w) === want) return r
  }
  return plain(from) // nothing in reach: the plain next draw, rather than none
}
