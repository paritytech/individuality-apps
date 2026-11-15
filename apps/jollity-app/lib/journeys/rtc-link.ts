// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE LINK ROW: one per link per round, so a query that groups links by pair
 * (rtc.pair) can judge each one, codecs and outcome side by side.
 * Pure: lib/journeys/rtc-quality.ts gathers the facts over the round and
 * sends the row as metrics at the round's close:
 *
 *   rtc.link (count 1)      the row itself, every categorical below plus the
 *                           round's shared attributes (codec in and out,
 *                           encoder/decoder and their kinds, path, pair, role)
 *   rtc.link.ttff_ms        from the link's first offer to its first decoded
 *                           frame, when this round's room stamped both
 *   rtc.link.freeze_ms      the round's inbound freeze total, 0 included
 *
 * The categoricals:
 *   rtc.outcome     video | connected-no-video | connected-unmeasured (no
 *                   frame counter on this browser) | not-connected | standby (a next-round
 *                   link held back on purpose, #1156: not a loss)
 *   rtc.last_stage  the furthest funnel stage this round's room stamped
 *                   (lib/webrtc/funnel.ts), or `carried`: a same-group round 2
 *                   keeps the room, so its links were stamped in round 1
 *   rtc.seen        the session counted the co-player as seen (#603): video
 *                   decoded in a shared open turn
 *   rtc.rtx, rtc.red, rtc.ulpfec, rtc.flexfec   negotiated, off the SDP
 *                   (lib/webrtc/sdp-video.ts); unsupported before both
 *                   descriptions existed
 *   rtc.rebuilds    0 | 1 | 2 | 3+: connections the link went through this
 *                   round beyond its first
 */
import { FUNNEL_STAGES, type FunnelStage } from "../webrtc/funnel"
import { UNSUPPORTED } from "../webrtc/gather"
import type { SdpVideo } from "../webrtc/sdp-video"

export interface LinkFacts {
  /** some reading of the round saw the peer connection `connected` */
  connected: boolean
  /** frames were decoded in the round; undefined when the browser has no frame counter */
  video: boolean | undefined
  /** this round's room's funnel stamps, ms from the mesh opening */
  stages: Partial<Record<FunnelStage, number>>
  sdp?: SdpVideo
  seen: boolean
  /** distinct peer connections (rtc-stats `link`) seen this round */
  links: number
  /** inbound freeze ms over the round */
  freezeMs: number
}

export interface LinkRow {
  attrs: Record<string, string>
  ttffMs?: number
  freezeMs: number
}

function outcome(facts: LinkFacts): string {
  if (facts.video || facts.stages.first_frame !== undefined) return "video"
  if (!facts.connected) return "not-connected"
  return facts.video === undefined ? "connected-unmeasured" : "connected-no-video"
}

function lastStage(stages: LinkFacts["stages"]): string {
  for (let i = FUNNEL_STAGES.length - 1; i >= 0; i--) if (stages[FUNNEL_STAGES[i]] !== undefined) return FUNNEL_STAGES[i]
  return "carried"
}

const flag = (sdp: SdpVideo | undefined, key: keyof SdpVideo): string => (sdp ? String(sdp[key]) : UNSUPPORTED)

export function linkRow(facts: LinkFacts): LinkRow {
  const rebuilds = Math.max(0, facts.links - 1)
  const { offer, first_frame: firstFrame } = facts.stages
  return {
    attrs: {
      "rtc.outcome": outcome(facts),
      "rtc.last_stage": lastStage(facts.stages),
      "rtc.seen": String(facts.seen),
      "rtc.rtx": flag(facts.sdp, "rtx"),
      "rtc.red": flag(facts.sdp, "red"),
      "rtc.ulpfec": flag(facts.sdp, "ulpfec"),
      "rtc.flexfec": flag(facts.sdp, "flexfec"),
      "rtc.rebuilds": rebuilds >= 3 ? "3+" : String(rebuilds),
    },
    ...(offer !== undefined && firstFrame !== undefined && firstFrame >= offer ? { ttffMs: firstFrame - offer } : {}),
    freezeMs: facts.freezeMs,
  }
}
