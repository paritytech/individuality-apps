// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE STAGE, RUN — the wheel's stage (./mount) as one thing a host starts and
 * stops: the stage's chunk and the baked coins loaded, the stage mounted
 * (held under a spectator's intro until it is released), and what the stage
 * says as it plays passed on until the player is through. It tells the host, in this order:
 * `mounted`, then `ended` (the stage's Continue is offered), then `done` (the
 * player is through); or `failed`, when the chunk or the coins did not load
 * or the stage did not mount. Nothing comes after `destroy()`.
 *
 * The stage is loaded with import(): the scene code in ./proto reads matchMedia
 * the moment it is evaluated, which a static prerender has no window for.
 * Its stylesheets are the host's to import, statically
 * (components/draw/wheel-stage.tsx).
 *
 * Framework-free (architecture rule 6), and no clock of its own: the stage
 * calls back when its Continue goes up and when the player is through, and
 * the bound on how long it may take is the host's, from the `progressMs` it is
 * handed at `mounted`.
 */
import type { WheelDraw, WheelProgress, WheelStage } from "./mount"

/** how long a cold-opened stage waits for a winner's baked prize coin before
 *  it mounts and, if the coin is not there yet, builds it */
const PRIZE_COIN_WAIT_MS = 1500

export type StageFailure = "load" | "mount"

export interface StageEvents {
  /** the stage is up: `held` as it was mounted, and `progressMs` how long an
   *  unheld stage may take to reach its ending (WHEEL_PROGRESS_TIMEOUT_MS) */
  mounted(at: { held: boolean; progressMs: number }): void
  /** the stage's chunk or coins did not load, or the stage did not mount */
  failed(reason: StageFailure, error: unknown): void
  /** the stage's Continue is offered; always before `done` */
  ended(): void
  /** the player is through: the stage's Continue pressed (a win, a
   *  spectator's draw), or the fall it starts played out (a loss) */
  done(): void
}

export interface StageRunner {
  /** let a stage mounted held play on; one not mounted yet mounts unheld */
  release(): void
  /** where the stage's story stands, for a stage that never ended */
  progress(): WheelProgress | undefined
  /** stop watching and take the stage down; no event comes after this */
  destroy(): void
}

export function startStage(host: HTMLElement, draw: WheelDraw, { held }: { held: boolean }, on: StageEvents): StageRunner {
  let destroyed = false
  let stage: WheelStage | null = null
  // what has been passed on: ended always before done, each once, nothing once destroyed
  let ended = false
  let done = false
  const end = () => {
    if (destroyed || ended) return
    ended = true
    on.ended()
  }
  const finish = () => {
    if (destroyed || done) return
    end()
    done = true
    on.done()
  }
  // the stage's chunk, and the coins baked ahead of time (./baked-coin): the
  // one the player drags into the slit, and for a winner the prize's. The
  // confirm screen has normally loaded both already (lib/game-session); opened
  // cold, the prize's coin is waited for only so long, as it is needed at the
  // end. A spectator has no coin to drag
  void Promise.all([
    import("./mount"),
    import("./baked-coin").then(({ loadBakedCoins, loadPrizeCoin }) =>
      Promise.all([
        draw.mine ? loadBakedCoins() : undefined,
        draw.won
          ? Promise.race([loadPrizeCoin(draw.prize.amount, draw.prize.unit), new Promise((resolve) => setTimeout(resolve, PRIZE_COIN_WAIT_MS))])
          : undefined,
      ]),
    ),
  ])
    .then(([{ mountWheel, WHEEL_PROGRESS_TIMEOUT_MS }]) => {
      if (destroyed) return
      try {
        // ENDED: the stage's Continue is offered. DONE: the player pressed it
        // (and a loss's fall has played)
        stage = mountWheel(host, draw, { held, onEnded: end, onDone: finish })
      } catch (error) {
        on.failed("mount", error)
        return
      }
      on.mounted({ held, progressMs: WHEEL_PROGRESS_TIMEOUT_MS })
    })
    .catch((error) => {
      if (!destroyed) on.failed("load", error)
    })
  return {
    release() {
      held = false
      stage?.release()
    },
    progress: () => stage?.progress(),
    destroy() {
      destroyed = true
      stage?.destroy()
      stage = null
    },
  }
}
