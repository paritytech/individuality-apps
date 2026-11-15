// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHAT A PEER CONNECTION GATHERED, AS TELEMETRY (lib/webrtc/gather.ts holds
 * the tally):
 *
 *  - `rtc.candidates`  distribution, the number of local candidates of one
 *    type (`rtc.candidate_type`: host, srflx, relay, other), a point per type
 *    including zeros, so "this side got no relay" is a 0 and not an absence
 *  - `rtc.gather_ms`   distribution, how long the gathering took
 *  - `rtc.ice_errors`  counter, the icecandidateerrors of a gathering, by `rtc.error_code`
 *    (701 = the TURN server was unreachable) and `rtc.error_host` (the server
 *    url's host, never the url)
 *
 * All carry the link's attributes (rtc.pair, rtc.peer, round). Read the two
 * ends of a pair that never connected side by side under one rtc.pair.
 */
import { recordCount, recordDistribution } from "../telemetry"
import type { CandidateType, GatherSnapshot } from "../webrtc/gather"

const TYPES: readonly CandidateType[] = ["host", "srflx", "relay", "other"]

/** A gathering's points: the candidates by type, the time (absent for a
 *  gathering that never completed), and the errors it raised, one count per
 *  code and host. `attrs` are the link's. */
export function recordGather({ counts, ms, errors }: GatherSnapshot, attrs: Record<string, string>): void {
  for (const type of TYPES) recordDistribution("rtc.candidates", counts[type], "none", { ...attrs, "rtc.candidate_type": type })
  if (ms !== undefined) recordDistribution("rtc.gather_ms", ms, "millisecond", attrs)
  for (const { code, host, n } of errors) recordCount("rtc.ice_errors", n, { ...attrs, "rtc.error_code": code, "rtc.error_host": host })
}
