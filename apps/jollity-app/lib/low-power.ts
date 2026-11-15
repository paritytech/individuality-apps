// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Low power mode: a lighter game path for slow phones. It is one on/off mode.
 * It lives in memory only, so a reload shows the full app again.
 * `?lowpower=1` turns the mode on for one load, in every build, so a support
 * or test link can start a phone the device check misjudged in it. Nothing in
 * the app builds that link.
 */
import { useSyncExternalStore } from "react"
import { devLog } from "./debug/log-store"
import { setLowPowerTags } from "./telemetry"

/**
 * Why the mode came on, the one value the `lowpower.reason` tag carries:
 * probe-weak and probe-weak-confirmed (the device check, by the rule that
 * decided), probe-no-verdict (the device check could not measure the device),
 * debug-menu (the switch in the debug sheet), url (?lowpower=1), manual (any
 * other caller that names no reason). Off reads "none".
 */
export type LowPowerReason = "probe-weak" | "probe-weak-confirmed" | "probe-no-verdict" | "debug-menu" | "url" | "manual"

let lowPower = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("lowpower") === "1"
let reason: LowPowerReason | "none" = lowPower ? "url" : "none"
if (lowPower) setLowPowerTags({ lowpower: true, reason })
const listeners = new Set<() => void>()

export function subscribeLowPower(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLowPower(): boolean {
  return lowPower
}

/** why the mode is on now, or "none" */
export function getLowPowerReason(): LowPowerReason | "none" {
  return reason
}

export function setLowPower(on: boolean, why: LowPowerReason = "manual"): void {
  if (on === lowPower) return
  lowPower = on
  reason = on ? why : "none"
  setLowPowerTags({ lowpower: on, reason })
  devLog("low-power", on ? `low power on (${why})` : "low power off")
  for (const listener of listeners) listener()
}

const serverLowPower = () => false

export function useLowPower(): boolean {
  return useSyncExternalStore(subscribeLowPower, getLowPower, serverLowPower)
}
