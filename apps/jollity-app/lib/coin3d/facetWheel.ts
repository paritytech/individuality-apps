// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The infinite wheel — how many collections ride on six faces.
//
// The coin has six faces (COIN_SIDES). An item can carry any number of
// collections. Turning the coin must walk every collection and then
// wrap, in both directions, for ever. So a physical face does not own one
// collection. It carries whichever collection the current turn puts there.
//
// Pure arithmetic. No DOM, no three.js, no React. Everything recomputes from
// the front index alone, so there is no running state to drift.
//
// `turns` counts faces and is unbounded. `front` is Math.round(turns): the
// ABSOLUTE index of the face at the player. The collection shown is
// `front mod count`. The physical face at the player is `front mod 6`.

import { COIN_SIDES } from './coinGeometry'

/** Positive remainder. `%` keeps the sign of the left operand in JS, and every
 *  index here can be negative. */
function mod(value: number, n: number): number {
  return ((value % n) + n) % n
}

/** How many steps physical face `face` sits from the front face, folded into
 *  [-2, +3].
 *
 *  Zero is the face at the player. -1 and +1 are its two visible neighbours.
 *  ±2 point away from the camera and +3 is the back. The fold puts the split
 *  between +3 and -2, which is the pair of faces the player cannot see. */
function faceDelta(face: number, front: number): number {
  const d = mod(face - front, COIN_SIDES)
  return d > COIN_SIDES / 2 ? d - COIN_SIDES : d
}

/** The ABSOLUTE face index physical face `face` carries at this turn. */
function faceAbsoluteIndex(face: number, front: number): number {
  return front + faceDelta(face, front)
}

/** The collection index physical face `face` carries at this turn. */
function faceCollection(face: number, front: number, count: number): number {
  return mod(faceAbsoluteIndex(face, front), Math.max(1, count))
}

/** What one face has engraved on it: the collection over the item it offers. */
export interface FaceText {
  /** The collection name. The small line on top. */
  label: string
  /** The item that collection offers. The big line below. */
  name: string
}

const EMPTY_FACE: FaceText = { label: '', name: '' }

/** One pair of strings per PHYSICAL face, in face order, for the given front
 *  index.
 *
 *  Feed this straight to the atlas. Step the front by one and exactly one entry
 *  changes: the face that was at delta -2 becomes the back at +3, or the other
 *  way round when the coin turns back. Both of those faces point away from the
 *  camera, so the player never sees a face re-letter itself. */
export function faceTexts(front: number, texts: readonly FaceText[]): FaceText[] {
  const out: FaceText[] = []
  for (let face = 0; face < COIN_SIDES; face++) {
    out.push(texts[faceCollection(face, front, texts.length)] ?? EMPTY_FACE)
  }
  return out
}
