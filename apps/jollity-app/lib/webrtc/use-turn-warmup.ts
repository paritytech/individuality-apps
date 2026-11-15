// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { useEffect } from "react"
import { devLog } from "../debug/log-store"
import { retryableNetworkChange, watchNetwork } from "../journeys/net-changes"
import { retryIceServers, setTurnPlayerAccount, warmIceServers } from "./ice"

const NETWORK_DEBOUNCE_MS = 750
const REFRESH_BEFORE_GAME_S = [10 * 60, 3 * 60]

export function warmupRefreshDelays(gameAt: number, nowMs = Date.now()): number[] {
  return REFRESH_BEFORE_GAME_S
    .map((beforeS) => (gameAt - beforeS) * 1000 - nowMs)
    .filter((delayMs) => delayMs > 0)
}

/** A pre-game warm-up belongs to the same playing account as the later mesh.
 * Bind it first so issued credentials can be restored after a WebView relaunch. */
export async function warmPlayerIceServers(
  account: Uint8Array | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!account) return
  setTurnPlayerAccount(account)
  await warmIceServers(signal)
}

/** Fetch relay credentials as soon as a registered game is known. This is
 * deliberately independent of the permission gate so returning players warm
 * up too. While the waiting room is open, only a real path transition gets a
 * second attempt; there is no timer loop against a stuck host. */
export function useTurnWarmup(
  enabled: boolean,
  gameAt: number | undefined,
  account: Uint8Array | undefined,
): void {
  useEffect(() => {
    if (!enabled || gameAt === undefined || !account) return
    const abort = new AbortController()
    void warmPlayerIceServers(account, abort.signal)
    let timer: ReturnType<typeof setTimeout> | undefined
    const refreshTimers = warmupRefreshDelays(gameAt).map((delayMs) =>
      setTimeout(() => void warmPlayerIceServers(account, abort.signal), delayMs),
    )
    const stop = watchNetwork((change) => {
      if (!retryableNetworkChange(change)) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        devLog("rtc", "registered-player network changed: refreshing TURN", change.attrs, "warn")
        void retryIceServers(abort.signal)
      }, NETWORK_DEBOUNCE_MS)
    })
    return () => {
      abort.abort()
      if (timer !== undefined) clearTimeout(timer)
      for (const refreshTimer of refreshTimers) clearTimeout(refreshTimer)
      stop()
    }
  }, [enabled, gameAt, account])
}
