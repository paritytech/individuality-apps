// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE rtc.sps ROW (#629): what the SPS tap (lib/webrtc/sps-tap.ts) read off a
 * link's first key frame, as the text attributes the trace and the rtc.sps
 * count carry. Pure. The SPS fields come from h264-sps.ts `spsAttrs`; the
 * tap's own numbers (its cost, the wait for the key frame, the frames it
 * read) go out as
 * distributions in game-trace.ts, never as text.
 *
 * The SENDER of the SPS is the far end of the link: its device and encoder
 * are on its own points under the same rtc.pair.
 */
import { spsAttrs } from "../webrtc/h264-sps"
import type { SpsTapEvent } from "../webrtc/sps-tap"

export function spsTapAttrs(event: SpsTapEvent): Record<string, string> {
  return {
    ...(event.sps ? spsAttrs(event.sps) : {}),
    "rtc.sps.outcome": event.outcome,
    "rtc.sps.engine": event.engine,
    "rtc.sps.mime": event.mime,
    "rtc.sps.keyframe_request": event.keyFrameRequest,
    ...(event.reason ? { "rtc.sps.reason": event.reason } : {}),
  }
}
