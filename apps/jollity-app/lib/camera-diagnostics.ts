// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { devLog } from "./debug/log-store"
import { cameraNoFrames, cameraTrail, recordCount, recordDistribution, recordGauge } from "./telemetry"

export type CameraCheckpoint = "open" | "join"
export type CameraOpenTrigger = "warm-up" | "join" | "return" | "retry" | "force" | "tap"
export type CameraTrailData = Record<string, string | number | boolean | undefined>
export interface CameraTrailEntry extends CameraTrailData {
  event: string
  page_ms: number
  stream_id: string
}

export interface CameraDiagnosticSnapshot {
  streamId: string
  openedAt: number
  generation: number
  lastEvent: string
  track: { readyState: string; muted: boolean; enabled: boolean; width?: number; height?: number; frameRate?: number; deviceHash?: string } | null
  self: { checkpoint?: CameraCheckpoint; attached?: string; stale?: boolean; play?: string; paused?: boolean; readyState?: number; firstFrameMs?: number; fps?: number }
  outbound: { links: number; fps?: number; framesEncoded?: number; framesSent?: number; limitation?: string }
  recovery?: string
  trail: readonly CameraTrailEntry[]
}

/** Fits the complete T-2:30 warm-up trail (including 10 s frame windows) in
 * the debug log's 4 KiB payload ceiling. */
const TRAIL_CAP = 24
const pageSalt = `${Math.random().toString(36).slice(2)}:${Date.now().toString(36)}`
const ids = new WeakMap<MediaStream, string>()
const opened = new WeakMap<MediaStream, number>()
const trackIds = new Map<string, string>()
let nextStream = 0
let nextTrack = 0
let snapshot: CameraDiagnosticSnapshot = emptySnapshot()
let currentStream: MediaStream | null = null
const listeners = new Set<() => void>()
const previousOutbound = new Map<number, { at: number; frames: number; track: string }>()
let lastOutboundLogAt = -Infinity
let lastOutboundLimitation = ""
let lastOutboundAdvanceAt = -Infinity
const summarizedGames = new Set<number>()

function emptySnapshot(): CameraDiagnosticSnapshot {
  return { streamId: "none", openedAt: 0, generation: 0, lastEvent: "none", track: null, self: {}, outbound: { links: 0 }, trail: [] }
}

const now = () => (typeof performance === "undefined" ? 0 : Math.round(performance.now()))
const rounded = (value: number): number => Math.round(value * 100) / 100

function compactData(data: CameraTrailData): CameraTrailData {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, typeof value === "number" ? rounded(value) : value]))
}

function hash(value: string): string {
  let h = 2166136261
  const input = `${pageSalt}:${value}`
  for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 16777619)
  return `d${(h >>> 0).toString(36)}`
}

export function cameraStreamId(stream: MediaStream | null | undefined): string {
  if (!stream) return "none"
  let id = ids.get(stream)
  if (!id) {
    id = `c${++nextStream}`
    ids.set(stream, id)
  }
  return id
}

function opaqueTrack(raw: string | undefined): string {
  if (!raw) return "none"
  let id = trackIds.get(raw)
  if (!id) {
    id = `t${++nextTrack}`
    trackIds.set(raw, id)
  }
  return id
}

function publish(next: CameraDiagnosticSnapshot) {
  snapshot = next
  for (const listener of listeners) listener()
}

export function recordCameraTrail(event: string, stream: MediaStream | null, data: CameraTrailData = {}): CameraTrailEntry {
  const entry: CameraTrailEntry = { ...compactData(data), event, page_ms: now(), stream_id: cameraStreamId(stream) }
  // Per-link outbound detail is already retained in numeric metrics and the
  // latest snapshot. Keeping it in the durable handover trail can overflow
  // the debug log payload and evict the actual camera lifecycle.
  const trail = event === "outbound.video" ? snapshot.trail : [...snapshot.trail, entry].slice(-TRAIL_CAP)
  publish({ ...snapshot, lastEvent: event, trail })
  devLog("camera", event, entry, event.includes("failed") || event === "self.no_frames" ? "warn" : "info")
  cameraTrail(event, entry)
  return entry
}

export function acceptCameraStream(stream: MediaStream, openedAt: number): void {
  currentStream = stream
  previousOutbound.clear()
  lastOutboundAdvanceAt = -Infinity
  opened.set(stream, openedAt)
  const track = stream.getVideoTracks()[0]
  const settings = track?.getSettings()
  publish({
    ...snapshot,
    streamId: cameraStreamId(stream),
    openedAt: rounded(openedAt),
    generation: snapshot.generation + 1,
    track: track ? {
      readyState: track.readyState,
      muted: track.muted,
      enabled: track.enabled,
      width: settings?.width,
      height: settings?.height,
      frameRate: settings?.frameRate === undefined ? undefined : rounded(settings.frameRate),
      deviceHash: settings?.deviceId ? hash(settings.deviceId) : undefined,
    } : null,
  })
}

export function updateCameraTrack(stream: MediaStream): void {
  if (stream !== currentStream) return
  const track = stream.getVideoTracks()[0]
  if (!track) return
  const settings = track.getSettings()
  publish({ ...snapshot, track: {
    readyState: track.readyState,
    muted: track.muted,
    enabled: track.enabled,
    width: settings.width,
    height: settings.height,
    frameRate: settings.frameRate === undefined ? undefined : rounded(settings.frameRate),
    deviceHash: settings.deviceId ? hash(settings.deviceId) : undefined,
  } })
}

function cameraAgeMs(stream: MediaStream): number {
  const began = opened.get(stream)
  return began === undefined ? 0 : Math.max(0, now() - began)
}

export function recordCameraReuse(stream: MediaStream): void {
  const track = stream.getVideoTracks()[0]
  const settings = track?.getSettings()
  recordCameraTrail("stream.reused", stream, {
    age_ms: cameraAgeMs(stream),
    ready_state: track?.readyState ?? "missing",
    muted: track?.muted ?? false,
    enabled: track?.enabled ?? false,
    width: settings?.width,
    height: settings?.height,
    frame_rate: settings?.frameRate,
    device_id_hash: settings?.deviceId ? hash(settings.deviceId) : "none",
  })
  recordCount("camera.reuse", 1, {})
}

export function recordCameraJoin(stream: MediaStream): void {
  recordDistribution("camera.age_ms_at_join", cameraAgeMs(stream), "millisecond", {})
}

export function recordSelfAttach(_video: HTMLVideoElement, attached: MediaStream, current: MediaStream, checkpoint: CameraCheckpoint): boolean {
  // `attached` is the stream the component was rendered with. The element may
  // still contain the previous stream during a normal React update; that is a
  // repair, not a stale component attachment.
  const stale = attached !== current
  recordCameraTrail("self.attach", current, {
    checkpoint,
    attached_stream_id: cameraStreamId(attached),
    current_stream_id: cameraStreamId(current),
    stale,
  })
  publish({ ...snapshot, self: { ...snapshot.self, checkpoint, attached: cameraStreamId(current), stale } })
  if (stale) recordCount("camera.stale_attachment", 1, { "camera.checkpoint": checkpoint })
  return stale
}

export function recordSelfPlay(stream: MediaStream, checkpoint: CameraCheckpoint, outcome: "resolved" | "rejected", video: HTMLVideoElement, error?: unknown): void {
  recordCameraTrail(outcome === "rejected" ? "self.play_rejected" : "self.play", stream, {
    checkpoint,
    outcome,
    error_name: error instanceof Error ? error.name : error ? "UnknownError" : "none",
    ready_state: video.readyState,
    paused: video.paused,
  })
  publish({ ...snapshot, self: { ...snapshot.self, play: outcome, readyState: video.readyState, paused: video.paused } })
}

export function recordSelfFirstFrame(stream: MediaStream, checkpoint: CameraCheckpoint, ms: number): void {
  recordCameraTrail("self.first_frame", stream, { checkpoint, first_frame_ms: ms })
  recordDistribution("camera.first_frame_ms", ms, "millisecond", { "camera.checkpoint": checkpoint })
  publish({ ...snapshot, self: { ...snapshot.self, firstFrameMs: rounded(ms) } })
}

export function recordSelfWindow(stream: MediaStream, checkpoint: CameraCheckpoint, frames: number, elapsedMs: number): void {
  const fps = elapsedMs > 0 ? frames * 1000 / elapsedMs : 0
  recordCameraTrail("self.window", stream, { checkpoint, frames, elapsed_ms: elapsedMs, fps })
  recordGauge("camera.self_fps", fps, "none", { "camera.checkpoint": checkpoint })
  publish({ ...snapshot, self: { ...snapshot.self, fps: rounded(fps) } })
}

export function recordNoFrames(stream: MediaStream, checkpoint: CameraCheckpoint, hiddenSinceOpen: boolean): void {
  recordCameraTrail("self.no_frames", stream, { checkpoint, hidden_since_open: hiddenSinceOpen, age_ms: cameraAgeMs(stream) })
  recordCount("camera.no_frames", 1, { "camera.checkpoint": checkpoint, "camera.hidden_since_open": String(hiddenSinceOpen) })
}

export function finishNoFrames(original: MediaStream, replacement: MediaStream | null, checkpoint: CameraCheckpoint, hiddenSinceOpen: boolean, outcome: "frame" | "no-frame" | "open-failed" | "unresolved"): void {
  cameraNoFrames({
    camera_checkpoint: checkpoint,
    age_ms: cameraAgeMs(original),
    hidden_since_open: hiddenSinceOpen,
    reopen_recovered: outcome === "frame",
    outcome,
    old_stream_id: cameraStreamId(original),
    new_stream_id: cameraStreamId(replacement),
  })
  recordCameraTrail("recover.done", replacement, { reason: "no-frames", outcome, old_stream_id: cameraStreamId(original) })
  publish({ ...snapshot, recovery: outcome })
}

type OutboundRow = { quality?: { link: number; at?: number; outbound?: { framesEncoded?: number; framesSent?: number; fps?: number; qualityLimitationReason?: string; trackIdentifier?: string } } }

export function observeCameraOutbound(rows: readonly OutboundRow[]): void {
  let links = 0
  let fpsSum = 0
  let fpsCount = 0
  let framesEncoded = 0
  let framesSent = 0
  let limitation = "none"
  const detail: Array<{ link: number; framesEncoded: number; framesSent: number; limitation: string; track: string }> = []
  for (const row of rows) {
    const sample = row.quality
    const out = sample?.outbound
    if (!sample || !out) continue
    links++
    framesEncoded += out.framesEncoded ?? 0
    framesSent += out.framesSent ?? 0
    limitation = out.qualityLimitationReason ?? limitation
    detail.push({ link: sample.link, framesEncoded: out.framesEncoded ?? 0, framesSent: out.framesSent ?? 0, limitation: out.qualityLimitationReason ?? "none", track: opaqueTrack(out.trackIdentifier) })
    const at = sample.at
    const frames = out.framesSent ?? out.framesEncoded
    const track = opaqueTrack(out.trackIdentifier)
    const prev = previousOutbound.get(sample.link)
    if (at !== undefined && frames !== undefined && prev && prev.track === track && at > prev.at && frames >= prev.frames) {
      const fps = (frames - prev.frames) * 1000 / (at - prev.at)
      fpsSum += fps
      fpsCount++
      if (frames > prev.frames) lastOutboundAdvanceAt = now()
      recordGauge("camera.outbound_fps", fps, "none", { "camera.limitation": limitation })
    }
    if (at !== undefined && frames !== undefined) previousOutbound.set(sample.link, { at, frames, track })
  }
  const outbound = { links, framesEncoded, framesSent, limitation, ...(fpsCount ? { fps: rounded(fpsSum / fpsCount) } : {}) }
  publish({ ...snapshot, outbound })
  const at = now()
  if (detail.length && (at - lastOutboundLogAt >= 10_000 || limitation !== lastOutboundLimitation)) {
    for (const row of detail) recordCameraTrail("outbound.video", currentStream, {
      link: row.link,
      frames_encoded: row.framesEncoded,
      frames_sent: row.framesSent,
      limitation: row.limitation,
      track_id: row.track,
    })
    lastOutboundLogAt = at
    lastOutboundLimitation = limitation
  }
}

/** True only when the existing RTC poll recently proved that encoded video
 * is advancing. A stuck local preview must never replace that healthy source. */
export function cameraOutboundAdvancing(maxAgeMs = 15_000): boolean {
  return now() - lastOutboundAdvanceAt <= maxAgeMs
}

export function cameraHandoverSummary(gameIndex?: number): void {
  if (gameIndex !== undefined) {
    if (summarizedGames.has(gameIndex)) return
    summarizedGames.add(gameIndex)
  }
  devLog("camera", "camera.handover_summary", {
    page_ms: now(),
    game_index: gameIndex,
    stream_id: snapshot.streamId,
    trail: snapshot.trail,
    latest: { ...snapshot, trail: undefined },
  })
}

export function clearCameraTrail(): void {
  publish({ ...snapshot, trail: [] })
}

export function getCameraDiagnosticSnapshot(): CameraDiagnosticSnapshot { return snapshot }
export function subscribeCameraDiagnostics(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }

export function resetCameraDiagnosticsForTest(): void {
  snapshot = emptySnapshot()
  currentStream = null
  previousOutbound.clear()
  lastOutboundLogAt = -Infinity
  lastOutboundLimitation = ""
  lastOutboundAdvanceAt = -Infinity
  summarizedGames.clear()
}
