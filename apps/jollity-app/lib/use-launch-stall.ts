// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { useEffect, useState } from "react"
import { armLaunchStall, type LaunchStall } from "./launch-stall"
import type { ChainHealthResult, ChainHealthWhere } from "./chain-health"

/** The reason the home has waited too long on "loading" (lib/launch-stall),
 *  or undefined. It clears the moment loading ends. */
export function useLaunchStall(options: {
  loading: boolean
  hasSource: boolean
  probe: (where: ChainHealthWhere) => Promise<ChainHealthResult | undefined>
  /** Keep a fired restart verdict until this screen remounts. */
  latch?: boolean
}): LaunchStall | undefined {
  const { loading, hasSource, probe, latch = false } = options
  const [stall, setStall] = useState<LaunchStall>()
  useEffect(() => {
    if (!loading) return
    const cancel = armLaunchStall({ hasSource: () => hasSource, probe: () => probe("open"), onStall: setStall })
    return () => {
      cancel()
      if (!latch) setStall(undefined)
    }
  }, [loading, hasSource, probe, latch])
  return latch || loading ? stall : undefined
}
