// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { LinkFailure } from "../webrtc/heal-cohort"

/**
 * Scalar typed attributes for one rtc.link.failed Logs record: an established
 * link failed, and how. `kind` torn-down is the transport closed under the link
 * (ICE `disconnected` and `failed` within LINK_TORN_DOWN_MS, a TURN socket
 * reset in issue #944); timed-out is a path that went quiet until consent ran
 * out. Durations stay numbers; the TURN host is credential-free and absent
 * off a relay.
 */
export function linkFailedAttributes(event: LinkFailure): Record<string, string | number | boolean> {
  return {
    "rtc.link.failed.kind": event.failKind,
    "rtc.link.failed.quiet_ms": Math.round(event.quietMs),
    "rtc.link.failed.up_ms": Math.round(event.upMs),
    "rtc.link.failed.path": event.path,
    ...(event.relayProtocol ? { "rtc.link.failed.relay_protocol": event.relayProtocol } : {}),
    ...(event.relayProtocolSource ? { "rtc.link.failed.relay_protocol_source": event.relayProtocolSource } : {}),
    ...(event.turnEndpointHost ? { "rtc.link.failed.turn_host": event.turnEndpointHost } : {}),
    "rtc.link.failed.page_hidden": event.pageHidden,
    ...(event.sinceNetChangeMs !== undefined ? { "rtc.link.failed.since_net_change_ms": Math.round(event.sinceNetChangeMs) } : {}),
  }
}
