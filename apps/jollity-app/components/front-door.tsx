// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The root layout's front door (lib/front-door.ts): a page load that reaches
 * a game page before home has been on screen draws nothing and goes home,
 * which sends it on once its gates have run.
 *
 * The prerender and the hydration render of a game page draw nothing either,
 * so none of its effects (the game session, the chest's reads, the draw's
 * claim) start for a load that is sent away.
 */
import { useEffect, useSyncExternalStore, type ReactNode } from "react"
import { usePathname, useRouter } from "next/navigation"
import { devLog } from "@/lib/debug/log-store"
import { behindHome, dropArrival, frontDoorHolds, frontDoorOpen, holdArrival, watchFrontDoor } from "@/lib/front-door"
import { recordCount } from "@/lib/telemetry/metrics"

const openNow = frontDoorOpen
const closedOnServer = () => false

export function FrontDoor({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const open = useSyncExternalStore(watchFrontDoor, openNow, closedOnServer)
  useEffect(() => {
    if (!behindHome(pathname)) return
    // the door itself, not the render: the hydration render drew nothing
    // either way. Open, the load has arrived where it was going.
    if (openNow()) return dropArrival()
    const href = `${pathname}${window.location.search}`
    devLog("front-door", "a page load came in past home — home first", { href })
    recordCount("app.front_door_held", 1, { "app.route": pathname })
    holdArrival(href)
    router.replace("/")
  }, [pathname, router])
  return frontDoorHolds(pathname, open) ? null : children
}
