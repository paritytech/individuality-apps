// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The collectables scene's UI half — a dumb canvas host. All the behavior lives in
 * lib/collectables-scene/engine.ts; this component only feeds it params: the
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
 * THE COLLECTABLES SCREEN FILLS AS THE CLAIMS COME IN. One engine for the whole visit:
 * every item the page adds becomes a piece that flies in as an orb in its
 * rarity's colour, into the bubble or, once it has popped, to its place
 * among the others. When the bubble pops is the page's (`open`); a tap pops
 * it early once something is in.
 *
 * AN OPENED PIECE STAYS IN THE SCENE, as a plain image ON THE PAGE. Once its
 * shell has shattered the wrapping stops drawing it and its image — a button,
 * there from the start but hidden — takes its place at the same size, moved
 * every frame by `transform` alone (no layout, no canvas paint), floating up
 * to the opened ones while the unopened ones settle below (the engine's
 * float). A tap on it opens the picker over it, from the keyboard too, and
 * the Pocket finds it by `data-collectables-piece`. With every piece opened they
 * all keep floating, until the Pocket's book closes over them.
 *
 * THE POCKET TAKES THEM ONE BY ONE (components/pocket): a piece it has
 * `taken` is gone from the scene, its shell, its sprite and its button, and
 * the pieces still out dim as the book's `cover` closes. The words at the top
 * say what to do next, and go as soon as the cover moves.
 */
import { useEffect, useRef, useState, type RefObject } from "react"
import { createCollectablesScene, type CollectablesPlacement, type CollectablesScene as CollectablesSceneEngine } from "@/lib/collectables-scene"
import { carryShown, takeCarried } from "@/lib/collectables-scene/carry"
import { loadImage } from "@/lib/dom/image"
import { BASE, materialFor, wrappingPhase } from "@/lib/wrapping/materials"
import { ensureFields, releaseFields } from "@/lib/wrapping/fieldCache"
import { markWrappingUnavailable, wrappingExpected } from "@/lib/wrapping/availability"
import type { WrappingRenderer, WrappingDrawEntry } from "@/lib/wrapping/renderer"
import { devLog } from "@/lib/debug/log-store"

export interface CollectablesItemView {
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
export function orbTint(item: CollectablesItemView): string {
  const tier = item.tier?.trim().toLowerCase()
  return (tier ? TIER_TINT[tier] : undefined) ?? (item.rare ? TIER_TINT.legendary! : TIER_TINT.common!)
}

/** Where a piece is drawn this frame, in viewport pixels. */
export interface PieceSpot {
  index: number
  cx: number
  cy: number
  size: number
  rotation: number
  /** broken open: drawn as its plain art, the button that carries `data-collectables-piece` */
  opened: boolean
  /** the Pocket has it: the scene keeps its place but does not draw it */
  taken?: boolean
}

export interface CollectablesSceneProps {
  /** names this showing: a new seed starts the scene over */
  seed?: string
  /** the collectables, one piece each (0–10; the page skips the scene at 0) */
  items: CollectablesItemView[]
  /** a tap on an opened collectable — the page
   *  opens the picker over it (the rect is its art's box, the zoom's starting
   *  frame) */
  onInspect?: (index: number, rect: DOMRect) => void
  /** the piece the picker is open over: it hides its art while the picker's
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
  /** every frame, where the scene draws each piece it still holds */
  onPieces?: (spots: PieceSpot[]) => void
  /** the pieces handed to the Pocket, which draws them now */
  taken?: readonly number[]
  /** pieces opened elsewhere (in the Pocket's book, then given back): open here too, with no shatter */
  openNow?: readonly number[]
  /** how far the Pocket's cover has closed, 0 to 1, read every frame */
  cover?: RefObject<number>
  /** the pieces float above this, px down the screen (the Pocket's book, once it is up); none: the scene's own foot */
  floor?: number | null
  className?: string
}

const HIT: readonly [number, number] = [0.5, 0.5]
/** air between the words at the top and the opened pieces under them, px */
const CEILING_GAP = 10

/** The pop: one tap on a focused piece and uBreak runs 0 → 1 from the tap
 *  point — the shell shatters outright, no cracking stages in between. */
const SHATTER_MS = 620
/** the flat sprites' longest side, px (a piece is ~120 css px; the zoom shows the wrapping) */
const SPRITE_MAX = 512

const easeOut = (k: number) => 1 - Math.pow(1 - Math.min(1, k), 3)

type DiscPlacement = CollectablesPlacement

/** the canvas's place on the page is read again this often, frames (and on every resize) */
const CANVAS_BOX_EVERY = 30

/** an opened piece's button, in CSS px: it is scaled to the piece every frame */
const OPENED_SIDE = 160

/** the words at the top come in between these, ms after the pieces begin to float */
const WORDS_FROM_MS = 900
const WORDS_TO_MS = 1400
/** with nothing opened yet, the words ask for the book this long after the float began, ms */
const WORDS_LATE_MS = 5000
/** the words are gone once the cover has closed this much */
const WORDS_GONE_AT = 0.3
/** a press this near a piece, of its box, is on it: the engine's own hit test */
const PIECE_HIT = 0.575
/** the pieces still out dim between these closings of the cover, by up to this much */
const DIM_FROM = 0.45
const DIM_TO = 0.75
const DIM = 0.6

/** nothing taken: one empty list, so a page without a Pocket does not hand a new one every render */
const NONE_TAKEN: readonly number[] = []

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const smooth = (n: number) => {
  const k = clamp01(n)
  return k * k * (3 - 2 * k)
}

export function CollectablesScene({
  seed,
  items,
  onInspect,
  inspected = null,
  open = false,
  onLanded,
  onOpened,
  onCollected,
  onPieces,
  onFocus,
  taken = NONE_TAKEN,
  openNow = NONE_TAKEN,
  cover,
  floor = null,
  canOpen = false,
  className,
}: CollectablesSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<CollectablesSceneEngine | null>(null)
  // the bubble the draw's hold carried here (lib/collectables-scene/carry), and how
  // many of its claims have lit: one quiet line under it says so
  const [carried, setCarried] = useState(false)
  const [lit, setLit] = useState(0)
  // the words at the top: what to do next, from when the pieces began to float
  const [zoomed, setZoomed] = useState(false)
  const [late, setLate] = useState(false)
  const floatAt = useRef(-1)
  const wordsRef = useRef<HTMLParagraphElement>(null)
  const piecesRef = useRef<HTMLDivElement>(null)
  // the Pocket's: gone from the scene, and where each was last drawn, so a
  // press there is not a tap on a piece nobody can see
  const takenRef = useRef(new Set<number>())
  useEffect(() => {
    takenRef.current = new Set(taken)
  }, [taken])
  const openNowRef = useRef(new Set<number>())
  useEffect(() => {
    openNowRef.current = new Set(openNow)
  }, [openNow])
  const lastSeen = useRef(new Map<number, { cx: number; cy: number; size: number }>())
  const coverRef = useRef(cover)
  useEffect(() => {
    coverRef.current = cover
  }, [cover])
  // the floor and the ceiling, in the canvas's own px: said to the engine when
  // they change, and when the canvas moves. The ceiling is under the words at
  // the top, so the opened pieces never cover what to do next
  const floorRef = useRef(floor)
  const applyEdges = () => {
    const canvas = canvasRef.current
    const top = canvas?.getBoundingClientRect().top ?? 0
    const f = floorRef.current
    sceneRef.current?.setFloor(f == null || !canvas ? null : f - top)
    const words = wordsRef.current
    sceneRef.current?.setCeiling(!words || !canvas ? null : words.getBoundingClientRect().bottom - top + CEILING_GAP)
  }
  useEffect(() => {
    floorRef.current = floor
    applyEdges()
  }, [floor])
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
  const hostCallbacks = useRef({ onLanded, onOpened, onCollected, onInspect, onPieces, onFocus })
  useEffect(() => {
    hostCallbacks.current = { onLanded, onOpened, onCollected, onInspect, onPieces, onFocus }
  }, [onLanded, onOpened, onCollected, onInspect, onPieces, onFocus])
  // the items handed to the engine so far, and how many of them have arrived
  const addedRef = useRef(0)
  const collectedRef = useRef(0)

  // ── OPENED: a broken-open piece stays in the scene as its plain art and
  // rises to the opened ones at the top (the engine's float), and floats there
  // until the Pocket's book closes, every piece opened or not ─────────────
  /** piece indices in the order they were opened */
  const [opened, setOpened] = useState<number[]>([])
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
  /** each piece's opened button (hidden until its shell breaks) */
  const openedEls = useRef<(HTMLButtonElement | null)[]>([])
  /** each piece's art as the sprite fits it: the image's box over the piece's, so the image is the wrapped art's size */
  const spriteFit = useRef<number[]>([])

  /** hand the engine every item it does not have yet: each flies in as an orb */
  const addPieces = (scene: CollectablesSceneEngine) => {
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
    // the draw's hold brought the bubble: it starts where the draw left it
    const carriedBubble = takeCarried()
    setCarried(!!carriedBubble)
    setLit(0)
    setLate(false)
    floatAt.current = -1
    let saidLate = false
    let canvasBox: DOMRect | null = null
    let canvasBoxAge = 0
    const scene = createCollectablesScene(canvas, {
      count: 0,
      carried: carriedBubble,
      onCarriedShown: carryShown,
      // a tap pops the bubble early, once something is in it
      canOpen: () => canOpenRef.current,
      onEvent: (name: string, data?: { on?: boolean; index?: number; x?: number; y?: number; side?: number }) => {
        if (name === "focus") {
          setZoomed(!!data?.on)
          hostCallbacks.current.onFocus?.(!!data?.on)
        } else if (name === "open") {
          if (floatAt.current < 0) floatAt.current = performance.now()
          hostCallbacks.current.onOpened?.()
        } else if (name === "burst") floatAt.current = performance.now()
        else if (name === "landed") hostCallbacks.current.onLanded?.()
        else if (name === "absorb" || name === "arrive") {
          collectedRef.current += 1
          if (carriedBubble) setLit(collectedRef.current)
          hostCallbacks.current.onCollected?.(collectedRef.current)
        } else if (name === "inspect" && data?.index !== undefined) {
          // an opened piece tapped: the picker opens out of its image's box
          const img = openedEls.current[data.index]?.querySelector("img")
          const box = canvas.getBoundingClientRect()
          const side = data.side ?? 0
          hostCallbacks.current.onInspect?.(
            data.index,
            img?.getBoundingClientRect() ??
              new DOMRect(box.left + (data.x ?? 0) - side / 2, box.top + (data.y ?? 0) - side / 2, side, side),
          )
        }
      },
      // TODO(sound): the engine emits 'absorb' / 'burst' / 'pop' {index}
      // here — synthesize a catch, the bubble's pop and the shatter (rare
      // shimmer) via WebAudio when sound lands. Haptics hook into the same
      // events (see the engine's pop TODO).
      // every frame: where the pieces are — the wrapping layer draws its
      // shells there and hides the flat art it replaces
      onDiscs(placements: DiscPlacement[], blend: number) {
        const renderer = rendererRef.current
        // where the canvas is on the page: read when it changes size, and now and then besides (the page above it may move it), not every frame
        if (!canvasBox || ++canvasBoxAge >= CANVAS_BOX_EVERY) {
          canvasBox = wrapCanvas.getBoundingClientRect()
          canvasBoxAge = 0
        }
        const rect = canvasBox
        const entries: WrappingDrawEntry[] = []
        const spots: PieceSpot[] = []
        const closed = coverRef.current?.current ?? 0
        const now = performance.now()
        // the words: in after the pop, out as the cover moves
        const words = wordsRef.current
        if (words) {
          const since = floatAt.current < 0 ? -1 : now - floatAt.current
          const shown = since < 0 ? 0 : clamp01((since - WORDS_FROM_MS) / (WORDS_TO_MS - WORDS_FROM_MS)) * (1 - smooth(closed / WORDS_GONE_AT))
          words.style.opacity = shown.toFixed(3)
          if (since > WORDS_LATE_MS && !saidLate) {
            saidLate = true
            setLate(true)
          }
        }
        // the pieces still out dim as the book closes on them
        if (piecesRef.current) piecesRef.current.style.opacity = (1 - DIM * smooth((closed - DIM_FROM) / (DIM_TO - DIM_FROM))).toFixed(3)
        for (const p of placements) {
          const item = itemsRef.current[p.index]
          const url = item?.image
          const id = String(p.index)

          // the Pocket's now: it draws this piece, the scene does not
          if (takenRef.current.has(p.index)) {
            lastSeen.current.set(p.index, { cx: p.cx, cy: p.cy, size: p.size })
            // where it would be: a piece the Pocket gives back flies home to here
            spots.push({ index: p.index, cx: rect.left + p.cx, cy: rect.top + p.cy, size: p.size, rotation: p.rotation, opened: openedRef.current.has(p.index), taken: true })
            scene.setSpriteHidden(p.index, true)
            const el = openedEls.current[p.index]
            if (el && el.style.display !== "none") el.style.display = "none"
            continue
          }
          // given back (or never taken): its spot is a piece again, to press
          lastSeen.current.delete(p.index)

          // opened elsewhere (the Pocket's book): open here at once, no shatter; it floats up with the opened ones,
          // with no rising light behind it: under a piece that flew home, that light reads as a stray box
          if (openNowRef.current.has(p.index) && !openedRef.current.has(p.index)) {
            openedRef.current.add(p.index)
            scene.openPiece(p.index, true)
            setOpened((prev) => (prev.includes(p.index) ? prev : [...prev, p.index]))
          }

          // ── the pop: a single tap, and the shell shatters from zero ─────
          const stage = p.crack > 0 ? 1 : 0
          const ageMs = p.crackAge * 1000
          let brk = 0
          let animating = false
          if (stage === 1) {
            brk = easeOut(ageMs / SHATTER_MS)
            animating = brk < 1
          }
          const shattered = (stage === 1 && !animating) || openedRef.current.has(p.index)

          if (shattered) {
            // fully broken: the shell is gone and the piece's image on the
            // page takes its place, the SAME size as the wrapped art (the
            // sprite's fit), so nothing jumps; the canvas draws it no more
            if (!openedRef.current.has(p.index)) {
              openedRef.current.add(p.index)
              scene.openPiece(p.index)
              setOpened((prev) => (prev.includes(p.index) ? prev : [...prev, p.index]))
            }
            scene.setSpriteHidden(p.index, true)
            const el = openedEls.current[p.index]
            if (el) {
              if (el.style.display === "none") el.style.display = ""
              const k = (p.size * (spriteFit.current[p.index] ?? 1)) / OPENED_SIDE
              el.style.transform =
                `translate3d(${p.cx - OPENED_SIDE / 2}px, ${p.cy - OPENED_SIDE / 2}px, 0) ` +
                `rotate(${p.rotation}deg) scale(${k * p.sx}, ${k * p.sy})`
            } else {
              scene.setSpriteHidden(p.index, false) // no button yet: the canvas stands in
            }
            spots.push({ index: p.index, cx: rect.left + p.cx, cy: rect.top + p.cy, size: p.size, rotation: p.rotation, opened: true })
            continue
          }
          spots.push({ index: p.index, cx: rect.left + p.cx, cy: rect.top + p.cy, size: p.size, rotation: p.rotation, opened: false })
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
      canvasBox = null
      applyEdges()
    })
    observer.observe(host)
    scene.resize(host.clientWidth, host.clientHeight)
    applyEdges()

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
          spriteFit.current[i] = sprites[i].scale
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
              spriteFit.current[i] = 1
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
        {/* the scene: every piece floats here, opened or not, until the Pocket's book closes */}
        <div className="absolute inset-0">
          {/* the pieces still out: they dim as the Pocket's cover closes */}
          <div ref={piecesRef} className="absolute inset-0">
            <canvas
              ref={canvasRef}
              className="absolute inset-0 h-full w-full cursor-pointer touch-none"
              onPointerDown={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                const x = event.clientX - rect.left
                const y = event.clientY - rect.top
                // where a piece the Pocket took was last drawn: nothing to tap there
                for (const spot of lastSeen.current.values()) if (Math.hypot(spot.cx - x, spot.cy - y) < spot.size * PIECE_HIT) return
                try {
                  event.currentTarget.setPointerCapture(event.pointerId)
                } catch {
                  /* capture is a nicety — never lose the press */
                }
                sceneRef.current?.press(x, y)
              }}
              onPointerMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                sceneRef.current?.move(event.clientX - rect.left, event.clientY - rect.top)
              }}
              onPointerUp={() => sceneRef.current?.release()}
              onPointerCancel={() => sceneRef.current?.release()}
              // a tap on an opened piece opens the picker as the finger lifts;
              // a phone then follows the touch with a click, which would land
              // on the picker's backdrop as it appears and close it at once
              onTouchEnd={(event) => event.preventDefault()}
              aria-label="Your collectables opening"
              role="img"
            />
            {/* the wrapping layer: pointer-transparent — the engine canvas below
                keeps owning every gesture */}
            <canvas ref={wrapRef} className="pointer-events-none absolute inset-0 h-full w-full" />
            {/* OPENED — each piece's image on the page, hidden until its shell
                breaks, then moved by transform every frame. Pointer-transparent:
                the engine canvas below owns every gesture (a tap on one opens
                the picker through the engine); a click here is the keyboard's. */}
            {items.slice(0, 10).map((item, index) => (
              <button
                key={index}
                type="button"
                ref={(el) => {
                  openedEls.current[index] = el
                  if (el && !openedRef.current.has(index)) el.style.display = "none"
                }}
                className={
                  "pointer-events-none absolute top-0 left-0 size-40 rounded-full will-change-transform focus-visible:outline-2 focus-visible:outline-white/70 " +
                  // the INSPECTED piece hands off to the picker: it hides while
                  // the projection stands in for it
                  (inspected === index ? "opacity-0" : "opacity-100")
                }
                aria-label={`Inspect ${item.name || "collectable"}`}
                onClick={(event) => {
                  const img = event.currentTarget.querySelector("img")
                  onInspect?.(index, (img ?? event.currentTarget).getBoundingClientRect())
                }}
              >
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- gateway art
                  <img
                    src={item.image}
                    alt=""
                    draggable={false}
                    // the Pocket lifts it from here
                    data-collectables-piece={index}
                    className="size-full object-contain"
                  />
                ) : null}
              </button>
            ))}
          </div>
          {/* a carried bubble (the draw's hold): what's happening, in one line under it */}
          <p
            aria-live="polite"
            className={
              "pointer-events-none absolute inset-x-0 top-[62%] text-center font-[family-name:var(--font-manrope)] text-[15px] font-medium tracking-[0.2px] text-[rgba(236,238,245,0.78)] transition-opacity duration-500 " +
              (carried && !open ? "opacity-100" : "opacity-0")
            }
          >
            {lit === 0 ? "Finding your collectables" : `Found ${lit}`}
          </p>
          {/* the words at the top: what to do next, gone once the cover moves */}
          <p
            ref={wordsRef}
            aria-live="polite"
            className="pointer-events-none absolute inset-x-0 top-[62px] text-center font-[family-name:var(--font-manrope)] text-[15px] leading-5 font-medium text-[rgba(232,236,255,0.72)] opacity-0"
          >
            {zoomed ? "Tap again to open it" : opened.length > 0 || late ? "Close the book to keep them" : "Tap one to look closer"}
          </p>
        </div>
    </div>
  )
}
