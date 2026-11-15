// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE SPS TAP, MAIN-THREAD END (#629): put a receive-side encoded transform
 * on each link's video receiver, read the sender's first SPS in a worker
 * (sps-tap.worker.ts → sps-tap-core.ts → h264-sps.ts), and hand the result
 * back by peer. It decides which links, the worker decides nothing.
 *
 * THE ENGINES, feature-detected, in order:
 *  - "script": RTCRtpScriptTransform (Safari 15.4+, Chrome 141+). The worker
 *    gets the frames through `onrtctransform` and can ask for a key frame.
 *  - "encoded": RTCRtpReceiver.createEncodedStreams (older Chromium). The
 *    streams are transferred to the same worker, so no per-frame code runs on
 *    the main thread. The PeerConnection is NEVER built with
 *    `encodedInsertableStreams: true`: on Chrome 153 that flag stopped every
 *    sender that did not pipe its own streams (no video at all), and
 *    createEncodedStreams works without it. An engine that still needs the
 *    flag throws here and the link goes untapped.
 *    OFF UNLESS `NEXT_PUBLIC_SPS_TAP_ENCODED=1`: this path cannot ask for a
 *    key frame, and on Chrome 153 every tapped link froze for ~3 s after its
 *    first frame (the script path, with its key frame request, did not). An
 *    engine with only this API reads "unsupported" by default.
 *  - none: nothing is attached.
 *
 * SAMPLED PER SESSION. `NEXT_PUBLIC_SPS_TAP_RATE` is the share of page
 * sessions that tap, and it DEFAULTS TO 0: real phones (Android MediaCodec,
 * iOS WKWebView inside the host) are unmeasured, and a transform whose key
 * frame request misbehaves freezes a link ~3 s. Raise it only once tapped
 * sessions show no rtc.freeze_ms or verdict regression. `NEXT_PUBLIC_SPS_TAP=0`
 * is the kill switch that stops every tap whatever the rate. The decision is
 * made once per page and goes on every metric point as rtc.sps_tap, so
 * decode_ms of tapped and untapped sessions can be compared: that is the
 * tap's real cost, which no code of ours can time from inside the pipeline.
 *
 * NOTHING IS ATTACHED BEFORE THE WORKER HAS ANSWERED. A script transform
 * whose worker never started holds the video; a worker that fails later
 * stops new attaches.
 */

import type { SpsTapResult } from "./sps-tap-core"

export type SpsTapEngine = "script" | "encoded"

/** what the tap reports for one link: the worker's result, the engine, and
 *  the main thread's own cost of attaching */
export type SpsTapEvent = SpsTapResult & { engine: SpsTapEngine; attachMs: number }

/** the slice of Worker the tap uses */
export interface TapWorker {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: never) => void) | null
  postMessage(message: unknown, transfer?: Transferable[] | unknown[]): void
  terminate(): void
}

export interface SpsTap {
  /** tap this receiver's frames for `peerId`: "attached", or why not */
  attach(peerId: string, receiver: RTCRtpReceiver): "attached" | UntappedReason
  /** after the mesh's connections are closed: stop the worker */
  close(): void
}

/** NEXT_PUBLIC_ vars are inlined at build time: the createEncodedStreams path, per build */
const SPS_TAP_ENCODED = process.env.NEXT_PUBLIC_SPS_TAP_ENCODED === "1"

/** which encoded-transform API this engine has and the build allows, if any */
export function spsTapEngine(
  g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
  allowEncoded: boolean = SPS_TAP_ENCODED,
): SpsTapEngine | null {
  if (typeof g.Worker !== "function") return null
  if (typeof g.RTCRtpScriptTransform === "function") return "script"
  if (!allowEncoded) return null
  const receiver = g.RTCRtpReceiver as { prototype?: object } | undefined
  if (receiver?.prototype && "createEncodedStreams" in receiver.prototype) return "encoded"
  return null
}

/** none until tapped sessions have shown the tap costs nothing (see above) */
const DEFAULT_TAP_RATE = 0

/** the build's sampling rate: a fraction in [0, 1]; unset or unreadable = the default */
export function parseTapRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TAP_RATE
  const rate = Number(raw)
  if (!Number.isFinite(rate)) return DEFAULT_TAP_RATE
  return Math.min(1, Math.max(0, rate))
}

/** NEXT_PUBLIC_ vars are inlined at build time, so this is per build */
const SPS_TAP_RATE = parseTapRate(process.env.NEXT_PUBLIC_SPS_TAP_RATE)

/** on = this session was drawn under the rate; off = not drawn, or the kill switch; unsupported = no API */
export function spsTapDecision(input: { rate: number; engine: SpsTapEngine | null; random: number; disabled?: boolean }): "on" | "off" | "unsupported" {
  if (input.disabled) return "off"
  if (!input.engine) return "unsupported"
  return input.random < input.rate ? "on" : "off"
}

/** the kill switch: NEXT_PUBLIC_SPS_TAP=0 stops every tap (per build) */
const SPS_TAP_DISABLED = process.env.NEXT_PUBLIC_SPS_TAP === "0"

let session: "on" | "off" | "unsupported" | undefined

/** This page session's decision, drawn once. */
export function sessionSpsTap(): "on" | "off" | "unsupported" {
  session ??= spsTapDecision({
    rate: SPS_TAP_RATE,
    engine: spsTapEngine(),
    random: Math.random(),
    disabled: SPS_TAP_DISABLED,
  })
  return session
}

function defaultWorker(): TapWorker {
  return new Worker(new URL("./sps-tap.worker.ts", import.meta.url), { type: "module" }) as unknown as TapWorker
}

type WorkerMessage = { kind: "ready" } | { kind: "result"; id: number; result: SpsTapResult }

/** Why a link got no tap: no worker could be built, the worker had not
 *  answered yet (or never will), the worker failed, the engine threw on
 *  attach, or the encoded streams could not be handed to the worker. */
export type UntappedReason = "no-worker" | "not-ready" | "worker-failed" | "attach-threw" | "post-failed"

/** The rtc.sps row for a link the tap never attached to, so it reads
 *  "untapped", never as a link with no video. */
export function untappedEvent(engine: SpsTapEngine, reason: UntappedReason): SpsTapEvent {
  return { outcome: "untapped", reason, engine, mime: "unknown", frames: 0, inspectMs: 0, parseMs: 0, toKeyMs: 0, attachMs: 0, keyFrameRequest: "unsupported" }
}

/**
 * THE rtc.sps_tap TAG, for the session, after the draw. A drawn session
 * starts "pending" and turns "on" at its first link actually attached; a
 * failure before that makes it "failed". Only "on" means links were tapped,
 * so the rollout gate (rtc.freeze_ms by rtc.sps_tap=on) never counts a
 * session that tapped nothing.
 */
export type SpsTapTag = "on" | "off" | "unsupported" | "pending" | "failed"

export function nextTapTag(current: SpsTapTag, what: "attached" | "failed"): SpsTapTag {
  if (current === "on" || what === "attached") return "on"
  return "failed"
}

let sessionTag: SpsTapTag = "pending"

/** The session's tag after `what` happened, or null when it did not change
 *  (one session, many rooms: the tag outlives each mesh). */
export function noteSessionTap(what: "attached" | "failed"): SpsTapTag | null {
  const next = nextTapTag(sessionTag, what)
  if (next === sessionTag) return null
  sessionTag = next
  return next
}

/** the tag a drawn-in session shows right now: "pending" until it is known */
export function sessionTapTag(): SpsTapTag {
  return sessionTag
}

/** A tap for one mesh, or null when its worker cannot be created. */
export function createSpsTap(options: {
  engine: SpsTapEngine
  onResult: (peerId: string, event: SpsTapEvent) => void
  /** the worker failed (an error event, or the ping could not be posted) */
  onWorkerFailed?: () => void
  createWorker?: () => TapWorker
  ScriptTransform?: typeof RTCRtpScriptTransform
  now?: () => number
}): SpsTap | null {
  const { engine, onResult, now = () => performance.now() } = options
  let worker: TapWorker
  try {
    worker = (options.createWorker ?? defaultWorker)()
  } catch {
    return null
  }
  let ready = false
  let failed = false
  let nextId = 1
  const links = new Map<number, { peerId: string; attachMs: number }>()

  worker.onmessage = (event: MessageEvent) => {
    const message = event.data as WorkerMessage
    if (message?.kind === "ready") {
      ready = true
      return
    }
    if (message?.kind !== "result") return
    const link = links.get(message.id)
    if (!link) return
    links.delete(message.id)
    onResult(link.peerId, { ...message.result, engine, attachMs: link.attachMs })
  }
  const fail = () => {
    if (failed) return
    failed = true
    options.onWorkerFailed?.()
  }
  worker.onerror = fail
  try {
    worker.postMessage({ kind: "ping" })
  } catch {
    fail()
  }

  const attachScript = (id: number, receiver: RTCRtpReceiver): "attached" => {
    const Transform = options.ScriptTransform ?? RTCRtpScriptTransform
    receiver.transform = new Transform(worker as unknown as Worker, { id })
    return "attached"
  }

  const attachEncoded = (id: number, receiver: RTCRtpReceiver): "attached" | "post-failed" => {
    const { readable, writable } = (receiver as unknown as { createEncodedStreams(): { readable: ReadableStream; writable: WritableStream } }).createEncodedStreams()
    try {
      worker.postMessage({ kind: "streams", id, readable, writable }, [readable, writable])
      return "attached"
    } catch {
      // the streams exist now, so the frames must flow: pipe them here
      readable.pipeTo(writable).catch(() => {})
      return "post-failed"
    }
  }

  return {
    attach(peerId, receiver) {
      if (failed) return "worker-failed"
      if (!ready) return "not-ready"
      const id = nextId++
      const start = now()
      let outcome: "attached" | UntappedReason
      try {
        outcome = engine === "script" ? attachScript(id, receiver) : attachEncoded(id, receiver)
      } catch {
        outcome = "attach-threw"
      }
      if (outcome === "attached") links.set(id, { peerId, attachMs: now() - start })
      return outcome
    },
    close() {
      links.clear()
      worker.onmessage = null
      try {
        worker.terminate()
      } catch {
        // already gone
      }
    },
  }
}
