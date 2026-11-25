// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/* eslint-disable @next/next/no-img-element -- gateway collectable art and a static cover asset */

/**
 * The collectables screen's way into the Pocket: an open book at the foot of the screen. Drag the book's cover across to close
 * it: every piece its edge sweeps past drops through the middle of the screen into its cell, and let go past CLAIM_AT the cover shuts by itself on the rest and lands with a thud. The book then grows
 * into the middle of the screen under "Added to your Pocket", everything fades, and the collectables screen goes on by itself;
 * only a hand-off the host refused puts up a Continue.
 *
 * This component is the book's markup and nothing more (architecture rule 6): lib/pocket/scene runs it, frame by
 * frame, on the elements rendered here, and this forwards the presses to it. The geometry is lib/pocket/book, the
 * motion lib/pocket/motion and the effects canvas lib/pocket/fx. A press on the book grabs the cover unless it
 * lands on a piece, which stays the scene's to look at.
 */
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react"
import { asset } from "@/lib/asset"
import { Button } from "@/components/ui/button"
import { orbTint, type PieceSpot } from "@/components/collectables/collectables-scene"
import { cellOrder, onCover as cellsOnCover } from "@/lib/pocket/book"
import { FADE_AT_MS, createPocketScene, fadeAndGo, fadeBack, type PocketScene } from "@/lib/pocket/scene"

export interface PocketPiece {
  image: string
  rare: boolean
  /** its rarity tier, whose colour (the scene's orb tint) is its landing */
  tier?: string
}

export function PocketClaim({
  surface,
  pieces,
  ring,
  onTake,
  onReturn,
  onCover,
  hidden,
  claimed,
  refusals,
  onClaim,
  onDone,
}: {
  surface: RefObject<HTMLElement | null>
  pieces: PocketPiece[]
  ring: RefObject<PieceSpot[]>
  /** a piece left the scene for the Pocket, which draws it from now on */
  onTake: (index: number) => void
  /** a piece the Pocket gave back (the book left open): the scene draws it again, opened if it was opened in the book */
  onReturn?: (index: number, opened: boolean) => void
  /** how far the cover has closed, 0 to 1, as it moves */
  onCover?: (closed: number) => void
  hidden: boolean
  claimed: boolean
  refusals: number
  onClaim: () => void
  onDone: () => void
}) {
  const [shut, setShut] = useState(false)
  // the pieces in the order they were taken (the n-th fills cellOrder's n-th
  // cell), and how many have landed: the scene's, drawn here
  const [filled, setFilled] = useState<readonly number[]>([])
  const [landed, setLanded] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<HTMLDivElement>(null)
  const coverRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const outerRef = useRef<HTMLDivElement>(null)
  const edgeRef = useRef<HTMLElement>(null)
  const fxRef = useRef<HTMLCanvasElement>(null)
  const flightsRef = useRef<HTMLDivElement>(null)
  const shellsRef = useRef<HTMLCanvasElement>(null)
  const shownRef = useRef<HTMLDivElement[]>([])
  const slotRefs = useRef<(HTMLDivElement | null)[]>([])
  const spriteRefs = useRef<(HTMLImageElement | null)[]>([])
  const scene = useRef<PocketScene | null>(null)
  const callbacks = useRef({ onClaim, onDone, onTake, onCover, onReturn })
  const hiddenRef = useRef(hidden)
  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])

  useEffect(() => {
    callbacks.current = { onClaim, onDone, onTake, onCover, onReturn }
  }, [onClaim, onDone, onTake, onCover, onReturn])

  const art = pieces
    .slice(0, 10)
    .map((piece, index) => ({ ...piece, index, tint: orbTint(piece) }))
  const count = art.length
  const half = cellsOnCover(count)
  const order = cellOrder(count)

  // the scene: one for the life of the Pocket, on the elements below
  useEffect(() => {
    const pocket = createPocketScene(
      {
        root: rootRef.current!,
        book: bookRef.current!,
        cover: coverRef.current!,
        inner: innerRef.current!,
        outer: outerRef.current!,
        edge: edgeRef.current!,
        flights: flightsRef.current!,
        fx: fxRef.current,
        shells: shellsRef.current,
        sprites: spriteRefs.current,
        cells: slotRefs.current,
      },
      {
        pieces: art,
        ring: () => ring.current ?? [],
        surface: () => surface.current,
        onCells: (next, n) => {
          setFilled(next)
          setLanded(n)
        },
        onShut: () => setShut(true),
        onTake: (index) => callbacks.current.onTake(index),
        onReturn: (index, opened) => callbacks.current.onReturn?.(index, opened),
        onCover: (closed) => callbacks.current.onCover?.(closed),
        onClaim: () => callbacks.current.onClaim(),
      },
    )
    scene.current = pocket
    pocket.run()
    return () => {
      pocket.destroy()
      scene.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one scene for the life of the Pocket; the effect below keeps its pieces current
  }, [])

  useEffect(() => {
    scene.current?.setPieces(art)
  })

  useEffect(() => {
    if (claimed) scene.current?.finish(false)
  }, [claimed])

  // a press on the book grabs the cover, unless it lands on a piece; the
  // scene never hears a press the cover took
  useEffect(() => {
    const area = surface.current
    if (!area) return

    const onDown = (event: PointerEvent) => {
      if (hiddenRef.current) return
      if ((event.target as Element | null)?.closest("button, a, [role=button]"))
        return
      if (scene.current?.press({ x: event.clientX, y: event.clientY }, event.pointerId))
        event.stopPropagation()
    }

    const onMove = (event: PointerEvent) => {
      scene.current?.move(event.pointerId, event.clientX)
    }

    const onUp = (event: PointerEvent) => {
      scene.current?.release(event.pointerId)
    }

    const onTouchMove = (event: TouchEvent) => {
      if (scene.current?.holding() && event.cancelable) event.preventDefault()
    }

    area.addEventListener("pointerdown", onDown, { capture: true })
    area.addEventListener("touchmove", onTouchMove, { passive: false })
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    return () => {
      area.removeEventListener("pointerdown", onDown, { capture: true })
      area.removeEventListener("touchmove", onTouchMove)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
  }, [surface])

  useEffect(() => {
    if (refusals === 0) return
    fadeBack(shownRef.current)
  }, [refusals])

  const leave = () => fadeAndGo(shownRef.current, callbacks.current.onDone)

  // the book shut: on by itself once it has had its moment, no Continue to
  // press. A hand-off the host refused (`refusals`) puts the Continue up
  // instead, so there is one to press
  useEffect(() => {
    if (!shut || refusals > 0) return
    const timer = setTimeout(
      () => fadeAndGo(shownRef.current, callbacks.current.onDone),
      FADE_AT_MS,
    )
    return () => clearTimeout(timer)
  }, [shut, refusals])

  const pieceAt = (place: number) => {
    const index = filled[place]
    return index === undefined ? undefined : art[index]
  }

  const cell = (j: number) => {
    const place = order.indexOf(j)
    const piece = pieceAt(place)
    return (
      <div
        key={j}
        ref={(el) => {
          slotRefs.current[j] = el
        }}
        className="pocket-cell"
        data-landed={place >= 0 && place < landed ? "" : undefined}
        style={piece ? ({ "--tint": piece.tint } as CSSProperties) : undefined}
      >
        <i className="pocket-cell-glow" />
        <i className="pocket-cell-ring" />
        {piece?.image ? (
          <img src={piece.image} alt="" draggable={false} decoding="async" />
        ) : null}
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={`pocket-claim${shut ? " is-shut" : ""}${hidden ? " is-hidden" : ""}`}
      data-testid="pocket-claim"
      data-shut={shut ? "true" : "false"}
    >
      <div
        ref={(el) => {
          if (el) shownRef.current[0] = el
        }}
        aria-hidden="true"
      >
        <div ref={bookRef} className="pocket-book">
          <div className="pocket-book-page">
            <div className="pocket-book-grid">
              {art.slice(half).map((_, k) => cell(half + k))}
            </div>
            <i className="pocket-book-shadow" />
          </div>
          <div ref={coverRef} className="pocket-book-cover">
            <div
              ref={innerRef}
              className="pocket-book-face pocket-book-face--inner"
            >
              <div className="pocket-book-grid">
                {art.slice(0, half).map((_, k) => cell(k))}
              </div>
              <i className="pocket-book-light" />
              <i className="pocket-book-shade" />
            </div>
            <div
              ref={outerRef}
              className="pocket-book-face pocket-book-face--outer"
            >
              <img
                src={asset("/assets/album-cover.webp")}
                alt=""
                draggable={false}
              />
              <i className="pocket-book-light" />
              <i className="pocket-book-shade" />
            </div>
            <i ref={edgeRef} className="pocket-book-edge" />
          </div>
        </div>
      </div>
      <div ref={flightsRef} className="pocket-flights">
        <canvas ref={fxRef} className="pocket-fx" aria-hidden="true" />
        {art.map(({ image }, k) =>
          image ? (
            <img
              key={k}
              ref={(el) => {
                spriteRefs.current[k] = el
              }}
              className="pocket-flight"
              src={image}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
          ) : null,
        )}
        <canvas ref={shellsRef} className="pocket-shells" aria-hidden="true" />
      </div>
      <div
        ref={(el) => {
          if (el) shownRef.current[1] = el
        }}
      >
        <h1 className="pocket-title" aria-hidden={!shut}>
          Added to your Pocket
        </h1>
      </div>
      {shut && refusals > 0 ? (
        <div
          ref={(el) => {
            if (el) shownRef.current[2] = el
          }}
          className="pocket-foot"
        >
          <Button size="lg" className="w-full max-w-sm" onClick={leave}>
            Continue
          </Button>
        </div>
      ) : shut ? null : (
        <button
          type="button"
          className="pocket-claim-without-gesture"
          onClick={() => scene.current?.finish(true)}
        >
          Claim all
        </button>
      )}
    </div>
  )
}
