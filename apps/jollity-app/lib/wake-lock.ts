// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
/**
 * Keep the screen awake while a game is pending or running.
 *
 * A phone left on the waiting room goes to sleep, and the Polkadot app's host
 * loses its chain connection and its bridge to us with it (the bridge port
 * has been seen to close minutes before kickoff; reconnecting is the host's
 * job). The Screen Wake Lock API stops the display from
 * dimming while we are in the foreground — the one case where the player IS
 * waiting on us. It is best-effort: an older WebView without the API, or a
 * denied request, changes nothing. The lock is released by the platform when
 * the page is hidden, so it is re-requested when the page comes back.
 */
import { useEffect } from "react"
import { devLog } from "./debug/log-store"

type WakeLockNavigator = Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> } }

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined") return
    const wakeLock = (navigator as WakeLockNavigator).wakeLock
    if (!wakeLock) {
      devLog("wake", "screen wake lock unavailable on this WebView")
      return
    }
    let sentinel: WakeLockSentinel | null = null
    let stopped = false
    const request = async () => {
      if (stopped || document.visibilityState !== "visible") return
      try {
        sentinel = await wakeLock.request("screen")
        devLog("wake", "screen wake lock acquired")
        sentinel.addEventListener("release", () => devLog("wake", "screen wake lock released"))
      } catch (error) {
        devLog("wake", "screen wake lock refused", { detail: String(error) }, "warn")
      }
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") void request()
    }
    void request()
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      stopped = true
      document.removeEventListener("visibilitychange", onVisible)
      void sentinel?.release().catch(() => {})
    }
  }, [active])
}
