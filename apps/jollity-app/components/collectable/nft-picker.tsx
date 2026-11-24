// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The NFT picker — a hologram on a coin. An OVERLAY on the
 * chest, opened by tapping an opened collectable there.
 *
 * THE SCREEN ZOOMS TO THE COLLECTABLE. It does not fly the collectable to a
 * stage in the middle — the whole stage starts mapped onto the tapped piece and
 * opens out to fill the frame, so it reads as the camera moving to the thing
 * you touched rather than the thing coming to you.
 *
 *   1. backdrop  — fixed, black, opacity driven by the spring
 *   2. the stage — fixed, full-viewport: projection (beam + art) over the
 *                  coin. THE ONLY TRANSFORMED ELEMENT: its transform maps
 *                  the projection's measured box onto the piece's art box. The
 *                  transform is cleared before measuring, so a StrictMode
 *                  re-run reads the true layout. (The
 *                  CHEST's canvases stay untransformed: scaling those
 *                  rasterizes them and poisons the wrapping layer's rect
 *                  math, which measures its canvas every frame.)
 *
 *   The choreography is one number: e. The stage zooms with e; the backdrop
 *   ramps in early (e 0.08→0.5), so the surroundings fall away while the
 *   collectable grows, and the DRESSING (beam, coin) late (e 0.45→1), so the
 *   collectable arrives before its setting does; the hologram tint crossfades over the
 *   piece's own art on the same ramp, so what leaves the piece is the art you
 *   tapped and what lands is a hologram. Closing runs the SAME spring in
 *   reverse — dressing out, the stage shrinking back onto its piece — and
 *   commits only when it lands (a turned coin swaps the opened collectable;
 *   "Yours" just closes).
 *
 * THE COIN IS THE CONTROL — the three.js collection coin (CoinCanvas). Drag
 * to turn, flick to coast; every collection that crosses the front TEARS the
 * projection (the glitch filter's two SMIL clocks, below) to that
 * collection's offer. Collection 0 is the piece you own. No labels, no
 * buttons.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { CoinCanvas, type CoinCanvasHandle } from "./coin-canvas"

export interface PickerItem {
  name: string
  image?: string
  rare?: boolean
  /** Holds what the same claim would mint in each collection that accepts it. */
  choices?: Offer[]
}

/** the projection colour */
const HOLO_RGB: readonly [number, number, number] = [78, 196, 255]
/** one tear end to end: art snaps at ~80ms, settles by 300 */
const TEAR_MS = 300

// ── the recolour filter's transfer tables ─────────────────────────────────────
const TINT_STEPS = 65
const lum = (c: readonly number[]) => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!
function tintAt(l: number): [number, number, number] {
  const src = HOLO_RGB.map((v) => v / 255)
  const d = l - lum(src)
  let out = src.map((v) => v + d)
  const low = Math.min(...out)
  const high = Math.max(...out)
  if (low < 0 && l - low > 0) out = out.map((v) => l + ((v - l) * l) / (l - low))
  if (high > 1 && high - l > 0) out = out.map((v) => l + ((v - l) * (1 - l)) / (high - l))
  return [out[0]!, out[1]!, out[2]!]
}
const TINT_TABLES: [string, string, string] = (() => {
  const cols: [number[], number[], number[]] = [[], [], []]
  for (let i = 0; i < TINT_STEPS; i++) {
    const rgb = tintAt(i / (TINT_STEPS - 1))
    for (let c = 0; c < 3; c++) cols[c]!.push(Math.round(rgb[c]! * 1000) / 1000)
  }
  return [cols[0].join(" "), cols[1].join(" "), cols[2].join(" ")]
})()

export interface Offer {
  collectionId: number
  label: string
  name: string
  src: string
}

/** Fallback zoom-from box when the caller has no rect to give: piece-sized, at
 *  the top of the frame where opened pieces gather. */
function pinnedOrigin(): DOMRect {
  const side = Math.max(24, window.innerWidth * 0.17)
  return new DOMRect((window.innerWidth - side) / 2, 14, side, side)
}

export function NftPicker({
  item,
  origin,
  onClose,
  onPick,
}: {
  /** the piece being inspected; null renders nothing */
  item: PickerItem | null
  /** the tapped piece's art box — where the hero takes off and lands */
  origin?: DOMRect | null
  onClose: () => void
  onPick: (offer: Offer) => void
}) {
  if (!item) return null
  // keyed by the piece, so a different piece remounts with a fresh flight
  return (
    <PickerStage
      key={item.name + (item.image ?? "")}
      item={item}
      origin={origin ?? null}
      onClose={onClose}
      onPick={onPick}
    />
  )
}

function PickerStage({
  item,
  origin,
  onClose,
  onPick,
}: {
  item: PickerItem
  origin: DOMRect | null
  onClose: () => void
  onPick: (offer: Offer) => void
}) {
  // ── the projection: what stands on the beam right now ────────────────────
  const [projected, setProjected] = useState<{ name: string; src?: string }>(() => ({
    name: item.name,
    src: item.image,
  }))
  const seedRef = useRef<SVGAnimateElement>(null)
  const ampRef = useRef<SVGAnimateElement>(null)
  const [tearing, setTearing] = useState(false)
  const tearTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(
    () => () => {
      tearTimersRef.current.forEach(clearTimeout)
    },
    [],
  )

  /** run one tear and land `next` on the projection mid-way through it */
  const projectWithTear = (next: { name: string; src?: string }) => {
    seedRef.current?.beginElement()
    ampRef.current?.beginElement()
    setTearing(true)
    tearTimersRef.current.forEach(clearTimeout)
    tearTimersRef.current = [
      setTimeout(() => setProjected(next), 80),
      setTimeout(() => setTearing(false), TEAR_MS),
    ]
  }

  const offers: Offer[] = (item.choices ?? []).filter(
    (offer) => offer.name !== item.name || offer.src !== item.image,
  )

  // ── the coin: index 0 = yours ─────────────────────────────────────────────
  const coinRef = useRef<CoinCanvasHandle>(null)
  const facets = [
    { label: "Yours", name: item.name },
    ...offers.map((offer) => ({ label: offer.label, name: offer.name })),
  ]
  const frontRef = useRef(0)
  const previewRef = useRef<Offer | null>(null)
  const projectFacet = (index: number) => {
    if (index === frontRef.current) return
    frontRef.current = index
    if (index === 0) {
      previewRef.current = null
      projectWithTear({ name: item.name, src: item.image })
    } else {
      const offer = offers[index - 1]
      if (!offer) return
      previewRef.current = offer
      projectWithTear({ name: offer.name, src: offer.src })
    }
  }

  // ── THE FLIGHT: one spring drives the hero, the dressing, the exit ───────
  const backdropRef = useRef<HTMLButtonElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  /** the setting, not the collectable: it arrives after the zoom does */
  const dressRef = useRef<HTMLDivElement>(null)
  const coinWrapRef = useRef<HTMLDivElement>(null)
  /** the piece's OWN art, under the tinted projection — what leaves the piece */
  const plainRef = useRef<HTMLImageElement>(null)
  /** the projection's STATIC box — the thing that must land on the piece's art */
  const artRef = useRef<HTMLDivElement>(null)
  const springK = useRef(0)
  const [closing, setClosing] = useState(false)
  const finishedRef = useRef(false)

  // LAYOUT effect, not a plain effect: the hero must be boxed, parked on the
  // tile, and made visible BEFORE the first paint — a post-paint effect left
  // one painted frame of the raw, unstyled image splattered across the
  // viewport, which read as a broken zoom.
  useLayoutEffect(() => {
    const backdrop = backdropRef.current
    const stage = stageRef.current
    if (!backdrop || !stage) return

    // WHERE THE ZOOM STARTS. It is not enough to shrink the stage into the
    // piece's box: what has to line up is the PROJECTION and the piece's ART, or
    // the picture jumps in size and position at the handover (the projection
    // sits in the middle of the stage, so mapping viewport→piece leaves it
    // smaller than the piece's art and off its centre).
    //
    // So: measure the projection's static box, and solve for the transform
    // that puts it exactly on the piece's art at e=0 and at identity at e=1.
    // The transform is cleared first, so the measurement is the true layout
    // no matter what a previous run (StrictMode's included) left behind.
    stage.style.transform = "none"
    const art = artRef.current?.getBoundingClientRect() ?? stage.getBoundingClientRect()
    const stageBox = stage.getBoundingClientRect()
    const from = origin ?? pinnedOrigin()
    // transform-origin is the stage's own centre, so every mapping is
    // relative to it: p → centre + s·(p − centre) + t
    const ox = stageBox.left + stageBox.width / 2
    const oy = stageBox.top + stageBox.height / 2
    const artCx = art.left + art.width / 2
    const artCy = art.top + art.height / 2
    const s0 = Math.max(0.02, from.width / Math.max(1, art.width))
    // t at e=0: whatever puts the scaled projection centre on the piece's
    const tx = from.left + from.width / 2 - ox - s0 * (artCx - ox)
    const ty = from.top + from.height / 2 - oy - s0 * (artCy - oy)
    stage.style.transformOrigin = "50% 50%"
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${s0})`
    // NO FADE, EITHER WAY. The piece hides the moment the picker opens and stays
    // hidden until it unmounts, so any stage fade leaves a window with the piece
    // invisible AND the stage invisible — a blank gap. Closing showed it worst:
    // the hologram vanished before the new collectable appeared on its piece.
    // Opaque from the first frame to the last, and the handover is one frame:
    // the same React batch that drops the picker puts the new art on the piece.
    // (The JSX starts at opacity 0 only to cover the paint before this runs;
    // useLayoutEffect lands ahead of it.)
    stage.style.opacity = "1"

    let raf = 0
    let last = performance.now()
    const want = closing ? 0 : 1
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      springK.current += (want - springK.current) * Math.min(1, dt * 6)
      if (Math.abs(want - springK.current) < 0.003) springK.current = want
      const k = springK.current
      const e = k * k * (3 - 2 * k)
      // the zoom
      stage.style.transform =
        `translate(${tx * (1 - e)}px, ${ty * (1 - e)}px) scale(${s0 + (1 - s0) * e})`
      // TWO ramps. The veil comes in EARLY: the surroundings fall away while
      // the collectable is still growing, which is what makes this read as
      // diving into it rather than a panel arriving. The dressing stays late.
      const veil = Math.min(1, Math.max(0, (e - 0.08) / 0.42))
      const dress = Math.min(1, Math.max(0, (e - 0.45) / 0.55))
      backdrop.style.opacity = String(veil)
      if (dressRef.current) dressRef.current.style.opacity = String(dress)
      if (coinWrapRef.current) {
        coinWrapRef.current.style.opacity = String(dress)
        // not grabbable until it is actually there to grab
        coinWrapRef.current.style.pointerEvents = dress > 0.6 ? "auto" : "none"
      }
      // the piece's own art hands over to the hologram on the same ramp
      if (plainRef.current) plainRef.current.style.opacity = String(1 - dress)
      if (k !== want) {
        raf = requestAnimationFrame(tick)
      } else if (closing && !finishedRef.current) {
        // the stage landed back on its piece — NOW commit
        finishedRef.current = true
        const picked = previewRef.current
        if (picked) onPick(picked)
        else onClose()
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // the zoom re-arms when the exit starts; the origin is fixed per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing])

  return (
    <div className="fixed inset-0 z-50">
      {/* the two filters */}
      <svg aria-hidden focusable="false" className="absolute size-0">
        <defs>
          <filter id="fx-holo-tint" colorInterpolationFilters="sRGB">
            <feColorMatrix
              type="matrix"
              values="0.3 0.59 0.11 0 0  0.3 0.59 0.11 0 0  0.3 0.59 0.11 0 0  0 0 0 1 0"
            />
            <feComponentTransfer>
              <feFuncR type="table" tableValues={TINT_TABLES[0]} />
              <feFuncG type="table" tableValues={TINT_TABLES[1]} />
              <feFuncB type="table" tableValues={TINT_TABLES[2]} />
            </feComponentTransfer>
          </filter>
          <filter id="fx-holo-glitch" colorInterpolationFilters="sRGB" x="-25%" y="-25%" width="150%" height="150%">
            <feTurbulence type="turbulence" baseFrequency="0.008 0.14" numOctaves={1} seed={7} result="tur">
              <animate
                ref={seedRef}
                attributeName="seed"
                values="7;41;18;63;7"
                keyTimes="0;0.28;0.52;0.78;1"
                dur={`${TEAR_MS / 1000}s`}
                begin="indefinite"
                fill="freeze"
              />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="tur" scale={0} xChannelSelector="R" yChannelSelector="G" result="torn">
              <animate
                ref={ampRef}
                attributeName="scale"
                values="0;34;8;46;0"
                keyTimes="0;0.22;0.5;0.74;1"
                dur={`${TEAR_MS / 1000}s`}
                begin="indefinite"
                fill="freeze"
              />
            </feDisplacementMap>
            <feColorMatrix in="torn" type="matrix" result="rch" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" />
            <feOffset in="rch" dx={5} dy={0} result="rsh" />
            <feColorMatrix in="torn" type="matrix" result="gbch" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" />
            <feOffset in="gbch" dx={-5} dy={0} result="gbsh" />
            <feBlend in="rsh" in2="gbsh" mode="screen" />
          </filter>
        </defs>
      </svg>

      {/* 1 — the backdrop; a tap starts the flight home (the turn IS the
             choice: whatever stands at the front is what you leave with) */}
      <button
        ref={backdropRef}
        type="button"
        aria-label="Close"
        // OPAQUE. At 70% the whole chest showed through — every unopened
        // piece, the other pieces, the footer — and the hologram read as a
        // panel floating over a busy screen instead of the only thing there.
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
        onClick={() => setClosing(true)}
      />

      {/* 2 — the stage: full-viewport, and the ONE transformed element. It
             starts mapped onto the tapped piece and zooms out to identity. */}
      <div
        ref={stageRef}
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
        style={{ opacity: 0 }}
      >
        {/* z-10: the beam inside this box has to paint IN FRONT of the coin,
            which is a later positioned sibling and would otherwise cover the
            beam's foot. In front, and reaching past the coin's top edge, it
            reads as light rising out of the middle of the coin's face. */}
        <div className="relative z-10 flex h-72 w-72 flex-col items-center justify-end">
          {/* the beam, foot pinned to the coin below — part of the DRESSING,
              so it arrives after the collectable has finished zooming */}
          {/* The wrapper MUST repeat the parent's flex centring. The beams are
              absolute with no left/right, so their position comes from their
              STATIC position — which is where flex would have put them. A
              plain block wrapper resolves that to its own left edge instead,
              and the beams end up 48px left of the art they belong under. */}
          <div
            ref={dressRef}
            className="absolute inset-0 flex flex-col items-center justify-end"
            style={{ opacity: 0 }}
          >
          <div
            aria-hidden
            className="absolute -bottom-6 h-48 w-48 origin-bottom motion-safe:animate-[holo-breathe_3.4s_ease-in-out_infinite]"
            style={{
              clipPath: "polygon(50% 100%, 22% 0%, 78% 0%)",
              background: "linear-gradient(to top, rgba(78,196,255,0.32), rgba(78,196,255,0.02))",
            }}
          />
          <div
            aria-hidden
            className="absolute -bottom-6 h-48 w-48 origin-bottom"
            style={{
              clipPath: "polygon(50% 100%, 42% 0%, 58% 0%)",
              background: "linear-gradient(to top, rgba(78,196,255,0.5), rgba(78,196,255,0.04))",
            }}
          />
          </div>
          {/* the projection — the piece itself, present from the first frame.
              The OUTER div is static and is what the zoom measures; the float
              animation lives on the inner one, or we would be measuring a box
              that is drifting up and down a few pixels. */}
          <div ref={artRef} className="absolute inset-x-8 top-0 bottom-14">
          <div className="h-full w-full motion-safe:animate-[holo-float_4.2s_ease-in-out_infinite]">
            {projected.src ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- gateway art */}
                <img
                  src={projected.src}
                  alt={projected.name}
                  className="absolute inset-0 h-full w-full object-contain motion-safe:animate-[holo-flicker_2.8s_steps(1)_infinite]"
                  style={{
                    filter: tearing ? "url(#fx-holo-tint) url(#fx-holo-glitch)" : "url(#fx-holo-tint)",
                  }}
                />
                {/* the SAME art, untinted: what the piece was showing. It fades
                    out as the zoom lands, so the piece becomes a hologram
                    rather than arriving as one. */}
                {/* eslint-disable-next-line @next/next/no-img-element -- gateway art */}
                <img
                  ref={plainRef}
                  src={projected.src}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 h-full w-full object-contain"
                />
              </>
            ) : null}
          </div>
          </div>
        </div>
        {/* the coin — the one interactive thing on the stage, and dressing:
            a coin shrunk into a piece's box reads as debris, so it fades in late */}
        {/* THE COIN'S FOOTPRINT, not the coin's canvas.
            Its size is a fraction of its canvas height (rc = h · 0.42, and the
            tilted slab stands about HALF its canvas tall — measured, not
            derived: the 3D slab is deeper than its face), so a coin worth
            looking at needs a taller canvas. Letting that canvas take
            its full height in the layout would drop ~190px of empty space
            under the coin and shove the whole composition off centre — the
            flex centres content height, not ink.
            So this box is the coin's VISIBLE height and the canvas overflows
            it. Its top edge is where the coin's top edge lands (CoinCanvas
            anchors it there), so the margin here is simply the beam-to-coin
            gap: a slight overlap, so the beam lands ON the coin's face. */}
        <div
          ref={coinWrapRef}
          className="relative z-0 -mt-6 h-40 w-full max-w-sm"
          style={{ opacity: 0, pointerEvents: "none" }}
        >
          <CoinCanvas
            ref={coinRef}
            facets={facets}
            onFacetChange={projectFacet}
            className="pointer-events-auto absolute inset-x-0 top-0 h-80"
          />
        </div>
      </div>

    </div>
  )
}
