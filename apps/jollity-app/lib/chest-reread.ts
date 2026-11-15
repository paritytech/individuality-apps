// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A chest read already made three bounded attempts. Keep asking slowly while
 * the shared host-health verdict is still undecided: 30 s, 60 s, then every
 * two minutes. A foreground return asks at once. The caller cancels this as
 * soon as the host counts as stuck, so this never becomes a loop against a
 * host that can recover only through an app restart.
 */

export const CHEST_REREAD_FIRST_MS = 30_000
export const CHEST_REREAD_SECOND_MS = 60_000
export const CHEST_REREAD_CAP_MS = 120_000

export type ChestRestartState = "loading" | "retrying" | "ready" | "settled"
export type ChestStallReason = "host-unanswered" | "chain-lost" | "read-unanswered" | undefined

/** A restart is a recovery for a host that stopped answering, never a
 * replacement for a chest already on screen or for a non-host read failure. */
export function chestRestartVisible(
  state: ChestRestartState,
  sharedHostStuck: boolean,
  stall: ChestStallReason,
): boolean {
  if (state !== "loading" && state !== "retrying") return false
  return sharedHostStuck || stall === "host-unanswered" || stall === "chain-lost"
}

export function chestRereadDelayMs(failedRereads: number): number {
  if (failedRereads <= 0) return CHEST_REREAD_FIRST_MS
  if (failedRereads === 1) return CHEST_REREAD_SECOND_MS
  return CHEST_REREAD_CAP_MS
}

export interface ChestRereadState {
  phase: "idle" | "waiting" | "reading" | "stopped"
  failedRereads: number
  due: boolean
  timerHeld: boolean
}

export type ChestRereadEvent =
  | { kind: "start" }
  | { kind: "trigger"; hidden: boolean }
  | { kind: "read-finished"; recovered: boolean; hidden: boolean }
  | { kind: "stop" }

export type ChestRereadCommand =
  | { kind: "schedule"; delayMs: number }
  | { kind: "clear-timer" }
  | { kind: "reread" }
  | { kind: "unsubscribe" }

export function createChestRereadState(): ChestRereadState {
  return { phase: "idle", failedRereads: 0, due: false, timerHeld: false }
}

/** Pure policy for the slow reread loop. Visibility and promise completion
 * arrive as events; the browser work leaves as commands for armChestRereads. */
export function chestRereadStep(
  previous: ChestRereadState,
  event: ChestRereadEvent,
): { state: ChestRereadState; commands: ChestRereadCommand[] } {
  const unchanged = { state: previous, commands: [] as ChestRereadCommand[] }
  if (event.kind === "stop") {
    if (previous.phase === "stopped") return unchanged
    return {
      state: { ...previous, phase: "stopped", due: false, timerHeld: false },
      commands: [...(previous.timerHeld ? [{ kind: "clear-timer" } as const] : []), { kind: "unsubscribe" }],
    }
  }
  if (previous.phase === "stopped") return unchanged
  if (event.kind === "start") {
    if (previous.phase !== "idle") return unchanged
    return {
      state: { ...previous, phase: "waiting", timerHeld: true },
      commands: [{ kind: "schedule", delayMs: chestRereadDelayMs(previous.failedRereads) }],
    }
  }
  if (event.kind === "read-finished") {
    if (previous.phase !== "reading") return unchanged
    if (event.recovered) {
      return { state: { ...previous, phase: "waiting", due: false }, commands: [] }
    }
    const failedRereads = previous.failedRereads + 1
    if (previous.due && !event.hidden) {
      return {
        state: { ...previous, failedRereads, due: false },
        commands: [{ kind: "reread" }],
      }
    }
    return {
      state: { ...previous, phase: "waiting", failedRereads, timerHeld: true },
      commands: [{ kind: "schedule", delayMs: chestRereadDelayMs(failedRereads) }],
    }
  }

  if (previous.phase === "idle") return unchanged
  if (event.hidden || previous.phase === "reading") {
    return { state: { ...previous, due: true }, commands: [] }
  }
  return {
    state: { ...previous, phase: "reading", due: false, timerHeld: false },
    commands: [...(previous.timerHeld ? [{ kind: "clear-timer" } as const] : []), { kind: "reread" }],
  }
}

export function armChestRereads(options: {
  /** true once the re-read found a renderable chest result */
  reread: () => Promise<boolean>
  hidden: () => boolean
  /** subscribe to the page returning to the foreground */
  onShown: (listener: () => void) => () => void
}): () => void {
  const { reread, hidden, onShown } = options
  let state = createChestRereadState()
  let timer: ReturnType<typeof setTimeout> | undefined

  const dispatch = (event: ChestRereadEvent): void => {
    const result = chestRereadStep(state, event)
    state = result.state
    for (const command of result.commands) {
      if (command.kind === "schedule") {
        timer = setTimeout(() => dispatch({ kind: "trigger", hidden: hidden() }), command.delayMs)
      } else if (command.kind === "clear-timer") {
        clearTimeout(timer)
        timer = undefined
      } else if (command.kind === "reread") {
        try {
          void reread().then(
            (recovered) => dispatch({ kind: "read-finished", recovered, hidden: hidden() }),
            () => dispatch({ kind: "read-finished", recovered: false, hidden: hidden() }),
          )
        } catch {
          dispatch({ kind: "read-finished", recovered: false, hidden: hidden() })
        }
      } else {
        unsubscribe()
      }
    }
  }

  const unsubscribe = onShown(() => {
    if (hidden()) return
    dispatch({ kind: "trigger", hidden: false })
  })
  dispatch({ kind: "start" })
  return () => dispatch({ kind: "stop" })
}
