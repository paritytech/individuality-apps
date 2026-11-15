// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The one delivery-health event per game, on time or recovered next open. */
import * as Sentry from "@sentry/react"
import { devLog } from "../debug/log-store"
import { newId } from "../debug/session-id"
import { withTimeout } from "../with-timeout"
import {
  deliveryHealthForGame,
  optionalDeliveryHealthForGame,
  markDeliveryHealthSent,
  pendingDeliveryHealth,
  type DeliveryHealth,
  type StoredHealth,
} from "./delivery-health"
import { sendLogEnvelope, telemetryStarted, waitForTelemetryIdle } from "./init"
import { logAttributes, type LogRecord } from "./log-envelope"
import { scopeTagAttrs } from "./scope-tags"

const SETTLE_MS = 15_000
const inFlight = new Set<number>()

export const deliveryHealthFields = (health: DeliveryHealth) => ({
  failed_fetch: health.failed.fetch,
  failed_4xx: health.failed["4xx"],
  failed_429: health.failed["429"],
  failed_5xx: health.failed["5xx"],
  failed_timeout: health.failed.timeout,
  retries: health.retries,
  dropped_events: health.droppedEvents,
  dropped_metrics: health.droppedMetrics,
  offline_ms: health.offlineMs,
  recovered_timeouts: health.recoveredTimeouts,
  longest_wait_ms: health.longestWaitMs,
  unknown_lanes: health.unknownLanes,
  failed_429_server: health.failed429Server,
  failed_429_local: health.failed429Local,
  limited_2xx: health.limited2xx,
  rate_limit_last: health.rateLimitLast,
  rate_limit_reasons: health.rateLimitReasons,
})

const prefixedDeliveryHealthFields = (prefix: string, health: DeliveryHealth): Record<string, string | number> =>
  Object.fromEntries(Object.entries(deliveryHealthFields(health)).map(([key, value]) => [`${prefix}.${key}`, value]))

/** Snapshot after older queued telemetry has settled, but never wait forever
 * on an offline queue. Shared with the matching game-log attachment. */
export async function settledHealth(gameIndex: number, waitMs = SETTLE_MS): Promise<StoredHealth> {
  await Sentry.flush(2_000).catch(() => false)
  await withTimeout(waitForTelemetryIdle(), waitMs)
  return deliveryHealthForGame(gameIndex)
}

/** The game log is primary evidence. Its optional health attachment gets a
 * bounded store read and is omitted when no durable record is available. */
export async function settledGameLogHealth(gameIndex: number, waitMs = SETTLE_MS): Promise<StoredHealth | null> {
  const startedAt = Date.now()
  await Sentry.flush(Math.min(2_000, waitMs)).catch(() => false)
  const idleWaitMs = Math.max(0, waitMs - (Date.now() - startedAt))
  if (idleWaitMs > 0) await withTimeout(waitForTelemetryIdle(), idleWaitMs)
  const storeWaitMs = Math.max(0, waitMs - (Date.now() - startedAt))
  return storeWaitMs > 0 ? optionalDeliveryHealthForGame(gameIndex, storeWaitMs) : null
}

export async function sendTelemetryHealth(gameIndex: number, late: boolean, snapshot?: StoredHealth): Promise<boolean> {
  if (!telemetryStarted()) return false
  if (inFlight.has(gameIndex)) return false
  inFlight.add(gameIndex)
  try {
    const { game, session } = snapshot ?? (await settledHealth(gameIndex))
    const fields = { ...deliveryHealthFields(game), session: deliveryHealthFields(session) }
    devLog("telemetry", `telemetry health for game ${gameIndex}`, { late, ...fields })
    const now = Date.now()
    const user = Sentry.getIsolationScope().getUser()
    const record: LogRecord = {
      timestamp: now / 1000,
      level: "info",
      body: "telemetry.health",
      trace_id: newId(),
      severity_number: 9,
      attributes: logAttributes({
        ...scopeTagAttrs(),
        ...(user?.id === undefined ? {} : { "user.id": String(user.id) }),
        ...(user?.username === undefined ? {} : { "user.name": user.username }),
        "game.index": String(gameIndex),
        "telemetry.health_late": late,
        ...prefixedDeliveryHealthFields("telemetry_health", game),
        ...prefixedDeliveryHealthFields("telemetry_health.session", session),
      }),
    }
    const sent = await sendLogEnvelope(`telemetry.health:${gameIndex}:${late}`, [record])
    if (sent) await markDeliveryHealthSent(gameIndex)
    return sent
  } finally {
    inFlight.delete(gameIndex)
  }
}

export async function uploadLateTelemetryHealth(): Promise<boolean> {
  let any = false
  for (const { gameIndex, game, session } of await pendingDeliveryHealth()) {
    if (await sendTelemetryHealth(gameIndex, true, { game, session })) any = true
  }
  return any
}
