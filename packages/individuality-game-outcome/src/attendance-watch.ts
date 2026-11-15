// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The player's verdict in one game, watched off two chain watches: the game
 * and the player's `Game.Players` row, both at the best block, mapped by
 * ./attendance.ts. A product hands its two halves out: `watch` for a screen
 * that shows the verdict, and `applied`, the wait of a prize's automatic
 * claim (#1096).
 */
import { deriveAttendance, type AttendanceView } from "./attendance"
import type { AttendanceRow, GameSlot } from "./attendance-rule"

type Unsubscribe = () => void

/** the two watches the verdict is made of, both at the best block */
export interface AttendanceReads {
  watchGame(cb: (game: GameSlot | undefined) => void, onError: (error: unknown) => void): Unsubscribe
  watchPlayerRow(who: string, cb: (row: AttendanceRow | undefined) => void, onError: (error: unknown) => void): Unsubscribe
}

export interface AttendanceWatch {
  /** `who`'s verdict in game `gameIndex` on every change; null while the row
   *  holds no verdict for that game */
  watch(who: string, gameIndex: number, cb: (view: AttendanceView | null) => void): Unsubscribe
  /** resolves once the chain applied `who`'s attendance in game `gameIndex`
   *  early, or the game settled: either way `Score.Participants` holds that
   *  game for them. Rejects as `gameSettled` does. */
  applied(who: string, gameIndex: number): Promise<void>
}

/** The player's attendance verdict for one game, watched at the best block, and the wait for the chain to apply it. */
export function attendanceWatch(
  engine: AttendanceReads,
  gameSettled: (gameIndex: number, signal?: AbortSignal) => Promise<void>,
  onError: (message: string, error: unknown) => void,
): AttendanceWatch {
  const watch: AttendanceWatch["watch"] = (who, gameIndex, cb) => {
    // both watches have answered once before anything is said
    let game: GameSlot | undefined
    let row: AttendanceRow | undefined
    let gameRead = false
    let rowRead = false
    let last: string | undefined
    const emit = () => {
      if (!gameRead || !rowRead) return
      const view = deriveAttendance(gameIndex, game, row)
      const seen = JSON.stringify(view)
      if (seen === last) return
      last = seen
      cb(view)
    }
    const stopGame = engine.watchGame(
      (value) => {
        game = value
        gameRead = true
        emit()
      },
      (error) => onError("attendance game watch failed", error),
    )
    const stopRow = engine.watchPlayerRow(
      who,
      (value) => {
        row = value
        rowRead = true
        emit()
      },
      (error) => onError("attendance row watch failed", error),
    )
    return () => {
      stopGame()
      stopRow()
    }
  }

  const applied: AttendanceWatch["applied"] = (who, gameIndex) => {
    const settle = new AbortController()
    let stop: Unsubscribe | undefined
    const enacted = new Promise<void>((resolve) => {
      stop = watch(who, gameIndex, (view) => {
        if (view?.final) resolve()
      })
    })
    return Promise.race([enacted, gameSettled(gameIndex, settle.signal)]).finally(() => {
      stop?.()
      settle.abort()
    })
  }

  return { watch, applied }
}
