// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { useEffect, useRef, useState } from "react"
import { recordCount, recordDistribution } from "./telemetry"
import { armReconnectWindow, type ReconnectWindow } from "./reconnect-window"
import { shouldWaitForReconnect, type ChainHealthWhere, type RestartCardReason } from "./chain-health"
import { recordRestartCardShown } from "./chain-restart"

export function finishReconnectWindow(window: Pick<ReconnectWindow, "recover" | "cancel">, healthy: boolean): void {
  if (healthy) window.recover()
  else window.cancel()
}

/** Keep silent-host advice reassuring for one monotonic minute. Concrete host
 * errors and repeated failed app opens remain immediate restart advice, except
 * right after a return from the background (`since`, the card's
 * reconnectingSince): then any loss waits out the minute counted from the
 * return. */
export function useReconnectWindow(options: {
  visible: boolean
  reason: RestartCardReason | undefined
  consecutiveLost: number
  healthy: boolean
  where: ChainHealthWhere
  /** the in-round bar: waits for a chain loss too, and persists no restart
   *  marker (its count is chain.restart_bar_shown) */
  surface?: "card" | "bar"
  /** when the page came back from the background, for a loss first seen
   * soon after it (ChainHealthCardState.reconnectingSince) */
  since?: number
}): boolean {
  const { visible, reason, consecutiveLost, healthy, where, surface = "card", since } = options
  const eligible = visible && shouldWaitForReconnect(reason, consecutiveLost, surface, since !== undefined)
  const [escalated, setEscalated] = useState(false)
  const windowRef = useRef<ReconnectWindow | null>(null)
  const wasEligibleRef = useRef(false)

  useEffect(() => {
    if (eligible && !wasEligibleRef.current) {
      setEscalated(false)
      recordCount("chain.reconnecting_shown", 1, {
        "chain.health.where": where,
        "chain.reconnecting_reason": reason!,
      })
      windowRef.current = armReconnectWindow({
        ...(since !== undefined ? { startedAtMs: since } : {}),
        onEscalate: () => {
          setEscalated(true)
          if (surface === "card") void recordRestartCardShown(where).catch(() => undefined)
          recordCount("chain.reconnecting_escalated", 1, {
            "chain.health.where": where,
            "chain.reconnecting_reason": reason!,
          })
        },
        onRecover: (elapsedMs) => {
          recordDistribution("chain.reconnecting_recovered_ms", elapsedMs, "millisecond", {
            "chain.health.where": where,
            "chain.reconnecting_reason": reason!,
          })
        },
      })
    } else if (!eligible && wasEligibleRef.current) {
      if (windowRef.current) finishReconnectWindow(windowRef.current, healthy)
      windowRef.current = null
      setEscalated(false)
    }
    wasEligibleRef.current = eligible
  }, [eligible, healthy, reason, where, surface, since])

  useEffect(
    () => () => {
      windowRef.current?.cancel()
      windowRef.current = null
      wasEligibleRef.current = false
    },
    [],
  )

  return eligible && !escalated
}
