// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* WHO'S PLAYING — the row of names along the top of the stage, once the
   wheel stops: everyone playing (at most 100), in the order their tickets
   go round the ring (names.js). DOM, not canvas: it is text.

   A RING, like the wheel: past its last name comes its first again. Each
   name is placed on its own, at the turn of the ring nearest the stage, so
   the row slides on round with no end to run into — and from any name to
   any other the short way (names.js nearestTurn). A row shorter than the
   stage has no turn to make, and is a plain row.

   The scene drives all of it, every frame: where the row sits (it slides so
   a name is over its ticket — names.js says where), how far each name has
   come on (it rises a few px as it fades in), and how much of it shows (the
   tickets' opacities, walk.js), and which is lit (underlined). Colours
   never change: names white, YOU in your colour (--slit-you). Nothing here is swiped; a name tapped lights its ticket (onPick). */

const GAP = 24 // between two names, nominal px

export function createLegend(app) {
  const root = document.createElement('div')
  root.id = 'slit-legend'
  const row = document.createElement('div')
  row.className = 'slit-legend-row'
  root.appendChild(row)
  app.appendChild(root)

  let items = []
  let litI = -1 //    the underlined name (−1: none)
  let key = ''
  let boxes = [] //   each name's [left, width], nominal px from the row's start
  let span = 0 //     once round the ring, nominal px (0: it does not wrap)
  let measuredAt = 0 // the scale they were measured at (0: not yet)
  let W = 390
  const shown = [] // per name: its in × its alpha, in hundredths, as last written
  const placed = [] // per name: where it was last put, device px ×10
  let lastX = 0
  let pick = null
  let live = null
  // a name tapped: the scene lights its ticket (only while the row is live: .is-live takes the taps)
  row.addEventListener('pointerdown', (e) => {
    const i = items.indexOf(e.target.closest?.('.slit-legend-item'))
    if (i >= 0) pick?.(i)
  })

  function measure(scale) {
    let x = 0
    boxes = items.map((el) => {
      const w = el.offsetWidth / scale
      const b = [x, w]
      x += w + GAP
      return b
    })
    span = x > W + GAP ? x : 0
    measuredAt = scale
    placed.length = 0
  }
  // a face that arrives late changes every width
  document.fonts?.ready?.then(() => (measuredAt = 0))
  const onFonts = () => (measuredAt = 0) // …and one asked for after the page was up (Inter, scene.js)
  document.fonts?.addEventListener?.('loadingdone', onFonts)
  /* name i's left edge on the stage with the row at x: the turn of the ring
     that puts it nearest the stage's middle */
  const leftOf = (i, x) => {
    const [l, w] = boxes[i] ?? [0, 0]
    const at = l + x
    return span > 0 ? at - span * Math.round((at + w / 2 - W / 2) / span) : at
  }

  return {
    /* who: [{ k, name, you }] in the row's order. Rebuilt only when it changes */
    set(who) {
      const id = who.map((w) => `${w.k}:${w.name}`).join(',')
      if (id === key) return
      key = id
      row.textContent = ''
      items = who.map((w) => {
        const el = document.createElement('span')
        el.className = w.you ? 'slit-legend-item is-you' : 'slit-legend-item'
        el.textContent = w.name
        el.style.setProperty('--in', '0')
        el.style.opacity = '0'
        row.appendChild(el)
        return el
      })
      shown.length = 0
      measuredAt = 0
      litI = -1
    },
    /* name i underlined, the lit one's (−1: none) */
    lit(i) {
      if (i === litI) return
      items[litI]?.classList.remove('is-lit')
      litI = i
      items[litI]?.classList.add('is-lit')
    },
    /* the stage's width, nominal px — where the ring turns */
    stage(w, scale) {
      if (w !== W) {
        W = w
        measuredAt = 0
      }
      if (measuredAt !== scale) measure(scale)
    },
    /* name i's box, nominal px from the row's start: [left, width] */
    box(i, scale) {
      if (measuredAt !== scale) measure(scale)
      return boxes[i] ?? [0, 0]
    },
    /* once round the ring (0: a plain row) */
    get span() {
      return span
    },
    /* name i's left edge on the stage with the row at x */
    leftOf,
    /* the row's offset (nominal px), and each name's in (0..1, the rise) and alpha */
    frame(x, scale, ins, alphas) {
      lastX = x
      for (let i = 0; i < items.length; i++) {
        const left = Math.round(leftOf(i, x) * scale * 10)
        if (placed[i] !== left) {
          placed[i] = left
          items[i].style.setProperty('--x', `${(left / 10).toFixed(1)}px`)
        }
        const a = Math.max(0, Math.min(1, ins[i])) * Math.max(0, Math.min(1, alphas[i]))
        const q = Math.round(a * 100) * 1000 + Math.round(Math.max(0, Math.min(1, ins[i])) * 100)
        if (shown[i] === q) continue
        shown[i] = q
        items[i].style.opacity = a.toFixed(2)
        items[i].style.setProperty('--in', Math.max(0, Math.min(1, ins[i])).toFixed(2))
      }
    },
    /* what a tapped name does: cb(i) */
    onPick(cb) {
      pick = cb
    },
    /* the names take taps, or not */
    live(on) {
      if (on === live) return
      live = on
      root.classList.toggle('is-live', on)
    },
    get count() {
      return items.length
    },
    /* the page taken down: the face's listener off, the row gone (the scene's dispose calls it) */
    dispose() {
      document.fonts?.removeEventListener?.('loadingdone', onFonts)
      root.remove()
    },
    /* what is on screen, for the suite: names, how much of each shows, and
       where each one's middle is on the stage, nominal px */
    debug() {
      const s = measuredAt || 1
      return {
        names: items.map((el) => el.textContent),
        shown: items.map((_, i) => Math.floor((shown[i] ?? 0) / 1000) / 100),
        in: items.map((_, i) => ((shown[i] ?? 0) % 1000) / 100),
        mid: boxes.map(([, w], i) => leftOf(i, lastX) + w / 2),
        width: boxes.map(([, w]) => w),
        x: lastX,
        span,
        top: root.offsetTop / s,
      }
    },
  }
}
