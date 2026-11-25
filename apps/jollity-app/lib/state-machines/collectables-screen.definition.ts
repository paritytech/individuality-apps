// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import type { CollectablesItem } from "@jollity/collectables"
import {
  collectablesScreenStep,
  collectablesScreenView,
  startCollectablesScreen,
  type CollectablesAnswer,
  type CollectablesScreenCommand,
  type CollectablesScreenEvent,
  type CollectablesScreenState,
} from "../collectables/collectables-screen"
import type { PayoffTag } from "../payoff-machine"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

// ── the claims the screen is handed ─────────────────────────────────────────

const GAME = 7
const SEED = "player:7"
const ANSWER_TAG: PayoffTag = { gameIndex: GAME, epoch: 3 }
const COLLECT_MS = 10_000
const SLOW_MS = 60_000
const VOTING_MS = 10_000
const SHOWN = 10

function claim(n: number): CollectablesItem {
  return {
    hash: `0x${n.toString(16).padStart(64, "0")}`,
    proof: null,
    state: "claimable",
    name: `Piece ${n}`,
    rarity: "common",
    image: `art:${n}`,
    collection: "Coffee and Tea",
    choices: [
      { collectionId: 17, collection: "Coffee and Tea", name: `Piece ${n}`, rarity: "common", image: `art:${n}` },
      { collectionId: 18, collection: "Jobs", name: `Job ${n}`, rarity: "common", image: `job:${n}` },
    ],
  }
}
/** the first read's two */
const FIRST = [claim(1), claim(2)]

const ANSWERS = {
  claims: { kind: "claims", game: GAME, seed: SEED, items: FIRST, settling: false, partial: false },
  "claims-settling": { kind: "claims", game: GAME, seed: SEED, items: FIRST, settling: true, partial: false },
  failed: { kind: "waiting", game: GAME, failed: true },
  pending: { kind: "waiting", game: GAME, failed: false },
  voting: { kind: "waiting", game: GAME, failed: false, voting: true },
  empty: { kind: "nothing", game: GAME, why: "no-attestations" },
  claimed: { kind: "nothing", game: GAME, why: "pocketed" },
  unprovable: { kind: "nothing", game: GAME, why: "pruned" },
} as const satisfies Record<string, CollectablesAnswer>
type AnswerName = keyof typeof ANSWERS
const ANSWER_NAMES = Object.keys(ANSWERS) as AnswerName[]

// ── events ─────────────────────────────────────────────────────────────────

const SIMPLE_KEYS = [
  "opened",
  "source:seed",
  "source:none",
  "health:lost",
  "health:stall",
  "health:ok",
  "timer:slow",
  "timer:collect",
  "timer:voting",
  "reread-due",
  "load-collectables",
  "landed",
  "collected:one",
  "collected:all",
  "vessel-opened",
  "cta",
  "album-done",
  "hand-off-refused",
  "pick",
  "unmounted",
] as const
type SimpleKey = (typeof SIMPLE_KEYS)[number]
const ANSWER_KEYS = [...ANSWER_NAMES.map((name) => `answer:${name}` as const), "answer:stale"] as const
const FEED_KEYS = ["came:new", "came:same", "came:stale", "settled:more", "settled:stale"] as const

export type CollectablesScreenEventKey = SimpleKey | (typeof ANSWER_KEYS)[number] | (typeof FEED_KEYS)[number]
/** a test event is its key: each stands for one thing the vessel, the player or the chain does */
export type CollectablesScreenTestEvent = { key: CollectablesScreenEventKey }
export const collectablesScreenEventKeys: readonly CollectablesScreenEventKey[] = [...SIMPLE_KEYS, ...ANSWER_KEYS, ...FEED_KEYS]
const ev = (key: CollectablesScreenEventKey): CollectablesScreenTestEvent => ({ key })

/** the reducer's event for a test event, stamped as the host and the vessel stamp it */
function concrete(event: CollectablesScreenTestEvent, state: CollectablesScreenState): CollectablesScreenEvent {
  const { key } = event
  const next = claim(state.claims.length + 1)
  const shown = Math.min(SHOWN, state.claims.length)
  switch (key) {
    case "source:seed":
      return { type: "source", seed: SEED, game: GAME }
    case "source:none":
      return { type: "source", seed: null, game: GAME }
    case "health:lost":
      return { type: "health", health: { lost: true, reason: "chain-lost", stall: undefined } }
    case "health:stall":
      return { type: "health", health: { lost: false, stall: "host-unanswered" } }
    case "health:ok":
      return { type: "health", health: { lost: false, stall: undefined } }
    case "timer:slow":
    case "timer:collect":
    case "timer:voting":
      return { type: "timer", timer: key === "timer:slow" ? "slow" : key === "timer:collect" ? "collect" : "voting" }
    case "collected:one":
      return { type: "collected", count: state.vessel.collected + 1 }
    case "collected:all":
      return { type: "collected", count: shown }
    case "pick":
      return { type: "pick", index: 0, collectionId: 18 }
    case "answer:stale":
      return { type: "answered", epoch: state.epoch + 1, answer: ANSWERS.claims, tag: ANSWER_TAG }
    case "came:new":
      return { type: "came", epoch: state.epoch, items: [next] }
    case "came:same":
      return { type: "came", epoch: state.epoch, items: [claim(1)] }
    case "came:stale":
      return { type: "came", epoch: state.epoch + 1, items: [next] }
    case "settled:more":
      return { type: "settled", epoch: state.epoch, items: [...state.claims, next], partial: false }
    case "settled:stale":
      return { type: "settled", epoch: state.epoch + 1, items: [next], partial: false }
  }
  if (key.startsWith("answer:")) {
    const name = key.slice("answer:".length) as AnswerName
    return { type: "answered", epoch: state.epoch, answer: ANSWERS[name], tag: ANSWER_TAG, picks: new Map(), stash: new Map() }
  }
  // what is left are the reducer's own simple events
  return { type: key } as CollectablesScreenEvent
}

// ── state keys and the hand-written table ──────────────────────────────────

const flags = <T extends string>(...parts: T[][]): string[] =>
  parts.reduce<string[]>((keys, part) => keys.flatMap((key) => part.map((value) => (key ? `${key}|${value}` : value))), [""])
/**
 * The voting wait turns the rereads off, so it is never keyed with them, and a failed read before it is still to be reported recovered.
 *
 * A voting wait is held until the voting notice wait has run from the open.
 */
const WAITING_KEYS = [
  ...flags(["waiting"], ["seeded", "unseeded"], ["landed", "-"], ["rereads", "-"], ["slow", "-"]),
  ...flags(["waiting"], ["seeded", "unseeded"], ["landed", "-"], ["-"], ["slow", "-"], ["voting", "voting-failed", "voting-held", "voting-held-failed"]),
]
/** the vessel (unlanded, landed and empty, shut with pieces in, opened), the way on (an open vessel always has one), and whether everything is in */
const COLLECTING_KEYS = [
  ...flags(["collecting"], ["unlanded", "empty", "shut"], ["-", "way-on", "closing"], ["all-in", "settling"]),
  ...flags(["collecting"], ["open"], ["way-on", "closing"], ["all-in", "settling"]),
]
export const collectablesScreenStateKeys = ["new", "closed", "waiting|restart", ...WAITING_KEYS, ...COLLECTING_KEYS, "nothing"] as const
export type CollectablesScreenStateKey = string

/**
 * The event keys that act on the world (emit a command) in each state, from
 * the rules; every other key is a no-op there. What only changes the view
 * (a claim that lands, a piece that flies in) is held to the model by the
 * observation every step, not counted here.
 */
function transitionsForState(stateKey: string): readonly CollectablesScreenEventKey[] {
  if (stateKey === "new") return ["opened", "unmounted"]
  if (stateKey === "closed") return []
  if (stateKey === "waiting|restart") return ["unmounted"]
  if (stateKey === "nothing") return ["cta", "unmounted"]
  const parts = stateKey.split("|")
  if (parts[0] === "waiting" && parts[5]) {
    const [, seeded, landed, , slow, voting] = parts
    const keys: CollectablesScreenEventKey[] = ["unmounted", "health:lost", "health:stall", "answer:failed", "answer:pending", "answer:empty", "answer:claimed", "answer:unprovable"]
    // C5: the voting notice and its Continue, which leaves unseen, are up once the voting notice wait has run
    if (slow === "slow" || !voting.startsWith("voting-held")) keys.push("cta")
    // C4: collectables-result is already sent, so claims act only to report a failed read recovered
    if (voting.endsWith("-failed")) keys.push("answer:claims", "answer:claims-settling")
    if (seeded === "unseeded") keys.push("source:none")
    if (landed === "-") keys.push("landed")
    return keys
  }
  if (parts[0] === "waiting") {
    const [, seeded, landed, rereads, slow] = parts
    const keys: CollectablesScreenEventKey[] = ["unmounted", "health:lost", "health:stall", "answer:claims", "answer:claims-settling", "answer:voting", "answer:empty", "answer:claimed", "answer:unprovable"]
    // C5: a failed read turns the rereads on, once
    if (rereads === "-") keys.push("answer:failed", "answer:pending")
    // C5: a reread reads at once; the payoff's load-collectables after it is a no-op
    else keys.push("reread-due")
    if (seeded === "unseeded") keys.push("source:none")
    if (landed === "-") keys.push("landed")
    // C9: nothing read by the collect wait, or by the backstop: taking longer, and Continue skips
    if (slow === "-") keys.push("timer:slow", ...(landed === "landed" ? (["timer:collect"] as const) : []))
    else keys.push("cta")
    return keys
  }
  const [, vessel, way, all] = parts
  const keys: CollectablesScreenEventKey[] = ["unmounted", "pick"]
  if (vessel === "unlanded") keys.push("landed")
  if (vessel === "shut") keys.push("vessel-opened")
  // C12: Continue on the way on sees a collectables screen that is all in; the album's end leaves
  if (way === "way-on" && all === "all-in") keys.push("cta")
  if (way === "closing") keys.push("album-done")
  return keys
}

const row = (transitions: readonly CollectablesScreenEventKey[]) =>
  Object.fromEntries(collectablesScreenEventKeys.map((key) => [key, transitions.includes(key) ? "transition" : "no-op"])) as Record<
    CollectablesScreenEventKey,
    "transition" | "no-op"
  >

export const collectablesScreenTransitionTable = defineTransitionTable<CollectablesScreenStateKey, CollectablesScreenEventKey>()(
  Object.fromEntries(collectablesScreenStateKeys.map((stateKey) => [stateKey, row(transitionsForState(stateKey))])) as Record<
    CollectablesScreenStateKey,
    Record<CollectablesScreenEventKey, "transition" | "no-op">
  >,
)

// ── the independent model ──────────────────────────────────────────────────

/** The screen as flags and counts, from rules C1–C14. It imports no reducer code. */
export interface ModelCollectables {
  life: "new" | "open" | "gone"
  epoch: number
  phase: "waiting" | "collecting" | "nothing"
  seeded: boolean
  why: string | null
  claims: number
  allIn: boolean
  failed: boolean
  rereads: boolean
  slow: boolean
  voting: boolean
  votingDue: boolean
  restart: "lost" | "stall" | null
  resultSent: boolean
  landed: boolean
  waited: boolean
  collected: number
  open: boolean
  closing: boolean
  refusals: number
}

const modelStart = (): ModelCollectables => ({
  life: "new",
  epoch: 0,
  phase: "waiting",
  seeded: false,
  why: null,
  claims: 0,
  allIn: false,
  failed: false,
  rereads: false,
  slow: false,
  voting: false,
  votingDue: false,
  restart: null,
  resultSent: false,
  landed: false,
  waited: false,
  collected: 0,
  open: false,
  closing: false,
  refusals: 0,
})

const tagOf = (tag: PayoffTag) => `${tag.gameIndex}/${tag.epoch}`
const shownIn = (m: ModelCollectables) => Math.min(SHOWN, m.claims)
/** C8, written out: asked to open, or already open */
const opensIn = (m: ModelCollectables) =>
  m.open || (m.phase === "collecting" && m.landed && m.collected > 0 && ((m.allIn && m.collected >= shownIn(m)) || m.waited))
/** C5: the voting notice is up only once its wait has run from the open */
const votingUp = (m: ModelCollectables) => m.voting && m.votingDue
const NOTHING_REASON: Record<string, string> = { "no-attestations": "no-attestations", pocketed: "pocketed", pruned: "pruned", "no-identity": "no-identity" }

/** Independent executable model of rules C1–C14. */
function modelCollectables(previous: ModelCollectables, event: CollectablesScreenTestEvent): { state: ModelCollectables; output: string[] } {
  const m: ModelCollectables = { ...previous }
  const out: string[] = []
  const done = () => ({ state: m, output: out })
  const { key } = event
  const result = (facts: string, tag: string) => {
    if (m.resultSent) return
    m.resultSent = true
    out.push(`payoff:collectables-result:${tag}:${facts}`)
  }
  const toNothing = (why: string, tag: string) => {
    const rereads = m.rereads
    m.phase = "nothing"
    m.why = why
    m.rereads = false
    m.voting = false
    out.push("stop-feed", "clear-timer:slow", "clear-timer:voting", ...(rereads ? ["rereads:off"] : []))
    result(`{"chest.outcome":"none","chest.reason":"${NOTHING_REASON[why]}"}`, tag)
  }

  if (m.life === "gone") return { state: previous, output: [] }
  if (key === "unmounted") {
    out.push("stop-feed", "clear-timer:slow", "clear-timer:collect", "clear-timer:voting", ...(m.rereads ? ["rereads:off"] : []))
    m.life = "gone"
    m.epoch += 1
    return done()
  }
  if (m.life === "new") {
    if (key !== "opened") return done()
    m.life = "open"
    m.epoch = 1
    out.push("payoff:collectables-opened:-", `arm-timer:slow:${SLOW_MS}`, `arm-timer:voting:${VOTING_MS}`, "read:1")
    return done()
  }

  const waiting = m.phase === "waiting"
  const collecting = m.phase === "collecting"
  switch (key) {
    case "source:seed":
    case "source:none":
      if (m.seeded || !waiting || m.restart) break
      if (key === "source:none") toNothing("no-identity", "capture")
      else m.seeded = true
      break
    case "answer:claims":
    case "answer:claims-settling":
      if (!waiting || m.restart) break
      m.phase = "collecting"
      m.claims = FIRST.length
      m.allIn = key === "answer:claims"
      if (m.failed) out.push("read-recovered")
      if (m.rereads) out.push("rereads:off")
      m.failed = false
      m.rereads = false
      m.slow = m.slow || votingUp(m)
      m.voting = false
      result(`{"chest.outcome":"collectables","chest.count":"${FIRST.length}"${m.allIn ? "" : ',"chest.settling":"true"'}}`, tagOf(ANSWER_TAG))
      break
    case "answer:failed":
    case "answer:pending":
      if (!waiting || m.restart) break
      if (key === "answer:failed") m.failed = true
      if (!m.rereads) out.push("rereads:on")
      m.rereads = true
      m.slow = m.slow || votingUp(m)
      m.voting = false
      break
    case "answer:voting":
      if (!waiting || m.restart) break
      if (m.rereads) out.push("rereads:off")
      m.rereads = false
      m.voting = true
      result('{"chest.outcome":"none","chest.reason":"voting"}', tagOf(ANSWER_TAG))
      break
    case "answer:empty":
    case "answer:claimed":
    case "answer:unprovable":
      if (!waiting || m.restart) break
      toNothing(key === "answer:empty" ? "no-attestations" : key === "answer:claimed" ? "pocketed" : "pruned", tagOf(ANSWER_TAG))
      break
    case "came:new":
      if (collecting && !m.allIn) m.claims += 1
      break
    case "settled:more":
      if (collecting && !m.allIn) {
        m.claims += 1
        m.allIn = true
      }
      break
    case "health:lost":
    case "health:stall":
      if (!waiting || m.restart) break
      out.push("stop-feed", "clear-timer:slow", "clear-timer:voting", ...(m.rereads ? ["rereads:off"] : []))
      m.restart = key === "health:lost" ? "lost" : "stall"
      m.rereads = false
      m.epoch += 1
      result('{"chest.outcome":"none","chest.reason":"failed"}', "capture")
      out.push("payoff:payoff-stalled:chest.load:-")
      break
    case "timer:slow":
      if (m.slow || m.restart || m.voting) break
      m.slow = true
      if (waiting) out.push("payoff:payoff-stalled:chest.slow:-")
      break
    case "timer:collect":
      if (!m.landed || m.waited) break
      m.waited = true
      if (waiting && !m.slow && !m.restart && !m.voting) {
        m.slow = true
        out.push("payoff:payoff-stalled:chest.slow:-")
      }
      break
    case "timer:voting":
      m.votingDue = true
      break
    case "reread-due":
      // C5: the reread reads at once, whatever the payoff does with it
      if (waiting && m.rereads) {
        m.epoch += 1
        out.push("payoff:collectables-reread-due:-", `read:${m.epoch}`)
      }
      break
    case "load-collectables":
      // the payoff's answer to the reread, whose read has already gone
      break
    case "landed":
      if (m.landed || !(collecting || (waiting && !m.restart))) break
      m.landed = true
      out.push(`arm-timer:collect:${COLLECT_MS}`)
      break
    case "collected:one":
    case "collected:all": {
      const count = key === "collected:one" ? m.collected + 1 : shownIn(m)
      if (collecting && m.landed && count > m.collected) m.collected = count
      break
    }
    case "vessel-opened":
      if (!collecting || !m.landed || m.open || m.collected === 0) break
      out.push(`log:the vessel opened:${JSON.stringify({ by: opensIn(m) ? (m.allIn ? "all in" : "the wait") : "a tap", collected: m.collected, shown: shownIn(m) })}`)
      m.open = true
      break
    case "cta":
      if (m.restart) break
      if (waiting) {
        // the payoff takes collectables-skip only before collectables-result: after the voting wait it leaves as the collectables screen does
        if (votingUp(m) || m.slow) out.push(m.resultSent ? "leave:collectables-continue" : "leave:collectables-skip")
        break
      }
      if (m.phase === "nothing") {
        if (m.why !== "no-identity") out.push(`mark-seen:${GAME}`)
        out.push("leave:collectables-continue")
        break
      }
      if (m.closing || !(m.open || m.slow)) break
      if (m.allIn) out.push(`mark-seen:${GAME}`)
      m.closing = true
      break
    case "album-done":
      if (collecting && m.closing) out.push("leave:collectables-continue")
      break
    case "hand-off-refused":
      if (collecting && m.closing) m.refusals += 1
      break
    case "pick":
      if (collecting) out.push(`save-pick:${claim(1).hash.slice(0, 10)}:18`)
      break
  }
  return done()
}

function modelKey(m: ModelCollectables): CollectablesScreenStateKey {
  if (m.life === "new") return "new"
  if (m.life === "gone") return "closed"
  if (m.phase === "nothing") return "nothing"
  if (m.phase === "waiting")
    return m.restart
      ? "waiting|restart"
      : `waiting|${m.seeded ? "seeded" : "unseeded"}|${m.landed ? "landed" : "-"}|${m.rereads ? "rereads" : "-"}|${m.slow ? "slow" : "-"}${m.voting ? `|voting${m.votingDue ? "" : "-held"}${m.failed ? "-failed" : ""}` : ""}`
  const vessel = !m.landed ? "unlanded" : m.collected === 0 ? "empty" : m.open ? "open" : "shut"
  const way = m.closing ? "closing" : m.open || m.slow ? "way-on" : "-"
  return `collecting|${vessel}|${way}|${m.allIn ? "all-in" : "settling"}`
}

function modelView(m: ModelCollectables): string {
  if (m.life !== "open") return "-"
  if (m.restart) return `restart:${m.restart === "lost" ? "chain-lost" : "host-unanswered"}`
  if (m.phase === "nothing") return `collectables|vessel=-|notice=nothing:${m.why}|action=continue|closing=-`
  if (m.phase === "waiting")
    return `collectables|vessel=${m.seeded ? `${SEED}:0:0:0` : "-"}|notice=${votingUp(m) ? "voting" : m.slow ? "slow" : "-"}|action=${votingUp(m) || m.slow ? "skip" : "-"}|closing=-`
  const pieces = shownIn(m)
  const action = m.open || m.slow ? "continue" : "-"
  return `collectables|vessel=${SEED}:${pieces}:${opensIn(m) ? 1 : 0}:${m.collected > 0 ? 1 : 0}|notice=-|action=${action}|closing=${m.closing ? `${pieces}:${m.refusals}` : "-"}`
}

// ── observations ───────────────────────────────────────────────────────────

export interface CollectablesScreenObservation {
  key: CollectablesScreenStateKey
  view: string
  commands: string[]
}

function normalizeCommand(command: CollectablesScreenCommand): string {
  switch (command.kind) {
    case "payoff": {
      const input = command.input.type === "payoff-stalled" ? `payoff-stalled:${command.input.stage}` : command.input.type
      const tag = command.tag === undefined ? "-" : command.tag === "capture" ? "capture" : tagOf(command.tag)
      return `payoff:${input}:${tag}${command.facts ? `:${JSON.stringify(command.facts)}` : ""}`
    }
    case "read":
      return `read:${command.epoch}`
    case "arm-timer":
      return `arm-timer:${command.timer}:${command.ms}`
    case "clear-timer":
      return `clear-timer:${command.timer}`
    case "rereads":
      return `rereads:${command.on ? "on" : "off"}`
    case "mark-seen":
      return `mark-seen:${command.game}`
    case "leave":
      return `leave:${command.via}`
    case "save-pick":
      return `save-pick:${command.hash.slice(0, 10)}:${command.collectionId}`
    case "log":
      return `log:${command.message}:${JSON.stringify(command.data)}`
    default:
      return command.kind
  }
}

function realStateKey(state: CollectablesScreenState): CollectablesScreenStateKey {
  if (state.phase === "new") return "new"
  if (state.phase === "closed") return "closed"
  if (state.phase === "nothing") return "nothing"
  const v = state.vessel
  if (state.phase === "waiting")
    return state.restart
      ? "waiting|restart"
      : `waiting|${state.seed !== null ? "seeded" : "unseeded"}|${v.landed ? "landed" : "-"}|${state.rereads ? "rereads" : "-"}|${state.slow ? "slow" : "-"}${state.voting ? `|voting${state.votingDue ? "" : "-held"}${state.failed ? "-failed" : ""}` : ""}`
  const vessel = !v.landed ? "unlanded" : v.collected === 0 ? "empty" : v.open ? "open" : "shut"
  const way = state.closing ? "closing" : v.open || state.slow ? "way-on" : "-"
  return `collecting|${vessel}|${way}|${state.allIn ? "all-in" : "settling"}`
}

function realView(state: CollectablesScreenState): string {
  if (state.phase === "new" || state.phase === "closed") return "-"
  const view = collectablesScreenView(state)
  if (view.kind === "restart") return `restart:${view.reason}`
  const vessel = view.vessel ? `${view.vessel.seed}:${view.vessel.pieces.length}:${view.vessel.open ? 1 : 0}:${view.vessel.canOpen ? 1 : 0}` : "-"
  const notice = view.notice === null ? "-" : typeof view.notice === "object" ? `nothing:${view.notice.nothing}` : view.notice
  return `collectables|vessel=${vessel}|notice=${notice}|action=${view.action ?? "-"}|closing=${view.closing ? `${view.closing.srcs.length}:${view.closing.refusals}` : "-"}`
}

// ── witnesses: a path to each state, then every event ──────────────────────

function pathTo(key: string): CollectablesScreenTestEvent[] {
  if (key === "new") return []
  if (key === "closed") return [ev("opened"), ev("unmounted")]
  if (key === "nothing") return [ev("opened"), ev("answer:empty")]
  if (key === "waiting|restart") return [ev("opened"), ev("health:lost")]
  const parts = key.split("|")
  if (parts[0] === "waiting") {
    const [, seeded, landed, rereads, slow, voting] = parts
    return [
      ev("opened"),
      ...(seeded === "seeded" ? [ev("source:seed")] : []),
      ...(landed === "landed" ? [ev("landed")] : []),
      ...(rereads === "rereads" || voting?.endsWith("-failed") ? [ev("answer:failed")] : []),
      ...(slow === "slow" ? [ev("timer:slow")] : []),
      ...(voting && !voting.startsWith("voting-held") ? [ev("timer:voting")] : []),
      ...(voting ? [ev("answer:voting")] : []),
    ]
  }
  const [, vessel, way, all] = parts
  const path = [ev("opened"), ev("source:seed"), ev(all === "all-in" ? "answer:claims" : "answer:claims-settling")]
  if (vessel !== "unlanded") path.push(ev("landed"))
  if (vessel === "shut" || vessel === "open") path.push(ev("collected:one"))
  if (vessel === "open") path.push(ev("vessel-opened"))
  else if (way !== "-") path.push(ev("timer:slow"))
  if (way === "closing") path.push(ev("cta"))
  return path
}

export const collectablesScreenWitnesses: NamedSequence<CollectablesScreenTestEvent, CollectablesScreenState, ModelCollectables>[] = collectablesScreenStateKeys.flatMap((stateKey) =>
  collectablesScreenEventKeys.map((eventKey) => ({ name: `${stateKey} × ${eventKey}`, events: [...pathTo(stateKey), ev(eventKey)] })),
)

// ── regressions: the captured scenarios (collectables-screen.capture.test.tsx) ──

const seq = (...keys: CollectablesScreenEventKey[]) => keys.map(ev)
export const collectablesScreenRegressions: NamedSequence<CollectablesScreenTestEvent, CollectablesScreenState, ModelCollectables>[] = [
  {
    name: "a settled collectables screen is up before the read answers, opens once all have flown in, and its Continue hands off",
    events: seq("opened", "source:seed", "landed", "answer:claims", "collected:all", "vessel-opened", "cta", "album-done"),
  },
  {
    name: "a collectables screen before the settle collects what lands, opens after the wait, and takes the settle's claims",
    events: seq("opened", "source:seed", "answer:claims-settling", "landed", "collected:all", "came:new", "collected:all", "timer:collect", "vessel-opened", "settled:more", "collected:all", "cta", "album-done"),
  },
  { name: "a tap opens the vessel early once something is in, and not before", events: seq("opened", "source:seed", "landed", "vessel-opened", "answer:claims", "vessel-opened", "collected:one", "vessel-opened") },
  {
    name: "nothing read by the collect wait says it is taking longer; a claim after it is collected, opens the vessel, and Continue stays",
    events: seq("opened", "source:seed", "landed", "timer:collect", "answer:claims-settling", "collected:one", "vessel-opened", "cta", "album-done"),
  },
  { name: "Continue is offered the moment the vessel opens", events: seq("opened", "source:seed", "landed", "answer:claims", "collected:one", "vessel-opened", "cta", "album-done") },
  { name: "a collectables screen left before its game settled is not seen", events: seq("opened", "source:seed", "answer:claims-settling", "landed", "collected:all", "timer:collect", "vessel-opened", "cta", "album-done") },
  { name: "an empty collectables screen says why, and Continue goes on", events: seq("opened", "source:seed", "answer:empty", "cta") },
  { name: "claims earned but not readable yet keep the vessel collecting, and a reread brings them", events: seq("opened", "source:seed", "landed", "answer:pending", "reread-due", "load-collectables", "answer:claims") },
  { name: "no player identity says so at once, and Continue goes on", events: seq("opened", "source:none", "cta") },
  { name: "a failed read keeps the vessel collecting, and reads again until the collectables screen is there", events: seq("opened", "source:seed", "landed", "answer:failed", "reread-due", "load-collectables", "answer:claims") },
  { name: "a failed read on a lost chain puts up the restart card, for good", events: seq("opened", "source:seed", "answer:failed", "health:lost", "health:ok", "reread-due", "answer:claims", "cta", "timer:slow") },
  { name: "a read that never answers says it is taking longer under the vessel, and Continue skips", events: seq("opened", "source:seed", "landed", "timer:collect", "cta") },
  { name: "a vessel that never lands still says so at the backstop wait", events: seq("opened", "source:seed", "timer:collect", "timer:slow", "cta") },
  {
    name: "a hand-off the host refuses brings the album back, and is tried again from it",
    events: seq("opened", "source:seed", "landed", "answer:claims", "collected:all", "vessel-opened", "cta", "album-done", "hand-off-refused", "album-done"),
  },
  { name: "a collection picked in the hologram is saved", events: seq("opened", "source:seed", "answer:claims", "pick") },
  { name: "leaving the screen mid-read lets the feed go", events: seq("opened", "source:seed", "unmounted", "answer:claims") },
  { name: "a vessel that never opens still offers a way on past the backstop wait", events: seq("opened", "source:seed", "answer:claims", "timer:slow", "cta", "album-done") },
  {
    name: "an empty collectables screen while players are still voting says nothing yet, never that it is taking longer, and Continue leaves it unseen",
    events: seq("opened", "source:seed", "landed", "answer:voting", "timer:voting", "timer:collect", "timer:slow", "cta"),
  },
  {
    name: "a voting answer before the voting notice wait puts nothing up, and the notice and its Continue come when the wait runs out",
    events: seq("opened", "source:seed", "landed", "answer:voting", "cta", "timer:voting", "cta"),
  },
  { name: "a voting answer after the voting notice wait puts the notice up at once", events: seq("opened", "source:seed", "landed", "timer:voting", "answer:voting", "cta") },
  {
    name: "a failed read after a voting answer that was never shown waits on the collect wait",
    events: seq("opened", "source:seed", "landed", "answer:voting", "answer:failed", "timer:voting", "cta", "timer:collect", "cta"),
  },
  { name: "a failed read after the voting wait keeps its Continue, which leaves unseen", events: seq("opened", "source:seed", "timer:voting", "answer:voting", "answer:failed", "reread-due", "cta") },
  {
    name: "a claim after the voting wait is collected, with a way on before the vessel opens",
    events: seq("opened", "source:seed", "timer:voting", "answer:voting", "answer:claims-settling", "landed", "cta", "album-done"),
  },
  { name: "the final empty collectables screen ends the voting wait on its reason", events: seq("opened", "source:seed", "answer:voting", "answer:empty", "cta") },
  { name: "stale answers and feeds are inert", events: seq("opened", "answer:stale", "answer:claims-settling", "came:stale", "settled:stale", "came:same", "came:new") },
]

// ── invariants ─────────────────────────────────────────────────────────────

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}
type Invariant = NamedInvariant<CollectablesScreenState, ModelCollectables, CollectablesScreenTestEvent, CollectablesScreenObservation, CollectablesScreenStateKey, CollectablesScreenEventKey>

export const collectablesScreenInvariants: Invariant[] = [
  {
    name: "closed absorbs every later event",
    specClause: "C14: after unmount nothing acts",
    check: ({ previousReal, real, realObservation }) => {
      if (previousReal.phase !== "closed") return
      assert(real === previousReal, "closed state changed")
      assert(realObservation.commands.length === 0, "closed state emitted a command")
    },
  },
  {
    name: "a stale answer or feed is inert",
    specClause: "C14: a stale epoch is inert",
    check: ({ previousReal, real, event, realObservation }) => {
      if (!event.key.endsWith(":stale")) return
      assert(real === previousReal, "a stale answer changed state")
      assert(realObservation.commands.length === 0, "a stale answer emitted a command")
    },
  },
  {
    name: "collectables-result is sent at most once",
    specClause: "C4, C6, C10: the payoff hears the collectables screen's result once",
    check: ({ previousReal, realObservation }) => {
      const results = realObservation.commands.filter((c) => c.startsWith("payoff:collectables-result")).length
      assert(results <= 1 && (results === 0 || !previousReal.resultSent), "collectables-result sent again")
    },
  },
  {
    name: "the long wait's skip comes only before collectables-result",
    specClause: "C9: the payoff takes collectables-skip only while it is still reading the collectables",
    check: ({ previousReal, realObservation }) => {
      if (realObservation.commands.includes("leave:collectables-skip")) assert(!previousReal.resultSent && previousReal.phase === "waiting", "a skip after the result")
    },
  },
  {
    name: "the vessel is never asked to open empty",
    specClause: "C8: it opens with something in, and stays open",
    check: ({ previousReal, real }) => {
      if (real.phase !== "collecting") return
      const view = collectablesScreenView(real)
      if (view.kind !== "chest" || !view.vessel) return
      if (view.vessel.open) assert(real.vessel.collected > 0, "asked to open with nothing in")
      const before = collectablesScreenView(previousReal)
      if (before.kind === "chest" && before.vessel?.open && previousReal.phase === "collecting") assert(view.vessel.open, "an open vessel closed")
    },
  },
  {
    name: "an open vessel always offers Continue",
    specClause: "C11: Continue as soon as the vessel has opened",
    check: ({ real }) => {
      if (real.phase !== "collecting" || !real.vessel.open || real.closing) return
      const view = collectablesScreenView(real)
      assert(view.kind === "chest" && view.action === "continue", "an open vessel without Continue")
    },
  },
  {
    name: "the long-wait notice is up only while nothing is read",
    specClause: "C9: taking longer than usual, while the collectables screen has nothing to show",
    check: ({ real }) => {
      if (real.phase === "closed") return
      const view = collectablesScreenView(real)
      if (view.kind === "chest" && view.notice === "slow") assert(real.phase === "waiting" && !real.restart, "the long-wait notice over a collectables screen")
    },
  },
  {
    name: "a collectables screen is seen only when all is in, or on a final nothing",
    specClause: "C12: a collectables screen still settling is left unseen; no player is never seen",
    check: ({ previousReal, realObservation }) => {
      if (!realObservation.commands.some((c) => c.startsWith("mark-seen"))) return
      const ok = previousReal.phase === "collecting" ? previousReal.allIn : previousReal.phase === "nothing" && previousReal.why !== "no-identity"
      assert(ok, `seen from a ${realStateKey(previousReal)} screen`)
    },
  },
  {
    name: "the restart card is for good, and the rereads only run while waiting",
    specClause: "C5, C10: rereads while waiting with the card down; the card stays up",
    check: ({ previousReal, real, realObservation }) => {
      if (previousReal.restart) assert(real.restart || real.phase === "closed", "the restart card went down")
      if (realObservation.commands.includes("rereads:on")) assert(real.phase === "waiting" && !real.restart, "rereads on away from the wait")
    },
  },
  {
    name: "the voting wait never says it is taking longer",
    specClause: "C9: while co-players are still voting the screen has already said why",
    check: ({ previousReal, realObservation }) => {
      if (previousReal.voting) assert(!realObservation.commands.includes("payoff:payoff-stalled:chest.slow:-"), "a slow stall over the voting wait")
    },
  },
  {
    name: "the voting notice waits for its wait from the open",
    specClause: "C5: the voting notice and its Continue are up only once VOTING_NOTICE_MS have passed since the open",
    check: ({ real }) => {
      if (real.phase === "closed") return
      const view = collectablesScreenView(real)
      if (view.kind === "chest" && view.notice === "voting") assert(real.votingDue, "the voting notice before its wait ran out")
    },
  },
  {
    name: "claims only grow, in the order they came",
    specClause: "C7: added by hash, never removed or reordered",
    check: ({ previousReal, real }) => {
      const before = previousReal.claims.map((c) => c.hash)
      const after = real.claims.map((c) => c.hash)
      assert(before.every((hash, i) => after[i] === hash), "a claim was removed or moved")
      assert(new Set(after).size === after.length, "a claim is shown twice")
    },
  },
]

// ── generated sequences ────────────────────────────────────────────────────

const eventArbitrary: fc.Arbitrary<CollectablesScreenTestEvent> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(ev("opened")) },
  { weight: 5, arbitrary: fc.constantFrom(...ANSWER_KEYS).map(ev) },
  { weight: 4, arbitrary: fc.constantFrom(...FEED_KEYS).map(ev) },
  ...SIMPLE_KEYS.filter((key) => key !== "opened").map((key) => ({ weight: key === "unmounted" ? 1 : 3, arbitrary: fc.constant(ev(key)) })),
)

export const collectablesScreenMachineDefinition: MachineDefinition<
  CollectablesScreenState,
  ModelCollectables,
  CollectablesScreenTestEvent,
  CollectablesScreenCommand[],
  string[],
  CollectablesScreenObservation,
  CollectablesScreenStateKey,
  CollectablesScreenEventKey
> = {
  name: "collectables-screen",
  initialReal: startCollectablesScreen,
  initialModel: modelStart,
  initialArbitrary: fc.constant({ real: startCollectablesScreen(), model: modelStart() }),
  realStep: (state, event) => {
    const result = collectablesScreenStep(state, concrete(event, state))
    return { state: result.state, output: result.commands }
  },
  modelStep: modelCollectables,
  // a cell is a transition when it acts on the world; what only changes the view is held by the observation
  classifyRealStep: (_previous, result) => (result.output.length === 0 ? "no-op" : "transition"),
  observeReal: ({ state, output }) => ({ key: realStateKey(state), view: realView(state), commands: output.map(normalizeCommand) }),
  observeModel: ({ state, output }) => ({ key: modelKey(state), view: modelView(state), commands: output }),
  realStateKey,
  modelStateKey: modelKey,
  eventKey: (event) => event.key,
  transitionTable: collectablesScreenTransitionTable,
  witnesses: collectablesScreenWitnesses,
  regressions: collectablesScreenRegressions,
  invariants: collectablesScreenInvariants,
  sequenceArbitrary: fc.array(eventArbitrary, { minLength: 0, maxLength: 60, size: "max" }),
  numRuns: 300,
}
