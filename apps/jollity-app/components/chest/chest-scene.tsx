// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The chest scene's UI half — a thin canvas host. All the behavior lives in
 * lib/chest-scene (typed in index.ts over the untyped engine.ts); this component only feeds it params: the
 * collectable items, when to open, and the box it lives in. Pointer
 * gestures forward to the engine (drag pieces, tap to zoom).
 *
 * THE WRAPPING (the shell effect in lib/wrapping): from the moment
 * a piece comes out of the bubble its flat art hands off to a GL "wrapping"
 * — the artwork encased in a translucent shell
 * (prism for rares, liquid/frost for commons, picked by art-URL hash). The
 * engine keeps owning WHERE everything is; the wrapping layer is a second
 * canvas that draws each shell at the placement the engine reports every
 * frame — so drag, push, and zoom all carry the shells with them. Fields are
 * prefetched while the bubble collects. Without WebGL, after its context is lost, or
 * with CORS-tainted art, the flat sprites quietly stay in place.
 *
 * THE CHEST FILLS AS THE CLAIMS COME IN. One engine for the whole visit:
 * every item the page adds becomes a piece that flies in as an orb in its
 * rarity's colour, into the bubble or, once it has popped, to its place
 * among the others. When the bubble pops is the page's (`open`); a tap pops
 * it early once something is in.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createChestScene, type ChestPlacement, type ChestScene as ChestSceneEngine } from "@/lib/chest-scene"
import { loadImage } from "@/lib/dom/image"
// the grid-arrival feel is the game's, so the tuning is the game's too
import { LAYOUT_EASE, LAYOUT_MS, PARK_MIN_PX } from "@/components/game/animations"
import { BASE, materialFor, wrappingPhase } from "@/lib/wrapping/materials"
import { ensureFields, releaseFields } from "@/lib/wrapping/fieldCache"
import { markWrappingUnavailable, wrappingExpected } from "@/lib/wrapping/availability"
import type { WrappingRenderer, WrappingDrawEntry } from "@/lib/wrapping/renderer"
import { devLog } from "@/lib/debug/log-store"

interface ChestItemView {
  image?: string
  rare?: boolean
  tier?: string
  name?: string
}

/** an orb's colour, by the item's rarity tier (lib collectables' default
 *  ladder: common, uncommon, rare, legendary); another collection's own tier
 *  names fall back to gold for a rare and white for the rest */
const TIER_TINT: Record<string, string> = {
  common: "#e3ecff",
  uncommon: "#6ff0b4",
  rare: "#6fb8ff",
  legendary: "#ffc94d",
}
function orbTint(item: ChestItemView): string {
  const tier = item.tier?.trim().toLowerCase()
  return (tier ? TIER_TINT[tier] : undefined) ?? (item.rare ? TIER_TINT.legendary! : TIER_TINT.common!)
}

/** Where a piece of the scatter is drawn this frame, in viewport pixels. */
export interface PieceSpot {
  index: number
  cx: number
  cy: number
  size: number
  rotation: number
}

export interface ChestSceneProps {
  /** names this showing: a new seed starts the scene over */
  seed?: string
  /** the collectables, one piece each (0–10; the page skips the scene at 0) */
  items: ChestItemView[]
  /** a tap on a pinned collectable — the page opens the picker over it
   *  (the rect is the pin's box, the zoom's starting frame) */
  onShelfTap?: (index: number, rect: DOMRect) => void
  /** the pin the picker is open over: it hides its art while the picker's
   *  hero stands in for it, or the hologram fronts a copy of itself */
  inspected?: number | null
  /** pop the bubble now (or the moment it is blown): the screen's timing */
  open?: boolean
  /** a tap may open it: something is in (the screen's word) */
  canOpen?: boolean
  /** the bubble is blown and floats, collecting */
  onLanded?: () => void
  /** the bubble popped, by `open` or by a tap */
  onOpened?: () => void
  /** how many pieces have arrived, in the bubble or in their place */
  onCollected?: (count: number) => void
  /** a piece zoomed in to the middle of the frame, or back out */
  onFocus?: (focused: boolean) => void
  /** every frame, where the scatter draws each piece it still holds */
  onPieces?: (spots: PieceSpot[]) => void
  /** the pieces have been handed to another layer, which draws them now */
  released?: boolean
  className?: string
}

/** the strip's exit, before the inventory arrives */
const STRIP_OUT_MS = 380
/** one card after another, so the grid assembles rather than appearing */
const CARD_STAGGER_MS = 70

const HIT: readonly [number, number] = [0.5, 0.5]

/** The pop: one tap on a focused piece and uBreak runs 0 → 1 from the tap
 *  point — the shell shatters outright, no cracking stages in between. */
const SHATTER_MS = 620
/** the flat sprites' longest side, px (a piece is ~120 css px; the zoom shows the wrapping) */
const SPRITE_MAX = 512

const easeOut = (k: number) => 1 - Math.pow(1 - Math.min(1, k), 3)

type DiscPlacement = ChestPlacement

export function ChestScene({
  seed,
  items,
  onShelfTap,
  inspected = null,
  open = false,
  onLanded,
  onOpened,
  onCollected,
  onPieces,
  onFocus,
  released = false,
  canOpen = false,
  className,
}: ChestSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<ChestSceneEngine | null>(null)
  const rendererRef = useRef<WrappingRenderer | null>(null)
  // the press point of each piece's LAST crack, in its own uv — computed once
  // per crack (hitUv inverts the current blit, so it must be read while the
  // press geometry is still fresh, not re-derived after the piece moves)
  const hitUvRef = useRef(new Map<string, { crack: number; uv: readonly [number, number] }>())
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  // the page's callbacks, read when the engine speaks
  const hostCallbacks = useRef({ onLanded, onOpened, onCollected, onPieces, onFocus })
  useEffect(() => {
    hostCallbacks.current = { onLanded, onOpened, onCollected, onPieces, onFocus }
  }, [onLanded, onOpened, onCollected, onPieces, onFocus])
  // the items handed to the engine so far, and how many of them have arrived
  const addedRef = useRef(0)
  const collectedRef = useRef(0)

  // ── PINNED: a broken-open
  // piece flies to the top of the frame and stays pinned there — landing
  // order, left to right. There is no shelf object; the collectables
  // themselves are the row ────────────────────────────────────────────────
  /** piece indices in landing order; a pin appears when its flight lands */
  const [shelf, setShelf] = useState<number[]>([])
  // the pins appear only once the chest animation is over (bubble popped,
  // camera settled on the pieces) — nothing pinned while it collects or pops
  const [staged, setStaged] = useState(false)
  const stagedRef = useRef(false)
  // every piece popped: the strip of pins gives way to the scrolling
  // inventory (the unfold, below)
  const complete = shelf.length >= Math.min(10, items.length) && items.length > 0
  // a tap pops the bubble only once the screen says something is in
  const canOpenRef = useRef(canOpen)
  useEffect(() => {
    canOpenRef.current = canOpen
  }, [canOpen])
  const openedRef = useRef(new Set<number>())
  // `open` as the engine's start reads it
  const openRef_ = useRef(open)
  useEffect(() => {
    openRef_.current = open
  }, [open])
  const slotRefs = useRef<(HTMLDivElement | null)[]>([])
  const flightLayerRef = useRef<HTMLDivElement>(null)


  /**
   * THE UNFOLD, in two beats — the strip LEAVES, then the inventory ARRIVES.
   *
   * Not a morph. The strip and the inventory are different layouts (a flex
   * row of 72px pins; a scrolling grid of half-width cards), and trying to
   * carry elements between them is what made this look broken: a CSS
   * transition animates a flex child's width while the layout snaps its
   * position, and the wrap point moves mid-flight so cards jump rows.
   *
   * So the strip slides out the way it came in, and once it is gone the cards
   * fly in from the nearest edge, staggered — the game's own language for a
   * grid arriving (see components/game/animations: parked tiles clear the
   * stage sideways, then glide in on LAYOUT_EASE).
   */
  // ONE piece of state — has the strip finished leaving — and the phase is
  // derived from it. Setting the phase directly from an effect would be a
  // cascading render; a timer callback is the honest place for it.
  const [cardsIn, setCardsIn] = useState(false)
  useEffect(() => {
    if (!complete || cardsIn) return
    const timer = setTimeout(() => setCardsIn(true), STRIP_OUT_MS)
    return () => clearTimeout(timer)
  }, [complete, cardsIn])
  const unfold = !complete ? "strip" : cardsIn ? "cards" : "leaving"

  const gridRef = useRef<HTMLDivElement>(null)

  /**
   * THE STRIP LEAVING. Imperative, not CSS: the strip arrives on a
   * `shelf-slide` animation, and an exit written as a second CSS animation
   * with THE SAME KEYFRAME NAME is treated as the same animation — the
   * browser updates it in place instead of restarting it, and since the
   * entrance had already finished the strip just snapped away with no
   * animation at all. A WAAPI animation is its own thing and always plays.
   */
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (unfold !== "leaving" || !grid) return
    const leaving = grid.animate(
      [
        { transform: "none", opacity: 1 },
        { transform: "translateY(-34px)", opacity: 0 },
      ],
      {
        duration: STRIP_OUT_MS,
        // out fast and gone — it is leaving, not presenting itself
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        // it must HOLD at gone: the phase flips a frame or two later, and a
        // strip that snapped back to visible in between would flash
        fill: "forwards",
      },
    )
    // ...but this is the same element the inventory renders into, so the hold
    // has to be released when the cards arrive. Left filling forwards, it
    // pins the whole grid at opacity 0 and nothing is ever seen again.
    return () => leaving.cancel()
  }, [unfold])

  /** the cards' entrance: each one from whichever edge it is nearest */
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (unfold !== "cards" || !grid) return
    const box = grid.getBoundingClientRect()
    const middle = box.left + box.width / 2
    const cards = [...grid.children] as HTMLElement[]
    cards.forEach((el, order) => {
      const rect = el.getBoundingClientRect()
      const fromLeft = rect.left + rect.width / 2 < middle
      const dx = Math.max(PARK_MIN_PX, rect.width + 24) * (fromLeft ? -1 : 1)
      el.animate(
        [
          { transform: `translateX(${dx}px)`, opacity: 0 },
          { transform: "none", opacity: 1 },
        ],
        {
          duration: LAYOUT_MS,
          easing: LAYOUT_EASE,
          delay: order * CARD_STAGGER_MS,
          // both, so a card waiting its turn is already parked rather than
          // sitting at rest for a beat and then jumping off-screen
          fill: "both",
        },
      )
    })
  }, [unfold])

  /** the freed art flies from where the piece was to its shelf slot */
  const launchFlight = (index: number, from: { cx: number; cy: number; size: number }) => {
    const host = hostRef.current
    const layer = flightLayerRef.current
    const order = openedRef.current.size - 1
    const slot = slotRefs.current[order]
    const src = itemsRef.current[index]?.image
    const land = () => setShelf((prev) => (prev.includes(index) ? prev : [...prev, index]))
    if (!host || !layer || !slot || !src) {
      land()
      return
    }
    const hostBox = host.getBoundingClientRect()
    const slotBox = slot.getBoundingClientRect()
    const startSide = from.size * 0.86 // the wrapped art's fit
    const img = document.createElement("img")
    img.src = src
    img.alt = ""
    img.style.cssText =
      "position:absolute;left:0;top:0;object-fit:contain;pointer-events:none;" +
      `width:${startSide}px;height:${startSide}px;`
    layer.appendChild(img)
    const sx = from.cx - startSide / 2
    const sy = from.cy - startSide / 2
    const tx = slotBox.left - hostBox.left + (slotBox.width - startSide) / 2
    const ty = slotBox.top - hostBox.top + (slotBox.height - startSide) / 2
    const scale = (slotBox.width * 0.86) / startSide
    const anim = img.animate(
      [
        { transform: `translate(${sx}px, ${sy}px) scale(1)` },
        { transform: `translate(${tx}px, ${ty}px) scale(${scale})` },
      ],
      { duration: 620, easing: "cubic-bezier(0.3, 0.8, 0.3, 1)", fill: "forwards" },
    )
    anim.onfinish = () => {
      land()
      img.remove()
    }
  }

  /** hand the engine every item it does not have yet: each flies in as an orb */
  const addPieces = (scene: ChestSceneEngine) => {
    const list = itemsRef.current
    while (addedRef.current < Math.min(10, list.length)) {
      if (scene.addPiece(orbTint(list[addedRef.current]!)) < 0) break
      addedRef.current += 1
    }
  }
  useEffect(() => {
    const scene = sceneRef.current
    if (scene) addPieces(scene)
  }, [items.length])
  useEffect(() => {
    if (open) sceneRef.current?.open()
  }, [open])

  // one engine per showing: it starts empty, and every item comes in as an orb
  useEffect(() => {
    const canvas = canvasRef.current
    const wrapCanvas = wrapRef.current
    const host = hostRef.current
    if (!canvas || !wrapCanvas || !host) return

    let disposed = false
    addedRef.current = 0
    collectedRef.current = 0
    const scene = createChestScene(canvas, {
      count: 0,
      // a tap pops the bubble early, once something is in it
      canOpen: () => canOpenRef.current,
      onEvent: (name: string, data?: { on?: boolean }) => {
        if (name === "focus") hostCallbacks.current.onFocus?.(!!data?.on)
        else if (name === "open") hostCallbacks.current.onOpened?.()
        else if (name === "landed") hostCallbacks.current.onLanded?.()
        else if (name === "absorb" || name === "arrive") {
          collectedRef.current += 1
          hostCallbacks.current.onCollected?.(collectedRef.current)
        }
      },
      // TODO(sound): the engine emits 'absorb' / 'burst' / 'pop' {index}
      // here — synthesize a catch, the bubble's pop and the shatter (rare
      // shimmer) via WebAudio when sound lands. Haptics hook into the same
      // events (see the engine's pop TODO).
      // every frame: where the pieces are — the wrapping layer draws its
      // shells there and hides the flat art it replaces
      onDiscs(placements: DiscPlacement[], blend: number) {
        if (blend >= 0.999 && !stagedRef.current) {
          stagedRef.current = true
          setStaged(true)
        }
        const renderer = rendererRef.current
        const rect = wrapCanvas.getBoundingClientRect()
        const entries: WrappingDrawEntry[] = []
        const spots: PieceSpot[] = []
        for (const p of placements) {
          const item = itemsRef.current[p.index]
          const url = item?.image
          const id = String(p.index)

          // ── the pop: a single tap, and the shell shatters from zero ─────
          const stage = p.crack > 0 ? 1 : 0
          const ageMs = p.crackAge * 1000
          let brk = 0
          let animating = false
          if (stage === 1) {
            brk = easeOut(ageMs / SHATTER_MS)
            animating = brk < 1
          }
          const shattered = stage === 1 && !animating

          if (shattered) {
            // fully broken: the freed art leaves the scatter for the shelf
            scene.setSpriteHidden(p.index, true)
            if (!openedRef.current.has(p.index)) {
              openedRef.current.add(p.index)
              scene.removePiece(p.index)
              launchFlight(p.index, p)
            }
            continue
          }
          spots.push({ index: p.index, cx: rect.left + p.cx, cy: rect.top + p.cy, size: p.size, rotation: p.rotation })
          if (!renderer || !url || !renderer.has(url)) {
            scene.setSpriteHidden(p.index, false) // art not ready — flat sprite
            continue
          }
          scene.setSpriteHidden(p.index, true)

          // where the last tap landed, in this shell's own uv — the cracks
          // fly apart from the finger. Cached once per pop.
          let hit: readonly [number, number] = HIT
          if (stage > 0) {
            const cached = hitUvRef.current.get(id)
            if (cached && cached.crack === stage) {
              hit = cached.uv
            } else {
              const uv = renderer.hitUv(id, rect.left + p.hitX, rect.top + p.hitY)
              if (uv) {
                hit = uv
                hitUvRef.current.set(id, { crack: stage, uv })
              }
            }
          }

          entries.push({
            id,
            url,
            material: materialFor(url, !!item.rare),
            phase: wrappingPhase(p.index),
            brk,
            hit,
            // fast movement (the burst) and a running pulse/shatter both
            // need a shade every frame, or the picture lags the motion
            moving: blend < 0.999 || animating,
            place: {
              cx: rect.left + p.cx,
              cy: rect.top + p.cy,
              size: p.size,
              rotation: p.rotation,
              opacity: 1,
            },
          })
        }
        renderer?.draw(entries, performance.now())
        hostCallbacks.current.onPieces?.(spots)
      },
    })
    sceneRef.current = scene
    addPieces(scene)
    if (openRef_.current) scene.open()
    const observer = new ResizeObserver(() => {
      scene.resize(host.clientWidth, host.clientHeight)
    })
    observer.observe(host)
    scene.resize(host.clientWidth, host.clientHeight)

    // the wrapping renderer — lazily, and only where it can actually run;
    // any failure leaves rendererRef null and the flat sprites stay
    const onContextLost = () => {
      markWrappingUnavailable("lost webgl context")
      devLog("chest", "wrapping context lost, the flat art stands in", undefined, "warn")
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
    wrapCanvas.addEventListener("webglcontextlost", onContextLost)
    if (wrappingExpected()) {
      void import("@/lib/wrapping/renderer").then(({ WrappingRenderer: Renderer }) => {
        if (disposed) return
        try {
          rendererRef.current = new Renderer(wrapCanvas)
        } catch {
          rendererRef.current = null
          return
        }
        // fields that finished building BEFORE the renderer existed still
        // need their upload — the cache answers these instantly
        for (const item of itemsRef.current.slice(0, 10)) {
          const src = item.image
          if (!src) continue
          void ensureFields(src)
            .then((entry) => {
              if (!disposed) rendererRef.current?.upload(src, entry, entry.image)
            })
            .catch(() => {})
        }
      })
    }

    return () => {
      disposed = true
      // dispose() loses the context on purpose, so the listener is removed first.
      wrapCanvas.removeEventListener("webglcontextlost", onContextLost)
      observer.disconnect()
      scene.destroy()
      sceneRef.current = null
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
    // one engine per showing: the items and `open` reach it through refs
  }, [seed])

  // the art BY VALUE: the page hands a new `items` array on every render, and
  // keyed on the array the effect below re-decoded every sprite each time
  // (settling, every picker open and close) — and the engine drew the stand-in
  // discs between the old bitmaps closing and the new ones landing
  const artKey = items
    .slice(0, 10)
    .map((item) => item.image ?? "")
    .join("\n")

  // warm the wrappings while the bubble collects: build each art's fields
  // (CORS load + distance transform) and upload — by the time the camera
  // settles on the pieces, renderer.has(url) is already true
  useEffect(() => {
    let cancelled = false
    const sprites: { image: CanvasImageSource & { width: number; height: number }; scale: number }[] = []
    // sprites decoded ahead at their drawn size: an <img> decodes on its first draw (the burst's frame)
    const bitmaps: ImageBitmap[] = []
    const flat = (img: HTMLImageElement): Promise<CanvasImageSource & { width: number; height: number }> => {
      const k = Math.min(1, SPRITE_MAX / Math.max(img.naturalWidth, img.naturalHeight, 1))
      return createImageBitmap(img, {
        resizeWidth: Math.max(1, Math.round(img.naturalWidth * k)),
        resizeHeight: Math.max(1, Math.round(img.naturalHeight * k)),
        resizeQuality: "high",
      }).then(
        (bitmap) => {
          if (cancelled) {
            bitmap.close()
            return img
          }
          bitmaps.push(bitmap)
          return bitmap
        },
        () => img,
      )
    }
    artKey.split("\n").forEach((src, i) => {
      if (!src) return
      void ensureFields(src)
        .then(async (entry) => {
          if (cancelled) return
          rendererRef.current?.upload(src, entry, entry.image)
          // the flat sprite is the same CORS-clean decoded image, sized by
          // the SAME fit the shell uses (art bbox at BASE.fit of the box) —
          // so breaking the wrapping never changes the picture's size
          const span = Math.max(entry.bbox[2] - entry.bbox[0], entry.bbox[3] - entry.bbox[1])
          // With the wrapping expected the shell draws this art, and the flat
          // sprite only stands in after a lost context: the decoded field
          // image serves for that. A bitmap is a second decoded copy (1 MB a
          // piece at 512 px), worth it only where the sprite IS the art from
          // the burst on, or where it must shrink.
          const fits = Math.max(entry.image.naturalWidth, entry.image.naturalHeight) <= SPRITE_MAX
          const image = wrappingExpected() && fits ? entry.image : await flat(entry.image)
          if (cancelled) return
          sprites[i] = { image, scale: span > 0 ? BASE.fit / span : 1 }
          sceneRef.current?.setSprites(sprites)
        })
        .catch(() => {
          // CORS or a dead gateway: fall back to a plain (taint-ok) image for
          // the flat sprite; the wrapping simply never claims this piece
          void loadImage(src)
            .then(flat)
            .then((image) => {
              if (cancelled) return
              sprites[i] = { image, scale: 1 }
              sceneRef.current?.setSprites(sprites)
            })
            .catch(() => {})
        })
    })
    return () => {
      cancelled = true
      bitmaps.forEach((bitmap) => bitmap.close())
    }
  }, [artKey])

  // the fields and their decoded art are this showing's: nothing else reads
  // them, and a later showing rebuilds them while its bubble collects
  useEffect(() => releaseFields, [])

  return (
    <div ref={hostRef} className={"relative overflow-hidden " + (className ?? "")}>
      <canvas
        ref={canvasRef}
        className={"absolute inset-0 h-full w-full cursor-pointer touch-none" + (released ? " opacity-0" : "")}
        onPointerDown={(event) => {
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            /* capture is a nicety — never lose the press */
          }
          const rect = event.currentTarget.getBoundingClientRect()
          sceneRef.current?.press(event.clientX - rect.left, event.clientY - rect.top)
        }}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          sceneRef.current?.move(event.clientX - rect.left, event.clientY - rect.top)
        }}
        onPointerUp={() => sceneRef.current?.release()}
        onPointerCancel={() => sceneRef.current?.release()}
        aria-label="Your chest opening"
        role="img"
      />
      {/* the wrapping layer: pointer-transparent — the engine canvas below
          keeps owning every gesture */}
      <canvas ref={wrapRef} className={"pointer-events-none absolute inset-0 h-full w-full" + (released ? " opacity-0" : "")} />
      {/* flights in progress: freed art on its way up to the band */}
      <div ref={flightLayerRef} aria-hidden className="pointer-events-none absolute inset-0 z-10" />
      {/* PINNED — one slot per piece, top of the frame. A landed collectable
          pins there and is the way into the picker. With EVERY piece opened
          the strip slides out and the collectables come back as a scrolling
          inventory (see the unfold above): the reveal is over, so they stop
          being a strip along the top and become the screen. Nothing pins
          until the chest animation has played out. */}
      {staged ? (
      <div
        ref={gridRef}
        className={
          "absolute z-10 flex " +
          (unfold === "cards"
            ? // the inventory: the whole frame, and it SCROLLS — ten
              // collectables do not fit, and you came here to find one
              "pointer-events-auto inset-0 flex-wrap content-start justify-center gap-3 overflow-y-auto p-5"
            : // ONE strip, never a ragged wrap: the pins share the width and
              // take as much of it as the count allows
              "pointer-events-none inset-x-4 top-3 justify-center gap-1.5 " +
              // the exit is animated imperatively below — a CSS animation
              // here would still be on the element and fight it
              (unfold === "strip"
                ? "motion-safe:animate-[shelf-slide_500ms_cubic-bezier(0.22,0.9,0.3,1)_both]"
                : ""))
        }
      >
        {items.slice(0, 10).map((_, order) => {
          const pieceIndex = shelf[order]
          const landed = pieceIndex !== undefined
          const item = landed ? items[pieceIndex] : undefined
          const art = item?.image
          const name = item?.name ?? ""
          return (
            <div
              key={order}
              ref={(el) => {
                slotRefs.current[order] = el
              }}
              className={
                // KEYED ON THE PHASE, not on `complete`. Keyed on complete,
                // a pin became a card the instant the last piece landed — so
                // the strip slid up already wearing card chrome, instead of
                // taking the pinned collectables up as they were.
                // No css transition either: the entrance is animated
                // imperatively, and a `transition-all` here fights it.
                (unfold === "cards"
                  ? "flex w-[calc(50%-0.75rem)] max-w-44 flex-none flex-col overflow-hidden rounded-xl border border-white/15 bg-white/[0.06] "
                  : "flex w-full max-w-[72px] min-w-0 flex-1 flex-col ") +
                (landed
                  ? "pointer-events-auto cursor-pointer"
                  : // an empty pin is reserved air — there is no shelf under
                    // it to draw, only the collectable that will land
                    "opacity-0")
              }
              onClick={
                landed
                  ? (event) => {
                      // the ART's box, not the tile's: the picker aligns its
                      // own projection onto this rect, and the tile carries
                      // padding (and a label, in the inventory) that would throw
                      // the handover off by its own margins
                      const art = event.currentTarget.querySelector("img")
                      onShelfTap?.(
                        pieceIndex,
                        (art ?? event.currentTarget).getBoundingClientRect(),
                      )
                    }
                  : undefined
              }
              role={landed ? "button" : undefined}
              aria-label={landed ? `Inspect ${name || "collectable"}` : undefined}
            >
              {art ? (
                // eslint-disable-next-line @next/next/no-img-element -- gateway art
                <img
                  src={art}
                  alt=""
                  data-chest-piece={pieceIndex}
                  className={
                    // NO transition: this art is handed to and from the
                    // picker's stage, which lands exactly on this box. A fade
                    // here is a fade of NOTHING — the stage has already gone —
                    // so the new collectable appeared late on every swap.
                    "aspect-square w-full object-contain " +
                    (unfold === "cards"
                      ? "p-3 "
                      : // pinned: the art carries its own drop shadow so it
                        // reads as an object stuck to the top of the frame
                        "p-0.5 drop-shadow-[0_3px_6px_rgba(0,0,0,0.55)] ") +
                    // the INSPECTED pin hands off to the picker: its art hides
                    // while the projection is parked over the beam
                    (inspected === pieceIndex ? "opacity-0" : "opacity-100")
                  }
                />
              ) : (
                <div className="aspect-square w-full" />
              )}
              {unfold === "cards" && landed ? (
                <div className="flex flex-col gap-0.5 border-t border-white/[0.07] px-3 py-2 text-left">
                  <span className="truncate text-sm font-semibold">{name || "Collectable"}</span>
                  <span
                    className={
                      "text-[11px] font-semibold tracking-[0.08em] uppercase " +
                      (item?.rare ? "text-warning" : "text-muted-foreground")
                    }
                  >
                    {item?.rare ? `★ ${item.tier ?? "Rare"}` : (item?.tier ?? "Common")}
                  </span>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      ) : null}
    </div>
  )
}
