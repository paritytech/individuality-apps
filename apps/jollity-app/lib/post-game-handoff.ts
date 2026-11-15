// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The shared way out of a game route once the chain has closed reporting.
 *
 * `/game` and `/connection-help` can both outlive the playable game.  This
 * module keeps their answer identical: a counted report goes to the draw (or
 * straight to the chest when no draw was scheduled), while every final
 * non-report state goes to the chest.  Unknown/open reads wait; they are never
 * evidence that the player missed their report.
 */
import type { GameSource } from "./game-source"
import type { ReportStatus } from "./report-missed"
import { storedVotesGame } from "./game-votes"
import { hasJoined } from "./joined"
import { drawEntryPath, peekDrawSchedule } from "./draw/draw-schedule"
import { postGameIndex, rememberPostGame } from "./post-game"
import { markSeen } from "./worker-bridge"

export interface PostGameHandoff {
  gameIndex: number
  href: string
  report: ReportStatus["report"]
}

export function handoffFromStatus(status: ReportStatus): PostGameHandoff | null {
  if (!status.closed || status.gameIndex === undefined || status.report === "unknown") return null
  const gameIndex = status.gameIndex
  rememberPostGame(gameIndex)
  if (status.report === "sent") void markSeen(gameIndex, "report")
  const path = status.report === "sent"
    ? drawEntryPath(peekDrawSchedule(gameIndex))
    : "/chest"
  return { gameIndex, href: `${path}?game=${gameIndex}`, report: status.report }
}

/** Find the game this device actually entered without mistaking an unrelated
 * current game for its own.  A joined current game supersedes older session
 * memory; otherwise the remembered handoff and retained vote book remain the
 * fallbacks. */
export async function playedGameIndex(
  source: GameSource,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const remembered = postGameIndex()
  const current = await source.reportStatus().catch(() => null)
  if (signal?.aborted) return undefined
  if (
    current?.gameIndex !== undefined &&
    current.gameDate !== undefined &&
    hasJoined(current.gameDate)
  ) return remembered !== undefined && remembered >= current.gameIndex
      ? remembered
      : current.gameIndex
  if (remembered !== undefined) return remembered
  if (!source.player) return undefined
  const stored = await storedVotesGame(source.player).catch(() => undefined)
  return signal?.aborted ? undefined : stored
}

/** One read.  Null means the game is unresolved, still open, or its report
 * row is temporarily unknown. */
export async function resolvePostGameHandoff(
  source: GameSource,
  options: { gameIndex?: number; signal?: AbortSignal } = {},
): Promise<PostGameHandoff | null> {
  const gameIndex = options.gameIndex ?? await playedGameIndex(source, options.signal)
  if (options.signal?.aborted || gameIndex === undefined) return null
  const status = await source.reportStatus(gameIndex).catch(() => null)
  if (options.signal?.aborted || !status) return null
  return handoffFromStatus(status)
}

function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), ms)
    const abort = () => finish(false)
    const finish = (completed: boolean) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      resolve(completed)
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

/** Keep the help page attached to the game until the chain settles it.
 *
 * The game is re-picked on every poll until one is found, then held: the pick
 * can come back empty on the first read alone (a reload with no session
 * storage, a current read that failed, no book), and picking once would end
 * the watch there and leave the player on the help page for good. Once
 * picked, the game never changes under the watch. */
export async function waitForPostGameHandoff(
  source: GameSource,
  options: { signal: AbortSignal; pollMs?: number },
): Promise<PostGameHandoff | null> {
  const pollMs = options.pollMs ?? 1_000
  let gameIndex: number | undefined
  while (!options.signal.aborted) {
    gameIndex ??= await playedGameIndex(source, options.signal)
    if (options.signal.aborted) return null
    if (gameIndex !== undefined) {
      const handoff = await resolvePostGameHandoff(source, { gameIndex, signal: options.signal })
      if (handoff) return handoff
    }
    if (!(await delay(pollMs, options.signal))) return null
  }
  return null
}

/** The tap's decision, made AFTER its own read returns. `handedOff` is read
 * again here, never only before the await: the watcher can hand off while the
 * read is in flight, and routing /game then would replace the chest it already
 * opened with an extra hop. Null means: another writer already routed, so
 * this tap does nothing. */
export async function tapDestination(
  source: GameSource | null,
  handedOff: () => boolean,
): Promise<PostGameHandoff | "/game" | null> {
  const handoff = source ? await resolvePostGameHandoff(source) : null
  if (handedOff()) return null
  return handoff ?? "/game"
}
