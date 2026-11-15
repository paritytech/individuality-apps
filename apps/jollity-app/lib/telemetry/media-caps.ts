// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHAT THIS DEVICE SAYS IT CAN DO FOR WEBRTC VIDEO, once per session, for the
 * codec map (#627). navigator.mediaCapabilities encodingInfo/decodingInfo with
 * `type: "webrtc"`, at the call's real shape (360x360, 300 kbit/s, 24 fps:
 * the "full" rung of lib/webrtc/send-adaptation-classifier.ts VIDEO_RUNGS and
 * the camera), for each codec we may
 * negotiate. Each direction becomes one tag, `rtc.cap.<codec>.<encode|decode>`:
 *
 *   hw           supported and power-efficient (a hardware codec)
 *   sw           supported, not power-efficient (software)
 *   no           the device says it cannot
 *   unsupported  the API is missing (older iOS, some WebViews), threw, or did
 *                not answer in time
 *
 * The full answers (supported, smooth, powerEfficient) go into the session's
 * `media_caps` context. Read-only: nothing here changes what the mesh offers.
 * Never throws. init.ts runs it when the page is idle.
 */
import { UNSUPPORTED } from "../webrtc/gather"

export const MEDIA_CAP_CODECS = [
  ["h264", "video/H264; profile-level-id=42e01f; packetization-mode=1"], // constrained baseline: what we prefer
  ["h264_high", "video/H264; profile-level-id=640c1f; packetization-mode=1"], // constrained high: what iOS offers
  ["vp8", "video/VP8"],
  ["vp9", "video/VP9"],
  ["av1", "video/AV1"],
] as const

export const MEDIA_CAP_TAG_KEYS = MEDIA_CAP_CODECS.flatMap(([id]) => [`rtc.cap.${id}.encode`, `rtc.cap.${id}.decode`])

const SHAPE = { width: 360, height: 360, bitrate: 300_000, framerate: 24 }
const ANSWER_MS = 2000

export interface CapInfo {
  supported: boolean
  smooth: boolean
  powerEfficient: boolean
}

type Ask = (config: { type: string; video: { contentType: string } & typeof SHAPE }) => Promise<Partial<CapInfo>>
export interface MediaCapsLike {
  encodingInfo?: Ask
  decodingInfo?: Ask
}

export function capValue(info: CapInfo | undefined): string {
  if (!info) return UNSUPPORTED
  if (!info.supported) return "no"
  return info.powerEfficient ? "hw" : "sw"
}

async function ask(fn: Ask | undefined, owner: MediaCapsLike, contentType: string, waitMs: number): Promise<CapInfo | undefined> {
  if (typeof fn !== "function") return undefined
  try {
    const answer = await Promise.race([fn.call(owner, { type: "webrtc", video: { contentType, ...SHAPE } }), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), waitMs))])
    if (!answer || typeof answer.supported !== "boolean") return undefined
    return { supported: answer.supported, smooth: answer.smooth === true, powerEfficient: answer.powerEfficient === true }
  } catch {
    return undefined
  }
}

export async function probeMediaCapabilities(
  mc: MediaCapsLike | undefined = typeof navigator === "undefined" ? undefined : (navigator as { mediaCapabilities?: MediaCapsLike }).mediaCapabilities,
  waitMs = ANSWER_MS,
): Promise<{ tags: Record<string, string>; context: Record<string, unknown> }> {
  const tags: Record<string, string> = Object.fromEntries(MEDIA_CAP_TAG_KEYS.map((key) => [key, UNSUPPORTED]))
  if (!mc || (typeof mc.encodingInfo !== "function" && typeof mc.decodingInfo !== "function")) return { tags, context: { api: "missing" } }
  const context: Record<string, unknown> = {}
  try {
    for (const [id, contentType] of MEDIA_CAP_CODECS) {
      for (const dir of ["encode", "decode"] as const) {
        const info = await ask(dir === "encode" ? mc.encodingInfo : mc.decodingInfo, mc, contentType, waitMs)
        tags[`rtc.cap.${id}.${dir}`] = capValue(info)
        context[`${id}.${dir}`] = info ?? UNSUPPORTED
      }
    }
  } catch {
    /* never throws: what was read stands */
  }
  return { tags, context }
}
