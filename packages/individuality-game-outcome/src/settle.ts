// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE SETTLE: the chain has finished a game once `Game.Game` is empty, or
 * already holds a later game. Some of what a game gave waits for it (the
 * attendance credits of a player whose verdict the votes left open, the score
 * of one decided only then); much does not (./attendance-watch.ts, ./before-settle.ts).
 *
 * A game with a player who signed up and never played settles only when its
 * report window closes: in one measured game that was seven and a half
 * minutes after the last turn.
 */
import type { GameSlot } from "./attendance-rule"

/** It is about twice the slowest healthy settle: the report window closes
 *  about 35 seconds after the last turn, and the pallet then processes the
 *  players for up to its `player_process` phase, 60 seconds on paseo-next-v2. */
export const SETTLE_TIMEOUT_MS = 180_000
/** how often the game is read while the watch waits */
export const SETTLE_POLL_MS = 5_000

export function isSettled(game: GameSlot | undefined, gameIndex: number): boolean {
  return game === undefined || game.index > gameIndex
}

export interface SettleReads {
  /** `Game.Game` now, retried as the product retries a read */
  readGame(signal?: AbortSignal): Promise<GameSlot | undefined>
  /** One more read of it, while the watch waits. Null when it gave up: a host
   *  request that never answers would hold the watch's query for good. */
  readGameOnce(): Promise<GameSlot | undefined | null>
  watchGame(cb: (game: GameSlot | undefined) => void, onError: (error: unknown) => void): () => void
}

export interface SettleOptions {
  /** the game was found settled: for the product's journey */
  onSettled?(gameIndex: number): void
  onWatchError?(error: unknown): void
  /** the reason a wait rejects with once `signal` aborts (default: `signal.reason`) */
  abortReason?(signal: AbortSignal): unknown
}

export interface SettleWait {
  /** One read: a past game is settled already. */
  settledNow(gameIndex: number, signal?: AbortSignal): Promise<boolean>
  /**
   * Resolve once the chain finishes a game `settledNow` found open.
   *
   * It rejects once SETTLE_TIMEOUT_MS passes without a settle, so a screen
   * waiting on it fails instead of loading for ever.
   */
  whenSettles(gameIndex: number, signal?: AbortSignal): Promise<void>
  /** `settledNow`, then `whenSettles` when it was not. */
  settled(gameIndex: number, signal?: AbortSignal): Promise<void>
}

/** Waits for the chain to settle a game, over the reads a product hands in (see the module header). */
export function settleWait(reads: SettleReads, options: SettleOptions = {}): SettleWait {
  const abortReason = options.abortReason ?? ((signal: AbortSignal) => signal.reason)

  const settledNow: SettleWait["settledNow"] = async (gameIndex, signal) => {
    const settled = isSettled(await reads.readGame(signal), gameIndex)
    if (settled) options.onSettled?.(gameIndex)
    return settled
  }

  const whenSettles: SettleWait["whenSettles"] = (gameIndex, signal) =>
    new Promise((resolve, reject) => {
      let done = false
      // the first value can arrive before `stop` holds the unsubscribe
      let stop: (() => void) | undefined = undefined
      let reread: ReturnType<typeof setTimeout> | undefined = undefined
      const onAbort = () => finish(abortReason(signal!))
      const finish = (error?: unknown) => {
        if (done) return
        done = true
        clearTimeout(reread)
        clearTimeout(deadline)
        stop?.()
        signal?.removeEventListener("abort", onAbort)
        if (error !== undefined) reject(error)
        else {
          resolve()
          // the product's hook, after the wait is answered: its throw holds nothing
          try {
            options.onSettled?.(gameIndex)
          } catch {
            /* the journey is the product's */
          }
        }
      }
      // The watch waits on its query in flight, and a host request that never
      // gets an answer holds that query for good. So the game is read again
      // until the watch or a read decides, and a read that hangs gives up.
      const readAgain = () => {
        if (done) return
        reread = setTimeout(() => {
          reads.readGameOnce().then((game) => {
            if (game !== null && isSettled(game, gameIndex)) finish()
            else readAgain()
          }, readAgain)
        }, SETTLE_POLL_MS)
      }
      const deadline = setTimeout(
        () => finish(new Error(`game ${gameIndex} has not settled after ${SETTLE_TIMEOUT_MS / 1000} seconds`)),
        SETTLE_TIMEOUT_MS,
      )
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
      readAgain()
      stop = reads.watchGame(
        (game) => {
          if (isSettled(game, gameIndex)) finish()
        },
        (error) => options.onWatchError?.(error),
      )
      if (done) stop()
    })

  const settled: SettleWait["settled"] = async (gameIndex, signal) => {
    if (await settledNow(gameIndex, signal)) return
    return whenSettles(gameIndex, signal)
  }

  return { settledNow, whenSettles, settled }
}
