// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The host's platform, for the update screen's instruction. Read only once
 * the build is known to be old (when the screen could show), through the host-info
 * doorway; "other" until it answers and whenever it cannot.
 */
import { useEffect, useState } from "react"
import { readHostInfo } from "../host/host-info"
import { updatePlatform, type UpdatePlatform } from "./update-copy"

export function useUpdatePlatform(needed: boolean): UpdatePlatform {
  const [platform, setPlatform] = useState<UpdatePlatform>("other")
  useEffect(() => {
    if (!needed) return
    let cancelled = false
    void readHostInfo().then((info) => {
      if (!cancelled) setPlatform(updatePlatform(info?.platform))
    })
    return () => {
      cancelled = true
    }
  }, [needed])
  return platform
}
