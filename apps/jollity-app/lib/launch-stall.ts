// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The bound on the home's bare "Jollity" title (#530). Armed while the home
 * is on "loading". After LAUNCH_STALL_MS it asks the question again:
 *
 * - no game source yet: the host never answered (host-unanswered);
 * - a source: re-run the chain-health probe ("open"). Lost or unanswered
 *   only a host that says its chain is lost stalls at once; anything else
 *   (healthy, declined, unknown, no probe, a throw) gets LAUNCH_STALL_GRACE_MS
 *   more, then stalls too (read-unanswered). The wall-clock read retries in
 *   lib/game-source keep running meanwhile, and the stall clears itself the
 *   moment a status lands.
 *
 * A stall is what puts the restart card on screen instead of the bare title,
 * so the page never waits on a dead host for good. Framework-free: the hook
 * (lib/use-launch-stall) only arms and cancels it.
 */
import type { ChainHealthResult } from "./chain-health"

export const LAUNCH_STALL_MS = 15_000
export const LAUNCH_STALL_GRACE_MS = 30_000

export type LaunchStall = "host-unanswered" | "chain-lost" | "read-unanswered"

export interface LaunchStallState {
  phase: "armed" | "probing" | "grace" | "stalled" | "cancelled"
}

export type LaunchStallEvent =
  | { kind: "initial-deadline"; hasSource: boolean }
  | { kind: "probe-finished"; result: ChainHealthResult | undefined }
  | { kind: "grace-deadline" }
  | { kind: "cancel" }

export type LaunchStallCommand =
  | { kind: "probe" }
  | { kind: "arm-grace"; ms: number }
  | { kind: "stall"; reason: LaunchStall }

export function startLaunchStall(): LaunchStallState {
  return { phase: "armed" }
}

/** Pure launch-stall decisions. Timer and probe effects stay in the host. */
export function launchStallStep(
  state: LaunchStallState,
  event: LaunchStallEvent,
): { state: LaunchStallState; commands: LaunchStallCommand[] } {
  const stay = { state, commands: [] as LaunchStallCommand[] }
  if (state.phase === "cancelled" || state.phase === "stalled") return stay
  if (event.kind === "cancel") return { state: { phase: "cancelled" }, commands: [] }
  if (event.kind === "initial-deadline") {
    if (state.phase !== "armed") return stay
    if (!event.hasSource)
      return { state: { phase: "stalled" }, commands: [{ kind: "stall", reason: "host-unanswered" }] }
    return { state: { phase: "probing" }, commands: [{ kind: "probe" }] }
  }
  if (event.kind === "probe-finished") {
    if (state.phase !== "probing") return stay
    if (event.result?.outcome === "host-chain-lost") {
      const reason = event.result.errorClass === "timeout" ? "host-unanswered" : "chain-lost"
      return { state: { phase: "stalled" }, commands: [{ kind: "stall", reason }] }
    }
    return { state: { phase: "grace" }, commands: [{ kind: "arm-grace", ms: LAUNCH_STALL_GRACE_MS }] }
  }
  if (state.phase !== "grace") return stay
  return { state: { phase: "stalled" }, commands: [{ kind: "stall", reason: "read-unanswered" }] }
}

export function armLaunchStall(options: {
  hasSource: () => boolean
  probe: () => Promise<ChainHealthResult | undefined>
  onStall: (reason: LaunchStall) => void
}): () => void {
  const { hasSource, probe, onStall } = options
  let state = startLaunchStall()
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const run = (command: LaunchStallCommand): void => {
    if (command.kind === "stall") onStall(command.reason)
    else if (command.kind === "arm-grace") graceTimer = setTimeout(() => dispatch({ kind: "grace-deadline" }), command.ms)
    else {
      probe()
        .catch(() => undefined)
        .then((result) => dispatch({ kind: "probe-finished", result }))
    }
  }
  const dispatch = (event: LaunchStallEvent): void => {
    const next = launchStallStep(state, event)
    state = next.state
    next.commands.forEach(run)
  }
  const timer = setTimeout(() => {
    dispatch({ kind: "initial-deadline", hasSource: hasSource() })
  }, LAUNCH_STALL_MS)
  return () => {
    dispatch({ kind: "cancel" })
    clearTimeout(timer)
    clearTimeout(graceTimer)
  }
}
