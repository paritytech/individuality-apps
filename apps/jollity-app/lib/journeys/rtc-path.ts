// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE SELECTED PATH of each link, through the game: which candidate pair the
 * connection chose, and when it changes. Pure and framework-free: it reads the
 * quality sample every report of the mesh's getStats loop already carries
 * (lib/webrtc/rtc-stats.ts), so it costs no getStats of its own, and a quiet
 * report (nothing changed) allocates nothing.
 *
 * `trackPaths` returns the peers whose path was just set or changed, once each.
 * A path is its descriptive tuple (local type, remote type, protocol, relay
 * protocol), never the stats ids: a rebuilt connection or an ICE restart mints
 * new candidate ids for the same route, and that is not a change worth a step.
 * A report with no pair keeps the last one, so a gap between two readings is
 * not a change either.
 *
 * The step's attributes and the game-log line come from the same sample. The
 * log line, `[jollity-rtc] path <peer> <local>/<remote> <protocol>`, is what
 * a reader of exported game logs can use to mark a link relay. On a relay the protocol is the relay's own (udp, tcp or
 * tls) when known, because that is the one that explains a bad link. The
 * browser's relayProtocol says it first; WebKit leaves that out but reports
 * the relay candidate's TURN url, whose transport says it next
 * (`rtc.relay_protocol_source` tells the two apart). A local relay also names
 * its TURN host, credential-free.
 *
 * What the browser does not report is said as `unsupported`, never left out:
 * the protocol, a local relay's relay protocol and the network type are only
 * there when the browser reports them. A relay on the far end only has no
 * relay protocol to read here: `remote`.
 */
import { rtcPath } from "./peer-path"
import { UNSUPPORTED, urlHost } from "../webrtc/gather"
import { resolvedRelay, type RtcSample } from "../webrtc/rtc-stats"

export interface PathEvent {
  id: string
  /** the rtc.path step's attributes (all text) */
  attrs: Record<string, string>
  /** the game-log line the link script reads */
  line: string
  /** false for the first path a peer is seen on, true for each later one */
  change: boolean
}

/** the four fields a path is, as last seen per peer */
interface Seen {
  localType?: string
  remoteType?: string
  protocol?: string
  relayProtocol?: string
}

const NO_EVENTS: PathEvent[] = []
let known = new Map<string, Seen>()

export function resetPaths(): void {
  known = new Map()
}

function describePath(id: string, q: RtcSample, change: boolean): PathEvent {
  const localType = q.localType!
  const remoteType = q.remoteType!
  const protocol = q.protocol ?? UNSUPPORTED
  const local = localType === "relay" ? resolvedRelay(q) : undefined
  const relay = local ? local.protocol : remoteType === "relay" ? "remote" : undefined
  const shown = relay !== undefined && relay !== "remote" && relay !== UNSUPPORTED ? relay : protocol
  return {
    id,
    change,
    line: `[jollity-rtc] path ${id} ${localType}/${remoteType} ${shown}`,
    attrs: {
      "rtc.path": rtcPath(`${localType}/${remoteType}`),
      "rtc.local_type": localType,
      "rtc.remote_type": remoteType,
      "rtc.protocol": protocol,
      ...(relay !== undefined ? { "rtc.relay_protocol": relay } : {}),
      ...(local ? { "rtc.relay_protocol_source": local.source, "rtc.turn_host": urlHost(q.relayEndpoint) } : {}),
      "rtc.network": q.networkType ?? UNSUPPORTED,
    },
  }
}

/** the peers of one report whose selected path was just set or changed */
export function trackPaths(readings: ReadonlyArray<{ id: string; quality?: RtcSample }>): PathEvent[] {
  let events = NO_EVENTS
  for (const { id, quality: q } of readings) {
    if (!q?.localType || !q.remoteType) continue
    const was = known.get(id)
    const relayProtocol = q.relayProtocol ?? q.relayTransport
    if (was && was.localType === q.localType && was.remoteType === q.remoteType && was.protocol === q.protocol && was.relayProtocol === relayProtocol) continue
    known.set(id, { localType: q.localType, remoteType: q.remoteType, protocol: q.protocol, relayProtocol })
    if (events === NO_EVENTS) events = []
    events.push(describePath(id, q, was !== undefined))
  }
  return events
}
