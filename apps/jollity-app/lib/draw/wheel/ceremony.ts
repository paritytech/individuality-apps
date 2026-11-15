// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export type DrawCeremonyFallbackReason = "none" | "load-failed" | "mount-failed" | "never-ended"

export interface DrawCeremonyEvidence {
  totalMs: number
  loadMs: number
  endingMs: number
  continueVisibleMs: number
  hiddenMs: number
  ended: boolean
  tapped: boolean
  /** the page moved on by itself after DRAW_IDLE_MS (lib/draw/draw-idle), not by a tap */
  idleAdvanced: boolean
  fallbackReason: DrawCeremonyFallbackReason
  /** where the stage's story stood when it was given up on (never-ended) */
  stall?: Record<string, string | number | boolean | null>
}

type Level = "info" | "warn"

interface Options {
  now?: () => number
  devLog: (message: string, data?: unknown, level?: Level) => void
  report: (evidence: DrawCeremonyEvidence) => void
}

/**
 * The host-side lifecycle for one wheel. It deliberately survives React's
 * development StrictMode effect replay: every milestone, report and tap is
 * idempotent, while the actual WebGL stage may be mounted again.
 */
export function createDrawCeremony(options: Options) {
  const now = options.now ?? Date.now
  const startedAt = now()
  let loadAt: number | null = null
  let mountedAt: number | null = null
  let endedAt: number | null = null
  let continueAt: number | null = null
  let hiddenAt: number | null = null
  let hiddenMs = 0
  let tapped = false
  let stall: DrawCeremonyEvidence["stall"]
  let idleAdvanced = false
  let navigated = false
  let reported = false
  let fallbackReason: DrawCeremonyFallbackReason = "none"

  const elapsed = (from: number | null, to: number): number => (from === null ? -1 : Math.max(0, to - from))
  const evidence = (at: number): DrawCeremonyEvidence => ({
    totalMs: Math.max(0, at - startedAt),
    loadMs: elapsed(loadAt, mountedAt ?? at),
    endingMs: elapsed(mountedAt, endedAt ?? at),
    continueVisibleMs: elapsed(continueAt, at),
    hiddenMs: hiddenMs + (hiddenAt === null ? 0 : Math.max(0, at - hiddenAt)),
    ended: endedAt !== null,
    tapped,
    idleAdvanced,
    fallbackReason,
    ...(stall ? { stall } : {}),
  })
  const reportOnce = (at: number): boolean => {
    if (reported) return false
    reported = true
    options.report(evidence(at))
    return true
  }

  return {
    /** the watch ran out: the page moves on. True once, as `tap` is. */
    idleAdvance(): boolean {
      if (navigated) return false
      navigated = true
      idleAdvanced = true
      options.devLog("wheel idle; moving on to the chest", { elapsedMs: now() - startedAt })
      reportOnce(now())
      return true
    },
    loadStarted(): void {
      if (loadAt !== null) return
      loadAt = now()
      options.devLog("wheel ceremony load started", { elapsedMs: loadAt - startedAt })
    },
    mounted(): void {
      if (mountedAt !== null) return
      mountedAt = now()
      options.devLog("wheel stage mounted", { elapsedMs: mountedAt - startedAt, loadMs: elapsed(loadAt, mountedAt) })
    },
    ended(): boolean {
      if (continueAt !== null) return false
      endedAt = now()
      continueAt = endedAt
      options.devLog("wheel ended; Continue visible", {
        elapsedMs: endedAt - startedAt,
        endingMs: elapsed(mountedAt, endedAt),
      })
      return true
    },
    fallback(
      reason: Exclude<DrawCeremonyFallbackReason, "none">,
      detail?: string,
      progress?: DrawCeremonyEvidence["stall"],
    ): boolean {
      if (continueAt !== null) return false
      const at = now()
      fallbackReason = reason
      continueAt = at
      stall = progress
      options.devLog(
        "wheel fallback; Continue visible",
        { elapsedMs: at - startedAt, reason, ...(detail ? { detail } : {}), ...(progress ? { progress } : {}) },
        "warn",
      )
      return true
    },
    hidden(): void {
      if (hiddenAt !== null) return
      hiddenAt = now()
      options.devLog("wheel page hidden", { elapsedMs: hiddenAt - startedAt, continueVisible: continueAt !== null })
    },
    resumed(): void {
      if (hiddenAt === null) return
      const at = now()
      hiddenMs += Math.max(0, at - hiddenAt)
      hiddenAt = null
      options.devLog("wheel page resumed", { elapsedMs: at - startedAt, hiddenMs })
    },
    leave(): void {
      const at = now()
      if (reported) return
      options.devLog("wheel page left", { elapsedMs: at - startedAt, continueVisible: continueAt !== null })
      reportOnce(at)
    },
    tap(): boolean {
      if (navigated || continueAt === null) return false
      const at = now()
      navigated = true
      tapped = true
      options.devLog("wheel Continue tapped", {
        elapsedMs: at - startedAt,
        continueVisibleMs: elapsed(continueAt, at),
        fallbackReason,
      })
      reportOnce(at)
      return true
    },
    snapshot(): DrawCeremonyEvidence {
      return evidence(now())
    },
  }
}
