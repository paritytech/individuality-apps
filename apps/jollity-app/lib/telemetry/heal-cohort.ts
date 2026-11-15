// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { HealCohortEvent } from "../webrtc/heal-cohort"

/** Scalar typed attributes for one rtc.heal.cohort Logs record. */
export function healCohortAttributes(event: HealCohortEvent): Record<string, string | number | boolean> {
  const perLink: Record<string, number> = {}
  event.recoveryMs.forEach((duration, index) => {
    if (duration !== null) perLink[`rtc.heal.cohort.recovery_ms.${index + 1}`] = duration
  })
  event.quietMs.forEach((duration, index) => {
    if (duration !== null) perLink[`rtc.heal.cohort.quiet_ms.${index + 1}`] = duration
  })
  return {
    "rtc.heal.cohort.size": event.size,
    "rtc.heal.cohort.window_ms": event.windowMs,
    "rtc.heal.cohort.relay_protocol": event.relayProtocol,
    "rtc.heal.cohort.turn_endpoint_host": event.turnEndpointHost,
    "rtc.heal.cohort.fail_kind": event.failKind,
    "rtc.heal.cohort.unrecovered": event.unrecovered,
    ...(event.pageHidden !== undefined ? { "rtc.heal.cohort.page_hidden": event.pageHidden } : {}),
    ...(event.sinceNetChangeMs !== undefined ? { "rtc.heal.cohort.since_net_change_ms": event.sinceNetChangeMs } : {}),
    ...perLink,
  }
}
