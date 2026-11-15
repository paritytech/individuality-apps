// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { devLog } from "../debug/log-store"
import { handoverAt } from "../joined"
import { retryableNetworkChange, watchNetwork } from "../journeys/net-changes"
import { waitingNetworkCheckSpan } from "../telemetry"
import { fetchIceServers } from "./ice"
import {
  retainWaitingNetworkDecision,
  runWaitingNetworkCheck,
  type WaitingNetworkCheckResult,
} from "./waiting-network-check"
import { probePath } from "./path-mode"

type CheckTrigger = "initial" | "network-change" | "foreground" | "pre-handover"

/** Two five-second attempts finish just before the waiting-room handover. */
const PRE_HANDOVER_CHECK_LEAD_S = 15

export function useWaitingNetworkCheck(options: {
  enabled: boolean
  hostAnswering: boolean
  gameAt?: number
  nowSeconds?: () => number
}): { result: WaitingNetworkCheckResult; done: boolean } {
  const { enabled, hostAnswering, gameAt } = options
  const nowSecondsRef = useRef(options.nowSeconds)
  const activation = useMemo(() => ({ enabled, hostAnswering, gameAt }), [enabled, hostAnswering, gameAt])
  const [outcome, setOutcome] = useState<{ activation: object; gameAt: number; result: WaitingNetworkCheckResult }>()

  useEffect(() => {
    nowSecondsRef.current = options.nowSeconds
  }, [options.nowSeconds])

  useEffect(() => {
    if (!enabled || !hostAnswering || gameAt === undefined) return
    let stopped = false
    let running = false
    let pendingTrigger: CheckTrigger | undefined
    let activeTrigger: CheckTrigger | undefined
    let controller: AbortController | undefined
    let preHandoverTimer: ReturnType<typeof setTimeout> | undefined
    let preHandoverRan = false

    const defer = (trigger: CheckTrigger) => {
      const priority: Record<CheckTrigger, number> = { initial: 0, "network-change": 1, foreground: 2, "pre-handover": 3 }
      if (pendingTrigger === undefined || priority[trigger] >= priority[pendingTrigger]) pendingTrigger = trigger
    }
    const run = async (trigger: CheckTrigger) => {
      if (stopped) return
      if (document.hidden) {
        defer(trigger)
        return
      }
      if (running) {
        defer(trigger)
        controller?.abort()
        return
      }
      running = true
      activeTrigger = trigger
      controller = new AbortController()
      setOutcome((current) =>
        current?.gameAt === gameAt && current.result === "runtime-stalled" ? current : undefined,
      )
      try {
        const iceServers = await fetchIceServers(controller.signal, trigger === "initial" ? "warmup" : "network-change")
        if (controller.signal.aborted || stopped) return
        const evidence = await runWaitingNetworkCheck({ iceServers, signal: controller.signal })
        if (stopped || evidence.result === "cancelled") return
        setOutcome((current) =>
          retainWaitingNetworkDecision(current, { activation, gameAt, result: evidence.result }),
        )
        const nowSeconds = nowSecondsRef.current?.()
        const leadTimeS = nowSeconds === undefined ? undefined : Math.max(0, gameAt - nowSeconds)
        waitingNetworkCheckSpan({ ...evidence, trigger, leadTimeS })
        devLog("rtc", `waiting-room network check: ${evidence.result}`, {
          trigger,
          gathered: `${evidence.counts.host}/${evidence.counts.srflx}/${evidence.counts.relay}`,
          attempts: evidence.attempts,
          relayUnreachable: evidence.relayUnreachable,
          ...(leadTimeS === undefined ? {} : { leadTimeS }),
        }, evidence.result === "blocked" ? "warn" : undefined)
        // and which path the game's links will take (path-mode.ts): kept for
        // the page, so the mesh opens on it in the clock
        const probe = await probePath({ iceServers, signal: controller.signal })
        if (!stopped && !controller.signal.aborted)
          devLog("rtc", `path probe: ${probe.mode}`, { trigger, nat: probe.nat, udp: probe.udp, relay: probe.relayProtocols.join(","), gathered: `${probe.candidates.host}/${probe.candidates.srflx}/${probe.candidates.relay}`, gatherMs: probe.gatherMs })
      } finally {
        running = false
        activeTrigger = undefined
        controller = undefined
        if (!stopped && pendingTrigger && !document.hidden) {
          const deferred = pendingTrigger
          pendingTrigger = undefined
          void run(deferred)
        }
      }
    }
    const schedulePreHandover = () => {
      if (preHandoverRan) return
      if (preHandoverTimer !== undefined) clearTimeout(preHandoverTimer)
      const current = nowSecondsRef.current?.()
      if (current === undefined) return
      const delayMs = Math.max(0, (handoverAt(gameAt) - PRE_HANDOVER_CHECK_LEAD_S - current) * 1_000)
      preHandoverTimer = setTimeout(() => {
        preHandoverTimer = undefined
        preHandoverRan = true
        void run("pre-handover")
      }, delayMs)
    }
    const onVisibility = () => {
      if (document.hidden) {
        if (running && activeTrigger) {
          defer(activeTrigger)
          controller?.abort()
        }
      } else {
        defer("foreground")
        const deferred = pendingTrigger
        pendingTrigger = undefined
        if (deferred) void run(deferred)
        schedulePreHandover()
      }
    }
    document.addEventListener("visibilitychange", onVisibility)
    const stopNetwork = watchNetwork((change) => {
      if (!retryableNetworkChange(change)) return
      void run("network-change")
    })
    void run("initial")
    schedulePreHandover()
    return () => {
      stopped = true
      controller?.abort()
      if (preHandoverTimer !== undefined) clearTimeout(preHandoverTimer)
      document.removeEventListener("visibilitychange", onVisibility)
      stopNetwork()
    }
  }, [enabled, hostAnswering, gameAt, activation])

  const confirmedStall = outcome !== undefined && outcome.gameAt === gameAt && outcome.result === "runtime-stalled"
  const done = confirmedStall || (enabled && hostAnswering && outcome?.activation === activation)
  return { result: done && outcome ? outcome.result : "inconclusive", done }
}
