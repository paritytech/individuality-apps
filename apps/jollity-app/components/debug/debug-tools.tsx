// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * Mounts the debug affordance: the summon gestures (useDebugSheet) and the
 * sheet they open. Rendered once, from DebugBoot, only when DEBUG_LOGS is on.
 */
import { DEBUG_LOGS } from "@/lib/debug/flag"
import { useDebugSheet } from "./use-debug-sheet"
import { DebugSheet } from "./debug-sheet"

export function DebugTools() {
  const { open, setOpen } = useDebugSheet()
  if (!DEBUG_LOGS) return null
  return open ? <DebugSheet onClose={() => setOpen(false)} /> : null
}
