// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* HOW A DRAW ENDS, ON THE WHEEL — the prize if the wedge landed
   on your ticket, the fall if it did not. The wheel page itself ends on its
   result line and nothing else; this is the flow page's (flow/scene.js),
   which is the wheel with this on the end.

     won   prizeAfterMs after the landing (the zoom is in by then), your disc
           comes off the wheel as the coin — same place, same size, same
           colour — and jumps up into the middle turning, with the amount
           engraved on it (render-utils/prize/). The wheel dims under it, and
           the discs round yours go up with it as the confetti.
     lost  zoomOutAfterMs after the landing the zoom eases back out to the
           whole wheel, and then the fall (render-utils/fall/): your coin
           flips in place and lands, "Not this time" comes up, and every other
           disc falls off the page. Yours is left on its slot, alone.

   ONE CLOCK, `e`: seconds since the landing, over the whole ending. The
   prize and the fall are closed forms of their own time since play(), so
   both are fed `e` less the moment they started, every frame — and the
   scene's slider can set `e`, and scrubbing back is exact. Once it reaches
   the end it stops there: the flow holds its last frame until New seed.

   Both play on the GL, which goes OVER the wheel's canvas while they do (so
   the coin is in front of the disc it came off). A see-through GL (the slit
   page's, the flip's) shows the wheel through it as it is painted. An
   opaque one (the flow's) has the wheel's own canvas as its scene's
   background, re-uploaded every frame after it is painted: the same pixels,
   one layer down. What the host hands over (`host`) is where things are on
   it. */

import * as THREE from 'three'
import { createPrizeReveal } from '../../render-utils/prize/reveal.js'
import { PRIZE } from '../../render-utils/prize/config.js'
import { createFallOutro } from '../../render-utils/fall/outro.js'
import { FALL } from '../../render-utils/fall/config.js'
import { FLOW } from './config.js'

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (x) => x * x * (3 - 2 * x)

/* host:
     gl()             the GL stage, built on first use
     app, canvas      the stage, and the wheel's own canvas (the backdrop)
     mine()           your disc as drawn now, nominal px, through the zoom: { x, y, r }
     others(from)     the discs round it as drawn now, nearest first: the confetti
     resting()        every slot but yours at rest, unzoomed, nominal px: the fall
     count()          how many slots there are
     tint()           your colour
     colours()        the confetti's
     look()           optional: the prize coin's look (render-utils/coin/look/) —
                      a fresh object; without it, the coin lab's default (the
                      Winners coin, metal)
     face()           optional: the words on that coin, [amount, unit] — the
                      FLOW's amount and unit without it
     mineFallsAfterMs()  optional: on a loss, your coin falls too, this long
                      after the last of the others is off the page — without
                      it (the flow) yours stays on its slot, alone
     lostHeadline()   optional: the fall's headline — without it, the flow's
                      (FLOW.lostHeadline); '' for none (the slit page has its own)
     zoomOutAfterMs(), zoomOutMs()  optional: a loss's zoom out, from the
                      ending's start and how long — without them, the flow's
     wheelBehindPrize()  optional: how much of the wheel shows under the prize,
                      0..1 — without it, the flow's (FLOW.wheelBehindPrize)
     mineOpacity()    optional: on a loss, how much of your coin shows, 0..1 —
                      without it, all of it
     won()            optional: true or false once the host knows the outcome
                      (the draw is decided before the coin lands), and then
                      only that ending is ever built — a loss never pays for
                      the prize's coin. Undefined (the flow): both, the prize's
                      at once, as before
     defer()          optional: true while another coin is still on the stage
                      (the slit's intro). The prize's coin is then built
                      without its maps and studio, which upload() brings up a
                      step a call once the host says that coin has gone */
export function createEnding(host) {
  let reveal = null
  let outro = null
  let kind = null //     'won' | 'lost' | null: the ending this draw has
  let begun = false //   the landing has happened: the clock runs
  let played = false //  …and the prize or the fall is up
  let e = 0
  let base = 0
  let held = false //    the slider has it
  let freeze = false //  the first frame of a play is free: e holds still across it
  let taken = [] //      the confetti's slots, in the order handed over
  let backdrop = null
  let backdropSize = ''
  /* BACK TO THE WHEEL, after a win: the words come up backAfterBurstMs after
     the confetti bursts; pressed, the coin is flicked up and comes back down
     onto your disc, green again (reveal.returnTo); the rest of the win — the
     words, the confetti — fades out over backUiFadeMs, and when that is over
     the wheel fades back in over backWheelInMs, where the spin left it, zoom
     and all: the wedge, the rings, the people playing and the slider with it.
     When the coin is down the page is the wheel's, landed. */
  let backAt = -1 //     real time the words were pressed, or −1
  let wheelIn = 0 //     0..1, the wheel coming back in
  let dismissed = false // the coin is down: the wheel has the page
  const pill = document.createElement('button')
  pill.type = 'button'
  pill.id = 'flow-back'
  pill.className = 'flow-pill'
  pill.textContent = FLOW.backLabel
  host.app.appendChild(pill)
  pill.addEventListener('click', () => back(performance.now() / 1000))
  let pillShown = null
  function showPill(on) {
    if (on === pillShown) return
    pillShown = on
    pill.classList.toggle('is-shown', on)
  }
  /* when the confetti bursts, in seconds from the prize's own start — the
     paper's throw, or the discs flying off the ring round the coin */
  /* when Back to the wheel comes up, s from the prize's start */
  const backShowS = () => burstS() + Math.max(0, FLOW.backAfterBurstMs) / 1000
  const burstS = () => (!PRIZE.confetti ? (PRIZE.chipAtMs + PRIZE.textFadeMs) / 1000 : (PRIZE.confettiKind === 'discs' ? PRIZE.discBurstAtMs : PRIZE.confettiAtMs) / 1000)
  function back(now) {
    if (kind !== 'won' || !played || backAt >= 0 || dismissed) return
    backAt = now
    wheelIn = 0
    held = true // the ending's clock stops where it is: the transition is real time
    showPill(false)
    // the disc is where the spin left it: the view stays at the spin's end, so it does not move under the coin
    reveal.returnTo({ to: host.mine(), ms: FLOW.backCoinMs, hopPx: FLOW.backHopPx, flips: FLOW.backFlips })
  }

  /* the words on the prize's coin, as play() engraves them: the coin is
     built with these, so its first frame has nothing left to engrave */
  const faceLines = () => (host.face?.() ?? [String(FLOW.amount), FLOW.unit]).map((l) => (typeof l === 'string' ? l : l.text))
  const ensureReveal = () => (reveal ??= createPrizeReveal({ gl: host.gl(), app: host.app, look: host.look?.(), first: faceLines(), defer: !!host.defer?.() }))
  const ensureOutro = () => (outro ??= createFallOutro({ gl: host.gl(), app: host.app, headline: () => host.lostHeadline?.() ?? FLOW.lostHeadline }))
  /* the prize's coin is the coin lab's: its bake, letters and first compile
     are a real cost, paid here at boot rather than on the spin's first frame
     — when the host cannot say yet whether it is wanted (warm() does, once
     it can) */
  if (host.won?.() === undefined) ensureReveal()

  /* when the prize or the fall starts, in seconds from the landing */
  /* a loss's zoom out: the host's timing if it has its own (the slit page's), else the flow's */
  const outAfterS = () => Math.max(0, host.zoomOutAfterMs?.() ?? FLOW.zoomOutAfterMs) / 1000
  const outForS = () => Math.max(0, host.zoomOutMs?.() ?? FLOW.zoomOutMs) / 1000
  const playAt = () => (kind === 'won' ? Math.max(0, FLOW.prizeAfterMs) / 1000 : outAfterS() + outForS())
  /* …and how long it is, all of it: the slider's second half */
  function lengthS() {
    if (!kind) return 0
    return playAt() + (kind === 'won' ? ensureReveal().endS : ensureOutro().endS)
  }

  const words = () => ({
    lines: faceLines(),
    headline: FLOW.wonHeadline,
    kicker: FLOW.kicker,
    chip: [`${FLOW.prefix}${FLOW.amount} `, { text: FLOW.unit, caps: true }],
  })

  function play() {
    if (kind === 'won') {
      const from = host.mine()
      const others = host.others(from)
      taken = others.map((o) => o.k)
      ensureReveal().play({ t: 0, from, tint: host.tint(), colours: host.colours(), others, ...words(), free: false })
    } else {
      // it is all the way out by now, so where your disc is drawn is where it rests
      fallFrom = host.mine()
      keptWith = FLOW.keepWinners
      mineWith = mineFalls()
      ensureOutro().play({ t: 0, from: fallFrom, tint: host.tint(), count: host.count(), discs: host.resting(), free: false, mineFallsAfterMs: mineWith })
    }
    played = true
    freeze = !held
  }
  function unplay() {
    reveal?.end()
    outro?.end()
    showPill(false)
    played = false
    taken = []
    if (backdrop && host.gl().scene.background === backdrop) host.gl().scene.background = null
  }

  /* the draw is decided: which ending it has. The fall is primed now, from
     where the discs will come to rest, so the slider knows how long it is
     before the wheel has even stopped. */
  function prepare(won) {
    stop()
    kind = won ? 'won' : 'lost'
    if (kind === 'lost') primeFall(host.mine())
  }
  /* the fall, primed with who falls — every disc but yours, and but the
     winners with keepWinners on — from `from`. The toggle is live: moved,
     it is primed again from the same place, where the fall is (frame()) */
  let fallFrom = null
  let keptWith = null
  /* yours falls too, mineFallsAfterMs after the others, if the host says so
     (the slit page does; the flow leaves yours on its slot). Live, the same way */
  const mineFalls = () => host.mineFallsAfterMs?.() ?? null
  let mineWith = null
  function primeFall(from) {
    fallFrom = from
    keptWith = FLOW.keepWinners
    mineWith = mineFalls()
    ensureOutro().prime({ from, count: host.count(), discs: host.resting(), mineFallsAfterMs: mineWith })
  }
  /* the wheel has come to rest: the clock starts */
  function begin(now) {
    if (!kind || begun) return
    begun = true
    held = false
    e = 0
    base = now
  }
  function stop() {
    unplay()
    fallFrom = null
    backAt = -1
    wheelIn = 0
    dismissed = false
    kind = null
    begun = false
    held = false
    freeze = false
    e = 0
  }
  /* the slider back into the spin: nothing has ended yet, but the draw — and
     so which ending it has — is the same one */
  function rewind() {
    unplay()
    backAt = -1
    wheelIn = 0
    dismissed = false
    begun = false
    held = false
    freeze = false
    e = 0
  }
  /* the slider let go: the clock runs on from where it was held. A prize or
     fall that has not started yet gets its free first frame when it does. */
  function release(now) {
    if (!begun || !held) return
    held = false
    base = now - e
  }
  /* the slider: e seconds into the ending, and it stays there */
  function seek(to, now) {
    if (!kind) return
    // the slider back into the ending takes the page back from the wheel
    backAt = -1
    wheelIn = 0
    dismissed = false
    begun = true
    held = true
    e = Math.max(0, Math.min(lengthS(), to))
    base = now - e
  }

  /* one frame: the clock, and whichever of the two is up. What the wheel
     needs from it comes back — how much of the zoom to keep, how bright the
     wheel is, whether your disc is the coin's now, the discs that are not on
     the wheel, and whether the GL is up. */
  /* back on the wheel after a win: landed, whole, the view where the spin left it */
  const NONE_BACK = (at) => ({ e: at, zoomKeep: 1, wheelAlpha: 1, mineAlpha: 1, gone: null, dropOf: null, wedgeFade: 0, ringsFade: 0, glUp: false })
  const NONE = { e: 0, zoomKeep: 1, wheelAlpha: 1, mineAlpha: 1, gone: null, dropOf: null, wedgeFade: 0, ringsFade: 0, glUp: false }
  function frame(now) {
    // the toggle moved: the fall primed again with who falls now, from where it was
    if (kind === 'lost' && fallFrom && (keptWith !== FLOW.keepWinners || mineWith !== mineFalls())) primeFall(fallFrom)
    if (!kind || !begun) return NONE
    /* the wheel has the page again: landed, whole, at the spin's end */
    if (dismissed) {
      showPill(false)
      return NONE_BACK(e)
    }
    if (freeze) {
      // the frame that built the coin is over, however long it took: carry on from where it was
      freeze = false
      base = now - e
    }
    if (!held) e = Math.min(lengthS(), now - base)
    if (e >= playAt() && !played) play()
    else if (e < playAt() && played) unplay()
    const t = e - playAt()
    if (played && kind !== 'won' && host.mineOpacity) outro.mineOpacity = host.mineOpacity()
    if (played) (kind === 'won' ? reveal : outro).update(t)

    if (kind === 'won') {
      const n = played ? reveal.taken : 0
      /* the wedge and the winners' rings go as the prize comes up — on the
         ending's own clock, so scrubbing back brings them in again */
      const out = played ? smooth(clamp01(t / Math.max(0.01, FLOW.wonFadeMs / 1000))) : 0
      const dim = played ? 1 + (Math.max(0, Math.min(1, host.wheelBehindPrize?.() ?? FLOW.wheelBehindPrize)) - 1) * smooth(clamp01(t / 0.45)) : 1
      /* back to the wheel, on real time from the press: the words and the
         confetti out over backUiFadeMs, then the wheel in over backWheelInMs,
         while the coin goes back down onto your disc */
      if (backAt >= 0) {
        const c = performance.now() / 1000 - backAt // real time, as the press and the coin's return are
        const uiS = Math.max(0.01, FLOW.backUiFadeMs / 1000)
        reveal.setOpacity(1 - smooth(clamp01(c / uiS)))
        wheelIn = smooth(clamp01((c - uiS) / Math.max(0.01, FLOW.backWheelInMs / 1000)))
        if (reveal.returned) {
          // the coin is your disc again, on the same frame the painter takes it over
          dismissed = true
          backAt = -1
          unplay()
          return NONE_BACK(e)
        }
      }
      showPill(played && backAt < 0 && t >= backShowS())
      const k = wheelIn
      return {
        e,
        zoomKeep: 1,
        wheelAlpha: dim + (1 - dim) * k,
        mineAlpha: played ? 0 : 1, // the coin is your disc until it is back down
        gone: n && k <= 0 ? new Set(taken.slice(0, n)) : null, // the discs come back with the wheel
        dropOf: null,
        wedgeFade: out * (1 - k),
        ringsFade: out * (1 - k),
        glUp: played,
        backing: backAt >= 0,
      }
    }
    const outS = outForS()
    const since = e - outAfterS()
    showPill(false)
    return {
      e,
      zoomKeep: since <= 0 ? 1 : outS > 0 ? 1 - smooth(clamp01(since / outS)) : 0,
      wheelAlpha: 1,
      mineAlpha: played ? 0 : 1,
      gone: null,
      dropOf: played ? (k) => outro.dropOf(k) : null,
      wedgeFade: played && !FLOW.keepWinners ? outro.fallShare : 0, // the wedge stays with the winners
      ringsFade: 0, // the rings fall with their discs (and stay with the winners that stay)
      /* your ring, round the coin once its flip has landed it back on your
         slot: the coin is your disc from then on, and your disc wears one */
      mineRing: played ? smooth(clamp01((t - Math.max(0.05, FALL.flipMs / 1000)) / 0.2)) : 0,
      glUp: played,
    }
  }

  /* after the wheel is painted: the frame's wheel under the coin, then the GL */
  function render(dt) {
    if (!played) return
    const gl = host.gl()
    if (gl.alpha) return gl.render(dt) // the wheel shows through: nothing to upload
    if (!backdrop) {
      backdrop = new THREE.CanvasTexture(host.canvas)
      backdrop.colorSpace = THREE.SRGBColorSpace
      // the canvas is transparent and a background has no alpha: premultiplied,
      // a disc at 0.2 is a dim grey on black rather than white
      backdrop.premultiplyAlpha = true
      backdrop.generateMipmaps = false
      backdrop.minFilter = THREE.LinearFilter
    }
    // a new size is a new texture on the GPU (the lost page does the same)
    const size = `${host.canvas.width}x${host.canvas.height}`
    if (size !== backdropSize) {
      if (backdropSize) backdrop.dispose()
      backdropSize = size
    }
    backdrop.needsUpdate = true
    gl.scene.background = backdrop
    gl.render(dt)
  }

  return {
    /* build what this draw's ending needs now, so a host that makes this
       lazily pays for it before its spin, not on it: the prize's coin on a
       win, the fall on a loss, both while the outcome is unknown. A draw
       dealt again the other way lets the prize's coin go */
    warm() {
      const won = host.won?.()
      if (won === false && reveal && !played) {
        reveal.dispose()
        reveal = null
      }
      if (won !== false) ensureReveal()
      if (won !== true) ensureOutro()
    },
    /* the prize's coin, deferred while another was up: its next GPU step
       (the maps, then its studio). True once there is nothing left */
    upload: () => reveal?.upload() ?? true,
    /* let the prize's coin go (the host is back at its start): warm()
       builds it again for the next draw that wants it */
    letGo() {
      unplay()
      reveal?.dispose()
      reveal = null
      backdrop?.dispose()
      backdrop = null
      backdropSize = ''
    },
    prepare,
    begin,
    stop,
    rewind,
    seek,
    release,
    frame,
    render,
    get kind() {
      return kind
    },
    get begun() {
      return begun
    },
    get played() {
      return played
    },
    get held() {
      return held
    },
    get e() {
      return e
    },
    get lengthS() {
      return lengthS()
    },
    /* a win: when Back to the wheel comes up, on the ending's clock (null: not a win) */
    get backShowAt() {
      return kind === 'won' ? playAt() + backShowS() : null
    },
    /* a loss's beats on the ending's clock: your coin's flip over, the
       others starting to fall — a host can hold between them (seek, release)
       — and the last of them off the page */
    get lossMarks() {
      if (kind !== 'lost') return null
      const o = ensureOutro()
      return { flipEnd: playAt() + o.flipEndS, fallAt: playAt() + o.fallAtS, othersOff: playAt() + o.othersOffS }
    },
    /* the prize is up and not on its way off: what hides the slider */
    get prizeUp() {
      return kind === 'won' && played && !dismissed && wheelIn <= 0
    },
    get dismissed() {
      return dismissed
    },
    back: (now) => back(now),
    /* the prize's coin, the fall's, the page's backdrop and the pill */
    dispose() {
      reveal?.dispose()
      outro?.dispose()
      backdrop?.dispose()
      pill.remove()
    },
    debug: () => ({
      kind,
      begun,
      played,
      e,
      lengthS: lengthS(),
      playAt: playAt(),
      prize: reveal ? reveal.debug() : { active: false },
      back: { pill: !!pillShown, backing: backAt >= 0, dismissed, burstS: burstS(), opacity: reveal ? reveal.opacity : 1, wheelIn },
      fall: outro ? outro.debug() : { active: false },
    }),
  }
}
