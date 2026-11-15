// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import * as Sentry from "@sentry/react"
import { newId } from "../debug/session-id"
import { maskSafe } from "../journeys/mask-text"
import { telemetryLive } from "./boot"
import { sendLogEnvelope } from "./init"
import { logAttributes, stableHexId, type LogLevel, type LogRecord } from "./log-envelope"
import { scopeTagAttrs } from "./scope-tags"

const severityNumber: Record<LogLevel, number> = { info: 9, warn: 13, error: 17 }

/** Send one best-effort, non-durable Sentry Log record. */
export function logEvent(
  name: string,
  level: LogLevel,
  attributes: Record<string, string | number | boolean | undefined>,
  detail?: string,
): void {
  try {
    if (!telemetryLive()) return
    const now = Date.now()
    const user = Sentry.getIsolationScope().getUser()
    const activeTraceId = Sentry.getActiveSpan()?.spanContext().traceId
    const record: LogRecord = {
      timestamp: now / 1000,
      level,
      body: name + (detail ? `\t${maskSafe(detail)}` : ""),
      trace_id: activeTraceId || stableHexId(name + now),
      severity_number: severityNumber[level],
      attributes: logAttributes({
        ...scopeTagAttrs(),
        ...(user?.id === undefined ? {} : { "user.id": String(user.id) }),
        ...(user?.username === undefined ? {} : { "user.name": user.username }),
        ...attributes,
      }),
    }
    void sendLogEnvelope(newId(), [record]).catch(() => false)
  } catch {
    /* telemetry never breaks the app */
  }
}
