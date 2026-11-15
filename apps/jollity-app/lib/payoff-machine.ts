// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The post-game payoff policy. This reducer owns ordering only: pages perform
 * chain reads, timers, navigation and telemetry, then feed their results back.
 *
 * The draw, then the chest, then out: the chest's Continue ends the payoff,
 * sends the game's log, and hands the player over to Humanity
 * (lib/membership/humanity-target). A won prize is claimed on the draw screen
 * by itself (lib/draw/auto-claim), outside this reducer.
 */

export type PayoffRoute = "/prize-draw" | "/chest"
export type PayoffOutcome = "shown" | "stalled"
export type PayoffActiveKind =
  | "draw-waiting"
  | "draw-showing"
  | "chest-reading"
  | "chest-showing"

interface ActivePayoff {
  kind: PayoffActiveKind
  gameIndex: number
  epoch: number
  route: PayoffRoute
  stalled: boolean
  drawFactSent: boolean
}

interface EndedPayoff {
  kind: "ended"
  gameIndex: number
  epoch: number
  route: PayoffRoute
  outcome: PayoffOutcome
}

export type PayoffState = ActivePayoff | EndedPayoff

interface TaggedEvent {
  gameIndex: number
  epoch: number
}

export type PayoffTag = TaggedEvent

export type PayoffInput =
    | { type: "draw-result" | "draw-none" | "draw-bypass" | "draw-continue" | "draw-idle" | "draw-error" }
    /** the draw screen has a way on up (its Continue, the words, a fallback): the idle may start */
    | { type: "draw-offered" }
    | { type: "chest-opened" | "chest-result" | "chest-error" | "chest-reread-due" | "chest-continue" | "chest-skip" }
    | { type: "payoff-stalled"; stage: string }
    | { type: "next-game" | "return-after-long-absence" | "app-gone" }
    | { type: "hidden" | "visible"; at: number }

export type PayoffEvent = TaggedEvent & PayoffInput

type PayoffFact = "drawShown" | "chestOpened" | "chestShown" | "payoffStalled"

export type PayoffCommand =
  | { kind: "telemetry"; fact: Exclude<PayoffFact, "payoffStalled"> }
  | { kind: "telemetry"; fact: "payoffStalled"; stage: string }
  | { kind: "replace-route"; route: PayoffRoute }
  | { kind: "arm-draw-idle" }
  | { kind: "cancel-draw-idle" }
  | { kind: "mark-draw-seen" }
  | { kind: "load-chest" }
  /** leave the game for the player's Humanity card (lib/membership/humanity-target) */
  | { kind: "hand-off" }
  | { kind: "end-payoff"; outcome: PayoffOutcome; cause: "handed-off" | "next-game" | "app-gone"; sendGameLog: boolean }

export interface PayoffTransition {
  state: PayoffState
  commands: PayoffCommand[]
}

const routeKind = (route: PayoffRoute): PayoffActiveKind => (route === "/prize-draw" ? "draw-waiting" : "chest-reading")

/**
 * A reload bootstrap is deliberately silent. The payoff journey itself opens
 * only when finishReport calls reportLanded; a missed report or direct payoff
 * relaunch therefore has no journey, and the existing telemetry executor
 * treats later facts as no-ops. The page route still needs reducer state so it
 * can keep the page's navigation without inventing a journey on reload.
 */
export function startPayoff(gameIndex: number, route: PayoffRoute, prior?: { ended?: PayoffOutcome; epoch?: number }): PayoffState {
  const epoch = prior?.epoch ?? 0
  if (prior?.ended) return { kind: "ended", gameIndex, epoch, route, outcome: prior.ended }
  return { kind: routeKind(route), gameIndex, epoch, route, stalled: false, drawFactSent: false }
}

export const payoffTag = (state: PayoffState): PayoffTag => ({ gameIndex: state.gameIndex, epoch: state.epoch })

const unchanged = (state: PayoffState): PayoffTransition => ({ state, commands: [] })

/** the chest is left: the payoff is over, its log goes, and so does the player */
const handOff = (state: ActivePayoff): PayoffTransition => {
  const outcome: PayoffOutcome = state.stalled ? "stalled" : "shown"
  return {
    state: { kind: "ended", gameIndex: state.gameIndex, epoch: state.epoch, route: state.route, outcome },
    commands: [{ kind: "end-payoff", outcome, cause: "handed-off", sendGameLog: true }, { kind: "hand-off" }],
  }
}

const active = (state: ActivePayoff, kind: PayoffActiveKind, route: PayoffRoute = state.route): ActivePayoff => ({
  ...state,
  kind,
  route,
})

/** Pure transition: no clocks, storage, framework calls or side effects. */
export function payoff(state: PayoffState, event: PayoffEvent): PayoffTransition {
  // These lifecycle observations do not alter the payoff route or facts.
  // They stay explicit inputs, so a policy that needs them lives here, not
  // in the pages.
  if (event.type === "return-after-long-absence" || event.type === "hidden" || event.type === "visible") return unchanged(state)
  if (state.kind === "ended" || event.gameIndex !== state.gameIndex || event.epoch !== state.epoch) return unchanged(state)

  switch (event.type) {
    case "draw-result":
      if (state.drawFactSent) return unchanged(state)
      if (state.kind !== "draw-waiting")
        return { state: { ...state, drawFactSent: true }, commands: [{ kind: "telemetry", fact: "drawShown" }] }
      return {
        state: { ...active(state, "draw-showing"), drawFactSent: true },
        commands: [{ kind: "telemetry", fact: "drawShown" }],
      }
    // the 60 s idle counts from the way on, not from the draw coming up: a
    // spectator is never moved on before their Continue
    case "draw-offered":
      return state.kind === "draw-showing" ? { state, commands: [{ kind: "arm-draw-idle" }] } : unchanged(state)
    case "draw-error":
      return unchanged(state)
    case "draw-none":
      if (state.drawFactSent) return unchanged(state)
      if (state.kind !== "draw-waiting")
        return { state: { ...state, drawFactSent: true }, commands: [{ kind: "telemetry", fact: "drawShown" }] }
      return {
        state: { ...active(state, "chest-reading", "/chest"), drawFactSent: true },
        commands: [
          { kind: "telemetry", fact: "drawShown" },
          { kind: "cancel-draw-idle" },
          { kind: "load-chest" },
          { kind: "replace-route", route: "/chest" },
        ],
      }
    case "draw-continue":
    case "draw-idle":
      if (state.kind !== "draw-showing") return unchanged(state)
      return {
        state: active(state, "chest-reading", "/chest"),
        commands: [
          ...(event.type === "draw-continue" ? ([{ kind: "mark-draw-seen" }] as const) : []),
          { kind: "cancel-draw-idle" },
          { kind: "load-chest" },
          { kind: "replace-route", route: "/chest" },
        ],
      }
    case "draw-bypass":
      if (state.kind !== "draw-waiting") return unchanged(state)
      return {
        state: active(state, "chest-reading", "/chest"),
        commands: [{ kind: "load-chest" }, { kind: "replace-route", route: "/chest" }],
      }
    case "payoff-stalled":
      if (state.stalled) return unchanged(state)
      return { state: { ...state, stalled: true }, commands: [{ kind: "telemetry", fact: "payoffStalled", stage: event.stage }] }
    case "chest-opened":
      if (state.kind !== "chest-reading") return unchanged(state)
      return { state, commands: [{ kind: "telemetry", fact: "chestOpened" }] }
    case "chest-result":
      if (state.kind !== "chest-reading") return unchanged(state)
      return { state: active(state, "chest-showing"), commands: [{ kind: "telemetry", fact: "chestShown" }] }
    case "chest-error":
      return unchanged(state)
    case "chest-reread-due":
      if (state.kind !== "chest-reading") return unchanged(state)
      return {
        state: { ...state, epoch: state.epoch + 1 },
        commands: [{ kind: "load-chest" }],
      }
    case "chest-continue":
      if (state.kind !== "chest-showing") return unchanged(state)
      return handOff(state)
    case "chest-skip":
      // the chest is taking longer than usual (lib/slow-payoff): the
      // player leaves without it, and the chest stays unseen for the chat to
      // point at
      if (state.kind !== "chest-reading") return unchanged(state)
      return handOff(state)
    case "next-game":
      return {
        state: { kind: "ended", gameIndex: state.gameIndex, epoch: state.epoch, route: state.route, outcome: "stalled" },
        commands: [{ kind: "end-payoff", outcome: "stalled", cause: "next-game", sendGameLog: false }],
      }
    case "app-gone": {
      const outcome: PayoffOutcome = "stalled"
      return {
        state: { kind: "ended", gameIndex: state.gameIndex, epoch: state.epoch, route: state.route, outcome },
        commands: [{ kind: "end-payoff", outcome, cause: "app-gone", sendGameLog: false }],
      }
    }
  }
}
