// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import { useEffect, useState } from "react"

/**
 * A boolean that follows `value` only once it has held for a while: `onMs` to
 * turn on, `offMs` to turn off. A flag that flaps for a tick (a link that
 * blinks through a round change) never reaches the screen.
 */
export function useDebounced(value: boolean, onMs: number, offMs = onMs): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShown(value), value ? onMs : offMs)
    return () => clearTimeout(timer)
  }, [value, onMs, offMs])
  return shown
}

/**
 * `useDebounced` for a flag that belongs to one thing (`key`): a reading taken
 * for one key never shows under the next. A new key starts from its own value
 * at once, and only its later changes wait out `onMs` / `offMs`.
 */
export function useDebouncedFor(key: string | null, value: boolean, onMs: number, offMs = onMs): boolean {
  const [held, setHeld] = useState({ key, shown: value })
  if (held.key !== key) setHeld({ key, shown: value })
  useEffect(() => {
    const timer = setTimeout(() => setHeld((h) => (h.key === key ? { key, shown: value } : h)), value ? onMs : offMs)
    return () => clearTimeout(timer)
  }, [key, value, onMs, offMs])
  return held.key === key ? held.shown : value
}
