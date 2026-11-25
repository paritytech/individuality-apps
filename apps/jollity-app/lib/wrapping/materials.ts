// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Part of the wrapping effect: its names are Wrapping*, except the shader exports (SHELL_*).
// The three looks, the shared dials, and which look an item wears.
//
// Every field below maps to a uniform of the fragment shader (shader.ts). The
// numbers were tuned by eye.
//
// `prism` and `frost` set no `amp`, no `scale` and no `speed`. They fall through
// to BASE. `wobble` returns 0 whenever `uMode > 0.5`, so for those two only
// `scale` still matters, and only through the ripple and the peel grain.
//
// The tilt is the idle sway and **nothing else**. A device tilt or a pointer
// move swinging every reflection and running the colour was tried and rejected.
// Do not add a `deviceorientation` listener. Do not add a `pointermove`
// listener.

/** The three looks. */
type WrappingLook = 'prism' | 'liquid' | 'frost'

/** Every dial the fragment shader reads. One field per uniform. */
export interface WrappingMaterial {
  /** Which look these numbers came from. Diagnostics only. */
  look: WrappingLook
  /** 1 freezes the wobble (`prism`, `frost`). 0 lets it run (`liquid`). */
  mode: number
  inflate: number
  smooth: number
  edge: number
  dome: number
  relief: number
  bump: number
  refract: number
  chroma: number
  opacity: number
  blurMix: number
  satCut: number
  blue: number
  fres: number
  spec: number
  sweep: number
  glowMix: number
  glowGain: number
  glowFall: number
  ripple: number
  zoneLo: number
  zoneHi: number
  zoneSpec: number
  zoneChroma: number
  zoneSharp: number
  cells: number
  tri: number
  shardSpread: number
  crackLight: number
  crackDark: number
  amp: number
  scale: number
  speed: number
  shatterSpin: number
}

/** What one look overrides. The rest comes from BASE. */
type LookDials = Omit<WrappingMaterial, 'look' | 'amp' | 'scale' | 'speed' | 'shatterSpin'> &
  Partial<Pick<WrappingMaterial, 'amp' | 'scale' | 'speed' | 'shatterSpin'>>

const MATERIALS: Readonly<Record<WrappingLook, LookDials>> = {
  prism: { mode: 1, inflate: 0.14, smooth: 1, edge: 0.1, dome: 0.36, relief: 0.56, bump: 0.36,
           refract: 0.09, chroma: 0.6, opacity: 0.96, blurMix: 0.8, satCut: 0.4, blue: 0.5,
           fres: 0.9, spec: 1.1, sweep: 1.2, glowMix: 1, glowGain: 1.5, glowFall: 3.2,
           ripple: 0.9, zoneLo: 0, zoneHi: 0.52, zoneSpec: 1.0, zoneChroma: 3, zoneSharp: 1,
           cells: 9, tri: 3, shardSpread: 0.34, crackLight: 0.9, crackDark: 0.7 },
  liquid: { mode: 0, inflate: 0.3, smooth: 0.65, edge: 0.05, dome: 0.5, relief: 0.7, bump: 0.3,
            refract: 0.12, chroma: 0.3, opacity: 0.95, blurMix: 1, satCut: 0.35, blue: 0.4,
            fres: 0.5, spec: 0.8, sweep: 0.9, glowMix: 0.85, glowGain: 1.6, glowFall: 2.4,
            ripple: 0.45, amp: 0.32, scale: 1.2, speed: 1.5,
            zoneLo: 0.1, zoneHi: 0.6, zoneSpec: 0.8, zoneChroma: 1.5, zoneSharp: 0.4,
            cells: 16, tri: 2, shardSpread: 0.28, crackLight: 0.9, crackDark: 0.7 },
  frost:  { mode: 1, inflate: 0.22, smooth: 1, edge: 0.08, dome: 0.7, relief: 0.5, bump: 0.2,
            refract: 0.06, chroma: 0.15, opacity: 1, blurMix: 1, satCut: 0.75, blue: 0.85,
            fres: 0.7, spec: 0.6, sweep: 0.7, glowMix: 1, glowGain: 0.9, glowFall: 2.0,
            ripple: 0.5, zoneLo: 0.2, zoneHi: 0.8, zoneSpec: 0.5, zoneChroma: 0.8, zoneSharp: 0.3,
            cells: 12, tri: 3, shardSpread: 0.3, crackLight: 0.7, crackDark: 0.6 },
}

/** The dials no look overrides, plus every runtime number the renderer and its
 *  host need, as one block.
 *
 *  Mutable on purpose, so a quality-for-frames trade (`ssaa`, `maxDpr`,
 *  `shadeMs`) or a still-frame comparison (`pad` and `fit` at 1) can set them
 *  at run time. Nothing writes these in the product path.
 *
 *  `reliefCoarse`, `tiltRange`, `shadeBudget`, `growMs` and `breakMs` are
 *  unused: nothing in this app reads them. */
export const BASE = {
  amp: 0.32, scale: 1.2, speed: 1.5,
  shatterSpin: 0.5,
  ssaa: 1.5,          // shade larger than the quad, let the blit average it down
  reliefCoarse: 1,    // blur radius multiplier for the relief map
  tiltRange: 26, tiltTau: 160,
  swayAmount: 0.5, swaySpeed: 0.55,
  frameMs: 16, shadeMs: 45, maxDpr: 2, cacheMax: 1024,
  // at most this many wrappings re-shade per drawn frame (unused here)
  shadeBudget: 3,
  pad: 1.02, expand: 2.4,
  fit: 0.86,          // the art's share of the wrapping's box
  growMs: 700,        // a new wrapping grows to full size over this (unused here)
  breakMs: 620,       // the shatter's length (unused here; the collectables screen has its own)
  effectScale: 1,
}

/** FNV-1a over the art URL. The URL is the one identity every caller already
 *  holds, so the same item always wears the same look. */
function hashName(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h
}

/** Which look this item wears, with its own thickness.
 *
 *  A rare item gets `prism`. Everything else splits between `liquid` and
 *  `frost` on bit 0 of the hash. Then the thickness varies from 0.82 to 1.22 of
 *  the look's own, deterministically, so a shelf of ten never looks stamped
 *  from one mould. */
function lookFor(url: string, isRare: boolean): WrappingLook {
  return isRare ? 'prism' : hashName(url) & 1 ? 'liquid' : 'frost'
}

export function materialFor(url: string, isRare: boolean): WrappingMaterial {
  return materialWith(lookFor(url, isRare), url)
}

/** One named look, with this item's own thickness. */
function materialWith(look: WrappingLook, url: string): WrappingMaterial {
  const h = hashName(url)
  const src = MATERIALS[look]
  const m: WrappingMaterial = {
    look,
    amp: BASE.amp,
    scale: BASE.scale,
    speed: BASE.speed,
    shatterSpin: BASE.shatterSpin,
    ...src,
  }
  m.inflate = m.inflate * (0.82 + (((h >>> 8) & 255) / 255) * 0.4)
  return m
}

/** The idle sway. Two periods that do not divide into each other, so it never
 *  reads as a metronome, and a per-wrapping phase so the shelf does not lean as
 *  one. This is the ONLY thing that drives `uTilt`. */
export function idleTilt(t: number, phase: number): [number, number] {
  return [
    Math.sin(t * BASE.swaySpeed + phase) * BASE.swayAmount,
    Math.sin(t * BASE.swaySpeed * 0.61 + phase * 1.7 + 1.1) * BASE.swayAmount * 0.7,
  ]
}

/** The per-wrapping phase offset, by the piece's index. */
export function wrappingPhase(index: number): number {
  return (index + 1) * 1.37
}
