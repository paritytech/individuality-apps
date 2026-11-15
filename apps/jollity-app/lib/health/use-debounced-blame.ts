// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The connection blame that a screen may show, or null.
 *
 * DEBOUNCED both ways, 4s on / 1s off — the same shape `game-session.ts` uses
 * for `troubled`. A round transition briefly tears down and rebuilds the mesh,
 * and a notice that flashed on every rotation would be noise a player learns to
 * ignore, which is worse than no notice at all.
 */
import { useEffect, useState } from "react"
import type { LadderVerdict } from "@jollity/statement-core"
import { noticeBlame } from "./notice"

const SHOW_AFTER_MS = 4_000
const HIDE_AFTER_MS = 1_000

export function useDebouncedBlame(
  verdict: LadderVerdict | null,
  hostAnswering: boolean,
  noUsablePath: boolean,
): ReturnType<typeof noticeBlame> {
  // A missing relay is only the player's network after the host has proved it
  // can answer. Before that, restart-first owns the diagnosis.
  const blame = noticeBlame(verdict, hostAnswering, noUsablePath)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setShown(blame !== null), blame ? SHOW_AFTER_MS : HIDE_AFTER_MS)
    return () => clearTimeout(timer)
    // Safe to depend on the object: `useMesh` only calls setVerdict when the
    // ladder's SHAPE changes, so this is not a fresh object every second. If
    // that gate is ever removed, this effect restarts its timer on every tick
    // and the notice never appears — the debounce would silently swallow it.
  }, [blame])

  return shown ? blame : null
}
