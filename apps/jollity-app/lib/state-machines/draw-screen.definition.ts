// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import {
  drawScreenStep,
  drawScreenView,
  startDrawScreen,
  type DrawAnswer,
  type DrawScreenCommand,
  type DrawScreenEvent,
  type DrawScreenState,
} from "../draw/draw-screen"
import type { PrizeDrawView } from "../draw/prize-draw"
import { winnersByRule } from "../draw/wheel/rule"
import type { PayoffTag } from "../payoff-machine"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

// ── the draws the screen is handed ─────────────────────────────────────────

/** each draw a test hands the screen, with what the rules say about it (D4) — written down, never computed by checkWheel */
const CASES = {
  won: { spectator: false, won: true, wheel: true, line: "the wheel", noWheel: null },
  lost: { spectator: false, won: false, wheel: true, line: "the wheel", noWheel: null },
  spectator: { spectator: true, won: false, wheel: true, line: "the wheel, watching: You weren't in this draw", noWheel: null },
  "words-won": { spectator: false, won: true, wheel: false, line: "You won (words, no wheel)", noWheel: "the chain has no ticket list or target for this draw" },
  "words-lost": { spectator: false, won: false, wheel: false, line: "Not this time (words, no wheel)", noWheel: "the chain has no ticket list or target for this draw" },
  "words-out": { spectator: true, won: false, wheel: false, line: "You weren't in this draw", noWheel: "the chain has no ticket list or target for this draw" },
  // the chain says won, but the rule lands elsewhere: the words, never a wheel that contradicts it
  disagree: { spectator: false, won: true, wheel: false, line: "You won (words, no wheel)", noWheel: "the rule and the chain disagree on the player's result" },
} as const
export type DrawCase = keyof typeof CASES
const DRAW_CASES = Object.keys(CASES) as DrawCase[]

const slot = (n: number): string => n.toString(16).padStart(64, "0")
const TICKETS = [1, 2, 3, 4].map(slot)
const MINE = slot(2)

function drawFor(name: DrawCase): PrizeDrawView {
  const spec = CASES[name]
  // one winner: a win cuts at the player's own slot, anything else just after it
  const target = name === "won" ? MINE : slot(3)
  return {
    gameIndex: 7,
    airdropIndex: 0,
    phase: "drawn",
    prizeUsd: 200,
    prizeSymbol: null,
    claimed: false,
    claimable: false,
    claimBlockedReason: null,
    userTicket: spec.spectator ? "" : MINE,
    won: spec.won,
    totalEntries: TICKETS.length,
    winningTickets: winnersByRule(TICKETS, target, 1),
    wheel: name.startsWith("words-") ? null : { tickets: TICKETS, target, winners: 1 },
  }
}

const DRAWS = Object.fromEntries(DRAW_CASES.map((name) => [name, drawFor(name)])) as Record<DrawCase, PrizeDrawView>
/** the fixture draw for a case, for the reducer's own tests */
export const drawScreenDraw = (name: DrawCase): PrizeDrawView => DRAWS[name]
const caseOf = (draw: PrizeDrawView | null): string => (draw === null ? "-" : (DRAW_CASES.find((name) => DRAWS[name] === draw) ?? "unknown"))
/** a spectator is told why they are not in the draw, when this phone knows */
const missOf = (name: DrawCase) => (CASES[name].spectator ? ("closed" as const) : null)
const answerOf = (name: DrawCase): DrawAnswer => ({ kind: "ready", draw: DRAWS[name], miss: missOf(name) })

const OPENED_TAG: PayoffTag = { gameIndex: 7, epoch: 0 }
const ANSWER_TAG: PayoffTag = { gameIndex: 7, epoch: 3 }
const PROGRESS_MS = 40_000
const OVERRIDE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"

// ── events ─────────────────────────────────────────────────────────────────

const SIMPLE_KEYS = [
  "opened",
  "load-waiting",
  "load-answered:spectator",
  "load-answered:none",
  "load-answered:no-identity",
  "load-failed",
  "stage-ended",
  "stage-done",
  "timer:intro-auto",
  "timer:intro-out",
  "timer:progress",
  "idle-elapsed",
  "continue",
  "bypass",
  "hidden",
  "visible",
  "page-left",
  "unmounted",
] as const

type SimpleKey = (typeof SIMPLE_KEYS)[number]

export type DrawScreenTestEvent =
  | { [K in SimpleKey]: { key: K } }[SimpleKey]
  | { key: "opened:preloaded"; preload: DrawCase | "none" | "no-identity" }
  | { key: "load-answered:wheel"; draw: "won" | "lost" }
  | { key: "load-answered:words"; draw: "words-won" | "words-lost" | "words-out" | "disagree" }
  | { key: "stage-mounted"; held: boolean }
  | { key: "stage-failed"; reason: "load" | "mount" }
  /** a load's event, stamped with an epoch that is not the screen's */
  | { key: "stale"; of: "load-waiting" | "load-answered" | "load-failed"; ahead: boolean }

export type DrawScreenEventKey = DrawScreenTestEvent["key"]

export const drawScreenEventKeys = [
  ...SIMPLE_KEYS,
  "opened:preloaded",
  "load-answered:wheel",
  "load-answered:words",
  "stage-mounted",
  "stage-failed",
  "stale",
] as const satisfies readonly DrawScreenEventKey[]

/** one representative of each key: the explorer's alphabet, and every witness's last step */
export const representative: Record<DrawScreenEventKey, DrawScreenTestEvent> = {
  ...(Object.fromEntries(SIMPLE_KEYS.map((key) => [key, { key }])) as Record<SimpleKey, DrawScreenTestEvent>),
  "opened:preloaded": { key: "opened:preloaded", preload: "won" },
  "load-answered:wheel": { key: "load-answered:wheel", draw: "won" },
  "load-answered:words": { key: "load-answered:words", draw: "words-won" },
  "stage-mounted": { key: "stage-mounted", held: false },
  "stage-failed": { key: "stage-failed", reason: "mount" },
  stale: { key: "stale", of: "load-answered", ahead: false },
}

const ev = (key: DrawScreenEventKey): DrawScreenTestEvent => representative[key]

/** the reducer's event for a test event, stamped as the host would stamp it from `epoch` */
function concrete(event: DrawScreenTestEvent, epoch: number): DrawScreenEvent {
  switch (event.key) {
    case "opened":
      return { type: "opened", payoffTag: OPENED_TAG }
    case "opened:preloaded":
      return {
        type: "opened",
        preloaded: event.preload === "none" || event.preload === "no-identity" ? { kind: event.preload } : answerOf(event.preload),
        payoffTag: OPENED_TAG,
      }
    case "load-waiting":
    case "load-failed":
      return { type: event.key, epoch }
    case "load-answered:wheel":
    case "load-answered:words":
      return { type: "load-answered", epoch, answer: answerOf(event.draw), payoffTag: ANSWER_TAG }
    case "load-answered:spectator":
      return { type: "load-answered", epoch, answer: answerOf("spectator"), payoffTag: ANSWER_TAG }
    case "load-answered:none":
      return { type: "load-answered", epoch, answer: { kind: "none" }, payoffTag: ANSWER_TAG }
    case "load-answered:no-identity":
      return { type: "load-answered", epoch, answer: { kind: "no-identity" }, payoffTag: ANSWER_TAG }
    case "stale": {
      const stale = epoch + (event.ahead ? 1 : -1)
      return event.of === "load-answered"
        ? { type: "load-answered", epoch: stale, answer: answerOf("won"), payoffTag: ANSWER_TAG }
        : { type: event.of, epoch: stale }
    }
    case "stage-mounted":
      return { type: "stage-mounted", held: event.held, progressMs: PROGRESS_MS }
    case "stage-failed":
      return { type: "stage-failed", reason: event.reason }
    case "timer:intro-auto":
    case "timer:intro-out":
    case "timer:progress":
      return { type: "timer", timer: event.key.slice("timer:".length) as "intro-auto" | "intro-out" | "progress" }
    default:
      return { type: event.key }
  }
}

// ── state keys and the hand-written table ──────────────────────────────────

const WHEEL_KEYS = [
  "wheel|loading|up|left:0",
  "wheel|loading|leaving|left:0",
  "wheel|loading|off|left:0",
  "wheel|mounted|up|left:0",
  "wheel|mounted|leaving|left:0",
  "wheel|mounted|off|left:0",
  "wheel|offered|up|left:0",
  "wheel|offered|leaving|left:0",
  "wheel|offered|off|left:0",
  "wheel|offered|up|left:1",
  "wheel|offered|leaving|left:1",
  "wheel|offered|off|left:1",
  "wheel|fallback|off|left:0",
  "wheel|fallback|off|left:1",
] as const
export const drawScreenStateKeys = ["new", "loading", "waiting", "failed", "no-identity", "none", "words", "closed", ...WHEEL_KEYS] as const
export type DrawScreenStateKey = (typeof drawScreenStateKeys)[number]

const READY_ANSWERS = ["load-answered:wheel", "load-answered:spectator", "load-answered:words"] as const
const ANSWERS = [...READY_ANSWERS, "load-answered:none", "load-answered:no-identity"] as const

/** the event keys that change something in each state, from the rules; every other key is a no-op there */
function transitionsForState(stateKey: DrawScreenStateKey): readonly DrawScreenEventKey[] {
  switch (stateKey) {
    case "new":
      return ["opened", "opened:preloaded", "unmounted"]
    case "loading":
      return [...ANSWERS, "load-waiting", "load-failed", "unmounted"]
    case "waiting":
      return [...ANSWERS, "load-failed", "bypass", "unmounted"]
    case "failed":
    case "no-identity":
      return ["bypass", "unmounted"]
    case "none":
      return ["unmounted"]
    case "words":
      return [...READY_ANSWERS, "continue", "idle-elapsed", "unmounted"]
    case "closed":
      return []
  }
  const [, stage, intro, leftPart] = stateKey.split("|")
  const left = leftPart === "left:1"
  const keys: DrawScreenEventKey[] = [...READY_ANSWERS, "hidden", "visible", "page-left", "unmounted"]
  if (stage === "loading") keys.push("stage-mounted", "stage-failed")
  if (stage === "mounted") keys.push("stage-ended", "timer:progress")
  if (intro === "up") keys.push("timer:intro-auto")
  if (intro === "leaving") keys.push("timer:intro-out")
  // the idle runs only once a way on is offered (D11)
  if (!left && (stage === "offered" || stage === "fallback")) keys.push("stage-done", "continue", "idle-elapsed")
  return keys
}

const row = (transitions: readonly DrawScreenEventKey[]) =>
  Object.fromEntries(drawScreenEventKeys.map((key) => [key, transitions.includes(key) ? "transition" : "no-op"])) as Record<
    DrawScreenEventKey,
    "transition" | "no-op"
  >

export const drawScreenTransitionTable = defineTransitionTable<DrawScreenStateKey, DrawScreenEventKey>()(
  Object.fromEntries(drawScreenStateKeys.map((stateKey) => [stateKey, row(transitionsForState(stateKey))])) as Record<
    DrawScreenStateKey,
    Record<DrawScreenEventKey, "transition" | "no-op">
  >,
)

// ── the independent model ──────────────────────────────────────────────────

type ModelTimer = "intro-auto" | "intro-out" | "progress"
const TIMER_ORDER: readonly ModelTimer[] = ["intro-auto", "intro-out", "progress"]

/** The screen as the page, WheelStage and ceremony hold it: flags, not phases. It imports no reducer code. */
export interface ModelDrawScreen {
  life: "new" | "open" | "gone"
  epoch: number
  override: boolean
  read: "pending" | "waiting" | "failed" | "none" | "no-identity" | "shown"
  draw: DrawCase | null
  /** the intro's own phase; "gone" for a player, who has none */
  intro: "up" | "leaving" | "gone"
  mounted: boolean
  /** the ceremony's continueAt, and what set it first */
  continueBy: null | "ended" | "fallback"
  navigated: null | "tap" | "idle"
  /** the timers armed and not yet fired or cleared, in TIMER_ORDER */
  timers: ModelTimer[]
}

const modelStart = (override = false): ModelDrawScreen => ({
  life: "new",
  epoch: 0,
  override,
  read: "pending",
  draw: null,
  intro: "gone",
  mounted: false,
  continueBy: null,
  navigated: null,
  timers: [],
})

const tagOf = (tag: PayoffTag): string => `${tag.gameIndex}/${tag.epoch}`
const isWheel = (m: ModelDrawScreen): boolean => m.read === "shown" && m.draw !== null && CASES[m.draw].wheel
const arm = (m: ModelDrawScreen, timer: ModelTimer): void => {
  m.timers = TIMER_ORDER.filter((t) => t === timer || m.timers.includes(t))
}
const disarm = (m: ModelDrawScreen, timer: ModelTimer): void => {
  m.timers = m.timers.filter((t) => t !== timer)
}

/** Independent executable model of rules D1–D15. */
function modelDrawScreen(previous: ModelDrawScreen, event: DrawScreenTestEvent): { state: ModelDrawScreen; output: string[] } {
  const m: ModelDrawScreen = { ...previous, timers: [...previous.timers] }
  const out: string[] = []
  const done = () => ({ state: m, output: out })
  const claims = (): boolean => m.draw !== null && CASES[m.draw].won && !m.override
  const claim = () => {
    if (claims()) out.push("start-claim")
  }
  // D13, D14: a page that is gone, and a load's answer from another epoch, change nothing
  if (m.life === "gone" || event.key === "stale") return { state: previous, output: [] }

  const land = (what: DrawCase | "none" | "no-identity", tag: PayoffTag) => {
    if (what === "none") {
      m.read = "none"
      out.push("log:no-draw", `payoff:draw-none:${tagOf(tag)}`)
      return
    }
    if (what === "no-identity") {
      m.read = "no-identity"
      out.push("log:shows:No player identity:-")
      return
    }
    const spec = CASES[what]
    m.read = "shown"
    m.draw = what
    if (!spec.wheel) {
      out.push(`log:no-wheel:${spec.noWheel}`, `log:shows:${spec.line}:${what}`, `payoff:draw-result:${tagOf(tag)}`)
      claim()
      out.push("payoff:draw-offered")
      return
    }
    out.push(
      `log:shows:${spec.line}:${what}`,
      `payoff:draw-result:${tagOf(tag)}`,
      "ceremony:load-started",
      `start-stage:held=${spec.spectator ? 1 : 0}:coin=${spec.spectator ? 0 : 1}:prize=${spec.won ? 1 : 0}`,
    )
    if (spec.spectator) {
      m.intro = "up"
      arm(m, "intro-auto")
      out.push("arm-timer:intro-auto:8000")
    }
  }
  const fallback = (reason: string) => {
    m.continueBy = "fallback"
    out.push(`ceremony-fallback:${reason}`)
    if (m.timers.includes("intro-auto")) out.push("clear-timer:intro-auto", "release-stage")
    if (m.timers.includes("intro-out")) out.push("clear-timer:intro-out")
    disarm(m, "intro-auto")
    disarm(m, "intro-out")
    m.intro = "gone"
    claim()
    out.push("payoff:draw-offered")
  }
  const leave = (cause: "tap" | "idle") => {
    m.navigated = cause
    out.push(`ceremony-report:${cause}`)
    claim()
    out.push(cause === "tap" ? "payoff:draw-continue" : "payoff:draw-idle")
  }

  if (event.key === "unmounted") {
    if (isWheel(m)) out.push(...m.timers.map((timer) => `clear-timer:${timer}`), "detach-idle", "destroy-stage", "ceremony-report:left")
    m.life = "gone"
    m.timers = []
    return done()
  }
  if (m.life === "new") {
    if (event.key !== "opened" && event.key !== "opened:preloaded") return done()
    const preload = event.key === "opened" ? "nothing" : event.preload
    m.life = "open"
    m.epoch += 1
    out.push(
      `log:opened:${preload === "nothing" ? "nothing" : preload === "no-identity" ? "no identity" : preload === "none" ? "none" : "ready"}`,
      "preload-collectables",
      `load-draw:${m.epoch}`,
    )
    if (preload !== "nothing" && preload !== "no-identity") land(preload, OPENED_TAG)
    return done()
  }

  const answer: DrawCase | "none" | "no-identity" | null =
    event.key === "load-answered:wheel" || event.key === "load-answered:words"
      ? event.draw
      : event.key === "load-answered:spectator"
        ? "spectator"
        : event.key === "load-answered:none"
          ? "none"
          : event.key === "load-answered:no-identity"
            ? "no-identity"
            : null

  // D1–D3: waiting on the read
  if (m.read === "pending" || m.read === "waiting") {
    if (answer !== null) land(answer, ANSWER_TAG)
    else if (event.key === "load-waiting" && m.read === "pending") {
      m.read = "waiting"
      out.push("log:shows:Drawing the winners…:-")
    } else if (event.key === "load-failed") {
      // D2: a failed read says so, with a way on
      m.read = "failed"
      out.push("log:shows:Couldn't load the draw:-", "payoff:draw-error")
    } else if (event.key === "bypass" && m.read === "waiting") out.push("payoff:draw-bypass")
    return done()
  }
  if (m.read === "no-identity" || m.read === "failed") {
    if (event.key === "bypass") out.push("payoff:draw-bypass")
    return done()
  }
  if (m.read === "none" || m.draw === null) return done()

  // a ready answer again (the page's own read after a preloaded one): logged again, and the words claim again
  const again = answer !== null && answer !== "none" && answer !== "no-identity"
  if (!CASES[m.draw].wheel) {
    // D5: the words
    if (event.key === "continue" || event.key === "idle-elapsed") {
      claim()
      out.push(event.key === "continue" ? "payoff:draw-continue" : "payoff:draw-idle")
    } else if (again) {
      out.push(`log:shows:${CASES[m.draw].line}:${m.draw}`)
      claim()
    }
    return done()
  }

  // D6–D12: the wheel
  const stageLoading = !m.mounted && m.continueBy === null
  if (again) out.push(`log:shows:${CASES[m.draw].line}:${m.draw}`)
  else if (event.key === "stage-mounted" && stageLoading) {
    m.mounted = true
    arm(m, "progress")
    out.push("ceremony:mounted", `arm-timer:progress:${PROGRESS_MS + (event.held ? 8000 : 0)}`)
  } else if (event.key === "stage-failed" && stageLoading) fallback(event.reason === "load" ? "load-failed" : "mount-failed")
  else if (event.key === "stage-ended" && m.mounted && m.continueBy === null) {
    m.continueBy = "ended"
    disarm(m, "progress")
    out.push("clear-timer:progress", "ceremony:ended")
    claim()
    out.push("payoff:draw-offered")
  } else if (event.key === "timer:progress" && m.timers.includes("progress")) {
    disarm(m, "progress")
    fallback("never-ended")
  } else if (event.key === "timer:intro-auto" && m.timers.includes("intro-auto")) {
    m.intro = "leaving"
    disarm(m, "intro-auto")
    arm(m, "intro-out")
    out.push("release-stage", "arm-timer:intro-out:500")
  } else if (event.key === "timer:intro-out" && m.timers.includes("intro-out")) {
    m.intro = "gone"
    disarm(m, "intro-out")
  } else if ((event.key === "stage-done" || event.key === "continue") && m.continueBy !== null && !m.navigated) leave("tap")
  else if (event.key === "idle-elapsed" && m.continueBy !== null && !m.navigated) leave("idle")
  else if (event.key === "hidden" || event.key === "visible") out.push(`ceremony:${event.key}`)
  else if (event.key === "page-left") out.push("ceremony-report:left")
  return done()
}

function modelKey(m: ModelDrawScreen): DrawScreenStateKey {
  if (m.life === "new") return "new"
  if (m.life === "gone") return "closed"
  if (m.read === "pending") return "loading"
  if (m.read !== "shown") return m.read
  if (!isWheel(m)) return "words"
  const stage = m.continueBy === "fallback" ? "fallback" : m.continueBy === "ended" ? "offered" : m.mounted ? "mounted" : "loading"
  return `wheel|${stage}|${m.intro === "gone" ? "off" : m.intro}|left:${m.navigated ? 1 : 0}` as DrawScreenStateKey
}

function modelView(m: ModelDrawScreen): string {
  if (m.life === "open" && m.read === "none") return "blank:Opening your collectables"
  if (m.life === "open" && (m.read === "waiting" || m.read === "failed" || m.read === "no-identity")) return `message:${m.read}`
  if (m.life !== "open" || m.read !== "shown" || m.draw === null) return "blank"
  const what = `${m.draw}:miss=${missOf(m.draw) ?? "-"}`
  if (!isWheel(m)) return `words:${what}`
  const intro = m.continueBy === "fallback" || m.intro === "gone" ? "-" : m.intro
  return `wheel:${what}:intro=${intro}:fallback=${m.continueBy === "fallback" ? 1 : 0}`
}

// ── observations ───────────────────────────────────────────────────────────

export interface DrawScreenObservation {
  key: DrawScreenStateKey
  view: string
  commands: string[]
}

function normalizeCommand(command: DrawScreenCommand): string {
  switch (command.kind) {
    case "load-draw":
      return `load-draw:${command.epoch}`
    case "payoff":
      return `payoff:${command.input.type}${command.tag ? `:${tagOf(command.tag)}` : ""}`
    case "start-stage":
      return `start-stage:held=${command.held ? 1 : 0}:coin=${command.coin ? 1 : 0}:prize=${command.prize ? 1 : 0}`
    case "arm-timer":
      return `arm-timer:${command.timer}:${command.ms}`
    case "clear-timer":
      return `clear-timer:${command.timer}`
    case "ceremony":
      return `ceremony:${command.mark}`
    case "ceremony-fallback":
      return `ceremony-fallback:${command.reason}`
    case "ceremony-report":
      return `ceremony-report:${command.cause}`
    case "log": {
      const { note } = command
      if (note.what === "opened") return `log:opened:${note.preloaded}`
      if (note.what === "shows") return `log:shows:${note.shown}:${caseOf(note.draw)}`
      return note.what === "no-wheel" ? `log:no-wheel:${note.reason}` : "log:no-draw"
    }
    default:
      return command.kind
  }
}

function realStateKey(state: DrawScreenState): DrawScreenStateKey {
  if (state.phase !== "wheel") return state.phase
  return `wheel|${state.stage}|${state.intro}|left:${state.exit ? 1 : 0}` as DrawScreenStateKey
}

function realView(state: DrawScreenState): string {
  const view = drawScreenView(state)
  switch (view.kind) {
    case "blank":
      return view.label ? `blank:${view.label}` : "blank"
    case "message":
      return `message:${view.message}`
    case "words":
      return `words:${caseOf(view.draw)}:miss=${view.miss ?? "-"}`
    case "wheel":
      return `wheel:${caseOf(view.draw)}:miss=${view.miss ?? "-"}:intro=${view.intro ?? "-"}:fallback=${view.fallback ? 1 : 0}`
  }
}

// ── witnesses: a path to each state, then every event ──────────────────────

const opening = (answer: (typeof READY_ANSWERS)[number]): DrawScreenTestEvent[] => [ev("opened"), ev(answer)]
/** a spectator's stage, mounted held under the intro */
const held: DrawScreenTestEvent = { key: "stage-mounted", held: true }
const spectatorMounted = [...opening("load-answered:spectator"), held]
const playerMounted = [...opening("load-answered:wheel"), ev("stage-mounted")]

/** the shortest path from the start to each state key */
const drawScreenPaths: Record<DrawScreenStateKey, readonly DrawScreenTestEvent[]> = {
  new: [],
  loading: [ev("opened")],
  waiting: [ev("opened"), ev("load-waiting")],
  failed: [ev("opened"), ev("load-failed")],
  "no-identity": [ev("opened"), ev("load-answered:no-identity")],
  none: [ev("opened"), ev("load-answered:none")],
  words: [ev("opened"), ev("load-answered:words")],
  closed: [ev("opened"), ev("unmounted")],
  "wheel|loading|up|left:0": opening("load-answered:spectator"),
  "wheel|loading|leaving|left:0": [...opening("load-answered:spectator"), ev("timer:intro-auto")],
  "wheel|loading|off|left:0": opening("load-answered:wheel"),
  "wheel|mounted|up|left:0": spectatorMounted,
  "wheel|mounted|leaving|left:0": [...spectatorMounted, ev("timer:intro-auto")],
  "wheel|mounted|off|left:0": playerMounted,
  "wheel|offered|up|left:0": [...spectatorMounted, ev("stage-ended")],
  "wheel|offered|leaving|left:0": [...spectatorMounted, ev("timer:intro-auto"), ev("stage-ended")],
  "wheel|offered|off|left:0": [...playerMounted, ev("stage-ended")],
  "wheel|offered|up|left:1": [...spectatorMounted, ev("stage-ended"), ev("stage-done")],
  "wheel|offered|leaving|left:1": [...spectatorMounted, ev("timer:intro-auto"), ev("stage-ended"), ev("stage-done")],
  "wheel|offered|off|left:1": [...playerMounted, ev("stage-ended"), ev("stage-done")],
  "wheel|fallback|off|left:0": [...opening("load-answered:wheel"), ev("stage-failed")],
  "wheel|fallback|off|left:1": [...opening("load-answered:wheel"), ev("stage-failed"), ev("continue")],
}

export const drawScreenWitnesses: NamedSequence<DrawScreenTestEvent, DrawScreenState, ModelDrawScreen>[] = drawScreenStateKeys.flatMap(
  (stateKey) =>
    drawScreenEventKeys.map((eventKey) => ({
      name: `${stateKey} × ${eventKey}`,
      events: [...drawScreenPaths[stateKey], representative[eventKey]],
    })),
)

// ── regressions: today's behaviour, scenario by scenario (draw-screen.capture.test.tsx) ──

const overridden = { real: startDrawScreen({ game: 7, override: OVERRIDE }), model: modelStart(true) }
const wheelAnswer = (draw: "won" | "lost"): DrawScreenTestEvent => ({ key: "load-answered:wheel", draw })
const wordsAnswer = (draw: "words-won" | "words-lost" | "words-out" | "disagree"): DrawScreenTestEvent => ({ key: "load-answered:words", draw })

export const drawScreenRegressions: NamedSequence<DrawScreenTestEvent, DrawScreenState, ModelDrawScreen>[] = [
  { name: "a winner plays the wheel and goes on to the collectables screen", events: [ev("opened"), wheelAnswer("won"), ev("stage-mounted"), ev("stage-ended"), ev("stage-done"), ev("unmounted")] },
  { name: "a loser plays the wheel, and goes on once the fall has played", events: [ev("opened"), wheelAnswer("lost"), ev("stage-mounted"), ev("stage-ended"), ev("stage-done")] },
  {
    name: "a spectator is told what the draw is over the held stage, then watches it",
    events: [ev("opened"), ev("load-answered:spectator"), held, ev("timer:intro-auto"), ev("timer:intro-out"), ev("stage-ended"), ev("stage-done")],
  },
  { name: "a loss the wheel cannot tell is told in words", events: [ev("opened"), wordsAnswer("words-lost"), ev("continue")] },
  { name: "a win the wheel cannot tell is told in words, and claimed at once", events: [ev("opened"), wordsAnswer("words-won"), ev("continue")] },
  { name: "a win the rule disagrees with is told in words", events: [ev("opened"), wordsAnswer("disagree"), ev("continue"), ev("continue")] },
  { name: "no draw this game goes straight to the collectables screen", events: [ev("opened"), ev("load-answered:none"), ev("bypass"), ev("continue")] },
  { name: "a draw still drawing says so, and Continue skips it", events: [ev("opened"), ev("load-waiting"), ev("bypass"), ev("bypass")] },
  {
    name: "a draw still drawing that then lands plays the wheel",
    events: [ev("opened"), ev("load-waiting"), wheelAnswer("lost"), ev("stage-mounted"), ev("stage-ended"), ev("stage-done")],
  },
  { name: "no player identity says so, and Continue skips it", events: [ev("opened"), ev("load-answered:no-identity"), ev("bypass")] },
  { name: "a failed read says so, and Continue goes on to the collectables screen", events: [ev("opened"), ev("load-failed"), ev("continue"), ev("bypass"), ev("idle-elapsed"), ev("bypass")] },
  { name: "a failed read while drawing says so too", events: [ev("opened"), ev("load-waiting"), ev("load-failed"), ev("load-waiting"), ev("bypass")] },
  { name: "a stage whose code does not load falls back to words and the page's Continue", events: [ev("opened"), wheelAnswer("won"), { key: "stage-failed", reason: "load" }, ev("continue"), ev("continue")] },
  { name: "a stage that does not mount falls back to words and the page's Continue", events: [ev("opened"), wheelAnswer("lost"), { key: "stage-failed", reason: "mount" }, ev("continue")] },
  { name: "a stage that never ends falls back once its bound runs out", events: [ev("opened"), wheelAnswer("won"), ev("stage-mounted"), ev("timer:progress"), ev("stage-ended"), ev("continue")] },
  { name: "a player left idle is moved on a minute after their Continue", events: [ev("opened"), wheelAnswer("lost"), ev("stage-mounted"), ev("stage-ended"), ev("idle-elapsed"), ev("stage-done")] },
  { name: "a spectator is never moved on before their Continue", events: [ev("opened"), ev("load-answered:spectator"), held, ev("idle-elapsed"), ev("timer:intro-auto"), ev("idle-elapsed"), ev("stage-ended")] },
  { name: "an idle before the stage ends does nothing", events: [ev("opened"), wheelAnswer("won"), ev("stage-mounted"), ev("idle-elapsed"), ev("stage-ended"), ev("timer:progress")] },
  { name: "a stage that runs out offers its way on, and only then idles", events: [ev("opened"), wheelAnswer("won"), ev("stage-mounted"), ev("timer:progress"), ev("idle-elapsed"), ev("stage-done")] },
  { name: "the words move on after a minute too", events: [ev("opened"), wordsAnswer("words-won"), ev("idle-elapsed"), ev("continue")] },
  { name: "time hidden is counted in the ceremony", events: [ev("opened"), wheelAnswer("won"), ev("stage-mounted"), ev("hidden"), ev("visible"), ev("stage-ended"), ev("stage-done")] },
  {
    name: "a page hidden for good reports the ceremony once, and a later Continue still goes on",
    events: [ev("opened"), wheelAnswer("won"), ev("stage-mounted"), ev("page-left"), ev("stage-ended"), ev("stage-done"), ev("page-left")],
  },
  { name: "leaving the screen tears the stage down and reports the ceremony", events: [ev("opened"), wheelAnswer("won"), ev("stage-mounted"), ev("unmounted"), ev("stage-ended")] },
  { name: "unmounting a spectator clears the intro and the progress bound", events: [ev("opened"), ev("load-answered:spectator"), held, ev("unmounted")] },
  {
    name: "a draw preloaded on the confirm screen opens on the wheel, with no black frame",
    events: [{ key: "opened:preloaded", preload: "won" }, wheelAnswer("won"), ev("stage-mounted"), ev("stage-ended"), ev("stage-done")],
  },
  { name: "preloaded words claim again when the page's own read lands", events: [{ key: "opened:preloaded", preload: "words-won" }, wordsAnswer("words-won"), ev("continue")] },
  { name: "a preloaded no-identity still opens on the black frame", events: [{ key: "opened:preloaded", preload: "no-identity" }, ev("load-answered:no-identity"), ev("bypass")] },
  { name: "a preloaded no-draw goes straight to the collectables screen", events: [{ key: "opened:preloaded", preload: "none" }, ev("load-answered:none")] },
  { name: "a spectator whose intro outlasts the import mounts unheld", events: [ev("opened"), ev("load-answered:spectator"), ev("timer:intro-auto"), ev("stage-mounted"), ev("timer:intro-out")] },
  { name: "a fallback under the intro releases the stage and clears the intro", events: [ev("opened"), ev("load-answered:spectator"), held, ev("timer:progress"), ev("timer:intro-auto"), ev("continue")] },
  {
    name: "stale load answers are inert",
    events: [ev("opened"), { key: "stale", of: "load-answered", ahead: true }, { key: "stale", of: "load-waiting", ahead: false }, { key: "stale", of: "load-failed", ahead: true }, wheelAnswer("won")],
  },
  { name: "the ?player= override never claims", initial: overridden, events: [ev("opened"), wheelAnswer("won"), ev("stage-mounted"), ev("stage-ended"), ev("stage-done")] },
  { name: "the ?player= override never claims words", initial: overridden, events: [ev("opened"), wordsAnswer("words-won"), ev("continue")] },
]

// ── invariants 1–8 ─────────────────────────────────────────────────────────

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}
const count = (commands: readonly string[], match: (command: string) => boolean): number => commands.filter(match).length
const LEAVES = new Set(["ceremony-report:tap", "ceremony-report:idle"])
const isResult = (command: string): boolean => command.startsWith("payoff:draw-result") || command.startsWith("payoff:draw-none")

type Invariant = NamedInvariant<DrawScreenState, ModelDrawScreen, DrawScreenTestEvent, DrawScreenObservation, DrawScreenStateKey, DrawScreenEventKey>

export const drawScreenInvariants: Invariant[] = [
  {
    name: "closed absorbs every later event",
    specClause: "D13: after unmount, every event is inert",
    check: ({ previousReal, real, realObservation }) => {
      if (previousReal.phase !== "closed") return
      assert(JSON.stringify(real) === JSON.stringify(previousReal), "closed state changed")
      assert(realObservation.commands.length === 0, "closed state emitted a command")
    },
  },
  {
    name: "a stale result is inert",
    specClause: "D14: a stale epoch is inert",
    check: ({ previousReal, real, event, realObservation }) => {
      if (event.key !== "stale") return
      assert(JSON.stringify(real) === JSON.stringify(previousReal), "stale event changed state")
      assert(realObservation.commands.length === 0, "stale event emitted a command")
    },
  },
  {
    name: "the wheel is left at most once",
    specClause: "D10, D11: Continue, the stage's done or the idle leaves once",
    check: ({ trace }) => {
      const wheel = trace.filter((entry) => entry.before.startsWith("wheel|")).flatMap((entry) => entry.real.commands)
      const leaves = count(wheel, (command) => LEAVES.has(command))
      const onward = count(wheel, (command) => command === "payoff:draw-continue" || command === "payoff:draw-idle")
      assert(leaves <= 1 && onward <= 1, `the wheel was left ${leaves} times, onward sent ${onward} times`)
    },
  },
  {
    name: "a wheel draw-continue is sent only from offered or fallback",
    specClause: "D10: offered or fallback, then stage-done or Continue",
    check: ({ previousReal, realObservation }) => {
      if (previousReal.phase !== "wheel" || !realObservation.commands.includes("payoff:draw-continue")) return
      assert(previousReal.stage === "offered" || previousReal.stage === "fallback", `draw-continue from a ${previousReal.stage} stage`)
    },
  },
  {
    name: "draw-result or draw-none is sent at most once",
    specClause: "D3, D4: the payoff gets the result once (by construction, so no effect can send it twice)",
    check: ({ trace }) => {
      const results = count(trace.flatMap((entry) => entry.real.commands), isResult)
      assert(results <= 1, `the result was sent ${results} times`)
    },
  },
  {
    name: "no claim before the result is seen, and none with the override",
    specClause: "D5, D8–D11, D15: the claim follows the result; the ?player= override never claims",
    check: ({ previousModel, model, real, realObservation }) => {
      if (!realObservation.commands.includes("start-claim")) return
      assert(!previousModel.override, "claimed with the ?player= override")
      assert(model.draw !== null && CASES[model.draw].won, "claimed a draw that was not won")
      const seen =
        real.phase === "words" || (real.phase === "wheel" && (real.stage === "offered" || real.stage === "fallback" || real.exit !== null))
      assert(seen, `claimed on a ${realStateKey(real)} screen`)
    },
  },
  {
    name: "a held mount only while the intro is up, released at most once",
    specClause: "D6: a spectator's stage is held under the intro and let go once",
    check: ({ real, realObservation, trace }) => {
      if (realObservation.commands.some((command) => command.startsWith("start-stage:held=1")))
        assert(real.phase === "wheel" && real.intro === "up", "a held stage with no intro up")
      const releases = count(trace.flatMap((entry) => entry.real.commands), (command) => command === "release-stage")
      assert(releases <= 1, `the stage was released ${releases} times`)
    },
  },
  {
    name: "the idle is offered once, and only with a way on",
    specClause: "D5, D8, D9, D11: the words, the stage's Continue or the fallback offer the way on, and only then may the idle run",
    check: ({ real, realObservation, trace }) => {
      if (realObservation.commands.includes("payoff:draw-offered"))
        assert(real.phase === "words" || (real.phase === "wheel" && (real.stage === "offered" || real.stage === "fallback")), `offered on a ${realStateKey(real)} screen`)
      const offers = count(trace.flatMap((entry) => entry.real.commands), (command) => command === "payoff:draw-offered")
      assert(offers <= 1, `the way on was offered ${offers} times`)
    },
  },
  {
    name: "unmount always detaches and destroys, and clears every timer",
    specClause: "D13: unmount detaches, destroys and clears everything",
    check: ({ previousReal, previousModel, event, realObservation }) => {
      if (event.key !== "unmounted" || previousReal.phase === "closed") return
      const clears = realObservation.commands.filter((command) => command.startsWith("clear-timer:")).map((command) => command.slice("clear-timer:".length))
      assert(JSON.stringify(clears) === JSON.stringify(previousModel.timers), `cleared [${clears}], armed [${previousModel.timers}]`)
      if (previousReal.phase === "wheel")
        for (const command of ["detach-idle", "destroy-stage"]) assert(realObservation.commands.includes(command), `unmount without ${command}`)
    },
  },
]

// ── generated sequences ────────────────────────────────────────────────────

const eventArbitrary: fc.Arbitrary<DrawScreenTestEvent> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<DrawScreenTestEvent>(ev("opened")) },
  { weight: 2, arbitrary: fc.constantFrom<DrawCase | "none" | "no-identity">(...DRAW_CASES, "none", "no-identity").map((preload) => ({ key: "opened:preloaded", preload }) as DrawScreenTestEvent) },
  { weight: 2, arbitrary: fc.constantFrom("won" as const, "lost" as const).map((draw): DrawScreenTestEvent => ({ key: "load-answered:wheel", draw })) },
  {
    weight: 2,
    arbitrary: fc.constantFrom("words-won" as const, "words-lost" as const, "words-out" as const, "disagree" as const).map(
      (draw): DrawScreenTestEvent => ({ key: "load-answered:words", draw }),
    ),
  },
  { weight: 3, arbitrary: fc.boolean().map((isHeld): DrawScreenTestEvent => ({ key: "stage-mounted", held: isHeld })) },
  { weight: 1, arbitrary: fc.constantFrom("load" as const, "mount" as const).map((reason): DrawScreenTestEvent => ({ key: "stage-failed", reason })) },
  {
    weight: 1,
    arbitrary: fc
      .record({ of: fc.constantFrom("load-waiting" as const, "load-answered" as const, "load-failed" as const), ahead: fc.boolean() })
      .map((stale): DrawScreenTestEvent => ({ key: "stale", ...stale })),
  },
  ...SIMPLE_KEYS.filter((key) => key !== "opened").map((key) => ({ weight: key === "unmounted" ? 1 : 3, arbitrary: fc.constant({ key } as DrawScreenTestEvent) })),
)

export const drawScreenInitialCases = [
  { name: "a player's own screen", real: startDrawScreen({ game: 7, override: undefined }), model: modelStart() },
  { name: "the ?player= override", ...overridden },
] as const

export const drawScreenMachineDefinition: MachineDefinition<
  DrawScreenState,
  ModelDrawScreen,
  DrawScreenTestEvent,
  DrawScreenCommand[],
  string[],
  DrawScreenObservation,
  DrawScreenStateKey,
  DrawScreenEventKey
> = {
  name: "draw-screen",
  initialReal: () => startDrawScreen({ game: 7, override: undefined }),
  initialModel: () => modelStart(),
  initialArbitrary: fc.constantFrom(...drawScreenInitialCases.map(({ real, model }) => ({ real, model }))),
  realStep: (state, event) => {
    const result = drawScreenStep(state, concrete(event, state.epoch))
    return { state: result.state, output: result.commands }
  },
  modelStep: modelDrawScreen,
  classifyRealStep: (previous, result) =>
    JSON.stringify(previous) === JSON.stringify(result.state) && result.output.length === 0 ? "no-op" : "transition",
  observeReal: ({ state, output }) => ({ key: realStateKey(state), view: realView(state), commands: output.map(normalizeCommand) }),
  observeModel: ({ state, output }) => ({ key: modelKey(state), view: modelView(state), commands: output }),
  realStateKey,
  modelStateKey: modelKey,
  eventKey: (event) => event.key,
  transitionTable: drawScreenTransitionTable,
  witnesses: drawScreenWitnesses,
  regressions: drawScreenRegressions,
  invariants: drawScreenInvariants,
  sequenceArbitrary: fc.array(eventArbitrary, { minLength: 0, maxLength: 60, size: "max" }),
  numRuns: 300,
}
