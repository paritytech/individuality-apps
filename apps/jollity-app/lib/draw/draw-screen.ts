// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE PRIZE DRAW SCREEN, as one pure reducer: what /prize-draw shows, and
 * when it lets go. It is this screen's authority; the payoff (lib/payoff-machine)
 * stays the journey's (draw → collectables screen), and is told by `payoff` commands.
 *
 * lib/draw/draw-screen-host runs it for app/prize-draw/page.tsx;
 * components/draw/wheel-stage.tsx draws it, and lib/draw/wheel/ceremony.ts
 * keeps the wheel's milestones and reports. lib/draw/draw-screen.capture.test.tsx holds the
 * whole screen to recorded traces. A failed read says so (D2), and the 60 s
 * idle counts from the way on (D5, D8, D9), not from the stage's mount.
 *
 * THE RULES (lib/state-machines/draw-screen.definition.ts models them, all
 * but D7's `stage-waiting` and `stage-started`):
 *
 * D1. The screen opens on the preloaded answer, or on the read it starts.
 * D2. Still drawing → "Drawing the winners…" with Continue, which sends `draw-bypass`.
 *     A read that fails, loading or still drawing → "Couldn't load the draw"
 *     with Continue (`draw-bypass`); the payoff gets `draw-error`.
 * D3. No identity → a message with Continue (`draw-bypass`). No draw → `draw-none`.
 * D4. A ready draw plays the wheel only if `checkWheel` passes; otherwise it is
 *     told in words. The payoff gets `draw-result` once, with the read's tag.
 * D5. Words: the claim starts at once, the way on is offered (`draw-offered`),
 *     Continue sends `draw-continue` and the idle `draw-idle`.
 * D6. A spectator: the intro over a held stage; release at 8 s, fade 0.5 s.
 * D7. On mount: the ceremony marks "mounted", and a progress bound is armed
 *     (+8 s if held). `stage-waiting` swaps it for the coin's own, longer
 *     bound while the stage waits for the player's coin (that time is theirs:
 *     COIN_WAIT_MS, 5 min); `stage-started` arms the animation's bound again.
 * D8. On `stage-ended` the screen is offered: the bound is cleared, the claim
 *     starts, and the way on is offered (`draw-offered`).
 * D9. A load or mount failure, or the bound running out → fallback: the words
 *     over the stage, the page's Continue, the intro gone, the stage released,
 *     the claim started, the way on offered (`draw-offered`).
 * D10. Offered or fallback: `stage-done` or Continue leaves once (ceremony
 *     reported as tap, claim, `draw-continue`).
 * D11. `idle-elapsed`, offered or fallback and not yet left: the ceremony is
 *     reported as idle, the claim starts, and `draw-idle` is sent. The payoff
 *     arms the 60 s idle on `draw-offered` and cancels it on the way out.
 * D12. Hidden and visible are ceremony marks; `page-left` asks for the report,
 *     which the ceremony sends once.
 * D13. Unmount: everything is detached, destroyed and cleared; after it, every event is inert.
 * D14. A stale epoch is inert.
 * D15. The `?player=` URL override (honoured in every build) never claims.
 *
 * Leaving is not the end of the stage: the page stays up until the route
 * changes, so `exit` is its own field, and `stage` keeps what the stage did.
 *
 * Pure (house rule, AGENTS.md "State machines"): no I/O, no clock. Time
 * arrives as `timer` and `idle-elapsed` events; the host runs every
 * command, in order.
 */
import type { DrawSkipKind } from "@individuality/sign-up"
import type { PayoffTag } from "../payoff-machine"
import type { PrizeDrawView } from "./prize-draw"
import type { StageFailure } from "./wheel/stage-runner"
import { checkWheel, type WheelCheck } from "./wheel/rule"

/** THE INTRO: the draw plays on by itself after INTRO_AUTO_MS, and the words
 *  fade over INTRO_OUT_MS (stage.css .wheel-intro's transition) */
const INTRO_AUTO_MS = 8_000
const INTRO_OUT_MS = 500

/** THE COIN'S WAIT: the player's time at the coin is theirs, so the stage's
 *  bound is not the animation's while it waits for them. But a coin that can
 *  never go in (a gesture the host's webview never delivers) must not hold the
 *  screen for ever, so the wait has a bound of its own, long enough for anyone
 *  still deciding: past it, the fallback words and the page's Continue (D9) */
export const COIN_WAIT_MS = 5 * 60_000

/** what a read of the draw says: `miss` is why a player with no ticket is not
 *  in it, when this phone knows (lib/draw/draw-miss) */
export type DrawAnswer =
  | { kind: "ready"; draw: PrizeDrawView; miss?: DrawSkipKind | null }
  | { kind: "none" }
  | { kind: "no-identity" }

export type DrawTimer = "intro-auto" | "intro-out" | "progress"
type DrawFallback = "load-failed" | "mount-failed" | "never-ended"
type DrawStage = "loading" | "mounted" | "offered" | "fallback"
type DrawIntro = "up" | "leaving" | "off"

/** a ready answer as the screen holds it: the rule's verdict on its wheel (null with no wheel) */
interface DrawShown {
  draw: PrizeDrawView
  miss: DrawSkipKind | null | undefined
  check: WheelCheck | null
}

interface Base {
  game: number | undefined
  /** the ?player= URL override (honoured in every build) */
  override: string | undefined
  epoch: number
}

export type DrawScreenState = Base &
  (
    | { phase: "new" | "loading" | "waiting" | "failed" | "no-identity" | "none" | "closed" }
    | { phase: "words"; answer: DrawShown }
    | { phase: "wheel"; answer: DrawShown; stage: DrawStage; intro: DrawIntro; exit: "tap" | "idle" | null }
  )

type WheelState = Extract<DrawScreenState, { phase: "wheel" }>

export type DrawScreenEvent =
  | { type: "opened"; preloaded?: DrawAnswer; payoffTag: PayoffTag }
  | { type: "load-waiting"; epoch: number }
  | { type: "load-answered"; epoch: number; answer: DrawAnswer; payoffTag: PayoffTag }
  | { type: "load-failed"; epoch: number }
  | { type: "stage-mounted"; held: boolean; progressMs: number }
  /** the stage is up and waiting for the player's coin: its bound waits too */
  | { type: "stage-waiting" }
  /** the coin went in: the stage's story has started, and its bound starts again from here */
  | { type: "stage-started"; progressMs: number }
  | { type: "stage-failed"; reason: StageFailure }
  | { type: "stage-ended" }
  | { type: "stage-done" }
  | { type: "timer"; timer: DrawTimer }
  | { type: "idle-elapsed" | "continue" | "bypass" | "hidden" | "visible" | "page-left" | "unmounted" }

/** a debug-sheet line; the host words it */
export type DrawScreenNote =
  | { what: "opened"; preloaded: "nothing" | "ready" | "none" | "no identity" }
  | { what: "shows"; shown: string; draw: PrizeDrawView | null }
  | { what: "no-draw" }
  | { what: "no-wheel"; reason: string }

export type DrawScreenCommand =
  | { kind: "load-draw"; epoch: number }
  | {
      kind: "payoff"
      input: { type: "draw-result" | "draw-none" | "draw-bypass" | "draw-offered" | "draw-continue" | "draw-idle" | "draw-error" }
      tag?: PayoffTag
    }
  | { kind: "start-claim" }
  /** `coin`: the player's coin to drag (a ticket); `prize`: a winner's prize coin */
  | { kind: "start-stage"; held: boolean; coin: boolean; prize: boolean }
  | { kind: "release-stage" }
  | { kind: "destroy-stage" }
  | { kind: "arm-timer"; timer: DrawTimer; ms: number }
  | { kind: "clear-timer"; timer: DrawTimer }
  /** the 60 s idle watch (lib/draw/draw-idle), which the payoff arms and cancels: let go as the page goes */
  | { kind: "detach-idle" }
  | { kind: "ceremony"; mark: "load-started" | "mounted" | "ended" | "hidden" | "visible" }
  | { kind: "ceremony-fallback"; reason: DrawFallback }
  | { kind: "ceremony-report"; cause: "tap" | "idle" | "left" }
  | { kind: "preload-collectables" }
  | { kind: "log"; note: DrawScreenNote }

export interface DrawScreenTransition {
  state: DrawScreenState
  commands: DrawScreenCommand[]
}

export type DrawScreenView =
  | { kind: "blank"; label?: "Opening your collectables" }
  | { kind: "message"; message: "waiting" | "failed" | "no-identity" }
  | { kind: "words"; draw: PrizeDrawView; miss: DrawSkipKind | null | undefined }
  /** `fallback`: the words over the stage, and the page's own Continue.
   *  `offered`: the stage has ended and offers its way on (the page's hold,
   *  components/draw/hold-to-collectables) */
  | { kind: "wheel"; draw: PrizeDrawView; miss: DrawSkipKind | null | undefined; intro: "up" | "leaving" | null; fallback: boolean; offered: boolean }

export function startDrawScreen({ game, override }: { game: number | undefined; override: string | undefined }): DrawScreenState {
  return { phase: "new", game, override, epoch: 0 }
}

const stay = (state: DrawScreenState): DrawScreenTransition => ({ state, commands: [] })
const base = ({ game, override, epoch }: Base): Base => ({ game, override, epoch })
const log = (note: DrawScreenNote): DrawScreenCommand => ({ kind: "log", note })

/** D4: can the wheel tell this draw? (the rule re-run against the chain's result) */
function shownOf(answer: Extract<DrawAnswer, { kind: "ready" }>): DrawShown {
  const { draw } = answer
  const check = draw.wheel
    ? checkWheel({
        tickets: draw.wheel.tickets,
        target: draw.wheel.target,
        winners: draw.wheel.winners,
        mine: draw.userTicket,
        winningTickets: draw.winningTickets,
        won: draw.won,
      })
    : null
  return { draw, miss: answer.miss, check }
}

const wheelPlays = (shown: DrawShown): boolean => shown.check?.ok === true

/** WHICH SCREEN the player got — the line to look for in an exported log */
function shownLine(shown: DrawShown): string {
  if (wheelPlays(shown)) return shown.draw.userTicket ? "the wheel" : "the wheel, watching: You weren't in this draw"
  if (!shown.draw.userTicket) return "You weren't in this draw"
  return shown.draw.won ? "You won (words, no wheel)" : "Not this time (words, no wheel)"
}

const shows = (shown: DrawShown): DrawScreenCommand => log({ what: "shows", shown: shownLine(shown), draw: shown.draw })

/** D15: a won prize is claimed by itself, but never for a ?player= URL override */
const claim = (state: Base, shown: DrawShown): DrawScreenCommand[] =>
  shown.draw.won && !state.override ? [{ kind: "start-claim" }] : []

const payoff = (type: Extract<DrawScreenCommand, { kind: "payoff" }>["input"]["type"], tag?: PayoffTag): DrawScreenCommand =>
  tag ? { kind: "payoff", input: { type }, tag } : { kind: "payoff", input: { type } }

/** D3–D6: the answer lands */
function answered(state: Base, answer: DrawAnswer, tag: PayoffTag): DrawScreenTransition {
  if (answer.kind === "none") return { state: { ...base(state), phase: "none" }, commands: [log({ what: "no-draw" }), payoff("draw-none", tag)] }
  if (answer.kind === "no-identity")
    return { state: { ...base(state), phase: "no-identity" }, commands: [log({ what: "shows", shown: "No player identity", draw: null })] }
  const shown = shownOf(answer)
  if (!wheelPlays(shown)) {
    const reason = shown.check?.reason ?? "the chain has no ticket list or target for this draw"
    return {
      state: { ...base(state), phase: "words", answer: shown },
      commands: [log({ what: "no-wheel", reason }), shows(shown), payoff("draw-result", tag), ...claim(state, shown), payoff("draw-offered")],
    }
  }
  const spectator = !shown.draw.userTicket
  return {
    state: { ...base(state), phase: "wheel", answer: shown, stage: "loading", intro: spectator ? "up" : "off", exit: null },
    commands: [
      shows(shown),
      payoff("draw-result", tag),
      { kind: "ceremony", mark: "load-started" },
      { kind: "start-stage", held: spectator, coin: !spectator, prize: shown.draw.won },
      ...(spectator ? [{ kind: "arm-timer", timer: "intro-auto", ms: INTRO_AUTO_MS } as const] : []),
    ],
  }
}

/** D1: opened on what the game session preloaded (a preloaded "no identity" still opens on loading) */
function opened(state: DrawScreenState, event: Extract<DrawScreenEvent, { type: "opened" }>): DrawScreenTransition {
  const { preloaded } = event
  const next = { ...base(state), epoch: state.epoch + 1 }
  const opening: DrawScreenCommand[] = [
    log({ what: "opened", preloaded: preloaded === undefined ? "nothing" : preloaded.kind === "no-identity" ? "no identity" : preloaded.kind }),
    { kind: "preload-collectables" },
    { kind: "load-draw", epoch: next.epoch },
  ]
  if (preloaded?.kind === "ready" || preloaded?.kind === "none") {
    const landed = answered(next, preloaded, event.payoffTag)
    return { state: landed.state, commands: [...opening, ...landed.commands] }
  }
  return { state: { ...next, phase: "loading" }, commands: opening }
}

/** D9: the stage gave up, or was given up on */
function fallback(state: WheelState, reason: DrawFallback): DrawScreenTransition {
  return {
    state: { ...state, stage: "fallback", intro: "off" },
    commands: [
      { kind: "ceremony-fallback", reason },
      ...(state.intro === "up"
        ? [{ kind: "clear-timer", timer: "intro-auto" } as const, { kind: "release-stage" } as const]
        : state.intro === "leaving"
          ? [{ kind: "clear-timer", timer: "intro-out" } as const]
          : []),
      ...claim(state, state.answer),
      payoff("draw-offered"),
    ],
  }
}

/** D10, D11: the wheel is left, once */
function leave(state: WheelState, cause: "tap" | "idle"): DrawScreenTransition {
  return {
    state: { ...state, exit: cause },
    commands: [
      { kind: "ceremony-report", cause },
      ...claim(state, state.answer),
      payoff(cause === "tap" ? "draw-continue" : "draw-idle"),
    ],
  }
}

/** the timers still armed in a wheel state */
function armedTimers(state: WheelState): DrawTimer[] {
  return [
    ...(state.intro === "up" ? ["intro-auto" as const] : state.intro === "leaving" ? ["intro-out" as const] : []),
    ...(state.stage === "mounted" ? ["progress" as const] : []),
  ]
}

/** D13 */
function unmounted(state: DrawScreenState): DrawScreenTransition {
  const closed: DrawScreenState = { ...base(state), phase: "closed" }
  if (state.phase !== "wheel") return { state: closed, commands: [] }
  return {
    state: closed,
    commands: [
      ...armedTimers(state).map((timer) => ({ kind: "clear-timer", timer }) as const),
      { kind: "detach-idle" },
      { kind: "destroy-stage" },
      { kind: "ceremony-report", cause: "left" },
    ],
  }
}

function wheelStep(state: WheelState, event: DrawScreenEvent): DrawScreenTransition {
  const left = state.exit !== null
  switch (event.type) {
    case "load-answered":
      // the page's own read, after a preloaded answer: the draw is logged again
      return event.answer.kind === "ready" ? { state, commands: [shows(state.answer)] } : stay(state)
    case "stage-mounted":
      if (state.stage !== "loading") return stay(state)
      return {
        state: { ...state, stage: "mounted" },
        commands: [
          { kind: "ceremony", mark: "mounted" },
          { kind: "arm-timer", timer: "progress", ms: event.progressMs + (event.held ? INTRO_AUTO_MS : 0) },
        ],
      }
    case "stage-waiting":
      // the player's own time at the coin is not the animation's: the wait's own, longer bound (COIN_WAIT_MS)
      if (state.stage !== "mounted") return stay(state)
      return {
        state,
        commands: [
          { kind: "clear-timer", timer: "progress" },
          { kind: "arm-timer", timer: "progress", ms: COIN_WAIT_MS },
        ],
      }
    case "stage-started":
      // the bound is the animation's: the player's own wait at the coin is not counted
      if (state.stage !== "mounted") return stay(state)
      return {
        state,
        commands: [
          { kind: "clear-timer", timer: "progress" },
          { kind: "arm-timer", timer: "progress", ms: event.progressMs },
        ],
      }
    case "stage-failed":
      return state.stage === "loading" ? fallback(state, event.reason === "load" ? "load-failed" : "mount-failed") : stay(state)
    case "stage-ended":
      if (state.stage !== "mounted") return stay(state)
      return {
        state: { ...state, stage: "offered" },
        commands: [
          { kind: "clear-timer", timer: "progress" },
          { kind: "ceremony", mark: "ended" },
          ...claim(state, state.answer),
          payoff("draw-offered"),
        ],
      }
    case "timer":
      if (event.timer === "progress") return state.stage === "mounted" ? fallback(state, "never-ended") : stay(state)
      if (event.timer === "intro-auto")
        return state.intro === "up"
          ? {
              state: { ...state, intro: "leaving" },
              commands: [{ kind: "release-stage" }, { kind: "arm-timer", timer: "intro-out", ms: INTRO_OUT_MS }],
            }
          : stay(state)
      return state.intro === "leaving" ? { state: { ...state, intro: "off" }, commands: [] } : stay(state)
    case "stage-done":
    case "continue":
      return !left && (state.stage === "offered" || state.stage === "fallback") ? leave(state, "tap") : stay(state)
    case "idle-elapsed":
      return !left && (state.stage === "offered" || state.stage === "fallback") ? leave(state, "idle") : stay(state)
    case "hidden":
    case "visible":
      return { state, commands: [{ kind: "ceremony", mark: event.type }] }
    case "page-left":
      return { state, commands: [{ kind: "ceremony-report", cause: "left" }] }
    default:
      return stay(state)
  }
}

/** Pure transition: no clocks, storage, framework calls or side effects. */
export function drawScreenStep(state: DrawScreenState, event: DrawScreenEvent): DrawScreenTransition {
  if (state.phase === "closed") return stay(state)
  if ("epoch" in event && event.epoch !== state.epoch) return stay(state)
  if (event.type === "unmounted") return unmounted(state)
  switch (state.phase) {
    case "new":
      return event.type === "opened" ? opened(state, event) : stay(state)
    case "loading":
    case "waiting":
      if (event.type === "load-answered") return answered(state, event.answer, event.payoffTag)
      if (event.type === "load-waiting" && state.phase === "loading")
        return { state: { ...state, phase: "waiting" }, commands: [log({ what: "shows", shown: "Drawing the winners…", draw: null })] }
      // D2: the read failed, and nothing reads again
      if (event.type === "load-failed")
        return {
          state: { ...state, phase: "failed" },
          commands: [log({ what: "shows", shown: "Couldn't load the draw", draw: null }), payoff("draw-error")],
        }
      return event.type === "bypass" && state.phase === "waiting" ? { state, commands: [payoff("draw-bypass")] } : stay(state)
    case "failed":
    case "no-identity":
      return event.type === "bypass" ? { state, commands: [payoff("draw-bypass")] } : stay(state)
    case "none":
      return stay(state)
    case "words":
      if (event.type === "continue") return { state, commands: [...claim(state, state.answer), payoff("draw-continue")] }
      if (event.type === "idle-elapsed") return { state, commands: [...claim(state, state.answer), payoff("draw-idle")] }
      return event.type === "load-answered" && event.answer.kind === "ready"
        ? { state, commands: [shows(state.answer), ...claim(state, state.answer)] }
        : stay(state)
    case "wheel":
      return wheelStep(state, event)
  }
}

/** what the screen shows: a pure projection of the state */
export function drawScreenView(state: DrawScreenState): DrawScreenView {
  switch (state.phase) {
    case "waiting":
    case "failed":
    case "no-identity":
      return { kind: "message", message: state.phase }
    case "none":
      return { kind: "blank", label: "Opening your collectables" }
    case "words":
      return { kind: "words", draw: state.answer.draw, miss: state.answer.miss }
    case "wheel":
      return {
        kind: "wheel",
        draw: state.answer.draw,
        miss: state.answer.miss,
        intro: state.intro === "off" ? null : state.intro,
        fallback: state.stage === "fallback",
        offered: state.stage === "offered",
      }
    default:
      return { kind: "blank" }
  }
}
