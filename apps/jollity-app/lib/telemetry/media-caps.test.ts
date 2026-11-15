// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { MEDIA_CAP_CODECS, MEDIA_CAP_TAG_KEYS, capValue, probeMediaCapabilities } from "./media-caps"

type Info = { supported: boolean; smooth: boolean; powerEfficient: boolean }
/** a mediaCapabilities whose answer depends on the codec and the direction */
function caps(answer: (dir: "encode" | "decode", contentType: string) => Info | Error) {
  const calls: Array<{ dir: string; config: { type: string; video: Record<string, unknown> } }> = []
  const ask = (dir: "encode" | "decode") => async (config: { type: string; video: { contentType: string } & Record<string, unknown> }) => {
    calls.push({ dir, config })
    const got = answer(dir, config.video.contentType)
    if (got instanceof Error) throw got
    return got
  }
  return { mc: { encodingInfo: ask("encode"), decodingInfo: ask("decode") }, calls }
}

describe("capValue", () => {
  it("hw when supported and power-efficient, sw when supported only, no when not", () => {
    expect(capValue({ supported: true, smooth: true, powerEfficient: true })).toBe("hw")
    expect(capValue({ supported: true, smooth: false, powerEfficient: false })).toBe("sw")
    expect(capValue({ supported: false, smooth: false, powerEfficient: false })).toBe("no")
    expect(capValue(undefined)).toBe("unsupported")
  })
})

describe("probeMediaCapabilities", () => {
  it("asks webrtc encode and decode for every codec at the call's real shape, and tags hw/sw/no", async () => {
    const { mc, calls } = caps((dir, type) =>
      type.includes("42e01f") && dir === "decode"
        ? { supported: true, smooth: true, powerEfficient: false }
        : type.includes("VP8")
          ? { supported: true, smooth: true, powerEfficient: true }
          : { supported: false, smooth: false, powerEfficient: false },
    )
    const result = await probeMediaCapabilities(mc)
    expect(calls).toHaveLength(MEDIA_CAP_CODECS.length * 2)
    expect(calls[0].config).toEqual({ type: "webrtc", video: { contentType: "video/H264; profile-level-id=42e01f; packetization-mode=1", width: 360, height: 360, bitrate: 300_000, framerate: 24 } })
    expect(result.tags).toMatchObject({
      "rtc.cap.h264.decode": "sw",
      "rtc.cap.h264.encode": "no",
      "rtc.cap.vp8.decode": "hw",
      "rtc.cap.vp8.encode": "hw",
      "rtc.cap.av1.decode": "no",
    })
    expect(Object.keys(result.tags).sort()).toEqual([...MEDIA_CAP_TAG_KEYS].sort())
    // the context keeps all three answers
    expect(result.context["h264.decode"]).toEqual({ supported: true, smooth: true, powerEfficient: false })
  })

  it("says unsupported for every tag when the API is missing, and never throws", async () => {
    const result = await probeMediaCapabilities(undefined)
    expect(new Set(Object.values(result.tags))).toEqual(new Set(["unsupported"]))
    expect(result.context).toEqual({ api: "missing" })
    const half = await probeMediaCapabilities({ decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: true }) } as never)
    expect(half.tags["rtc.cap.vp8.decode"]).toBe("hw")
    expect(half.tags["rtc.cap.vp8.encode"]).toBe("unsupported")
  })

  it("a call that throws or never answers is unsupported for that codec alone", async () => {
    const { mc } = caps((_dir, type) => (type.includes("AV1") ? new TypeError("webrtc type unknown") : { supported: true, smooth: true, powerEfficient: true }))
    const result = await probeMediaCapabilities(mc)
    expect(result.tags["rtc.cap.av1.decode"]).toBe("unsupported")
    expect(result.tags["rtc.cap.vp9.decode"]).toBe("hw")
    const hung = await probeMediaCapabilities({ encodingInfo: () => new Promise(() => {}), decodingInfo: () => new Promise(() => {}) } as never, 5)
    expect(hung.tags["rtc.cap.h264.encode"]).toBe("unsupported")
  })
})

describe("the capability tags on every metric point", () => {
  it("are all scope tags, so the codec map can read them off any rtc point", async () => {
    const { SCOPE_TAGS } = await import("./scope-tags")
    for (const key of MEDIA_CAP_TAG_KEYS) expect(SCOPE_TAGS as readonly string[]).toContain(key)
  })
})
