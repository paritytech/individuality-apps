// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { useEffect, useState } from "react"
import { devLog } from "../debug/log-store"
import { retryableNetworkChange, watchNetwork } from "../journeys/net-changes"
import { fetchIceServers, retryIceServers } from "./ice"
import { lastPathProbe, observePathProbe, probePath, type PathProbe } from "./path-mode"

/** a probe older than this is taken again when the game opens */
const PROBE_FRESH_MS = 5 * 60_000

/**
 * THE PATH THIS PHONE TAKES in the game (path-mode.ts): the waiting room's
 * probe when it is fresh, else one taken now, and again on every network
 * change. `checking` while a probe runs, for the waiting room's status line.
 */
export function usePathMode(active: boolean): { probe: PathProbe | null; checking: boolean } {
  const [probe, setProbe] = useState<PathProbe | null>(() => lastPathProbe())
  const [checking, setChecking] = useState(false)
  useEffect(() => observePathProbe(setProbe), [])
  useEffect(() => {
    if (!active) return
    let controller: AbortController | undefined
    const run = async (networkChanged: boolean) => {
      controller?.abort()
      const mine = (controller = new AbortController())
      setChecking(true)
      try {
        const iceServers = networkChanged ? await retryIceServers(mine.signal) : await fetchIceServers(mine.signal, "warmup")
        if (mine.signal.aborted) return
        const result = await probePath({ iceServers, signal: mine.signal })
        if (mine.signal.aborted) return
        devLog("rtc", `path probe: ${result.mode}`, { trigger: networkChanged ? "network-change" : "game", nat: result.nat, udp: result.udp, relay: result.relayProtocols.join(","), gatherMs: result.gatherMs }, result.mode === "blocked" ? "warn" : undefined)
      } finally {
        if (controller === mine) setChecking(false)
      }
    }
    const fresh = lastPathProbe()
    if (!fresh || Date.now() - fresh.at > PROBE_FRESH_MS) void run(false)
    const stop = watchNetwork((change) => {
      if (retryableNetworkChange(change)) void run(true)
    })
    return () => {
      controller?.abort()
      stop()
    }
  }, [active])
  return { probe, checking }
}
