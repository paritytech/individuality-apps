// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE CHEST SCREEN'S HOST — runs ./chest-screen, the screen's reducer: it
 * holds the state, steps it on every event, and runs every command the step
 * emits, in order (AGENTS.md "State machines" rule 2), the payoff's too. One
 * queue: an event dispatched while a command runs is stepped after the
 * commands before it, never in the middle of them. It keeps no second copy of
 * the state, only what the commands act on: the source, the feed in flight,
 * the timers and the rereads.
 *
 * THE FEED (./chest-feed) is one run per read: the first read; while the game
 * settles, the claims as they land (the source's watchChest, woken by the
 * player's own chain row); then the settle's own read. The first is the run
 * the prize draw may already have started (shared); a reread is a run of its
 * own. Each finding carries the run's epoch, so a run let go answers nothing.
 *
 * Construction is pure: it steps `opened` and keeps the commands until the
 * page attaches. React StrictMode's replay detaches and attaches again at
 * once, so a detach tears down a microtask later, unless an attach comes
 * first.
 *
 * Everything outside (the chain, the payoff's journey, storage, telemetry,
 * the browser) comes in through `ChestScreenDeps` (./chest-screen-deps), so
 * this file and its tests import none of it.
 */
import type { GameSource } from "../game-source"
import { executeChestCommands, type PayoffScreenRunner } from "../payoff-screen-runner"
import type { PayoffCommand } from "../payoff-machine"
import type { Attrs } from "../telemetry"
import type { ChestFeedEvent } from "./chest-feed"
import {
  chestScreenStep,
  chestScreenView,
  chestScreenWaiting,
  startChestScreen,
  type ChestHealth,
  type ChestScreenCommand,
  type ChestScreenEvent,
  type ChestScreenState,
  type ChestScreenView,
  type ChestTimer,
} from "./chest-screen"

export interface ChestScreenDeps {
  /** the URL's ?game=, or the game the session remembered when a host dropped it */
  game: number | undefined
  /** the ?player= URL override (honoured in every build) */
  override: string | undefined
  source(): Promise<GameSource | null>
  /** the vessel's seed for the player and the game, or null with no player */
  seed(source: GameSource): string | null
  /** hold a run of the claims feed (./chest-feed), the shared one for the first read; returns its release */
  feed(source: GameSource, options: { shared: boolean }, listener: (event: ChestFeedEvent) => void): () => void
  payoff: PayoffScreenRunner
  chestOpened(): void
  chestShown(facts: Attrs): void
  chestReadRecovered(ms: number): void
  payoffStalled(stage: string): void
  payoffHandedOff(): void
  /** leave for the player's Humanity card; `refused` when the host would not open it */
  leaveForHumanity(refused: () => void): void
  markSeen(game: number): void
  savePick(hash: string, collectionId: number): void
  /** a timer; returns its cancel */
  timer(ms: number, onElapsed: () => void): () => void
  /** the rereads' schedule (lib/chest-reread armChestRereads); returns its cancel */
  rereads(reread: () => Promise<boolean>): () => void
  now(): number
  log(message: string, data?: unknown, level?: "info" | "warn"): void
}

/** what the page itself tells the screen: the vessel's reports, the player's taps, the health verdict */
type ChestScreenInput =
  | { type: "landed" | "vessel-opened" | "cta" | "album-done" }
  | { type: "collected"; count: number }
  | { type: "pick"; index: number; collectionId: number }
  | { type: "health"; health: ChestHealth }

export interface ChestScreenHost {
  view(): ChestScreenView
  /** the game source once resolved (the chain-health card watches it) */
  source(): GameSource | null | undefined
  /** the first read is still out, or failed: what the launch stall watches */
  waiting(): boolean
  subscribe(listener: () => void): () => void
  attach(): void
  detach(): void
  send(input: ChestScreenInput): void
}

export function createChestScreenHost(deps: ChestScreenDeps): ChestScreenHost {
  let state: ChestScreenState = startChestScreen()
  let view = chestScreenView(state)
  const listeners = new Set<() => void>()
  const queue: ChestScreenEvent[] = []
  let held: ChestScreenCommand[] | null = []
  let draining = false
  let closing = 0
  const openedAt = deps.now()

  // what the commands act on
  let source: GameSource | null | undefined
  let feedRun = 0
  let releaseFeed: (() => void) | null = null
  const timers = new Map<ChestTimer, () => void>()
  let cancelRereads: (() => void) | null = null
  /** a reread waits for the answer it asked for */
  let rereadAnswered: ((stillWaiting: boolean) => void) | null = null

  function dispatch(event: ChestScreenEvent): void {
    queue.push(event)
    if (!draining) drain(() => {})
  }

  /** run `first`, then step every queued event; listeners hear once, at the end */
  function drain(first: () => void): void {
    draining = true
    const before = view
    try {
      first()
      for (let event = queue.shift(); event; event = queue.shift()) {
        const step = chestScreenStep(state, event)
        const changed = step.state !== state
        state = step.state
        if (changed) view = chestScreenView(state)
        if (event.type === "answered" && changed && rereadAnswered) {
          rereadAnswered(state.phase === "waiting")
          rereadAnswered = null
        }
        if (held) held.push(...step.commands)
        else step.commands.forEach(run)
      }
    } finally {
      draining = false
    }
    if (view !== before) listeners.forEach((listener) => listener())
  }

  const refused = () => dispatch({ type: "hand-off-refused" })

  function runPayoff(commands: PayoffCommand[], facts?: Attrs): void {
    executeChestCommands(commands, {
      chestOpened: deps.chestOpened,
      chestShown: () => {
        if (facts) deps.chestShown(facts)
      },
      payoffStalled: deps.payoffStalled,
      payoffEnded: deps.payoffHandedOff,
      handOff: () => deps.leaveForHumanity(refused),
      // the payoff's answer to the chest's reread, which has already read (C5)
      loadChest: () => dispatch({ type: "load-chest" }),
    })
  }

  async function resolveSource(): Promise<GameSource | null> {
    if (source !== undefined) return source
    const resolved = await deps.source()
    if (source === undefined) {
      source = resolved
      dispatch({ type: "source", seed: resolved ? deps.seed(resolved) : null, game: deps.game ?? null })
      listeners.forEach((listener) => listener())
    }
    return source
  }

  function stopFeed(): void {
    feedRun += 1
    releaseFeed?.()
    releaseFeed = null
  }

  function feed(epoch: number): void {
    stopFeed()
    const run = feedRun
    const tag = deps.payoff.capture()
    void resolveSource().then((from) => {
      if (run !== feedRun || !from) return
      releaseFeed = deps.feed(from, { shared: epoch === 1 }, (event) => {
        if (event.type === "answered") dispatch({ type: "answered", epoch, answer: event.answer, tag, picks: event.picks, stash: event.stash })
        else if (event.type === "came") dispatch({ type: "came", epoch, items: event.items })
        else dispatch({ type: "settled", epoch, items: event.items, partial: event.partial })
      })
    })
  }

  function run(command: ChestScreenCommand): void {
    switch (command.kind) {
      case "payoff": {
        const tag = command.tag === "capture" ? deps.payoff.capture() : command.tag
        runPayoff(deps.payoff.send(command.input, tag), command.facts)
        break
      }
      case "read":
        feed(command.epoch)
        break
      case "stop-feed":
        stopFeed()
        break
      case "arm-timer": {
        timers.get(command.timer)?.()
        const timer = command.timer
        timers.set(timer, deps.timer(command.ms, () => dispatch({ type: "timer", timer })))
        break
      }
      case "clear-timer":
        timers.get(command.timer)?.()
        timers.delete(command.timer)
        break
      case "rereads":
        cancelRereads?.()
        cancelRereads = null
        if (command.on)
          cancelRereads = deps.rereads(
            () =>
              new Promise<boolean>((resolve) => {
                rereadAnswered = (stillWaiting) => resolve(!stillWaiting)
                dispatch({ type: "reread-due" })
              }),
          )
        break
      case "read-recovered":
        deps.chestReadRecovered(deps.now() - openedAt)
        break
      case "mark-seen":
        deps.markSeen(command.game)
        break
      case "leave":
        if (deps.payoff.current().kind === "ended") deps.leaveForHumanity(refused)
        else runPayoff(deps.payoff.send({ type: command.via }))
        break
      case "save-pick":
        deps.savePick(command.hash, command.collectionId)
        break
      case "log":
        deps.log(command.message, command.data)
        break
      default: {
        const unhandled: never = command
        throw new Error(`chest screen: no executor for ${JSON.stringify(unhandled)}`)
      }
    }
  }

  dispatch({ type: "opened" })

  return {
    view: () => view,
    source: () => source,
    waiting: () => chestScreenWaiting(state),
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    attach() {
      closing += 1
      if (!held) return
      const commands = held
      held = null
      drain(() => commands.forEach(run))
    },
    detach() {
      const token = ++closing
      queueMicrotask(() => {
        if (token !== closing) return
        dispatch({ type: "unmounted" })
      })
    },
    send: dispatch,
  }
}
