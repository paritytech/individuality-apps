// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { useEffect, useState } from "react"
import { homeSourceResolved } from "./journeys/home-first-status"
import { getGameSource, type GameSource, type GameStatus } from "./game-source"

export function useGameStatus(): {
  status: GameStatus
  source: GameSource | undefined
  /** resolved to "no host environment and no dev override" — show the gate */
  hostOnly: boolean
  /** the source's game clock, unix seconds — use for countdowns */
  now: number
} {
  const [status, setStatus] = useState<GameStatus>({ kind: "loading" })
  const [source, setSource] = useState<GameSource>()
  const [hostOnly, setHostOnly] = useState(false)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void getGameSource().then((resolved) => {
      if (cancelled) return
      if (!resolved) {
        setHostOnly(true)
        return
      }
      homeSourceResolved()
      setSource(resolved)
      stop = resolved.watchStatus(setStatus)
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])

  useEffect(() => {
    const tick = () => setNow(source ? source.nowSeconds() : Math.floor(Date.now() / 1000))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [source])

  return { status, source, hostOnly, now }
}

