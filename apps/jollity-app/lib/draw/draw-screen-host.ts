// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE DRAW SCREEN'S HOST — runs lib/draw/draw-screen, the screen's reducer:
 * it holds the state, steps it on every event, and runs every command the
 * step emits, in order (AGENTS.md "State machines" rule 2). One queue: an
 * event dispatched while a command runs is stepped after the commands before
 * it, never in the middle of them. It keeps no second copy of the state, only
 * the resources the commands act on: the stage, the timers, the idle watch,
 * the ceremony and the read in flight.
 *
 * Construction is pure: it steps `opened` (a draw the confirm screen preloaded
 * is the wheel from the first render) and keeps the commands until the page
 * attaches. React StrictMode's replay detaches and attaches again at once, so
 * a detach tears down a microtask later, unless an attach comes first.
 *
 * Everything outside (the chain, the journey, the browser, telemetry) comes
 * in through `DrawScreenDeps` (./draw-screen-deps), so this file and its
 * tests import none of it.
 */
import type { DrawSkipKind } from "@individuality/sign-up"
import type { GameSource } from "../game-source"
import type { DrawState } from "../journeys/payoff-facts"
import type { PayoffCommand } from "../payoff-machine"
import type { DrawLoad, DrawLoadResult } from "./draw-load"
import { executePrizeDrawCommands, type PrizeDrawPayoffRunner } from "./payoff-runner"
import type { DrawWheel, PrizeDrawView } from "./prize-draw"
import { coinAmount, PRIZE_UNIT } from "./prize-unit"
import type { createDrawCeremony } from "./wheel/ceremony"
import type { WheelDraw } from "./wheel/mount"
import type { WheelCheck } from "./wheel/rule"
import type { StageEvents, StageRunner } from "./wheel/stage-runner"
import {
  drawScreenStep,
  drawScreenView,
  startDrawScreen,
  type DrawAnswer,
  type DrawScreenCommand,
  type DrawScreenEvent,
  type DrawScreenNote,
  type DrawScreenState,
  type DrawScreenView,
  type DrawTimer,
} from "./draw-screen"

type Ceremony = ReturnType<typeof createDrawCeremony>

/** the 60 s idle watch (./draw-idle createBrowserDrawIdle) */
interface DrawIdleWatch {
  start(): void
  stop(): void
  touch(): void
  detach(): void
}

export interface DrawScreenDeps {
  game: number | undefined
  /** the ?player= URL override (honoured in every build) */
  override: string | undefined
  /** what the game session preloaded on the confirm screen */
  peek(): DrawLoadResult | undefined
  /** why a player with no ticket is not in the draw, when this phone knows */
  miss(): DrawSkipKind | null | undefined
  source(): Promise<GameSource | null>
  load(source: GameSource): DrawLoad
  claim(source: GameSource, draw: PrizeDrawView): void
  payoff: PrizeDrawPayoffRunner
  drawShown(state: DrawState, check: WheelCheck | null, game: number | undefined): void
  markSeen(game: number): void
  toChest(): void
  preloadChest(): void
  /** keyed by the draw's game, so a reload keeps counting */
  idle(key: string, onAdvance: () => void): DrawIdleWatch
  /** a tap anywhere on the stage restarts the idle; returns its cancel */
  touch(element: HTMLElement, idle: DrawIdleWatch): () => void
  stage(element: HTMLElement, draw: WheelDraw, options: { held: boolean }, on: StageEvents): StageRunner
  names(wheel: DrawWheel, ticket: string): Promise<string | null>
  ceremony(): Ceremony
  hidden(): boolean
  log(message: string, data?: unknown, level?: "info" | "warn"): void
  describe(error: unknown): string
}

/** what the page itself tells the screen */
type DrawScreenInput = { type: "continue" | "bypass" | "hidden" | "visible" | "page-left" }

export interface DrawScreenHost {
  view(): DrawScreenView
  subscribe(listener: () => void): () => void
  attach(): void
  detach(): void
  send(input: DrawScreenInput): void
  /** the element the stage mounts in (WheelStage's), or null as it goes */
  stageElement(element: HTMLElement | null): void
}

/** a read's result as the reducer takes it; `null` is no identity */
function answerOf(result: DrawLoadResult, miss: () => DrawSkipKind | null | undefined): DrawAnswer {
  if (result === null) return { kind: "no-identity" }
  return result.kind === "ready" ? { kind: "ready", draw: result.draw, miss: miss() } : result
}

const sameView = (a: DrawScreenView, b: DrawScreenView): boolean =>
  Object.keys({ ...a, ...b }).every((key) => a[key as keyof DrawScreenView] === b[key as keyof DrawScreenView])

export function createDrawScreenHost(deps: DrawScreenDeps): DrawScreenHost {
  let state: DrawScreenState = startDrawScreen({ game: deps.game, override: deps.override })
  let view = drawScreenView(state)
  const listeners = new Set<() => void>()
  const queue: DrawScreenEvent[] = []
  let held: DrawScreenCommand[] | null = []
  let draining = false
  let closing = 0

  // the resources the commands act on
  let element: HTMLElement | null = null
  let stage: StageRunner | null = null
  let stageWanted: { held: boolean } | null = null
  let stageError: unknown
  const timers = new Map<DrawTimer, ReturnType<typeof setTimeout>>()
  let idle: DrawIdleWatch | null = null
  let untouch: (() => void) | null = null
  let ceremony: Ceremony | null = null
  let read: DrawLoad | null = null

  const shown = () => (state.phase === "words" || state.phase === "wheel" ? state.answer : null)

  function dispatch(event: DrawScreenEvent): void {
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
        const step = drawScreenStep(state, event)
        state = step.state
        const next = drawScreenView(state)
        if (!sameView(next, view)) view = next
        if (held) held.push(...step.commands)
        else step.commands.forEach(run)
      }
    } finally {
      draining = false
    }
    if (view !== before) listeners.forEach((listener) => listener())
  }

  function runPayoff(commands: PayoffCommand[]): void {
    executePrizeDrawCommands(commands, {
      drawShown: () => {
        const answer = shown()
        const facts: DrawState = state.phase === "none" ? { kind: "none" } : answer ? { kind: "ready", draw: answer.draw } : { kind: "loading" }
        deps.drawShown(facts, answer?.check ?? null, answer?.draw.gameIndex ?? deps.game)
      },
      markDrawSeen: () => {
        const answer = shown()
        if (answer) deps.markSeen(answer.draw.gameIndex)
      },
      replaceChest: deps.toChest,
      // the payoff arms the idle once the screen offers a way on, and cancels it on the way out
      armIdle: () => {
        idle ??= deps.idle(String(shown()?.draw.gameIndex), () => dispatch({ type: "idle-elapsed" }))
        touchStage()
        idle.start()
      },
      cancelIdle: () => idle?.stop(),
      // the chest's clips, already on their way since the screen opened (preload-chest): fetched once
      loadChest: deps.preloadChest,
    })
  }

  function loadDraw(epoch: number): void {
    const tag = deps.payoff.capture()
    void deps.source().then((source) => {
      if (!source) return dispatch({ type: "load-answered", epoch, answer: { kind: "no-identity" }, payoffTag: tag })
      // a page gone before the source came holds no read
      if (state.phase === "closed") return
      const load = deps.load(source)
      read = load
      const waiting = () => {
        if (load.waiting) dispatch({ type: "load-waiting", epoch })
      }
      const stop = load.subscribe(waiting)
      waiting()
      // a failed read is the reducer's to say (the read logs why: draw-load)
      return load.promise
        .then(
          (result) => dispatch({ type: "load-answered", epoch, answer: answerOf(result, deps.miss), payoffTag: tag }),
          () => dispatch({ type: "load-failed", epoch }),
        )
        .finally(stop)
    })
  }

  function startClaim(): void {
    const answer = shown()
    if (!answer) return
    void deps.source().then((source) => {
      if (source) deps.claim(source, answer.draw)
    })
  }

  function beginStage(): void {
    const answer = shown()
    if (stage || !stageWanted || !element || !answer?.draw.wheel) return
    const { draw } = answer
    const wheel = answer.draw.wheel
    stage = deps.stage(
      element,
      {
        tickets: wheel.tickets,
        mine: draw.userTicket,
        target: wheel.target,
        winners: wheel.winners,
        won: draw.won,
        prize: { amount: coinAmount(draw.prizeUsd), unit: PRIZE_UNIT, prefix: "$" },
        names: (ticket) => deps.names(wheel, ticket),
        // the player's friends, by name: the app has no list of friends, so
        // none are marked and the wheel stands its usual time
        friends: [],
      },
      stageWanted,
      {
        mounted: ({ held, progressMs }) => dispatch({ type: "stage-mounted", held, progressMs }),
        waiting: () => dispatch({ type: "stage-waiting" }),
        started: ({ progressMs }) => dispatch({ type: "stage-started", progressMs }),
        failed: (reason, error) => {
          stageError = error
          dispatch({ type: "stage-failed", reason })
        },
        ended: () => dispatch({ type: "stage-ended" }),
        done: () => dispatch({ type: "stage-done" }),
      },
    )
  }

  function touchStage(): void {
    if (idle && element && !untouch) untouch = deps.touch(element, idle)
  }

  function log(note: DrawScreenNote): void {
    if (note.what === "no-wheel") return deps.log("no wheel for this draw", { reason: note.reason }, "warn")
    const game = deps.game ?? null
    if (note.what === "opened") deps.log("draw screen opened", { game, player: deps.override ?? null, preloaded: note.preloaded })
    else if (note.what === "no-draw") deps.log("no draw scheduled — skipping the draw screen", { game })
    else {
      const { draw } = note
      deps.log(`draw screen shows: ${note.shown}`, {
        game,
        listed: draw?.listedEntries ?? null,
        total: draw?.totalEntries ?? null,
        ticket: draw ? Boolean(draw.userTicket) : null,
        won: draw?.won ?? null,
        claimed: draw?.claimed ?? null,
      })
    }
  }

  function run(command: DrawScreenCommand): void {
    switch (command.kind) {
      case "load-draw":
        return loadDraw(command.epoch)
      case "payoff":
        return runPayoff(deps.payoff.send(command.input, command.tag))
      case "start-claim":
        return startClaim()
      case "start-stage":
        stageWanted = { held: command.held }
        return beginStage()
      case "release-stage":
        if (stageWanted) stageWanted.held = false
        return stage?.release()
      case "destroy-stage":
        stage?.destroy()
        stage = null
        stageWanted = null
        return
      case "arm-timer": {
        const { timer } = command
        timers.set(
          timer,
          setTimeout(() => {
            timers.delete(timer)
            dispatch({ type: "timer", timer })
          }, command.ms),
        )
        return
      }
      case "clear-timer":
        clearTimeout(timers.get(command.timer))
        timers.delete(command.timer)
        return
      case "detach-idle":
        untouch?.()
        idle?.detach()
        untouch = idle = null
        return
      case "ceremony":
        if (command.mark === "load-started") {
          ceremony = deps.ceremony()
          // the page may open hidden: the ceremony counts from here
          if (deps.hidden()) ceremony.hidden()
          return ceremony.loadStarted()
        }
        if (command.mark === "mounted") return ceremony?.mounted()
        if (command.mark === "ended") return void ceremony?.ended()
        return command.mark === "hidden" ? ceremony?.hidden() : ceremony?.resumed()
      case "ceremony-fallback":
        if (command.reason === "never-ended") return void ceremony?.fallback("never-ended", undefined, stage?.progress())
        return void ceremony?.fallback(command.reason, deps.describe(stageError))
      case "ceremony-report":
        if (command.cause === "tap") return void ceremony?.tap()
        if (command.cause === "idle") return void ceremony?.idleAdvance()
        return ceremony?.leave()
      case "preload-chest":
        return deps.preloadChest()
      case "log":
        return log(command.note)
      default: {
        const unhandled: never = command
        throw new Error(`draw screen: no executor for ${JSON.stringify(unhandled)}`)
      }
    }
  }

  // D1: opened on what the confirm screen preloaded, its commands held for attach
  const preloaded = deps.peek()
  dispatch({
    type: "opened",
    ...(preloaded === undefined ? {} : { preloaded: answerOf(preloaded, deps.miss) }),
    payoffTag: deps.payoff.capture(),
  })

  return {
    view: () => view,
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
        // the read is held while the page is: a draw still drawing is read no more
        read?.release()
        read = null
      })
    },
    send: dispatch,
    stageElement(next) {
      if (next === element) return
      untouch?.()
      untouch = null
      element = next
      if (!next) return
      touchStage()
      beginStage()
    },
  }
}
