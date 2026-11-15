// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { AwayPeriodEvent } from "../webrtc/away-period"

/** Typed scalar attributes for one rtc.away_period Logs record. */
export function awayPeriodAttributes(event: AwayPeriodEvent): Record<string, string | number> {
  return {
    "rtc.away_reason": event.reason,
    "rtc.away_return": event.return,
    "rtc.away_last_attempt": event.lastAttempt,
    "rtc.away_attempts": event.attempts,
    "rtc.away_offerer": event.offerer,
    ...(event.offererRole ? { "rtc.away_offerer_role": event.offererRole } : {}),
    "rtc.away_ms": event.ms,
  }
}
