// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { join } from "node:path"
import sharp, { type Sharp } from "sharp"
import type { CrewIdentity } from "./catalogue"
import gestureSubjectBoundsJson from "./gesture-poses/subject-bounds.json"

export interface FrameRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface FrameRegions {
  portrait: FrameRegion
  name: FrameRegion
  username: FrameRegion
  motion: FrameRegion
}

export interface CrewGesture {
  label: string
}

type GesturePose = "a" | "b"
type GestureSubjectBounds = Record<string, Record<GesturePose, FrameRegion>>
const GESTURE_SUBJECT_BOUNDS = gestureSubjectBoundsJson as GestureSubjectBounds
const CREW_ASSET_ROOT = join(process.cwd(), "scripts", "e2e-live", "crew")

/** One unmistakable generated gesture sequence per PreviewNet person. Keep
 * this explicit: adding a crew member without choosing their gesture is a test
 * failure instead of silently reusing somebody else's move. */
const CREW_GESTURES: Readonly<Record<string, CrewGesture>> = {
  "captain-baseline": { label: "open-hand wave" },
  "lady-latency": { label: "peace sign sway" },
  "relay-ray": { label: "rock-on thrust" },
  "handoff-hank": { label: "shaka reach" },
  "the-rejoiner": { label: "thumbs-up bounce" },
  "late-larry": { label: "thumbs-down sway" },
  "locale-lola": { label: "okay sign reach" },
  "tokyo-taro": { label: "Vulcan salute" },
  "berlin-bruno": { label: "crossed-fingers reach" },
  "shutter-sheila": { label: "finger-heart reach" },
  "phantom-phil": { label: "I-love-you sign" },
  "narrowband-ned": { label: "two-hand heart" },
  "packet-jack": { label: "two-hand clap" },
  "chainless-charlie": { label: "two-hand celebration" },
  "relay-rita": { label: "palms-up shrug" },
  "tap-tony": { label: "prayer hands" },
  "timewarp-tess": { label: "bicep flex" },
  "crash-carter": { label: "high index point" },
  "longhaul-lou": { label: "upward point" },
  "clockwork-clyde": { label: "downward point" },
  "future-fran": { label: "time-portal hand sweep" },
  "background-betty": { label: "rightward point" },
  "reload-rex": { label: "raised victory fist" },
  "freeze-frame-fred": { label: "forward fist bump" },
  "datagram-dana": { label: "left fist extension" },
  "flip-fiona": { label: "right fist extension" },
  "null-nancy": { label: "point at viewer" },
  "stutter-stu": { label: "robot-arm wave" },
  "chaincut-chip": { label: "cross-and-open dance" },
  "fifth-turn-felix": { label: "diagonal disco point" },
}

const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)))
const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2)
const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")

export function squareSafeRegion(width: number, height: number): FrameRegion {
  const size = Math.min(width, height)
  return { x: Math.round((width - size) / 2), y: Math.round((height - size) / 2), width: size, height: size }
}

export function frameRegions(width: number, height: number): FrameRegions {
  const safe = squareSafeRegion(width, height)
  const panelX = Math.round(safe.x + safe.width * 0.52)
  const pad = Math.max(8, Math.round(safe.width * 0.035))
  const right = safe.x + safe.width - pad
  return {
    portrait: { x: 0, y: 0, width: Math.round(width * 0.68), height },
    name: { x: panelX + pad, y: Math.round(height * 0.2), width: right - panelX - pad, height: Math.round(height * 0.28) },
    username: { x: panelX + pad, y: Math.round(height * 0.56), width: right - panelX - pad, height: Math.round(height * 0.12) },
    motion: { x: Math.round(width * 0.05), y: Math.round(height * 0.06), width: Math.round(width * 0.58), height: Math.round(height * 0.88) },
  }
}

export function identityGesture(identity: CrewIdentity): CrewGesture {
  const gesture = CREW_GESTURES[identity.key]
  if (!gesture) throw new Error(`no camera gesture for crew identity ${identity.key}`)
  return gesture
}

export function identityGesturePosePath(identity: CrewIdentity, pose: GesturePose): string {
  return join(CREW_ASSET_ROOT, "gesture-poses", `${identity.key}-${pose}.webp`)
}

export function identityGestureSubjectBounds(identity: CrewIdentity, pose: GesturePose): FrameRegion {
  const bounds = GESTURE_SUBJECT_BOUNDS[identity.key]?.[pose]
  if (!bounds) throw new Error(`no camera gesture subject bounds for ${identity.key}-${pose}`)
  return bounds
}

/** Recompute the committed subject box from the source pixels. The positive
 * Laplacian edge-energy percentiles exclude the blurred sidebars while a
 * six-pixel margin keeps hair and fingertips inside the proof box. */
export async function measureGestureSubjectBounds(identity: CrewIdentity, pose: GesturePose): Promise<FrameRegion> {
  const size = 360
  const { data } = await sharp(identityGesturePosePath(identity, pose))
    .extract({ left: 140, top: 0, width: size, height: size })
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const xs = Array<number>(size).fill(0)
  const ys = Array<number>(size).fill(0)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const energy = data[y * size + x]
    xs[x] += energy
    ys[y] += energy
  }
  const percentile = (values: number[], low: number, high: number): readonly [number, number] => {
    const total = values.reduce((sum, value) => sum + value, 0)
    let cumulative = 0
    let first = 0
    let last = values.length - 1
    for (let index = 0; index < values.length; index++) {
      cumulative += values[index]
      if (cumulative >= total * low) { first = index; break }
    }
    cumulative = 0
    for (let index = 0; index < values.length; index++) {
      cumulative += values[index]
      if (cumulative >= total * high) { last = index; break }
    }
    return [first, last]
  }
  const [rawLeft, rawRight] = percentile(xs, 0.025, 0.975)
  const [rawTop, rawBottom] = percentile(ys, 0.02, 0.985)
  const left = Math.max(0, rawLeft - 6)
  const right = Math.min(size - 1, rawRight + 6)
  const top = Math.max(0, rawTop - 6)
  const bottom = Math.min(size - 1, rawBottom + 6)
  return { x: 140 + left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

const nameLines = (name: string): readonly [string, string?] => {
  const words = name.trim().split(/\s+/)
  if (words.length < 2) return [name]
  let split = 1
  let best = Number.POSITIVE_INFINITY
  for (let index = 1; index < words.length; index++) {
    const left = words.slice(0, index).join(" ")
    const right = words.slice(index).join(" ")
    const score = Math.max(left.length, right.length)
    if (score < best) {
      best = score
      split = index
    }
  }
  return [words.slice(0, split).join(" "), words.slice(split).join(" ")]
}

const frameFontSize = (name: string, availableWidth: number, height: number): number => {
  const longest = Math.max(...nameLines(name).map((line) => line?.length ?? 0))
  return Math.max(Math.round(height * 0.045), Math.min(Math.round(height * 0.075), Math.floor(availableWidth / Math.max(1, longest) * 1.55)))
}

/** The ordinary, recognisable camera card. Generated gestures replace this
 * outbound track only while this identity is the active host. */
export function identityFrameSvg(identity: CrewIdentity, width: number, height: number, frameIndex: number, includeLabels = true): string {
  const regions = frameRegions(width, height)
  const panelX = regions.name.x - Math.max(8, Math.round(Math.min(width, height) * 0.035))
  const scannerX = Math.round((frameIndex % 30) / 29 * Math.max(1, regions.portrait.width - width * 0.04))
  const scannerWidth = even(width * 0.035)
  const dot = Math.max(3, Math.round(height * 0.012))
  const gap = dot * 3
  const dotY = Math.round(height * 0.88)
  const [first, second] = nameLines(identity.displayName)
  const fontSize = frameFontSize(identity.displayName, regions.name.width, height)
  const nameX = regions.name.x
  const nameY = regions.name.y + fontSize
  const usernameSize = Math.round(height * 0.032)
  const activeDot = Math.floor(frameIndex / 5) % 3
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${identity.palette.primary}"/><stop offset="1" stop-color="#090B16"/></linearGradient>
    <linearGradient id="scan" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${identity.palette.secondary}" stop-opacity="0"/><stop offset="0.5" stop-color="${identity.palette.secondary}" stop-opacity="0.32"/><stop offset="1" stop-color="${identity.palette.secondary}" stop-opacity="0"/></linearGradient>
  </defs>
  <rect x="${scannerX}" y="0" width="${scannerWidth}" height="${height}" fill="url(#scan)"/>
  <path d="M ${panelX} 0 H ${width} V ${height} H ${Math.round(width * 0.49)} Z" fill="url(#panel)"/>
  <path d="M ${panelX} 0 V ${height}" stroke="${identity.palette.secondary}" stroke-width="${Math.max(2, Math.round(width * 0.004))}" opacity="0.9"/>
  ${includeLabels ? `<text x="${nameX}" y="${nameY}" fill="${identity.palette.ink}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="800">${xml(first)}</text>` : ""}
  ${includeLabels && second ? `<text x="${nameX}" y="${nameY + Math.round(fontSize * 1.05)}" fill="${identity.palette.ink}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="800">${xml(second)}</text>` : ""}
  <rect x="${regions.username.x}" y="${regions.username.y}" width="${regions.username.width}" height="${regions.username.height}" rx="${Math.round(height * 0.018)}" fill="${identity.palette.secondary}" opacity="0.2"/>
  ${includeLabels ? `<text x="${regions.username.x + Math.round(width * 0.014)}" y="${regions.username.y + Math.round(regions.username.height * 0.68)}" fill="${identity.palette.ink}" font-family="Arial, Helvetica, sans-serif" font-size="${usernameSize}" font-weight="600">${xml(identity.username)}</text>` : ""}
  <text x="${regions.username.x}" y="${Math.round(height * 0.76)}" fill="${identity.palette.ink}" opacity="0.78" font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(height * 0.026)}">PREVIEWNET CREW</text>
  ${[0, 1, 2].map((index) => `<circle cx="${regions.username.x + index * gap + dot}" cy="${dotY}" r="${dot}" fill="${identity.palette.secondary}" opacity="${index === activeDot ? 1 : 0.28}"/>`).join("")}
  </svg>`
}

export function harnessFrameSvg(profile: string, width: number, height: number, frameIndex: number): string {
  const regions = frameRegions(width, height)
  const sweep = Math.round((frameIndex % 30) / 29 * width)
  const dot = Math.max(3, Math.round(height * 0.012))
  const activeDot = Math.floor(frameIndex / 5) % 3
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="harness" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#172554"/><stop offset="0.55" stop-color="#0F766E"/><stop offset="1" stop-color="#111827"/></linearGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#67E8F9" stop-opacity="0"/><stop offset="0.5" stop-color="#67E8F9" stop-opacity="0.28"/><stop offset="1" stop-color="#67E8F9" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#harness)"/>
  <circle cx="${Math.round(width * 0.19)}" cy="${Math.round(height * 0.5)}" r="${Math.round(height * 0.27)}" fill="none" stroke="#67E8F9" stroke-width="${Math.max(2, Math.round(width * 0.004))}" opacity="0.75"/>
  <circle cx="${Math.round(width * 0.19)}" cy="${Math.round(height * 0.5)}" r="${Math.round(height * 0.18)}" fill="none" stroke="#A7F3D0" stroke-width="${Math.max(2, Math.round(width * 0.0025))}" opacity="0.65"/>
  <rect x="${sweep - Math.round(width * 0.04)}" y="0" width="${Math.round(width * 0.08)}" height="${height}" fill="url(#beam)"/>
  <text x="${regions.name.x}" y="${regions.name.y + Math.round(height * 0.085)}" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(height * 0.075)}" font-weight="800">Harness Check</text>
  <rect x="${regions.username.x}" y="${regions.username.y}" width="${regions.username.width}" height="${regions.username.height}" rx="${Math.round(height * 0.018)}" fill="#67E8F9" opacity="0.2"/>
  <text x="${regions.username.x + Math.round(width * 0.014)}" y="${regions.username.y + Math.round(regions.username.height * 0.68)}" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(height * 0.027)}" font-weight="600">${xml(profile)}</text>
  <text x="${regions.username.x}" y="${Math.round(height * 0.76)}" fill="#CCFBF1" font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(height * 0.026)}">PREVIEWNET BOOT HARNESS</text>
  ${[0, 1, 2].map((index) => `<circle cx="${regions.username.x + index * dot * 3 + dot}" cy="${Math.round(height * 0.88)}" r="${dot}" fill="#67E8F9" opacity="${index === activeDot ? 1 : 0.28}"/>`).join("")}
  </svg>`
}

const rawRgb = async (image: Sharp, width: number, height: number): Promise<Buffer> =>
  image.resize(width, height, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer()

export async function renderIdentityFrame(identity: CrewIdentity, width: number, height: number, frameIndex: number, includeLabels = true): Promise<Buffer> {
  return (await prepareIdentityFrameRenderer(identity, width, height, includeLabels))(frameIndex)
}

/** Decode and crop the ordinary portrait once per clip, then composite only
 * the small moving card layer for each frame. */
export async function prepareIdentityFrameRenderer(
  identity: CrewIdentity,
  width: number,
  height: number,
  includeLabels = true,
): Promise<(frameIndex: number) => Promise<Buffer>> {
  const regions = frameRegions(width, height)
  const portraitPath = join(CREW_ASSET_ROOT, "portraits", identity.portrait)
  const portrait = await sharp(portraitPath)
    .resize(regions.portrait.width, regions.portrait.height, { fit: "cover", position: "attention" })
    .removeAlpha()
    .toColourspace("srgb")
    .png()
    .toBuffer()
  const background = await rawRgb(
    sharp({ create: { width, height, channels: 3, background: identity.palette.primary } }).composite([
      { input: portrait, left: 0, top: 0 },
    ]),
    width,
    height,
  )
  return (frameIndex) => rawRgb(
    sharp(background, { raw: { width, height, channels: 3 } }).composite([
      { input: Buffer.from(identityFrameSvg(identity, width, height, frameIndex, includeLabels)), left: 0, top: 0 },
    ]),
    width,
    height,
  )
}

export async function renderHarnessFrame(profile: string, width: number, height: number, frameIndex: number): Promise<Buffer> {
  return rawRgb(
    sharp({ create: { width, height, channels: 3, background: "#111827" } }).composite([
      { input: Buffer.from(harnessFrameSvg(profile, width, height, frameIndex)), left: 0, top: 0 },
    ]),
    width,
    height,
  )
}

export function rgbToYuv420(rgb: Buffer, width: number, height: number): Buffer {
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error("YUV420 requires even dimensions")
  if (rgb.length !== width * height * 3) throw new Error(`RGB frame length ${rgb.length} does not match ${width}x${height}`)
  const ySize = width * height
  const chromaWidth = width / 2
  const chromaSize = chromaWidth * (height / 2)
  const output = Buffer.alloc(ySize + chromaSize * 2)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 3
      const r = rgb[source]
      const g = rgb[source + 1]
      const b = rgb[source + 2]
      output[y * width + x] = clamp(16 + 0.257 * r + 0.504 * g + 0.098 * b)
    }
  }
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let u = 0
      let v = 0
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const source = ((y + dy) * width + x + dx) * 3
          const r = rgb[source]
          const g = rgb[source + 1]
          const b = rgb[source + 2]
          u += 128 - 0.148 * r - 0.291 * g + 0.439 * b
          v += 128 + 0.439 * r - 0.368 * g - 0.071 * b
        }
      }
      const chroma = (y / 2) * chromaWidth + x / 2
      output[ySize + chroma] = clamp(u / 4)
      output[ySize + chromaSize + chroma] = clamp(v / 4)
    }
  }
  return output
}
