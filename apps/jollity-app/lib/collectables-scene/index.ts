// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The collectables scene's typed API.
 *
 * ./engine.ts is a frame loop over plain numbers and is kept untyped
 * (`@ts-nocheck`). This module is its only importer and gives it a declared
 * shape, so nothing untyped reaches a caller: import the scene from
 * "@/lib/collectables-scene", never from "./engine". A change to the engine's API
 * must be mirrored here by hand — the compiler cannot check the two agree.
 */
import { createCollectablesScene as createUntypedCollectablesScene } from "./engine"
import type { CarriedBubble } from "./carry"

/** An image the 2D canvas can draw and measure. */
type CollectablesSpriteImage = CanvasImageSource & { width: number; height: number }

/** One piece's flat art. `scale` is the art's share of the piece's box (the
 *  wrapping layer's fit, so the flat and the wrapped art are the same size);
 *  a bare image draws at 1. */
type CollectablesSprite = CollectablesSpriteImage | { image: CollectablesSpriteImage; scale?: number }

/** The moments the scene announces (for the host, sounds or haptics). */
type CollectablesSceneEvent =
  /** the bubble is blown and floats, collecting */
  | "landed"
  /** a piece's orb went into the bubble (`index`) */
  | "absorb"
  /** a piece came in after the pop and reached its place (`index`) */
  | "arrive"
  /** the bubble starts to open, by `open()` or by a tap (`clock`) */
  | "open"
  /** the bubble popped */
  | "burst"
  /** the camera zoomed into a piece, or back out (`on`) */
  | "focus"
  /** a tap cracked the focused piece (`index`) */
  | "pop"
  /** an opened piece was tapped (`index`), its box centred at `x`, `y`, `side` across, canvas-local CSS px */
  | "inspect"

/** The payload of an event; which fields are set depends on the event. */
interface CollectablesSceneEventData {
  index?: number
  clock?: number
  on?: boolean
  x?: number
  y?: number
  side?: number
}

/** Where one live piece is drawn this frame, for a layer drawn on top. */
export interface CollectablesPlacement {
  /** the piece, in the order it was added */
  index: number
  /** its centre, in canvas-local CSS px */
  cx: number
  cy: number
  /** its box side, in CSS px */
  size: number
  /** its wiggle, in degrees */
  rotation: number
  /** 1 once a tap has cracked it, else 0 */
  crack: number
  /** seconds of scene clock since the crack (Infinity before one) */
  crackAge: number
  /** where the cracking tap landed, in canvas-local CSS px */
  hitX: number
  hitY: number
  /** its breathing tilt, as the circle is squashed by it across and down (1: none) */
  sx: number
  sy: number
}

export interface CollectablesSceneOptions {
  /** pieces present from the start, 0–10 (default 6); the collectables screen passes 0 and adds them */
  count?: number
  /** read at each tap on the floating bubble: may it pop now? Left out, it always may. */
  canOpen?: () => boolean
  /** every announced moment; a listener that throws is ignored */
  onEvent?: (name: CollectablesSceneEvent, data: CollectablesSceneEventData) => void
  /** every frame: the live pieces' placements, and how far the camera has
   *  settled on the pieces after the pop (0..1) */
  onDiscs?: (placements: CollectablesPlacement[], blend: number) => void
  /** the bubble the draw's hold carried here (./carry): it starts blown where
   *  it was, and each claim is found from a share of its pieces */
  carried?: CarriedBubble | null
  /** the carried bubble is drawn by the scene now: the layer that carried it can go */
  onCarriedShown?: () => void
}

export interface CollectablesScene {
  /** start over: the bubble blows up again, empty */
  replay(): void
  /** a tap at canvas-local CSS px: pop the bubble (once something is in),
   *  zoom into a piece, or crack the focused one */
  tap(px: number, py: number): void
  /** pointer gestures in canvas-local CSS px: drag pieces, or a tap on release */
  press(px: number, py: number): void
  move(px: number, py: number): void
  release(): void
  /** the collectable art, one entry per piece index (holes draw a plain disc) */
  setSprites(next: readonly (CollectablesSprite | undefined)[]): void
  /** a piece came in (a claim): an orb in this CSS colour flies it into the
   *  bubble, or to its place once the bubble has popped. Its index, or -1
   *  when the collectables screen is full. */
  addPiece(tint: string): number
  /** pop the bubble: now if it is blown, else the moment it is */
  open(): void
  /** the piece's shell has broken: it stays as its plain art and floats up
   *  to the opened ones */
  openPiece(index: number): void
  /** stop (true) or restart (false) the frames while something covers the scene */
  hold(on: boolean): void
  /** the pieces float above this, CSS px from the canvas's top (the Pocket's book); null: the canvas's foot */
  setFloor(px: number | null): void
  /** another layer draws this piece now: stop painting its flat art */
  setSpriteHidden(index: number, hidden: boolean): void
  /** the host element changed size, in CSS px */
  resize(width: number, height: number): void
  /** stop the frame loop for good */
  destroy(): void
}

/** Start a collectables scene on `canvas`. Its frame loop runs until `destroy()`. */
export const createCollectablesScene: (canvas: HTMLCanvasElement, opts?: CollectablesSceneOptions) => CollectablesScene =
  createUntypedCollectablesScene
