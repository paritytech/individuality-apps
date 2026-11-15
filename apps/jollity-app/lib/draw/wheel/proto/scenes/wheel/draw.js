// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE DRAW RULE — the chain's own, cut down to what a flat wheel needs: the
   ticket values, the ring they sort into, the target, and the ranking. The
   wheel is flat and has no orbits, so there is no second SHA-256 per
   ticket, which is what lets n = 5000 rebuild in a blink.

   No imports and no DOM: this file runs unchanged under `node -e`.

   The rule, from pallets/airdrop/src/lib.rs L590-726 @ 4b606a31e2eb:

     value_i = SHA256("jollity/v1/ticket" || seed || uint32_be(i))
     target  = SHA256("jollity/v1/axis"   || entropy)
     f_i     = (value_i - target) mod 2^256          forward distance ONLY
     winners = the N smallest f_i

   "Closest" is shorthand: the runtime takes the next clockwise ticket, not
   absolute distance on both sides of the target. A picture that shows
   two-sided distance is showing an algorithm that is not running.

   Entropy is structurally unreachable from the layout — buildRing takes no
   entropy argument of any kind, ever, and the target lives only behind
   targetFor(), which nothing above it calls. That is a fact about which
   functions have which parameters, not a convention, and the smoke suite
   asserts it by reading this source back. */

export const DOMAINS = {
  ticket: 'jollity/v1/ticket',
  axis: 'jollity/v1/axis',
}

const utf8 = (s) => new TextEncoder().encode(s)

function concatBytes(...parts) {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

// lexicographic on bytes = numeric on the big-endian 256-bit integer
function compareBytes(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function bytesToBigInt(bytes) {
  let v = 0n
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i])
  return v
}

// SHA-256 over raw bytes, async — globalThis.crypto.subtle exists in both
// Node >= 20 and the browser, so this module runs unchanged in either.
export async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return new Uint8Array(digest)
}

/* value_i = SHA256("jollity/v1/ticket" || seed || uint32_be(i)), one per
   ticket. The only source of ticket values: the sort order over these is the
   ring, and the ring is what the draw cuts. */
export async function ticketValues(seed, n) {
  const domain = utf8(DOMAINS.ticket)
  const seedBytes = utf8(String(seed))
  const jobs = new Array(n)
  for (let i = 0; i < n; i++) {
    const idxBytes = new Uint8Array(4)
    new DataView(idxBytes.buffer).setUint32(0, i, false)
    jobs[i] = sha256(concatBytes(domain, seedBytes, idxBytes))
  }
  return Promise.all(jobs)
}

/* the ring: every ticket's value, the sort order over them, and the inverse.
   `order[k]` is the ticket at sorted position k — which IS the wheel's slot k,
   walked in rank order, never a second sort. `idxOf[i]` is ticket i's slot.
   No entropy parameter, structurally. */
export async function buildRing({ seed, n }) {
  const values = await ticketValues(seed, n)
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => compareBytes(values[a], values[b]))
  const idxOf = new Int32Array(n)
  for (let k = 0; k < n; k++) idxOf[order[k]] = k
  return { n, seed, values, order, idxOf }
}

/* JOLLITY: the ring from the chain's own ticket slots (Airdrop.Registrations
   keys, 32 bytes each) instead of hashing a seed. Same shape as buildRing, so
   ranksFor and the layout cannot tell the difference. Ticket 0 is the player's,
   as buildRing's ticket 0 is "you". Jollity's change. */
export function ringFromValues(values) {
  const n = values.length
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => compareBytes(values[a], values[b]))
  const idxOf = new Int32Array(n)
  for (let k = 0; k < n; k++) idxOf[order[k]] = k
  return { n, seed: 'chain', values, order, idxOf }
}

/* the only path to a target. Nothing above this line references it or the
   axis domain — a ring is complete and placeable without it ever running. */
export async function targetFor(entropy) {
  const bytes = typeof entropy === 'string' ? utf8(entropy) : entropy
  return sha256(concatBytes(utf8(DOMAINS.axis), bytes))
}

// f_i = (value_i - target) mod 2^256 — the forward distance, as a 256-bit
// subtraction. The smoke suite sorts on this to check ranksFor's shortcut.
export function forwardDistance(value, target) {
  const mod = 1n << 256n
  return (bytesToBigInt(value) - bytesToBigInt(target) + mod) % mod
}

/* ranking collapses to a rotation: with the tickets already sorted by value,
   `cut` is the first sorted position whose value >= target (n, wrapping to 0,
   if none), and rank_i = (idx_i - cut) mod n. One binary search, then O(1) per
   ticket — and it is exactly "start at the target and walk clockwise", which
   is why the winners are slots cut … cut+N-1: one adjacent run, always. */
export function ranksFor(ring, target, winners) {
  const { n, order, idxOf, values } = ring
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compareBytes(values[order[mid]], target) >= 0) hi = mid
    else lo = mid + 1
  }
  const cut = lo

  const rank = new Int32Array(n)
  const isWinner = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const r = (idxOf[i] - cut + n) % n
    rank[i] = r
    isWinner[i] = r < winners ? 1 : 0
  }
  const firstLoser = order[(cut + winners) % n]
  return { cut, rank, isWinner, firstLoser }
}
