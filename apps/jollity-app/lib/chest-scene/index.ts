// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The chest scene's typed API.
 *
 * ./engine.ts is a frame loop over plain numbers and is kept untyped
 * (`@ts-nocheck`). This module is its only importer and gives it a declared
 * shape, so nothing untyped reaches a caller: import the scene from
 * "@/lib/chest-scene", never from "./engine". A change to the engine's API
 * must be mirrored here by hand — the compiler cannot check the two agree.
 */
import { createChestScene as createUntypedChestScene } from "./engine"

/** An image the 2D canvas can draw and measure. */
type ChestSpriteImage = CanvasImageSource & { width: number; height: number }

/** One piece's flat art. `scale` is the art's share of the piece's box (the
 *  wrapping layer's fit, so the flat and the wrapped art are the same size);
 *  a bare image draws at 1. */
type ChestSprite = ChestSpriteImage | { image: ChestSpriteImage; scale?: number }

/** The moments the scene announces (for the host, sounds or haptics). */
type ChestSceneEvent =
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

/** The payload of an event; which fields are set depends on the event. */
interface ChestSceneEventData {
  index?: number
  clock?: number
  on?: boolean
}

/** Where one live piece is drawn this frame, for a layer drawn on top. */
export interface ChestPlacement {
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
}

export interface ChestSceneOptions {
  /** pieces present from the start, 0–10 (default 6); the chest passes 0 and adds them */
  count?: number
  /** read at each tap on the floating bubble: may it pop now? Left out, it always may. */
  canOpen?: () => boolean
  /** every announced moment; a listener that throws is ignored */
  onEvent?: (name: ChestSceneEvent, data: ChestSceneEventData) => void
  /** every frame: the live pieces' placements, and how far the camera has
   *  settled on the pieces after the pop (0..1) */
  onDiscs?: (placements: ChestPlacement[], blend: number) => void
}

export interface ChestScene {
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
  setSprites(next: readonly (ChestSprite | undefined)[]): void
  /** a piece came in (a claim): an orb in this CSS colour flies it into the
   *  bubble, or to its place once the bubble has popped. Its index, or -1
   *  when the chest is full. */
  addPiece(tint: string): number
  /** pop the bubble: now if it is blown, else the moment it is */
  open(): void
  /** the piece left the scene (it landed on the shelf): stop simulating it */
  removePiece(index: number): void
  /** another layer draws this piece now: stop painting its flat art */
  setSpriteHidden(index: number, hidden: boolean): void
  /** the host element changed size, in CSS px */
  resize(width: number, height: number): void
  /** stop the frame loop for good */
  destroy(): void
}

/** Start a chest scene on `canvas`. Its frame loop runs until `destroy()`. */
export const createChestScene: (canvas: HTMLCanvasElement, opts?: ChestSceneOptions) => ChestScene =
  createUntypedChestScene
