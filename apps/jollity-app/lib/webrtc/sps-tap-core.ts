// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE TAP'S LOOP (#629): what runs on one receiver's encoded frames, inside
 * the worker (sps-tap.worker.ts). Framework-free and DOM-free, so the tests
 * drive it with plain web streams.
 *
 * It is on the media path, so three rules hold whatever happens:
 *  - EVERY FRAME GOES ON, UNCHANGED AND IN ORDER. The tap reads `data` of a
 *    key frame only, never writes it, and a parser error is caught.
 *  - IT STOPS AT THE FIRST KEY FRAME. That frame is parsed, written, and then
 *    the locks are released and the rest is `pipeTo`'d natively: no code of
 *    ours runs per frame after it. (Setting `receiver.transform = null`
 *    would be the real detach, but on Chrome 153 it stopped the video for
 *    good; measured 10 Oct 2026, see the PR.)
 *  - IT ASKS FOR A KEY FRAME RIGHT AFTER. On Chrome 153 a receiver with an
 *    encoded transform decoded the first key frame and then nothing until the
 *    next one, about 3 s later, on 5 of 6 links; one key frame request after
 *    the first passed it removed that on 10 of 10. `requestKeyFrame` is the
 *    transformer's sendKeyFrameRequest where the engine has it. It is sent
 *    ONCE per link (one runTap per link, after the loop), and a failure of
 *    it, thrown or rejected, is swallowed: the frames are already piped.
 *
 * And it measures itself: the time its own code took per inspected frame,
 * the parse, and the wait from the first frame to the key frame.
 */
import { spsFromFrame, type SpsFields } from "./h264-sps"

/** the parts of an RTCEncodedVideoFrame the tap reads */
export interface TapFrame {
  type?: string
  data: ArrayBuffer
  getMetadata?: () => { mimeType?: string }
}

/**
 * sps       the first key frame held an SPS (in `sps`)
 * no-sps    an H.264 (or unlabelled) key frame with no SPS in it
 * not-h264  the engine labelled the key frame another codec
 * no-key    no key frame within maxFrames
 * ended     the stream closed before a key frame
 * error     the parser threw, or a write failed
 * untapped  the tap never attached to this link (its `reason` says why);
 *           set by sps-tap.ts, never by runTap
 */
type SpsTapOutcome = "sps" | "no-sps" | "not-h264" | "no-key" | "ended" | "error" | "untapped"

export interface SpsTapResult {
  outcome: SpsTapOutcome
  sps?: SpsFields
  /** the key frame's mimeType, or "unknown" when the engine gives none */
  mime: string
  /** frames the tap read itself (the key frame included) */
  frames: number
  /** ms of the tap's own code across those frames, the writes' waits excluded */
  inspectMs: number
  /** ms of the SPS parse */
  parseMs: number
  /** ms from the first frame to the key frame */
  toKeyMs: number
  keyFrameRequest: "sent" | "failed" | "unsupported"
  /** untapped only: why nothing was attached (sps-tap.ts `UntappedReason`) */
  reason?: string
}

/** ~12 s at 24 fps: a link with no key frame by then has no picture anyway */
const MAX_INSPECT_FRAMES = 300

export async function runTap(io: {
  readable: ReadableStream<TapFrame>
  writable: WritableStream<TapFrame>
  now: () => number
  requestKeyFrame?: () => unknown
  maxFrames?: number
  parse?: (data: Uint8Array) => SpsFields | null
}): Promise<SpsTapResult> {
  const { readable, writable, now, maxFrames = MAX_INSPECT_FRAMES, parse = spsFromFrame } = io
  const reader = readable.getReader()
  const writer = writable.getWriter()
  const result: SpsTapResult = { outcome: "no-key", mime: "unknown", frames: 0, inspectMs: 0, parseMs: 0, toKeyMs: 0, keyFrameRequest: "unsupported" }
  let firstAt = 0
  for (;;) {
    let next: ReadableStreamReadResult<TapFrame>
    try {
      next = await reader.read()
    } catch {
      result.outcome = "error"
      return result
    }
    if (next.done) {
      result.outcome = "ended"
      return result
    }
    const f = next.value
    const start = now()
    if (result.frames === 0) firstAt = start
    result.frames++
    const key = f.type === "key"
    if (key) {
      result.toKeyMs = start - firstAt
      try {
        result.mime = f.getMetadata?.().mimeType ?? "unknown"
        if (result.mime !== "unknown" && result.mime.toLowerCase() !== "video/h264") {
          result.outcome = "not-h264"
        } else {
          const parseStart = now()
          const sps = parse(new Uint8Array(f.data))
          result.parseMs = now() - parseStart
          result.outcome = sps ? "sps" : "no-sps"
          if (sps) result.sps = sps
        }
      } catch {
        result.outcome = "error"
      }
    }
    result.inspectMs += now() - start
    try {
      await writer.write(f)
    } catch {
      result.outcome = "error"
      return result
    }
    if (key || result.frames >= maxFrames) break
  }
  // inspection over: hand the stream to the engine's own pipe
  reader.releaseLock()
  writer.releaseLock()
  readable.pipeTo(writable).catch(() => {})
  if (io.requestKeyFrame) {
    try {
      await io.requestKeyFrame()
      result.keyFrameRequest = "sent"
    } catch {
      result.keyFrameRequest = "failed"
    }
  }
  return result
}
