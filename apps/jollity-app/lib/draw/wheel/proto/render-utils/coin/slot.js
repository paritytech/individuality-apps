// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* The slot: DOM over the GL, from the bottom up: the dark block under the mouth (the coin
   dims behind it instead of being cut), one gradient of light standing on
   the mouth (its own width: glowWidthPx), the hairline itself brightest at
   its centre, a double chevron above pointing down, and the hint under it.

   The light answers the coin through ONE number, --slot-hot: the glow's alpha
   (0..1, COIN.restGlow far away → COIN.slotGlow at the mouth), written here
   quantised to 1/100 and only on change; the CSS (styles.css) puts it on the
   glow's opacity and scale and on the hairline, and #app carries a transition
   on it so a release lets the light down softly.

   Everything is nominal stage px × --scale, hung off --cx, so it sits on the
   GL's pixel at any frame size. The markup is appended here; the CSS it
   answers to (#slot, .slot-*) is in the shared styles.css and tokens.css. */

import { COIN } from './config.js'

const HINT = 'drag your lottery\ntoken into the slot'

export function createSlot({ app }) {
  const root = document.createElement('div')
  root.id = 'slot'
  root.setAttribute('aria-hidden', 'true')
  root.innerHTML = `
    <div class="slot-shade"></div>
    <div class="slot-glow"></div>
    <div class="slot-mouth"></div>
    <svg class="slot-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5l8 8 8-8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M4 12l8 8 8-8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <div class="slot-hint">${HINT.replace('\n', '<br>')}</div>`
  app.appendChild(root)

  const st = app.style
  let hotQ = -1 // the last --slot-hot written, ×100
  let y = -1
  let w = -1
  let gw = -1
  let ch = -1
  let alpha = -1
  let hint = -1
  let chevron = -1
  let shade = -1

  return {
    /* per frame: the dials are live, so the geometry is re-read each time */
    sync() {
      if (COIN.slotY !== y) st.setProperty('--slot-y', `${(y = COIN.slotY)}px`)
      if (COIN.slotWidthPx !== w) st.setProperty('--slot-w', `${(w = COIN.slotWidthPx)}px`)
      if (COIN.glowWidthPx !== gw) st.setProperty('--slot-glow-w', `${(gw = COIN.glowWidthPx)}px`)
      if (COIN.chevronPx !== ch) st.setProperty('--slot-chevron-px', `${(ch = COIN.chevronPx)}px`)
      const sh = Math.round(Math.min(1, Math.max(0, COIN.shadeA)) * 100)
      if (sh !== shade) st.setProperty('--slot-shade', ((shade = sh) / 100).toFixed(2))
    },
    /* the glow's alpha, 0..1 */
    hot(v) {
      const q = Math.round(Math.min(1, Math.max(0, v)) * 100)
      if (q === hotQ) return
      hotQ = q
      st.setProperty('--slot-hot', (q / 100).toFixed(2))
    },
    get hotValue() {
      return hotQ < 0 ? 0 : hotQ / 100
    },
    /* the whole slot's opacity: 1 while the coin is in play, fading to 0 as the
       sphere takes over; 0 = display none */
    show(a) {
      const q = Math.round(Math.min(1, Math.max(0, a)) * 100)
      if (q === alpha) return
      alpha = q
      root.style.opacity = (q / 100).toFixed(2)
      root.classList.toggle('is-hidden', q === 0)
    },
    /* the hint under the mouth: shown until the first drag */
    hint(a) {
      const q = Math.round(Math.min(1, Math.max(0, a)) * 100)
      if (q === hint) return
      hint = q
      root.style.setProperty('--slot-hint', (q / 100).toFixed(2))
    },
    /* the chevron over the mouth: shown until the point of no return */
    chevron(a) {
      const q = Math.round(Math.min(1, Math.max(0, a)) * 100)
      if (q === chevron) return
      chevron = q
      root.style.setProperty('--slot-chevron', (q / 100).toFixed(2))
    },
    get element() {
      return root
    },
  }
}
