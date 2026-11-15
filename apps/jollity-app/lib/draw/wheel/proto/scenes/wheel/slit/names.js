// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* WHO'S PLAYING — the names, who is in the row, and where a name sits over
   its ticket. Pure: no DOM, no canvas (the row is legend.js, the scene feeds
   it), so the suite checks the rules in node.

   A name is a handle dealt from the draw's seed, the same every time for the
   same ticket: a word, and sometimes a two-digit tag (REDHERRING.07). Yours
   is YOU. */

const WORDS = [
  'redherring', 'gustav', 'valentina', 'martin', 'rva11', 'verissimo', 'dan', 'may', 'nova', 'pixelfox',
  'orbit', 'saffron', 'kestrel', 'lumen', 'juniper', 'atlas', 'marlow', 'quill', 'tamsin', 'odile',
  'brick', 'cosmo', 'wren', 'ingrid', 'basil', 'zephyr', 'hollis', 'magpie', 'otto', 'pearl',
  'rufus', 'sable', 'tilde', 'ursa', 'vesper', 'wilder', 'yarrow', 'zola', 'arlo', 'bixby',
  'clover', 'dex', 'ember', 'fennel', 'goose', 'hazel', 'iris', 'jett', 'kit', 'lark',
]

/* a 32-bit hash of a string (FNV-1a) — the seed and the slot together */
function hash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function nameFor(seed, k) {
  const h = hash(`${seed}:${k}`)
  const w = WORDS[h % WORDS.length].toUpperCase()
  const tag = (h >>> 8) % 3 === 0 ? '' : `.${String((h >>> 12) % 100).padStart(2, '0')}`
  return w + tag
}

/* AT MOST 100 in the row, for the page's sake: every winner and you first,
   then the rest by how near the wedge's middle they rest (nearest first —
   those are the ones on the stage). In the row they go ROUND THE RING, as
   their tickets rest: clockwise from six o'clock — up the left, over the
   top (the wedge's winners left to right), down the right — and the row is
   a ring too (legend.js wraps it), so from any name to any other it slides
   the short way round. pos(k) → {x, y} at rest; hub the wheel's middle */
export const ROW_MAX = 100
const TAU = Math.PI * 2
export const roundFrom6 = (p, hub) => (((Math.atan2(p.y - hub.y, p.x - hub.x) - Math.PI / 2) % TAU) + TAU) % TAU
export function rowFor({ n, mine, winners, pos, focus, hub }) {
  const pick = new Set([...winners, mine])
  const rest = []
  for (let k = 0; k < n; k++) if (!pick.has(k)) rest.push(k)
  const d = (k) => {
    const p = pos(k)
    return Math.hypot(p.x - focus.x, p.y - focus.y)
  }
  rest.sort((a, b) => d(a) - d(b))
  for (const k of rest) {
    if (pick.size >= ROW_MAX) break
    pick.add(k)
  }
  const round = (k) => roundFrom6(pos(k), hub)
  return [...pick].sort((a, b) => round(a) - round(b))
}

/* the row's offset for name i, the nearest of its turns round the ring to
   where the row is now (span: once round; 0, a row that does not wrap) */
export const nearestTurn = (x, now, span) => (span > 0 ? x + span * Math.round((now - x) / span) : x)

/* WHERE THE ROW SITS so name i is over its ticket: its middle over the
   ticket's x. A name that would then come nearer the stage's edge than SIDE
   is held by its edge to the ticket's middle instead (its left edge, by the left of the stage;
   its right, by the right) — so the line down to the ticket runs from the
   end of its underline, a corner; a ticket
   off the stage itself, the name SIDE px in from the stage's edge. Returns
   the row's offset, nominal px. box: [left, width] in the row; t: {x, r} */
export const SIDE = 24
export function rowXFor(box, t, W) {
  const [left, w] = box
  let at = t.x - w / 2 // where the name's left edge goes
  if (t.x < 0) at = SIDE
  else if (t.x > W) at = W - SIDE - w
  else if (at < SIDE) at = Math.max(0, t.x)
  else if (at + w > W - SIDE) at = Math.min(W, t.x) - w
  return at - left
}
