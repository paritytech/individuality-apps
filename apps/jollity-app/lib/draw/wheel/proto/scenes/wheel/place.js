// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* WHERE THE TICKETS SIT — three answers, one interface.

   The draw is draw.js's and is the chain's: a cut, then the next N tickets
   clockwise. So every ticket already wins with probability N/n whatever this
   file does. What a placement decides is whether the picture can SHOW that
   run as one fixed wedge — and that is what the dial is for.

   The rule all three keep: slot k sits at k·(2pi/n), so each ticket owns its
   own equal slice of the circle and a wedge of N·(2pi/n) holds exactly N of
   them, contiguous, at every stopping point, with no exceptions. They differ
   only in the RADIUS, which is free.

     one ring        every ticket on one circle. Readable to ~150,
                     and the clearest statement of the rule there is.
     rings, spread   the visualisation's: L rings, discs per ring in
                     proportion to its circumference, and the slots dealt
                     out so each ring's discs sit as evenly round it as the
                     shared k·(2pi/n) grid allows. Even density, visible bands.
     sunflower       the Fibonacci trick with the roles swapped. Phyllotaxis
                     puts equal radial steps at the golden ANGLE; we cannot
                     touch the angle without giving up the rule above, so the
                     golden ratio goes into the radius instead. The field comes
                     out even with no bands, and the discs sit 2-3x further
                     apart than rings do at the same n (4.7 px vs 1.5 px at
                     n=2000 in a 390 px frame). It is the only thing here that
                     moves the wheel's capacity ceiling.

   A fourth, "rings in order" — one ring filled completely before the next, at
   the on-ring pitch 2pi/per — was built and dropped. It keeps the winners
   adjacent on a rim, but the wedge can no longer be a pie slice (a full-radius
   slice crosses every other ring at the same angle), and a run wrapping
   n-1 -> 0 through the short last ring is uncoverable by any rotation. */

const TAU = Math.PI * 2
const PHI_INV = 0.6180339887498949 // 1/phi

/* WHICH WAY IT TURNS. Slot k is drawn at theta[k] + SPIN·phi, and phi only
   ever grows — the landing solves for a positive total and the hold winds one
   way — so the sense of rotation lives here and nowhere else. -1 is clockwise,
   which is the way a wheel of this kind is read. Everything that puts a slot
   on the screen (paint.js, the hit test, targetAngle, underWedge) goes through
   it; the wedge does not, because it never moves. */
export const SPIN = -1
const wrap = (a) => ((a % TAU) + TAU) % TAU
const signed = (a) => wrap(a + Math.PI) - Math.PI // into (-pi, pi]

export const PLACEMENTS = ['one ring', 'rings, spread', 'sunflower']
export const DEFAULT_PLACEMENT = 'one ring'

/* WHERE THE RINGS SIT, between the rim and the hole:
     from edge   the outermost on the rim and each next one `ringStep` (a
                 share of the rim) further in — packed at the edge, so a few
                 rings are a band at the rim, not spread down to the hole. Never
                 past the hole: a step that would take them there is spread.
     spread      from the hole to the rim, evenly. */
export const RING_POSITIONS = ['from edge', 'spread']

/* the ring count actually used: rounded, at least 1, never more than there
   are tickets. Only the ringed placement has any. */
export const ringsFor = (kind, n, rings) => (kind === 'rings, spread' ? Math.max(1, Math.min(Math.round(rings), Math.max(1, n))) : 1)

/* THE DISC SIZE, FITTED TO THE COUNT — one look from 15 tickets to 2000.

   With the count, the hole and the wheel's width fixed, how far apart the
   discs sit is geometry, not a choice: so a min and max DISTANCE would only
   fight the size dials. What is a choice is how much of that spacing a disc
   fills (`share`), and the two ends it may not pass (`minPx` at the crowded
   end, `maxPx` at the sparse one). Below ~100 tickets the disc sits at maxPx
   and the gaps simply grow — it stays a donut, one ring at the rim.

   The rings follow the count too: a ring for every `perRing` tickets (70:
   one ring at 50, two at 120, three at 200, six at 420), and then fewer,
   while the rings would sit closer together than `ringGap` of their own
   discs across (2 diameters: 420 is six rings of 6.3 px 12.6 px apart, the
   look the wheel was tuned on). One ring's spacing "between" is the band.
   How many and how big are worked out on the spread rings; 'from edge'
   (RING_POSITIONS) then only moves them out to the rim at ringGap discs
   apart, which the count already leaves room for — at 420 the two agree.

   Everything in nominal stage px; the painter scales it. */
export function fitFor({ kind, n, hole, rimPx, minPx, maxPx, share, perRing = 70, ringGap = 2 }) {
  const lo = Math.max(0.5, Math.min(minPx, maxPx))
  const hi = Math.max(lo, maxPx)
  const size = (p) => Math.max(lo, Math.min(hi, share * p))
  const band = Math.max(1e-6, rimPx * (1 - hole))
  if (kind === 'one ring') {
    const p = (TAU * rimPx) / n
    return { dot: size(p), rings: 1, pitchPx: p }
  }
  if (kind === 'sunflower') {
    const p = Math.sqrt((Math.PI * rimPx * rimPx * (1 - hole * hole)) / (n * KAPPA))
    return { dot: size(p), rings: 1, pitchPx: p }
  }
  /* L rings: the spacing round them, the spacing between them, and the disc
     that fills `share` of the closer of the two */
  const at = (L) => {
    const round = (TAU * rimPx * ringRadii(L, hole).reduce((a, b) => a + b, 0)) / n
    const between = L === 1 ? band : band / (L - 1)
    const p = L === 1 ? round : Math.min(round, between)
    return { between, p, dot: size(p) }
  }
  /* a ring per `perRing` tickets — then fewer, while the rings would sit
     closer than `ringGap` of their own discs across */
  let L = Math.max(1, Math.min(40, n, Math.round(n / Math.max(1, perRing))))
  while (L > 1 && at(L).between < ringGap * at(L).dot - 1e-9) L--
  const f = at(L)
  return { dot: f.dot, rings: L, pitchPx: f.p }
}

/* L radii from the hole to the rim, innermost first. One ring sits on the
   rim itself — an inner hole with nothing outside it is not a wheel. A step
   (share of the rim) packs them in from the rim at that spacing (RING_POSITIONS'
   from edge), never closer to the middle than the hole; 0 spreads them. */
function ringRadii(L, hole, step = 0) {
  if (L === 1) return [1]
  const even = (1 - hole) / (L - 1)
  const d = step > 0 ? Math.min(step, even) : even
  return Array.from({ length: L }, (_, l) => 1 - (L - 1 - l) * d)
}

/* each ring gets discs in proportion to its circumference, so the density is
   even radially as well as tangentially. Largest-remainder on the way in, so
   the counts sum to exactly n. Which ring each slot goes to is evenRings'. */
function spreadRadii(n, L, hole, step = 0) {
  const R = ringRadii(L, hole, step)
  const total = R.reduce((a, b) => a + b, 0)
  const want = R.map((r) => (r / total) * n)
  const m = want.map((w) => Math.max(1, Math.floor(w)))
  let left = n - m.reduce((a, b) => a + b, 0)
  const byRemainder = want.map((w, l) => [w - Math.floor(w), l]).sort((a, b) => b[0] - a[0])
  for (let k = 0; left > 0; k++, left--) m[byRemainder[k % L][1]]++
  while (left < 0) {
    for (let k = 0; k < L && left < 0; k++) {
      const l = byRemainder[L - 1 - k][1]
      if (m[l] > 1) {
        m[l]--
        left++
      }
    }
  }
  const ring = evenRings(n, m)
  const rad = new Float64Array(n)
  for (let k = 0; k < n; k++) rad[k] = R[ring[k]]
  return { rad, ring, R }
}

/* WHICH RING EACH SLOT GOES TO, so every ring reads as evenly spaced.

   The angles are not ours — slot k is at k·(2pi/n) whatever ring it is on —
   so a ring of m discs can only be even to the nearest slot: its gaps want to
   be n/m slots, and every slot is claimed by exactly one ring, so the rings
   take turns and shove each other. The golden step this used to share with
   the sunflower is even in AREA but not round a ring: the slots it sends to
   one ring have two or three gap lengths far apart (8 to 51 slots on the
   inner ring at the defaults, against an even 13.5), and the ring reads as
   clumps with holes between them.

   Two passes. Earliest-deadline-first deals the slots out in order: ring l's
   j-th disc is due one ring-gap after (j + stagger)·n/m, and each slot goes
   to whichever released disc is due soonest. That is close, but it runs
   0 … n-1 as a line. Then a descent treats it as the circle it is: swap the
   rings of two neighbouring slots, the pair n-1, 0 included, whenever that
   brings the gaps closer to n/m. Being circular all the way round is what
   leaves no seam — the join n-1 -> 0 is polished like every other.

   Worst gap against the even one, 420 tickets / 6 rings: 6.3x for the golden
   step, 1.7x for this; the discs get a third more room as well. */
function evenRings(n, m) {
  const L = m.length
  const ring = new Int32Array(n)
  const due = m.map((c) => n / c)
  const next = new Int32Array(L)
  const release = (l, j) => (j + (l + 0.5) / L - 0.5) * due[l]
  for (let k = 0; k < n; k++) {
    let best = -1
    let soonest = Infinity
    for (let pass = 0; pass < 2 && best < 0; pass++) {
      for (let l = 0; l < L; l++) {
        if (next[l] >= m[l]) continue
        const r = release(l, next[l])
        if (pass === 0 && r > k + 0.5) continue // not released yet
        if (r + due[l] < soonest) {
          soonest = r + due[l]
          best = l
        }
      }
    }
    ring[k] = best
    next[best]++
  }

  /* each slot's neighbours on its own ring, round the circle */
  const prv = new Int32Array(n)
  const nxt = new Int32Array(n)
  const last = new Int32Array(L).fill(-1)
  const first = new Int32Array(L).fill(-1)
  for (let k = 0; k < n; k++) {
    const l = ring[k]
    if (last[l] < 0) first[l] = k
    else {
      nxt[last[l]] = k
      prv[k] = last[l]
    }
    last[l] = k
  }
  for (let l = 0; l < L; l++) {
    nxt[last[l]] = first[l]
    prv[first[l]] = last[l]
  }
  const gapTo = (a, b) => (b - a + n) % n || n

  /* moving a disc one slot along its ring grows one gap by 1 and shrinks the
     other by 1, so the change in the summed ((gap - even)/even)^2 is closed
     form. A ring of one disc has one gap of n wherever it sits. */
  const grows = (l, before, after) => (m[l] === 1 ? 0 : (2 * (before - after) + 2) / (due[l] * due[l]))
  for (let sweep = 0, better = true; better && sweep < 64; sweep++) {
    better = false
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n
      const a = ring[k]
      const b = ring[j]
      if (a === b) continue
      // a's disc steps k -> j (its gap behind grows), b's steps j -> k
      const delta = grows(a, gapTo(prv[k], k), gapTo(k, nxt[k])) + grows(b, gapTo(j, nxt[j]), gapTo(prv[j], j))
      if (!(delta < -1e-12)) continue
      const pa = prv[k]
      const qa = nxt[k]
      const pb = prv[j]
      const qb = nxt[j]
      if (pa === k) prv[j] = nxt[j] = j
      else {
        nxt[pa] = j
        prv[qa] = j
        prv[j] = pa
        nxt[j] = qa
      }
      if (pb === j) prv[k] = nxt[k] = k
      else {
        nxt[pb] = k
        prv[qb] = k
        prv[k] = pb
        nxt[k] = qb
      }
      ring[k] = b
      ring[j] = a
      better = true
    }
  }
  return ring
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a)

/* THE SEAM, and why the sunflower is an integer lattice rather than frac(k/phi).
   The obvious sunflower radius is sqrt(hole^2 + (1-hole^2)·frac(k·0.618…)),
   and it looks right everywhere except in one place: slot n-1 sits next to
   slot 0 in ANGLE, but the golden sequence has no period n, so at that wrap
   its phase simply breaks and a seam runs from the hole to the rim.

   Taking the same step on an integer lattice fixes it exactly: radius index
   (k·G) mod n, with G the integer nearest n/phi that is coprime to n. Coprime
   makes it a bijection, so the radii are a permutation of 0…n-1 — perfectly
   even in area, better than the irrational version — and `mod n` makes the
   sequence periodic, so the step from slot n-1 to slot 0 is the same step as
   every other. There is no wrap to see. */
function goldenStep(n) {
  if (n <= 2) return 1
  const want = Math.round(n * PHI_INV)
  for (let d = 0; d < n; d++) {
    for (const g of [want + d, want - d]) {
      if (g >= 1 && g < n && gcd(g, n) === 1) return g
    }
  }
  return 1
}

/* THE RADIUS LADDER — where the u-th slot of the sunflower sits, u in [0,1).

   With every disc the same size, even coverage means even AREA: the slots up
   to radius r are the share of the annulus up to r, which gives the familiar
   sqrt. That stops being true the moment the discs are not all the same size,
   and the first correction is not the right one either. Both were tried:

     even area          the slots ignore the size. The rim ends up crowded and
                        the middle hollow — the gap between two discs ran
                        5.0 px at the hole down to 1.0 px at the rim.
     one over size^2    give a disc `grow` times bigger `grow^2` the area. Now
                        the ratio of distance to size is flat, which means the
                        GAP grows with the disc: 4.2 px at the hole out to
                        9.9 px at the rim. The wheel frays at the edge.

   What reads as a round, evenly filled wheel is a constant GAP, so the
   centre-to-centre distance wants to be the disc's own size plus the same
   slack everywhere: d(r) = s(r) + g. The slack is not a guess — it is solved
   for, as the one value that fits exactly n slots into the annulus at that
   spacing. It comes out at 4.6 px at the hole to 7.7 px at the rim on the
   defaults, and if the discs are already too big to fit, g solves to 0 and
   this degrades to the size^2 law rather than to nonsense.

   A grow of 1 collapses to the sqrt (the smoke section checks that it does),
   and the mapping is monotone whatever the law, which is what keeps the
   golden step's own guarantees — a permutation of the ladder, and no seam. */

const KAPPA = Math.sqrt(3) / 2 // the area a point owns at spacing d in a hex-ish lattice
const SLICES = 2048

/* how many slots an annulus holds if the centre-to-centre distance at radius
   r is size(r) + slack */
function slotsAt(hole, disc, grow, slack) {
  let sum = 0
  for (let i = 0; i < SLICES; i++) {
    const t = (i + 0.5) / SLICES
    const r = hole + t * (1 - hole)
    const d = disc * Math.pow(grow, t) + slack
    sum += ((TAU * r) / (KAPPA * d * d)) * ((1 - hole) / SLICES)
  }
  return sum
}

/* the slack that fits exactly n of them. Monotone in slack, so bisection. */
function slackFor(n, hole, disc, grow) {
  if (!(disc > 0) || slotsAt(hole, disc, grow, 0) <= n) return 0 // already overfull
  let lo = 0
  let hi = 4
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (slotsAt(hole, disc, grow, mid) > n) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function radiusLadder(n, hole, grow, disc) {
  const span = 1 - hole
  /* no growth, no annulus, or no idea how big a disc is: there is nothing to
     correct for, and a zero disc would put a zero in the denominator below */
  if (!(grow > 1) || span < 1e-9 || !(disc > 0)) {
    const a = hole * hole
    const b = 1 - a
    return (u) => Math.sqrt(a + b * u)
  }
  const slack = slackFor(n, hole, disc, grow)
  const cdf = new Float64Array(SLICES + 1)
  for (let i = 1; i <= SLICES; i++) {
    const t = (i - 0.5) / SLICES
    const r = hole + t * span
    const d = disc * Math.pow(grow, t) + slack
    cdf[i] = cdf[i - 1] + r / (d * d) / SLICES
  }
  const total = cdf[SLICES]
  return (u) => {
    const want = u * total
    let lo = 1
    let hi = SLICES
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cdf[mid] < want) lo = mid + 1
      else hi = mid
    }
    const f = (want - cdf[lo - 1]) / Math.max(1e-12, cdf[lo] - cdf[lo - 1])
    return hole + ((lo - 1 + f) / SLICES) * span
  }
}

/* the first Fibonacci numbers up to n. The three-distance theorem puts the
   closest pair of a golden-ratio sequence at a Fibonacci offset, so these are
   the offsets a spacing check must look at — a plain "compare k to k+1" would
   report the sunflower as far roomier than it is. */
function fibUpTo(n) {
  const out = []
  let a = 1
  let b = 2
  while (a <= n) {
    out.push(a)
    ;[a, b] = [b, a + b]
  }
  return out
}

/* the smallest distance between any two discs, as a ratio of the rim — what
   caps the disc size so a crowded wheel still reads. Not an all-pairs scan
   (25M at n=5000): the candidates are small index offsets and the Fibonacci
   offsets above. The wrap is included, so a seam would show up here. */
function minGap(theta, rad, n) {
  const offsets = new Set([...Array.from({ length: Math.min(48, Math.max(0, n - 1)) }, (_, i) => i + 1), ...fibUpTo(n - 1)])
  let best = Infinity
  for (const d of offsets) {
    if (d < 1 || d >= n) continue
    for (let k = 0; k < n; k++) {
      const j = (k + d) % n
      const ra = rad[k]
      const rb = rad[j]
      const v = Math.sqrt(Math.max(0, ra * ra + rb * rb - 2 * ra * rb * Math.cos(theta[j] - theta[k])))
      if (v < best) best = v
    }
  }
  return Number.isFinite(best) ? best : 2
}

/* build the layout. Slot k is the ticket at sorted position k in draw.js's
   ring — rank order, never a second sort — so the winners are always the run
   of slots cut … cut+N-1. Pure geometry: nothing here has ever seen the
   entropy, and the smoke suite reads this source back to prove it. */
/* ringPosition and ringStep: where the rings sit (RING_POSITIONS), and for
   'from edge' how far apart, as a share of the rim */
export function place({ kind = DEFAULT_PLACEMENT, n, rings = 1, hole = 0.62, grow = 1, sizeSpacing = false, discRatio = 0, ringPosition = 'spread', ringStep = 0 }) {
  const L = ringsFor(kind, n, rings)
  const pitch = TAU / n
  const theta = new Float64Array(n)
  const rad = new Float64Array(n)
  let ring = null
  let radii = [1]

  for (let k = 0; k < n; k++) theta[k] = k * pitch

  if (kind === 'rings, spread') {
    const spread = spreadRadii(n, L, hole, ringPosition === 'from edge' ? ringStep : 0)
    radii = spread.R
    ring = spread.ring
    rad.set(spread.rad)
  } else if (kind === 'sunflower') {
    const G = goldenStep(n)
    const ladder = radiusLadder(n, hole, sizeSpacing ? grow : 1, discRatio)
    for (let k = 0; k < n; k++) rad[k] = ladder((((k * G) % n) + 0.5) / n)
  } else {
    rad.fill(1)
  }

  const gap = minGap(theta, rad, n)
  const span = (winners) => winners * pitch
  let lo = Infinity
  let hi = -Infinity
  for (let k = 0; k < n; k++) {
    if (rad[k] < lo) lo = rad[k]
    if (rad[k] > hi) hi = rad[k]
  }

  return {
    kind,
    n,
    rings: L,
    hole,
    pitch,
    theta,
    rad,
    ring,
    radii,
    gap,
    span,
    radMin: lo,
    radMax: hi,
    spin: SPIN,

    /* where slot k points once the wheel has turned to phi. THE definition —
       the painter, the hit test and underWedge all ask for it rather than
       writing theta + SPIN·phi out again, because a copy of it that missed
       the SPIN measured the wheel in a frame it no longer turns in. */
    angleAt: (k, phi) => theta[k] + SPIN * phi,

    /* the rest angle that lands the winners' run under the wedge. The run is
       contiguous in slot order and n·pitch is exactly 2pi, so the unwrapped
       mean is right even when the run wraps n-1 -> 0. */
    targetAngle({ cut, winners, wedgeAngle }) {
      // solves theta_mean + SPIN·phi = wedgeAngle, and SPIN² is 1
      return SPIN * (wedgeAngle - (cut + (winners - 1) / 2) * pitch)
    },

    /* the slots actually under the wedge, at rotation phi. Ground truth for
       "did the wedge land on the winners" — the caller compares this against
       ranksFor's own set, it never asks the draw. */
    underWedge({ phi, wedgeAngle, winners }) {
      const half = span(winners) / 2 + 1e-9
      const out = []
      for (let k = 0; k < n; k++) if (Math.abs(signed(theta[k] + SPIN * phi - wedgeAngle)) <= half) out.push(k) // = angleAt(k, phi)
      return out
    },

    /* the wedge, as a piece to paint: the winners' slice of the circle, and
       the radii that hold discs. The painter draws it as a pie slice from the
       dead centre out past r1; r0 and r1 are also where the
       zoom finds the wedge's middle. */
    sectors({ winners, wedgeAngle }) {
      const w = span(winners)
      return [{ a0: wedgeAngle - w / 2, a1: wedgeAngle + w / 2, r0: lo, r1: hi }]
    },
  }
}
