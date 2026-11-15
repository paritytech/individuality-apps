// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHAT A LINK'S VIDEO NEGOTIATED BESIDE ITS CODEC: retransmission (RTX) and
 * forward error correction (RED, ULPFEC, FlexFEC), read off the SDP. Pure, no
 * imports. getStats names the codec a stream really runs (rtc-stats.ts), but
 * not whether RTX or FEC were agreed: Chrome only reports codec stats a stream
 * references, and a repair format never is. The answer is the negotiated set
 * and is a subset of the offer, so a format both of a link's current
 * descriptions carry is a negotiated one. The Mesh reads this once per
 * description pair (lib/webrtc/mesh.ts report), for the per-link summary row
 * (lib/journeys/rtc-quality.ts, #559 / the codec map).
 */

export interface SdpVideo {
  rtx: boolean
  red: boolean
  ulpfec: boolean
  flexfec: boolean
}

/** the rtpmap encoding names of an SDP's video sections, lowercased */
export function videoRtpNames(sdp: string | undefined): Set<string> {
  const names = new Set<string>()
  if (typeof sdp !== "string") return names
  let video = false
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("m=")) video = line.startsWith("m=video")
    else if (video && line.startsWith("a=rtpmap:")) {
      const name = /^a=rtpmap:\d+\s+([^/\s]+)/.exec(line)?.[1]
      if (name) names.add(name.toLowerCase())
    }
  }
  return names
}

/** The repair formats both descriptions carry; undefined until both exist. */
export function sdpVideoFeatures(local: string | undefined, remote: string | undefined): SdpVideo | undefined {
  if (typeof local !== "string" || typeof remote !== "string") return undefined
  const a = videoRtpNames(local)
  const b = videoRtpNames(remote)
  const both = (name: string) => a.has(name) && b.has(name)
  return { rtx: both("rtx"), red: both("red"), ulpfec: both("ulpfec"), flexfec: both("flexfec-03") || both("flexfec") }
}
