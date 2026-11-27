// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Counterexamples found by a TLA+ model of the game session (the model is
 * not part of this repository), replayed against the REAL `useGameSession`.
 *
 * The repo has no React renderer for tests (no jsdom, no testing-library), so
 * this file carries a small one: `vi.mock("react")` swaps in useState /
 * useRef / useMemo / useEffect with React's commit order — a render, then the
 * passive effects in declaration order (cleanup before re-run), repeated until
 * no state changed. A discrete event (a tap) flushes at once, as React 18+
 * does; a timer's updates flush in a microtask. One fake clock drives both the
 * chain (`source.nowSeconds` reads `Date.now()`) and the auto-confirm window.
 *
 * A finding stays `it.fails` only while its counterexample is open; once the
 * product satisfies the property, its replay is a normal regression test. The
 * "harness" block checks the renderer on paths the model says HOLD.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ── the fake React ──────────────────────────────────────────────────────────
const R = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: (() => void) | void }
  const state = {
    hooks: [] as unknown[],
    idx: 0,
    queue: [] as { slot: number; fn: () => (() => void) | void }[],
    dirty: false,
    scheduled: false,
    rendering: false,
    alive: true,
    body: null as null | (() => void),
  }
  const changed = (a?: unknown[], b?: unknown[]) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))
  function flush() {
    let guard = 0
    while (state.dirty && state.alive && state.body) {
      if (++guard > 100) throw new Error("fake React: render loop")
      state.dirty = false
      state.idx = 0
      state.rendering = true
      state.body()
      state.rendering = false
      const queue = state.queue
      state.queue = []
      for (const { slot, fn } of queue) {
        const effect = state.hooks[slot] as Effect
        if (typeof effect.cleanup === "function") effect.cleanup()
        effect.cleanup = fn()
      }
    }
  }
  function schedule() {
    state.dirty = true
    if (state.rendering || state.scheduled) return
    state.scheduled = true
    queueMicrotask(() => {
      state.scheduled = false
      flush()
    })
  }
  function useState<T>(init: T | (() => T)) {
    const slot = state.idx++
    if (!(slot in state.hooks))
      state.hooks[slot] = { v: typeof init === "function" ? (init as () => T)() : init }
    const cell = state.hooks[slot] as { v: T; set?: (u: T | ((p: T) => T)) => void }
    // a setter outlives its mount (a promise settling after a reload); it
    // writes into the detached cell and wakes nothing, as React drops it
    const hooksAtMount = state.hooks
    cell.set ??= (update) => {
      const next = typeof update === "function" ? (update as (p: T) => T)(cell.v) : update
      if (Object.is(next, cell.v)) return
      cell.v = next
      if (state.hooks === hooksAtMount) schedule()
    }
    return [cell.v, cell.set] as const
  }
  function useRef<T>(init: T) {
    const slot = state.idx++
    if (!(slot in state.hooks)) state.hooks[slot] = { current: init }
    return state.hooks[slot] as { current: T }
  }
  function useMemo<T>(fn: () => T, deps: unknown[]) {
    const slot = state.idx++
    const cell = state.hooks[slot] as { v: T; deps: unknown[] } | undefined
    if (!cell || changed(cell.deps, deps)) state.hooks[slot] = { v: fn(), deps }
    return (state.hooks[slot] as { v: T }).v
  }
  function useCallback<T>(fn: T, deps: unknown[]) {
    const slot = state.idx++
    const cell = state.hooks[slot] as { v: T; deps: unknown[] } | undefined
    if (!cell || changed(cell.deps, deps)) state.hooks[slot] = { v: fn, deps }
    return (state.hooks[slot] as { v: T }).v
  }
  // the client snapshot: the harness has no prerender to hydrate
  function useSyncExternalStore<T>(_subscribe: unknown, getSnapshot: () => T) {
    return getSnapshot()
  }
  function useEffect(fn: () => (() => void) | void, deps?: unknown[]) {
    const slot = state.idx++
    const cell = state.hooks[slot] as Effect | undefined
    if (!cell) state.hooks[slot] = { deps }
    else if (!changed(cell.deps, deps)) return
    else cell.deps = deps
    state.queue.push({ slot, fn })
  }
  function mount(body: () => void) {
    state.hooks = []
    state.queue = []
    state.alive = true
    state.body = body
    state.dirty = true
    flush()
  }
  function unmount() {
    for (const cell of state.hooks) {
      const effect = cell as Effect
      if (effect && typeof effect.cleanup === "function") effect.cleanup()
    }
    state.alive = false
    state.body = null
    state.hooks = []
  }
  /** a discrete event: React flushes its updates and effects before the next one */
  function act(fn: () => void) {
    fn()
    flush()
  }
  /** a render with no state change, as a parent's render gives */
  function rerender() {
    state.dirty = true
    flush()
  }
  return { useState, useRef, useMemo, useCallback, useEffect, useSyncExternalStore, mount, unmount, act, flush, rerender }
})

vi.mock("react", () => {
  const api = {
    useState: R.useState,
    useRef: R.useRef,
    useMemo: R.useMemo,
    useCallback: R.useCallback,
    useEffect: R.useEffect,
    useSyncExternalStore: R.useSyncExternalStore,
  }
  return { ...api, default: api }
})

// ── the world around the session ────────────────────────────────────────────
const W = vi.hoisted(() => ({
  joined: true,
  viaDoor: false,
  router: null as null | { push: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn>; prefetch: ReturnType<typeof vi.fn> },
  source: null as unknown,
  /** every devLog line the session wrote, as [tag, message] */
  logs: [] as [string, string][],
  logData: [] as { tag: string; message: string; data?: unknown }[],
  /** the host storage: key -> string, and every write to it */
  built: [] as unknown[],
  reportEvents: [] as string[],
  isolationActions: [] as string[],
  store: new Map<string, string>(),
  writes: [] as string[],
  readHangs: false,
  /** this many reads never answer, then the reads work */
  readHangsFirst: 0,
  readDelayMs: 0,
  readFailures: 0,
  drawScheduled: undefined as number | undefined,
}))
vi.mock("next/navigation", () => ({ useRouter: () => W.router }))
// the REAL doorway module, for its game clock (`makeSource`: the peer check
// and the published offset); the session still gets the test's source
vi.mock("./game-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./game-source")>()),
  getGameSource: () => Promise.resolve(W.source),
  playerIdOf: (ref: { type: string; value: string }) => (ref.type === "Account" ? ref.value : `person:${ref.value}`),
}))
// what the real doorway module pulls in and the clock never touches
vi.mock("./engine", () => ({ resolveDevEngine: () => null, resolveHostEngine: async () => null }))
vi.mock("./telemetry", async () => (await import("./telemetry/testing")).fakeTelemetryModule())
vi.mock("./host/identity", () => ({ knownDisplayName: async () => null }))
vi.mock("./collectable-art", () => ({ loadCollectableImage: () => {} }))
vi.mock("./joined", () => ({ hasJoined: () => W.joined, readJoinedGameAt: () => null, cameThroughWaitingRoom: () => W.viaDoor }))
vi.mock("./draw/draw-load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./draw/draw-load")>()),
  // a load that never answers: the session only starts it on the confirm screen
  loadDraw: () => ({ promise: new Promise(() => {}), result: undefined, waiting: false, subscribe: () => () => {}, release: () => {} }),
}))
vi.mock("./draw/draw-schedule", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./draw/draw-schedule")>()),
  peekDrawSchedule: () => W.drawScheduled,
}))
vi.mock("@/lib/draw/wheel/mount", () => ({}))
// The real TURN proof starts with a real dynamic import of the host SDK, and
// the fake clock does not wait for it. On a slow runner the proof's 5 s bound
// fires first, ice.ts keeps that TURN timeout as module state, and every later
// mount in this file replays it (the clock rewinds per test, so it always
// looks fresh) as stuck-host evidence. Answer the way a fast machine does.
vi.mock("./host/turn-proof", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./host/turn-proof")>()),
  turnProofBody: async () => ({ reason: "not inside a host", code: "no-host" as const }),
}))
vi.mock("./post-game", () => ({
  rememberPostGame: () => {},
  postGameIndex: () => undefined,
}))
vi.mock("./debug/log-store", () => ({
  devLog: (tag: string, message: string, data?: unknown) => {
    W.logs.push([tag, message])
    W.logData.push({ tag, message, data })
    if (tag === "vote" && message === "report built") W.built.push(data)
  },
}))
const HEALTH = vi.hoisted(() => ({
  stats: null as SignalStats | null,
  listeners: new Set<() => void>(),
}))
vi.mock("./health/snapshot", () => ({
  getHealthSnapshot: () =>
    HEALTH.stats === null ? null : { stats: HEALTH.stats },
  subscribeHealth: (listener: () => void) => {
    HEALTH.listeners.add(listener)
    return () => HEALTH.listeners.delete(listener)
  },
}))
vi.mock("./host/storage", () => ({
  readStoredString: async (key: string) => W.store.get(key) ?? null,
  writeStoredString: async (key: string, value: string) => {
    W.writes.push(key)
    W.store.set(key, value)
  },
  readStoredJSON: async (key: string) => {
    if (W.readHangs) return new Promise<never>(() => {})
    const raw = W.store.get(key)
    return raw ? JSON.parse(raw) : null
  },
  tryReadStoredString: async (key: string) => {
    if (W.readHangs) return new Promise<never>(() => {})
    if (W.readHangsFirst > 0) {
      W.readHangsFirst -= 1
      return new Promise<never>(() => {})
    }
    if (W.readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, W.readDelayMs))
    if (W.readFailures > 0) {
      W.readFailures -= 1
      return { ok: false as const }
    }
    return { ok: true as const, value: W.store.get(key) ?? null }
  },
  writeStoredJSON: async (key: string, value: unknown) => {
    W.writes.push(key)
    W.store.set(key, JSON.stringify(value))
  },
  hostStorage: async () => ({
    readJSON: async (key: string) => {
      const raw = W.store.get(key)
      return raw ? JSON.parse(raw) : null
    },
    writeJSON: async (key: string, value: unknown) => {
      W.store.set(key, JSON.stringify(value))
    },
  }),
}))
vi.mock("./host/error-detail", () => ({ describeError: (e: unknown) => String(e) }))
vi.mock("./camera", () => ({
  useCamera: () => ({ kind: "unavailable", reason: "test" }),
  cameraState: () => ({ kind: "idle" }),
  requestCameraJoinCheck: vi.fn(),
  cameraHandoverSummary: vi.fn(),
}))
vi.mock("./journeys/game-trace", () => {
  const noop = () => {}
  return {
    beginJoin: noop, cameraSettled: noop, confirmOpened: noop, isolated: () => W.isolationActions.push("trace"), leftGame: noop, noteGame: noop, peerSeen: noop,
    storeCalibrated: noop, storeClockEvent: noop,
    reportFailed: () => W.reportEvents.push("failed"),
    reportBuilt: () => W.reportEvents.push("built"),
    reportSubmitting: () => W.reportEvents.push("submitting"),
    autoConfirmOff: noop, reportWindowClosed: noop, reportLanded: noop, roundChanged: noop,
    drawShown: (state: { kind: string }) => W.reportEvents.push(`draw:${state.kind}`),
  }
})
/** a test may give the mesh link states: `link(peer)` for every peer the
 *  session asks the mesh for; none by default, so no link is ever judged */
const MESH = vi.hoisted(() => ({
  away: new Set<string>(),
  saidAway: new Set<string>(),
  peerReturnEpoch: 0,
  link: null as null | ((peer: string) => RTCPeerConnectionState),
  /** the peers whose video stream the mesh holds; the session only asks whether one is here */
  streams: new Map<string, unknown>(),
  pathEvidence: false,
  /** the transport the session handed the mesh on its last render */
  transport: undefined as unknown,
  roomKey: "",
  peers: [] as string[],
  /** a later round's co-players, linked ahead on standby */
  standby: [] as string[],
  round: null as number | null,
  gameTurn: null as number | null,
  openedRooms: [] as string[],
  closedRooms: [] as string[],
  gestures: [] as { peerId: string; tag: "Accept" | "Unaccept"; round: number; turn: number | null }[],
  sentGestures: [] as [string, "Accept" | "Unaccept", number][],
}))
const TURN = vi.hoisted(() => ({
  players: [] as (Uint8Array | undefined)[],
  warmups: 0,
}))
vi.mock("./webrtc/ice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webrtc/ice")>()),
  setTurnPlayerAccount: (account: Uint8Array | undefined) => TURN.players.push(account),
  warmIceServers: async () => {
    TURN.warmups++
  },
}))
vi.mock("./webrtc/useMesh", () => {
  const mesh = {
    localStream: null, streams: new Map(), states: new Map(), gestures: [], sendGesture: () => {},
    present: new Set(), stats: () => undefined, health: () => new Map(), verdict: null, noUsablePath: false, links: [], seats: new Map(),
  }
  return {
    useMesh: ({ roomKey, peers, standby, createTransport, round, gameTurn }: { roomKey: string; peers: string[]; standby?: string[]; createTransport?: unknown; round: number | null; gameTurn: number | null }) => {
      MESH.transport = createTransport
      MESH.gameTurn = gameTurn
      MESH.peers = [...peers]
      MESH.standby = [...(standby ?? [])]
      MESH.round = round
      if (roomKey !== MESH.roomKey) {
        if (MESH.roomKey) MESH.closedRooms.push(MESH.roomKey)
        MESH.roomKey = roomKey
        if (roomKey) MESH.openedRooms.push(roomKey)
      }
      const link = MESH.link
      return {
        ...mesh,
        away: MESH.away,
        saidAway: MESH.saidAway,
        peerReturnEpoch: MESH.peerReturnEpoch,
        streams: MESH.streams,
        gestures: MESH.gestures,
        sendGesture: (peerId: string, tag: "Accept" | "Unaccept", round: number) => MESH.sentGestures.push([peerId, tag, round]),
        states: link ? new Map(peers.map((peer) => [peer, link(peer)])) : mesh.states,
        health: () => new Map(peers.map((peer) => [peer, {
          conn: link?.(peer) ?? "new",
          everConnected: MESH.pathEvidence,
          gaveEndpoint: MESH.pathEvidence,
          createdAt: 0,
          failCount: 0,
        }])),
      }
    },
  }
})

import { ctaLabel, sessionNowMs, useGameSession, type GameSessionView, type Vote } from "./game-session"
import { advance, createClockSync } from "./clock-sync"
import { TILES_ENTER_SECONDS } from "@jollity/game-chain/game"
import { summarizeVotes, type AutoSeals, type TurnVotes } from "./game-roster"
import { createDeviceClock } from "./device-clock"
import { makeSource as makeChainSource } from "./game-source"
import { resetChainClockForTests, setChainNow } from "./chain-clock"
import { resetStoreClockForTests, storeClock } from "./store-clock"
import { TTL_S, type SignalStats } from "@jollity/statement-core"
import type { GameEngine, PalletGame } from "@jollity/protocol"
import type { ReportVote } from "@jollity/protocol"
import { recorded, resetRecorded } from "./telemetry/testing"
import { reportStatusOf } from "./report-missed"
import { ReportWindowClosedError } from "./report-retry"
import { captureLegacyDecisions } from "./webrtc/legacy-decision-capture"

// ── the game: 2 rounds of a 4-seat group, you in seat 0 ─────────────────────
// Round r runs [55r, 55r + 48) after G (4 turns of 12 s: 2 intro, 8 play,
// 2 ending), the gap is 7 s, the last turn ends at G + 103, and the report
// window closes REPORT_WINDOW seconds later.
const G = 2_000_000_000
const SEATS = 4
const ROUNDS = 2
const GAME_END = 103
const REPORT_WINDOW = 20
const ME = "me"
const B = "bob"
const C = "carol"
const D = "dave"
const seat = (index: number, who: string) => ({ index, player: { type: "Account", value: who } })
const group = () => [seat(0, ME), seat(1, B), seat(2, C), seat(3, D)]

/** the pallet's report call and its phases, as far as the session can tell.
 *  The game is in Reporting until report_ends, or until every attendance is
 *  decided (`earlyProcess`), then in PlayerProcess, where gameView() reads
 *  null and step 1 archives the Players row. */
type Chain = {
  reports: ReportVote[][][]
  calls: number
  mode: "land" | "hang" | "fail-but-land" | "land-unheard"
  /** the chain left Reporting early (pending_attendance == 0) */
  earlyProcess: boolean
  /** seconds the node's best block trails the chain's clock */
  bestLag: number
  /** step 1 has processed the player once the game left Reporting */
  processed: boolean
  /** the co-players accepted the player: attendance follows a sent report */
  accepted: boolean
  /** the node still holds the last block in Reporting (the best chain down to finalized) */
  reportingBlockHeld: boolean
  /** the next N report-status reads fail */
  statusReadFailures: number
  /** Game.Game is cleared: the chain holds no game at all */
  cleared: boolean
}
let chain: Chain
function fakeChain(mode: Chain["mode"] = "land"): Chain {
  return {
    reports: [],
    calls: 0,
    mode,
    earlyProcess: false,
    bestLag: 0,
    processed: true,
    accepted: true,
    reportingBlockHeld: true,
    statusReadFailures: 0,
    cleared: false,
  }
}
const REPORT_ENDS = G + GAME_END + REPORT_WINDOW
/** the page's chain clock minus the true chain time, in seconds */
let clockShift = 0
/** the chain is in Reporting at chain second `at` */
const inReporting = (at = Date.now() / 1000) => !chain.earlyProcess && at < REPORT_ENDS
function makeSource() {
  return {
    kind: "chain",
    player: ME,
    nowSeconds: () => Date.now() / 1000 + clockShift,
    signalling: undefined,
    gameView: async () => {
      // the doorway resolves a view in Shuffle and Reporting alone
      if (Date.now() / 1000 >= G && !inReporting(Date.now() / 1000 - chain.bestLag)) return null
      return {
        gameIndex: 7,
        timing: { gameDate: G, reportEnds: REPORT_ENDS, rounds: ROUNDS, maxGroupSize: SEATS },
        mySeat: [0, 0],
        seats: [group(), group()],
        // `Game.Players(me).sent_report`, as the doorway reads it
        reportSent: chain.reports.length > 0,
      }
    },
    // the doorway's status read: the node's best block, through the real derivation
    reportStatus: async (gameIndex?: number) => {
      if (chain.statusReadFailures > 0) {
        chain.statusReadFailures--
        return { gameIndex, closed: false, report: "unknown" as const }
      }
      const reporting = inReporting(Date.now() / 1000 - chain.bestLag)
      const sent = chain.reports.length > 0
      const game: PalletGame = {
        index: 7,
        state: reporting ? { type: "Reporting", value: { player_count: SEATS } } : { type: "PlayerProcess" },
        airdrops_scheduled: 1,
        registration_ends: G - 300,
        shuffle_deadline: G - 200,
        game_date: G,
        report_ends: REPORT_ENDS,
        rounds: ROUNDS,
        max_group_size: SEATS,
      }
      const archived = !reporting && chain.processed
      return reportStatusOf(
        {
          game: chain.cleared ? undefined : game,
          player: archived ? undefined : { registered: true, sent_report: sent },
          lastAttendedGame: archived && sent && chain.accepted ? 7 : null,
          ...(archived && chain.reportingBlockHeld ? { reportingRow: { registered: true, sent_report: sent } } : {}),
        },
        gameIndex,
      )
    },
    // the pallet's `report`:
    // one per player (ReportAlreadySent), inside the window (NoReporting)
    submitReport: (report: ReportVote[][]) => {
      chain.calls++
      if (chain.mode === "hang") return new Promise<void>(() => {})
      if (!inReporting()) return Promise.reject(new ReportWindowClosedError())
      if (chain.reports.length > 0) return Promise.reject(new Error("ReportAlreadySent"))
      chain.reports.push(report)
      if (chain.mode === "fail-but-land") {
        chain.mode = "land"
        return Promise.reject(new Error("the transaction watch ended before any block held it"))
      }
      if (chain.mode === "land-unheard") {
        // the last report in: every attendance is decided, the chain moves on
        chain.earlyProcess = true
        chain.mode = "land"
        return Promise.reject(new Error("subscription dropped"))
      }
      return Promise.resolve()
    },
  }
}

/** The page's watcher: one first-frame offer per arming, and a new arming
 *  whenever the session's videoObservationEpoch for that peer moves. A stream
 *  that keeps playing is therefore offered again inside a turn, but a frame is
 *  never re-offered on a timer. */
function offerLikeThePage(ids: string[]) {
  const armed = new Map<string, number>()
  const poll = () => {
    if (!view) return setTimeout(poll, 1)
    for (const id of ids) {
      if (!view.display.includes(id)) continue
      const epoch = view.videoObservationEpoch(id)
      if (armed.get(id) === epoch) continue
      armed.set(id, epoch)
      R.act(() => view.markVideoArrived(id))
    }
    setTimeout(poll, 100)
  }
  setTimeout(poll, 0)
}

let view: GameSessionView
function mountSession(markSeen = true) {
  W.router = {
    push: vi.fn(),
    replace: vi.fn((url: string) => {
      if (url === "/connection-help") W.isolationActions.push("navigate")
    }),
    prefetch: vi.fn(),
  }
  R.mount(() => {
    view = useGameSession()
  })
  // The pre-#426 scenarios exercise voting rather than decoded-video roles.
  // Give them the video evidence their old assumptions implied. New #426
  // scenarios opt out and drive markVideoArrived explicitly.
  if (markSeen) offerLikeThePage([B, C, D])
  return W.router
}
/** let the wall clock (and every timer) run to G + sec */
async function runTo(sec: number) {
  const ms = (G + sec) * 1000 - Date.now()
  if (ms > 0) await vi.advanceTimersByTimeAsync(ms)
}
async function waitForSubmitState(state: GameSessionView["submitState"], timeoutMs = 2000) {
  for (let elapsed = 0; elapsed <= timeoutMs && view.submitState !== state; elapsed += 25)
    await vi.advanceTimersByTimeAsync(25)
}
/** the app is backgrounded: no timer fires until G + sec, then one tick does */
async function sleepTo(sec: number) {
  vi.setSystemTime((G + sec) * 1000)
  await vi.advanceTimersByTimeAsync(600)
}
const tap = (id: string, verdict: Vote) => R.act(() => view.voteFor(id, verdict))
// the end screens replace /game rather than push over it (#427)
const wentToDraw = (router: { replace: ReturnType<typeof vi.fn> }) =>
  router.replace.mock.calls.some(([url]) => String(url).startsWith("/prize-draw?game=7"))
const wentToMissed = (router: { replace: ReturnType<typeof vi.fn> }) =>
  router.replace.mock.calls.some(([url]) => url === "/collectables?game=7")
/** B's verdict in each round's report (B is the first co-player, seat 1) */
const bobFiled = () => chain.reports.at(-1)?.map((round) => round[0])

/** the page's visibility, as the session reads it: `document` is a bare target */
let doc: EventTarget & { visibilityState: "visible" | "hidden" }
const setVisibility = (state: "visible" | "hidden") => {
  doc.visibilityState = state
  doc.dispatchEvent(new Event("visibilitychange"))
}

const signalStats = (over: Partial<NonNullable<typeof HEALTH.stats>> = {}) => ({
  kind: "statement",
  storeLive: true,
  subActive: true,
  submitsOk: 0,
  submitsFailed: 0,
  framesSent: 0,
  framesRecv: 0,
  lastSubmitOkAt: 0,
  lastInboundAt: 0,
  lastError: "",
  inflight: 0,
  firstSendAt: 0,
  signTimeouts: 0,
  ...over,
})

const publishSignalStats = (over: Partial<NonNullable<typeof HEALTH.stats>> = {}) => {
  HEALTH.stats = signalStats(over)
  for (const listener of HEALTH.listeners) listener()
}

beforeEach(() => {
  setChainNow(() => Date.now())
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" as const }) as typeof doc
  vi.stubGlobal("document", doc)
  vi.useFakeTimers()
  vi.setSystemTime((G - 5) * 1000)
  W.joined = true
  W.viaDoor = false
  W.source = makeSource()
  TURN.players = []
  TURN.warmups = 0
  W.logs = []
  W.logData = []
  W.store = new Map([
    [
      "jollity.votes",
      JSON.stringify({
        gameIndex: 7,
        account: ME,
        turnVotes: {},
        banned: [],
        overrides: {},
        autoSeals: {},
        videoRoleHistory: {
          [B]: { fromTurn: 0 },
          [C]: { fromTurn: 0 },
          [D]: { fromTurn: 0 },
        },
      }),
    ],
  ])
  W.built = []
  W.reportEvents = []
  W.isolationActions = []
  W.writes = []
  W.readHangs = false
  W.readHangsFirst = 0
  W.readDelayMs = 0
  W.readFailures = 0
  W.drawScheduled = undefined
  HEALTH.stats = null
  MESH.link = null
  MESH.streams = new Map()
  MESH.transport = undefined
  MESH.roomKey = ""
  MESH.peers = []
  MESH.round = null
  MESH.gameTurn = null
  MESH.openedRooms = []
  MESH.closedRooms = []
  MESH.gestures = []
  MESH.sentGestures = []
  MESH.away = new Set()
  MESH.saidAway = new Set()
  MESH.peerReturnEpoch = 0
  MESH.pathEvidence = false
  resetRecorded()
  chain = fakeChain()
  clockShift = 0
})
afterEach(() => {
  R.unmount()
  resetChainClockForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("harness — paths the model says HOLD", () => {
  it("a full game files one report that matches the grid, then opens the draw", async () => {
    const router = mountSession()
    await runTo(3) // round 0, you host: everyone else votable
    tap(B, "person")
    tap(C, "person")
    await runTo(15) // B hosts: B is not votable
    expect(view.votable(B)).toBe(false)
    await runTo(GAME_END + 1)
    expect(view.confirming).toBe(true)
    expect(view.autoActive).toBe(true)
    const shown = [B, C, D].map((id) => view.voteShown(id))
    await runTo(GAME_END + 9)
    expect(chain.calls).toBe(1)
    const filed = chain.reports[0]
    expect(filed).toHaveLength(ROUNDS)
    // the grid's verdict IS the report's, in every round the player sat in
    for (const round of filed) expect(round).toEqual(shown.map((v) => (v === "person" ? "Person" : "NotPerson")))
    expect(wentToDraw(router)).toBe(true)
  })

  it("a full game with no scheduled draw skips its screen and opens the collectables screen (#515)", async () => {
    W.drawScheduled = 0
    const router = mountSession()
    await runTo(GAME_END + 9)
    expect(chain.calls).toBe(1)
    expect(wentToMissed(router)).toBe(true)
    expect(wentToDraw(router)).toBe(false)
    expect(W.reportEvents).toContain("draw:none")
  })

  it("#437: a peer returning at the isolation deadline gets a fresh recovery grace", async () => {
    const base = makeSource()
    const gameView = (await base.gameView())!
    const pair = [seat(0, ME), seat(1, B)]
    W.source = {
      ...base,
      signalling: () => ({}),
      gameView: async () => ({
        ...gameView,
        timing: { ...gameView.timing, rounds: 1, maxGroupSize: 10, reportEnds: G + 140 },
        seats: [pair],
      }),
    }
    MESH.link = () => "connected"
    const router = mountSession()
    await runTo(3)
    expect(view.peerSignal(B)).toBe("connected")
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")

    // The host goes away and its link fails. This render starts the existing
    // 30-second isolation grace for the remaining player.
    MESH.away = new Set([B])
    MESH.link = () => "failed"
    await vi.advanceTimersByTimeAsync(600)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")

    // As in Previewnet game 92, the host announces that it is back just before
    // that deadline, while its fresh peer connection still needs another tick
    // to become connected. The old isolation timer must not eject the player
    // while this new recovery attempt is visibly in progress.
    await vi.advanceTimersByTimeAsync(24_000)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")
    MESH.away = new Set()
    MESH.peerReturnEpoch++
    await vi.advanceTimersByTimeAsync(600)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")
    await vi.advanceTimersByTimeAsync(3_000)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")
    MESH.link = () => "connected"
    await vi.advanceTimersByTimeAsync(600)

    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")
  })

  it("#437: an explicitly-away sole peer can return after the old isolation deadline", async () => {
    vi.stubGlobal("navigator", { onLine: true })
    const base = makeSource()
    const gameView = (await base.gameView())!
    const pair = [seat(0, ME), seat(1, B)]
    W.source = {
      ...base,
      signalling: () => ({}),
      gameView: async () => ({
        ...gameView,
        timing: { ...gameView.timing, rounds: 1, maxGroupSize: 10, reportEnds: G + 140 },
        seats: [pair],
      }),
    }
    MESH.link = () => "connected"
    const router = mountSession()
    await runTo(3)

    // Game 94's remote page announced it was away before its link failed. An
    // absent peer is not proof that this browser is isolated, so the old
    // 30-second local-isolation deadline must not eject the remaining player.
    MESH.away = new Set([B])
    MESH.saidAway = new Set([B])
    MESH.link = () => "failed"
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")

    // The peer's first fresh presence landed just after that old boundary.
    // Its still-dead link begins a fresh ordinary grace, which a successful
    // reconnect cancels.
    MESH.away = new Set()
    MESH.saidAway = new Set()
    MESH.peerReturnEpoch++
    await vi.advanceTimersByTimeAsync(600)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")
    await vi.advanceTimersByTimeAsync(3_000)
    MESH.link = () => "connected"
    await vi.advanceTimersByTimeAsync(600)

    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")
  })

  it("#437: a timeout-away sole peer still proves local isolation", async () => {
    vi.stubGlobal("navigator", { onLine: true })
    const base = makeSource()
    const gameView = (await base.gameView())!
    const pair = [seat(0, ME), seat(1, B)]
    W.source = {
      ...base,
      signalling: () => ({}),
      gameView: async () => ({
        ...gameView,
        timing: { ...gameView.timing, rounds: 1, maxGroupSize: 10, reportEnds: G + 140 },
        seats: [pair],
      }),
    }
    MESH.link = () => "connected"
    const router = mountSession()
    await runTo(3)

    // The link supervisor's timeout-away label must not make a genuinely
    // unreachable peer disappear from the local-isolation verdict.
    MESH.link = () => "failed"
    await vi.advanceTimersByTimeAsync(9_000)
    MESH.away = new Set([B])
    await vi.advanceTimersByTimeAsync(600)
    expect(view.isolated).toBe(true)
    expect(view.playerNetworkIsolated).toBe(false)

    // A PC state by itself is not proof of a player-network outage: a host
    // signalling failure can leave every eagerly-created PC failed/new too.
    // Once a peer previously connected or supplied an endpoint, simultaneous
    // loss of every path is the stronger diagnosis used by the notice.
    MESH.pathEvidence = true
    await vi.advanceTimersByTimeAsync(600)
    expect(view.playerNetworkIsolated).toBe(true)
    await vi.advanceTimersByTimeAsync(20_800)

    expect(router.replace).toHaveBeenCalledWith("/connection-help")
  })

  it("captures one isolation deadline before tracing and navigating", async () => {
    vi.stubGlobal("navigator", { onLine: true })
    const base = makeSource()
    const gameView = (await base.gameView())!
    const pair = [seat(0, ME), seat(1, B)]
    W.source = {
      ...base,
      signalling: () => ({}),
      gameView: async () => ({
        ...gameView,
        timing: { ...gameView.timing, rounds: 1, maxGroupSize: 10, reportEnds: G + 140 },
        seats: [pair],
      }),
    }
    MESH.link = () => "connected"
    const capture = captureLegacyDecisions((record) => {
      if (record.kind === "isolation-commit") W.isolationActions.push("capture")
    })
    try {
      const router = mountSession()
      await runTo(3)
      MESH.link = () => "failed"
      MESH.pathEvidence = true
      await vi.advanceTimersByTimeAsync(31_000)

      expect(capture.records.filter((record) => record.kind === "isolation-commit")).toHaveLength(1)
      expect(W.isolationActions).toEqual(["capture", "trace", "navigate"])
      expect(router.replace).toHaveBeenCalledTimes(1)
      expect(router.replace).toHaveBeenCalledWith("/connection-help")
    } finally {
      capture.stop()
    }
  })

  it("#437: said-away peers cannot hide one timeout-away expected peer", async () => {
    vi.stubGlobal("navigator", { onLine: true })
    const base = makeSource()
    const gameView = (await base.gameView())!
    W.source = {
      ...base,
      signalling: () => ({}),
      gameView: async () => ({
        ...gameView,
        timing: { ...gameView.timing, rounds: 1, maxGroupSize: 10, reportEnds: G + 140 },
        seats: [group()],
      }),
    }
    MESH.link = () => "connected"
    const router = mountSession()
    await runTo(3)

    MESH.link = () => "failed"
    MESH.away = new Set([B, C, D])
    MESH.saidAway = new Set([B, C])
    await vi.advanceTimersByTimeAsync(31_000)

    expect(router.replace).toHaveBeenCalledWith("/connection-help")
  })

  it("#437: staggered away additions across peers do not postpone isolation", async () => {
    const base = makeSource()
    const gameView = (await base.gameView())!
    W.source = {
      ...base,
      signalling: () => ({}),
      gameView: async () => ({
        ...gameView,
        timing: { ...gameView.timing, rounds: 1, maxGroupSize: 10, reportEnds: G + 140 },
        seats: [group()],
      }),
    }
    MESH.link = () => "connected"
    const router = mountSession()
    await runTo(3)

    MESH.link = () => "failed"
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(8_000)
    MESH.away = new Set([B])
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(8_000)
    MESH.away = new Set([B, C])
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(8_000)
    MESH.away = new Set([B, C, D])
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(7_000)

    expect(router.replace).toHaveBeenCalledWith("/connection-help")
  })

  it("#437: away/back churn with no link ever connected cannot renew the grace", async () => {
    vi.stubGlobal("navigator", { onLine: true })
    const base = makeSource()
    const gameView = (await base.gameView())!
    const trio = [seat(0, ME), seat(1, B), seat(2, C)]
    W.source = {
      ...base,
      signalling: () => ({}),
      gameView: async () => ({
        ...gameView,
        timing: { ...gameView.timing, rounds: 1, maxGroupSize: 10, reportEnds: G + 140 },
        seats: [trio],
      }),
    }
    MESH.link = () => "connected"
    const router = mountSession()
    await runTo(3)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")

    // Every link stays failed for the rest of the test, so every isolated
    // millisecond below is real isolation and no peer ever reconnects.
    MESH.link = () => "failed"

    // Episode 1: 20 s of isolation, then both peers say away at once. With
    // no expected peer left to judge by, the clock legitimately pauses.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")
    MESH.saidAway = new Set([B, C])
    MESH.away = new Set([B, C])
    await vi.advanceTimersByTimeAsync(600)
    expect(view.isolated).toBe(false)

    // Episode 2: they come back, still unreachable. No link has connected
    // once, so this is the same sustained failure, not a new recovery.
    MESH.saidAway = new Set()
    MESH.away = new Set([B, C])
    MESH.peerReturnEpoch++
    await vi.advanceTimersByTimeAsync(600)
    expect(view.isolated).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")

    // Episode 3: they churn once more.
    MESH.saidAway = new Set([B, C])
    MESH.away = new Set([B, C])
    await vi.advanceTimersByTimeAsync(600)
    MESH.saidAway = new Set()
    MESH.away = new Set([B, C])
    MESH.peerReturnEpoch++
    await vi.advanceTimersByTimeAsync(600)
    expect(view.isolated).toBe(true)

    // 61 s of real isolation: two graces plus a second. Away/back churn
    // cannot postpone a real isolation indefinitely, so the player must be
    // on the help page by now.
    await vi.advanceTimersByTimeAsync(21_000)
    expect(router.replace).toHaveBeenCalledWith("/connection-help")
  })

  it("#437: an isolation episode does not carry its deadline across the round change", async () => {
    vi.stubGlobal("navigator", { onLine: true })
    const base = makeSource()
    const gameView = (await base.gameView())!
    W.source = {
      ...base,
      signalling: () => ({}),
      gameView: async () => ({
        ...gameView,
        timing: { ...gameView.timing, rounds: 2, maxGroupSize: 4, reportEnds: G + 140 },
        seats: [group(), group()],
      }),
    }
    const router = mountSession()
    await runTo(3)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")

    // Late in round 0 the links fail while the peers are still present, so
    // this player is isolated and an episode starts with its own deadline,
    // which lands after the round change at 55.
    await runTo(30)
    MESH.link = () => "failed"
    await vi.advanceTimersByTimeAsync(600)
    await runTo(50)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")

    // Round 1 starts at 55 and runs to 103. Between rounds nothing is
    // isolated and no link has connected, so the episode must not survive
    // into round 1: its peers get a full grace from round 1's own start.
    // 10 s into round 1 the old deadline (about 60) is already past.
    await runTo(65)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")
    // Past a full grace of round 1 (55 + 30).
    await runTo(90)
    expect(router.replace).toHaveBeenCalledWith("/connection-help")
  })

  it("#437: repeated away/back churn cannot extend isolation more than once", async () => {
    const base = makeSource()
    const gameView = (await base.gameView())!
    const pair = [seat(0, ME), seat(1, B)]
    W.source = {
      ...base,
      signalling: () => ({}),
      gameView: async () => ({
        ...gameView,
        timing: { ...gameView.timing, rounds: 1, maxGroupSize: 10, reportEnds: G + 140 },
        seats: [pair],
      }),
    }
    MESH.link = () => "connected"
    const router = mountSession()
    await runTo(3)

    MESH.away = new Set([B])
    MESH.link = () => "failed"
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(24_000)
    MESH.away = new Set()
    MESH.peerReturnEpoch++
    await vi.advanceTimersByTimeAsync(600)

    await vi.advanceTimersByTimeAsync(10_000)
    MESH.away = new Set([B])
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(1_000)
    MESH.away = new Set()
    MESH.peerReturnEpoch++
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(21_000)

    expect(router.replace).toHaveBeenCalledWith("/connection-help")
  })

  it("a ban rejects the player in every later turn the tick opens", async () => {
    mountSession()
    await runTo(3)
    tap(B, "person")
    await runTo(27) // round 0, C hosts
    tap(B, "person")
    await runTo(39) // round 0, D hosts
    R.act(() => view.ban(B))
    await runTo(GAME_END + 9)
    // person ×2 against the ban's reject ×4 (r0 D's turn + every B-votable turn of round 1)
    expect(bobFiled()).toEqual(["NotPerson", "NotPerson"])
  })

  it("a failed submit stays locked while the automatic retry lands", async () => {
    const source = W.source as ReturnType<typeof makeSource>
    const real = source.submitReport
    let first = true
    source.submitReport = (report) => {
      if (first) {
        first = false
        chain.calls++
        return Promise.reject(new Error("transient"))
      }
      return real(report)
    }
    const router = mountSession()
    await runTo(GAME_END + 8)
    expect(view.submitState).toBe("submitting")
    expect(view.votable(C)).toBe(false)
    expect(W.reportEvents).not.toContain("failed")
    await vi.advanceTimersByTimeAsync(1_600)
    expect(wentToDraw(router)).toBe(true)
  })

  it("automatically retries a failed report after 1.5 seconds without a tap", async () => {
    const source = W.source as ReturnType<typeof makeSource>
    const real = source.submitReport
    let first = true
    source.submitReport = (report) => {
      if (first) {
        first = false
        chain.calls++
        return Promise.reject(new Error("cannot get the current block: subscription dropped"))
      }
      return real(report)
    }
    const router = mountSession()
    await runTo(GAME_END + 8)
    expect(view.submitState).toBe("submitting")
    await vi.advanceTimersByTimeAsync(1600)
    expect(chain.calls).toBe(2)
    expect(W.reportEvents.filter((event) => event === "built")).toHaveLength(1)
    expect(W.reportEvents.filter((event) => event === "submitting")).toHaveLength(1)
    expect(wentToDraw(router)).toBe(true)
  })

  it("a lost handover probe accelerates retries without skipping confirm review", async () => {
    const source = makeSource()
    const real = source.submitReport
    const starts: number[] = []
    let first = true
    source.submitReport = (report) => {
      starts.push(Date.now())
      if (first) {
        first = false
        chain.calls++
        return Promise.reject(new Error("cannot get the current block: subscription dropped"))
      }
      return real(report)
    }
    W.source = {
      ...source,
      probeChainHealth: async () => ({
        outcome: "host-chain-lost" as const,
        latencyMs: 4,
        errorClass: "subscription-dropped" as const,
        error: "subscription dropped",
      }),
    }
    mountSession()
    await runTo(GAME_END + 2)
    expect(chain.calls).toBe(0)
    await runTo(GAME_END + 8)
    expect(chain.calls).toBe(2)
    expect(starts[1] - starts[0]).toBeLessThan(100)
    expect(W.built[0]).toMatchObject({ filedBy: "auto-confirm" })
  })

  it("shows a non-blocking stuck-host state in the round and clears it on health", async () => {
    const source = makeSource()
    let probe = 0
    W.source = {
      ...source,
      probeChainHealth: async () => {
        probe += 1
        if (probe === 1)
          return {
            outcome: "unknown" as const,
            latencyMs: 5000,
            errorClass: "timeout" as const,
            error: "chain health probe timed out",
          }
        if (probe === 2)
          return {
            outcome: "host-chain-lost" as const,
            latencyMs: 5000,
            errorClass: "timeout" as const,
            error: "two chain health probes timed out in a row",
            consecutiveLost: 1,
          }
        return { outcome: "healthy" as const, latencyMs: 2, consecutiveLost: 0 }
      },
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(0)
    expect(view.hostStuck).toBe(false)

    await runTo(14)
    expect(view.phase).toBe("live")
    expect(view.hostStuck).toBe(true)
    expect(view.hostStuckReason).toBe("host-unanswered")
    expect(view.hostStuckConsecutiveOpens).toBe(1)
    expect(recorded.metrics).not.toContainEqual(expect.objectContaining({ name: "chain.restart_card_shown" }))

    await runTo(16)
    expect(view.hostStuck).toBe(false)
  })

  it("exposes a concrete handover loss reason to the game card", async () => {
    const source = makeSource()
    W.source = {
      ...source,
      probeChainHealth: async () => ({
        outcome: "host-chain-lost" as const,
        latencyMs: 3,
        errorClass: "subscription-dropped" as const,
        error: "subscription dropped",
        consecutiveLost: 1,
      }),
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(0)
    expect(view.hostStuck).toBe(true)
    expect(view.hostStuckReason).toBe("chain-lost")
  })

  it.each([
    ["submit", "submitsOk", "lastSubmitOkAt"],
    ["receive", "framesRecv", "lastInboundAt"],
  ] as const)("clears the in-round bar on a fresh store %s and ignores an older probe", async (_kind, count, at) => {
    const source = makeSource()
    let finishStaleProbe!: (result: {
      outcome: "host-chain-lost"
      latencyMs: number
      errorClass: "subscription-dropped"
      error: string
    }) => void
    let probe = 0
    W.source = {
      ...source,
      signalling: () => ({}),
      probeChainHealth: async () => {
        probe += 1
        if (probe === 1)
          return {
            outcome: "unknown" as const,
            latencyMs: 5000,
            errorClass: "timeout" as const,
            error: "chain health probe timed out",
          }
        if (probe === 2)
          return {
            outcome: "host-chain-lost" as const,
            latencyMs: 5000,
            errorClass: "timeout" as const,
            error: "two chain health probes timed out in a row",
          }
        return new Promise((resolve) => {
          finishStaleProbe = resolve
        })
      },
    }
    publishSignalStats()
    mountSession()

    await runTo(14)
    expect(view.hostStuck).toBe(true)

    // The card's 5 s re-check starts on the old host path and remains in
    // flight. A new statement-store submit is independent recovery evidence
    // and must clear the bar well inside the 15 s live acceptance bound.
    await runTo(15)
    expect(probe).toBe(3)
    const recoveredAt = Date.now()
    R.act(() => publishSignalStats({ [count]: 1, [at]: Date.now() }))
    await vi.advanceTimersByTimeAsync(0)
    expect(view.hostStuck).toBe(false)
    expect(Date.now() - recoveredAt).toBeLessThan(15_000)

    // Its attempt order was captured before the store recovery, so a late
    // stale failure cannot put the bar back up.
    finishStaleProbe({
      outcome: "host-chain-lost",
      latencyMs: 5000,
      errorClass: "subscription-dropped",
      error: "old resumed subscription dropped",
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(view.hostStuck).toBe(false)
  })

  it("cancels an armed automatic retry when the page unmounts", async () => {
    const source = W.source as ReturnType<typeof makeSource>
    source.submitReport = () => {
      chain.calls++
      return Promise.reject(new Error("cannot get the current block: subscription dropped"))
    }
    mountSession()
    await runTo(GAME_END + 8)
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.calls).toBe(1)
    expect(view.submitState).toBe("submitting")
    R.unmount()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(chain.calls).toBe(1)
  })

  it("retries fast #76 failures every 1.5 seconds and stops at report_ends", async () => {
    const source = W.source as ReturnType<typeof makeSource>
    const starts: number[] = []
    source.submitReport = () => {
      chain.calls++
      starts.push(Date.now())
      return Promise.reject(new Error("cannot get the current block: subscription dropped"))
    }
    mountSession()
    await runTo(GAME_END + 8)
    await vi.advanceTimersByTimeAsync(4_600)
    expect(starts.length).toBeGreaterThanOrEqual(4)
    expect(starts.slice(1).every((at, index) => at - starts[index]! === 1_500)).toBe(true)
    await runTo(GAME_END + REPORT_WINDOW + 5)
    const callsAfterClose = chain.calls
    await vi.advanceTimersByTimeAsync(5_000)
    expect(chain.calls).toBe(callsAfterClose)
    expect(W.reportEvents.filter((event) => event === "built")).toHaveLength(1)
    expect(W.reportEvents.filter((event) => event === "submitting")).toHaveLength(1)
    expect(W.reportEvents.filter((event) => event === "failed")).toHaveLength(1)
  })

  it("waits for a healthy eight-second inclusion without duplicating or failing", async () => {
    const source = W.source as ReturnType<typeof makeSource>
    source.submitReport = (report) => {
      chain.calls++
      chain.reports.push(report)
      return new Promise<void>((resolve) => setTimeout(resolve, 8_000))
    }
    const router = mountSession()
    await runTo(GAME_END + 8)
    expect(chain.calls).toBe(1)
    expect(view.submitState).toBe("submitting")
    await vi.advanceTimersByTimeAsync(7_000)
    expect(chain.calls).toBe(1)
    expect(W.reportEvents).toEqual(["built", "submitting"])
    expect(wentToDraw(router)).toBe(true)
  })

  it("records no terminal failure when a deadline rejection already landed on chain", async () => {
    const source = W.source as ReturnType<typeof makeSource>
    let reject: ((error: Error) => void) | undefined
    source.submitReport = (report) => {
      chain.calls++
      chain.reports.push(report)
      return new Promise<void>((_, rejectPromise) => (reject = rejectPromise))
    }
    const router = mountSession()
    await runTo(GAME_END + 8)
    await runTo(GAME_END + REPORT_WINDOW + 1)
    reject!(new Error("the transaction watch ended at the deadline"))
    await vi.advanceTimersByTimeAsync(0)
    expect(wentToDraw(router)).toBe(true)
    expect(W.reportEvents).not.toContain("failed")
  })
})

describe("useGameSession — co-player taps", () => {
  it("records one game.tap_received row when a co-player accept for this round arrives", async () => {
    // Given
    mountSession()
    await runTo(3)
    expect(MESH.peers).toContain(B)

    // When
    MESH.gestures = [{ peerId: B, tag: "Accept", round: 0, turn: MESH.gameTurn }]
    R.rerender()
    R.rerender()

    // Then
    expect(view.acceptedYou).toBe(1)
    const received = recorded.metrics.filter((m) => m.name === "game.tap_received")
    expect(received).toHaveLength(1)
    expect(received[0]!.attrs).toMatchObject({ outcome: "shown", round: "1", "rtc.pair": "g7:r1:bc9b90b71742", "tap.tag": "accept", "tap.seq": "1" })
  })

  it("shows a co-player accept again on a later turn of the same round", async () => {
    // Given
    mountSession()
    await runTo(inTurnOf(0))
    MESH.gestures = [{ peerId: B, tag: "Accept", round: 0, turn: MESH.gameTurn }]
    R.rerender()
    R.rerender()
    await runTo(inTurnOf(1))
    expect(view.acceptedYou).toBe(0)

    // When
    MESH.gestures = [...MESH.gestures, { peerId: B, tag: "Accept", round: 0, turn: MESH.gameTurn }]
    R.rerender()
    R.rerender()

    // Then
    expect(view.acceptedYou).toBe(1)
    const received = recorded.metrics.filter((m) => m.name === "game.tap_received")
    expect(received.map((m) => m.attrs.outcome)).toEqual(["shown", "shown"])
    expect(received[1]!.attrs).toMatchObject({ "tap.seq": "2", "tap.turn": "1" })
  })

  it("counts only the co-players who accepted you on this turn", async () => {
    // Given
    mountSession()
    await runTo(inTurnOf(0))
    MESH.gestures = [{ peerId: B, tag: "Accept", round: 0, turn: MESH.gameTurn }]
    R.rerender()
    R.rerender()
    await runTo(inTurnOf(1))

    // When
    MESH.gestures = [...MESH.gestures, { peerId: C, tag: "Accept", round: 0, turn: MESH.gameTurn }]
    R.rerender()
    R.rerender()

    // Then
    expect(view.acceptedYou).toBe(1)
  })

  it("shows nothing for a second co-player accept inside one turn", async () => {
    // Given
    mountSession()
    await runTo(inTurnOf(1))
    MESH.gestures = [{ peerId: B, tag: "Accept", round: 0, turn: MESH.gameTurn }]
    R.rerender()
    R.rerender()

    // When
    MESH.gestures = [...MESH.gestures, { peerId: B, tag: "Accept", round: 0, turn: MESH.gameTurn }]
    R.rerender()
    R.rerender()

    // Then
    expect(view.acceptedYou).toBe(1)
    const received = recorded.metrics.filter((m) => m.name === "game.tap_received")
    expect(received.map((m) => m.attrs.outcome)).toEqual(["shown", "already-accepted"])
  })

  it("takes a co-player who unaccepts you out of the count of this turn", async () => {
    // Given
    mountSession()
    await runTo(inTurnOf(1))
    MESH.gestures = [{ peerId: B, tag: "Accept", round: 0, turn: MESH.gameTurn }]
    R.rerender()
    R.rerender()

    // When
    MESH.gestures = [...MESH.gestures, { peerId: B, tag: "Unaccept", round: 0, turn: MESH.gameTurn }]
    R.rerender()
    R.rerender()

    // Then
    expect(view.acceptedYou).toBe(0)
  })

  async function acceptCastInTheNextRound() {
    mountSession()
    await runTo(inTurnOf(SEATS - 1))
    MESH.gestures = [{ peerId: B, tag: "Accept", round: 1, turn: MESH.gameTurn }]
    R.rerender()
    R.rerender()
  }

  it("shows an accept cast in the next round when that round opens", async () => {
    // Given
    await acceptCastInTheNextRound()
    expect(view.acceptedYou).toBe(0)

    // When
    await runTo(inTurnOf(SEATS))

    // Then
    expect(view.acceptedYou).toBe(1)
  })

  it("drops an accept cast in the next round on the second turn of that round", async () => {
    // Given
    await acceptCastInTheNextRound()
    await runTo(inTurnOf(SEATS))

    // When
    await runTo(inTurnOf(SEATS + 1))

    // Then
    expect(view.acceptedYou).toBe(0)
  })

  it("names a second accept on the first turn of the round, after one cast before it opened, already-accepted", async () => {
    // Given
    await acceptCastInTheNextRound()
    await runTo(inTurnOf(SEATS))

    // When
    MESH.gestures = [...MESH.gestures, { peerId: B, tag: "Accept", round: 1, turn: MESH.gameTurn }]
    R.rerender()
    R.rerender()

    // Then
    expect(view.acceptedYou).toBe(1)
    const received = recorded.metrics.filter((m) => m.name === "game.tap_received")
    expect(received.map((m) => m.attrs.outcome)).toEqual(["round-not-open", "already-accepted"])
  })

  it("records one game.tap_sent row when the player taps a co-player", async () => {
    // Given
    mountSession()
    await runTo(3)

    // When
    tap(B, "person")

    // Then
    expect(MESH.sentGestures).toEqual([[B, "Accept", 0]])
    const sent = recorded.metrics.filter((m) => m.name === "game.tap_sent")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.attrs).toMatchObject({ outcome: "handed", round: "1", "rtc.pair": "g7:r1:bc9b90b71742", "tap.tag": "accept", "tap.seq": "1" })
  })
})

describe("useGameSession — TLA+ counterexamples", () => {
  // S1. ConfirmEnds (liveness), GameSession_Hang.cfg: nothing bounds `submitReport`, so a
  // signer or watch that never answers leaves "Submitting..." for good — the
  // CTA disabled, no error, no retry, no draw.
  it("S1: a report that never settles still ends in a surfaced error", async () => {
    chain = fakeChain("hang")
    mountSession()
    await runTo(GAME_END + 9)
    expect(chain.calls).toBe(1)
    expect(view.submitState).toBe("submitting")
    await runTo(GAME_END + REPORT_WINDOW + 120) // the window has long closed
    expect(chain.calls).toBe(1)
    expect(view.submitState).toBe("error")
  })

  // S2. NoSubmitOutsideWindow, GameSession_Throttle.cfg: `confirming` holds on
  // "finished" too and confirmVotes reads no `reportEnds`. An app that was
  // backgrounded through the whole report window comes back to a confirm
  // stage that auto-files a report the pallet must refuse (NoReporting), and
  // every retry can only fail the same way. One mount, so it does not depend
  // on `gameView()` still answering after the window.
  it("S2: no report is sent once the report window has closed", async () => {
    mountSession()
    await runTo(3)
    await sleepTo(GAME_END + REPORT_WINDOW + 5) // backgrounded until past report_ends
    expect(view.confirming).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(chain.calls).toBe(0)
  })

  // S3a. ErrorIsRecoverable, GameSession_Faults.cfg: the report is
  // included but the client hears a failure (the watch errored or completed
  // first). The retry the CTA offers can only meet ReportAlreadySent, so a
  // player whose report counted never reaches the draw.
  it("S3a: after a report that landed unseen, the retry still reaches the draw", async () => {
    chain = fakeChain("fail-but-land")
    const router = mountSession()
    await runTo(GAME_END + 8)
    expect(chain.reports).toHaveLength(1) // it counted
    expect(view.submitState).toBe("submitting")
    await vi.advanceTimersByTimeAsync(1600) // automatic re-read sees it
    expect(wentToDraw(router)).toBe(true)
  })

  // S3b. AtMostOneReport, GameSession_Reload.cfg: a reload while "Submitting..." — the
  // submit on the wire still lands, and the rejoined session, which keeps
  // nothing, files a second report (ReportAlreadySent) and strands the player.
  it("S3b: a rejoin after the report landed does not file a second one", async () => {
    const source = W.source as ReturnType<typeof makeSource>
    const real = source.submitReport
    let release: (() => void) | undefined
    source.submitReport = (report) => {
      if (chain.calls === 0) {
        chain.calls++
        return new Promise<void>((resolve) => (release = () => void real(report).then(resolve)))
      }
      return real(report)
    }
    mountSession()
    await runTo(GAME_END + 8)
    expect(view.submitState).toBe("submitting")
    R.unmount() // the page reloads
    chain.calls-- // the reload does not cancel the submit on the wire; it lands now
    release!()
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.reports).toHaveLength(1)
    const router = mountSession() // rejoin (hasJoined)
    await runTo(GAME_END + 18)
    expect(chain.calls).toBe(1)
    expect(view.submitState).not.toBe("error")
    expect(wentToDraw(router)).toBe(true)
  })

  it("tells the card that the report landed", async () => {
    // Given
    const router = mountSession()

    // When
    await runTo(GAME_END + 8)

    // Then
    expect(wentToDraw(router)).toBe(true)
    expect(JSON.parse(W.store.get("jollity.seen:7")!)).toEqual({ chest: false, draw: false, report: true })
  })

  it("tells the card that the report landed after the page left", async () => {
    // Given
    const source = W.source as ReturnType<typeof makeSource>
    const real = source.submitReport
    let release: (() => void) | undefined
    source.submitReport = (report) => new Promise<void>((resolve, reject) => (release = () => void real(report).then(resolve, reject)))
    mountSession()
    await runTo(GAME_END + 8)
    expect(view.submitState).toBe("submitting")

    // When
    R.unmount()
    release!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(JSON.parse(W.store.get("jollity.seen:7")!)).toEqual({ chest: false, draw: false, report: true })
  })

  // S4. BannedRejected, GameSession_Throttle.cfg: a backgrounded WebView
  // suspends the 500 ms tick; on return one tick seals only the turn it left
  // and opens only the turn it lands on. The turns between are neither sealed
  // nor opened, so the ban casts no reject there, and the majority flips.
  it("S4: a ban rejects the player in the turns a throttled tick skipped", async () => {
    mountSession()
    await runTo(3) // round 0, you host
    tap(B, "person")
    await runTo(27) // round 0, C hosts
    tap(B, "person")
    await runTo(39) // round 0, D hosts
    R.act(() => view.ban(B))
    await sleepTo(GAME_END + 1) // backgrounded across round 1, back in the report window
    R.act(() => view.confirmVotes()) // a background never auto-files (#201): the player confirms
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.calls).toBe(1)
    // unthrottled, round 1 adds three rejects: person 2, notperson 4 (the harness test above)
    expect(bobFiled()).toEqual(["NotPerson", "NotPerson"])
    const players = (W.built[0] as { players: Record<string, { autoTurns: number }> }).players
    expect(players[B].autoTurns).toBe(0) // the replayed rejects came from the ban, not the turn seal
  })

  it("S4: a ban covers turns missed after the app suspends between rounds", async () => {
    mountSession()
    await runTo(39) // round 0, D hosts
    R.act(() => view.ban(B))
    await runTo(50) // the app reaches the gap before its timers are suspended
    await sleepTo(94) // round 1, D hosts; turns 0-2 were missed
    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
    }
    expect(stored.turnVotes[4]?.[B]).toBe("notperson")
    expect(stored.turnVotes[5]?.[B]).toBeUndefined() // B hosted and was not votable
    expect(stored.turnVotes[6]?.[B]).toBe("notperson")
  })

  it("S4: a ban covers the last round when the app suspends in the gap until reporting", async () => {
    mountSession()
    await runTo(39) // round 0, D hosts
    R.act(() => view.ban(B))
    await runTo(50) // between rounds
    await sleepTo(GAME_END + 1) // the whole last round was missed
    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
    }
    expect(Object.keys(stored.turnVotes).filter((turn) => Number(turn) >= 4)).toEqual(["4", "5", "6", "7"])
    expect(stored.turnVotes[4]?.[B]).toBe("notperson")
    expect(stored.turnVotes[5]?.[B]).toBeUndefined() // B hosted and was not votable
    expect(stored.turnVotes[6]?.[B]).toBe("notperson")
    expect(stored.turnVotes[7]?.[B]).toBe("notperson")
  })

  it("S4: a mounted player asleep through handover gets defaults for missed opening turns", async () => {
    mountSession()
    await vi.advanceTimersByTimeAsync(0) // mount in the final wait before round 0
    await sleepTo(39) // wake in round 0, turn 3
    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
    }
    expect(Object.keys(stored.turnVotes)).toEqual(["0", "1", "2"])
    expect(stored.turnVotes[0]?.[B]).toBe("notperson")
    expect(stored.turnVotes[1]?.[B]).toBeUndefined() // B hosted and was not votable
    expect(stored.turnVotes[2]?.[B]).toBe("notperson")
  })

  it("S4: a fresh mount in round 0 never invents earlier votes after a backward step", async () => {
    vi.setSystemTime((G + 39) * 1000)
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    let stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
    }
    expect(Object.keys(stored.turnVotes)).toEqual([])
    vi.setSystemTime((G - 1) * 1000) // a correction moves the snapshot back into the final wait
    await vi.advanceTimersByTimeAsync(600)
    await sleepTo(94)
    stored = JSON.parse(W.store.get("jollity.votes")!) as typeof stored
    expect([0, 1, 2].every((turn) => stored.turnVotes[turn] === undefined)).toBe(true)
  })

  it("#390: a backward clock replay preserves the original turn seal and report summary", async () => {
    let sourceNow = G + 3 // round 0, turn 0
    W.source = { ...makeSource(), nowSeconds: () => sourceNow }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    tap(B, "person")

    sourceNow = G + 15 // turn 0 closes and gets its first, authoritative seal
    await vi.advanceTimersByTimeAsync(600)
    type StoredTrail = { turnVotes: TurnVotes; autoSeals: AutoSeals }
    const before = JSON.parse(W.store.get("jollity.votes")!) as StoredTrail
    const beforeSummary = summarizeVotes(before.turnVotes, before.autoSeals, C, undefined, "notperson", { verdict: "notperson", seen: true })
    expect(before.turnVotes[0]).toEqual({ [B]: "person", [C]: "notperson", [D]: "notperson" })
    expect(before.autoSeals[0]).toEqual([C, D])

    sourceNow = G + 3 // the corrected chain clock revisits the completed turn
    await vi.advanceTimersByTimeAsync(600)
    sourceNow = G + 15 // advancing again attempts to seal turn 0 a second time
    await vi.advanceTimersByTimeAsync(600)

    const after = JSON.parse(W.store.get("jollity.votes")!) as StoredTrail
    expect(after.turnVotes[0]).toEqual(before.turnVotes[0])
    expect(after.autoSeals[0]).toEqual(before.autoSeals[0])
    expect(after.turnVotes[1]).toBeUndefined()
    expect(after.autoSeals[1]).toBeUndefined()
    expect(summarizeVotes(after.turnVotes, after.autoSeals, C, undefined, "notperson", { verdict: "notperson", seen: true })).toEqual(beforeSummary)
    expect(W.logs.filter(([, message]) => message === "turn sealed")).toHaveLength(1)
  })

  it("S4: an unanchored cold start that looks pre-game remains a late join", async () => {
    let sourceNow = G - 20 // a slow phone initially reads the final wait
    W.source = { ...makeSource(), nowSeconds: () => sourceNow }
    resetChainClockForTests()
    mountSession()
    await vi.advanceTimersByTimeAsync(0)
    sourceNow = G + 15 // the first chain anchor lands in round 0, turn 1
    setChainNow(() => sourceNow * 1000)
    await vi.advanceTimersByTimeAsync(600)
    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
    }
    expect(stored.turnVotes[0]).toBeUndefined()
  })

  it("#527: a rejoin seals NotPerson for the pre-load turns and the turns that ended while the clock settled", async () => {
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7, account: ME, turnVotes: {}, banned: [], overrides: {}, autoSeals: {}, firstOpenedTurn: 0,
      videoRoleHistory: {
        [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 },
      },
    }))
    let sourceNow = G + 15 // loaded in turn 1
    let ready = false
    W.source = {
      ...makeSource(),
      nowSeconds: () => sourceNow,
      clockState: () => ready
        ? { ready: true, coldStartedAt: G + 15 }
        : { ready: false },
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    expect(W.logs.filter(([, message]) => message === "turn sealed")).toHaveLength(0)
    expect(view.votable(B)).toBe(false)
    tap(B, "person")

    sourceNow = G + 27 // the late first block lands after the mount turn ended
    await vi.advanceTimersByTimeAsync(600)
    expect(W.logs.filter(([, message]) => message === "turn sealed")).toHaveLength(0)
    sourceNow = G + 39 // turn 3: turns 1 and 2 ended while the clock settled
    ready = true
    await vi.advanceTimersByTimeAsync(600)
    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
    }
    // turn 0 ended before the load, turns 1 and 2 while the clock settled:
    // a relaunched player sat all three out, so each is sealed NotPerson for
    // its votable co-players (the missed-turn rule), and the saved books carry it
    expect(Object.keys(stored.turnVotes)).toEqual(["0", "1", "2"])
    expect(stored.turnVotes[0]?.[B]).toBe("notperson")
    for (const turn of [1, 2]) {
      const votes = Object.values(stored.turnVotes[turn] ?? {})
      expect(votes.length).toBeGreaterThan(0)
      expect(votes.every((v) => v === "notperson")).toBe(true)
    }
    expect(W.logs.filter(([, message]) => message === "turn sealed")).toHaveLength(3)
    expect(recorded.metrics).not.toContainEqual(expect.objectContaining({ name: "turn.skipped_cold" }))
  })

  it("#527: a crash before turn 0 (waiting-room marker, no stored first turn) seals turns 0 and 1 on relaunch", async () => {
    W.viaDoor = true
    const sourceNow = G + 27 // relaunched in turn 2
    let ready = false
    W.source = {
      ...makeSource(),
      nowSeconds: () => sourceNow,
      clockState: () => ready
        ? { ready: true, coldStartedAt: G + 27 }
        : { ready: false },
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    ready = true
    await vi.advanceTimersByTimeAsync(600)
    const stored = JSON.parse(W.store.get("jollity.votes")!) as { turnVotes: Record<number, Record<string, Vote>> }
    expect(Object.keys(stored.turnVotes)).toEqual(["0", "1"])
    for (const turn of [0, 1]) {
      const votes = Object.values(stored.turnVotes[turn] ?? {})
      expect(votes.length).toBeGreaterThan(0)
      expect(votes.every((v) => v === "notperson")).toBe(true)
    }
  })

  it("#527: a late joiner without the waiting-room marker and without stored books stays unseen", async () => {
    const sourceNow = G + 27
    let ready = false
    W.source = {
      ...makeSource(),
      nowSeconds: () => sourceNow,
      clockState: () => ready
        ? { ready: true, coldStartedAt: G + 27 }
        : { ready: false },
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    ready = true
    await vi.advanceTimersByTimeAsync(600)
    const stored = JSON.parse(W.store.get("jollity.votes")!) as { turnVotes: Record<number, Record<string, Vote>> }
    expect(Object.keys(stored.turnVotes)).toEqual([])
  })

  it("#527: a rejoin between rounds with every earlier turn already sealed seals nothing extra", async () => {
    const sealedAll = (turns: number[]) => Object.fromEntries(turns.map((t) => [t, { [B]: "notperson", [C]: "notperson", [D]: "notperson" }]))
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7, account: ME, turnVotes: sealedAll([0, 1, 2, 3]), banned: [], overrides: {},
      autoSeals: Object.fromEntries([0, 1, 2, 3].map((t) => [t, [B, C, D]])), firstOpenedTurn: 0,
    }))
    const before = JSON.stringify(sealedAll([0, 1, 2, 3]))
    let sourceNow = G + 15
    let ready = false
    W.source = {
      ...makeSource(),
      nowSeconds: () => sourceNow,
      clockState: () => ready
        ? { ready: true, coldStartedAt: G + 15 }
        : { ready: false },
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    sourceNow = G + 15 // clock settles with no turn ended since the load
    ready = true
    await vi.advanceTimersByTimeAsync(600)
    const stored = JSON.parse(W.store.get("jollity.votes")!) as { turnVotes: Record<number, Record<string, Vote>> }
    expect(Object.keys(stored.turnVotes)).toEqual(["0", "1", "2", "3"])
    expect(JSON.stringify(stored.turnVotes)).toBe(before)
    expect(recorded.metrics).not.toContainEqual(expect.objectContaining({ name: "turn.skipped_cold" }))
  })

  // THE GAME-WINDOW GAP. In production the clock is ready on the first chain
  // anchor (watchNow), but coldStartedAt needs the game window, which comes
  // from a separate engine.watchGame / engine.game() read. A mid-game load can
  // therefore tick `{ ready: true }` with no coldStartedAt for a while, and the
  // clock never goes back to not-ready in between. The missed-turn rule (#527)
  // must hold across that gap.
  describe("#527: the clock is ready before the game window arrives", () => {
    const gapSource = (load: number) => {
      let sourceNow = load
      let windowKnown = false
      W.source = {
        ...makeSource(),
        nowSeconds: () => sourceNow,
        clockState: () => windowKnown ? { ready: true, coldStartedAt: load } : { ready: true },
      }
      return {
        at: (now: number) => { sourceNow = now },
        windowArrives: () => { windowKnown = true },
      }
    }
    const storedVotes = () => (JSON.parse(W.store.get("jollity.votes") ?? "{}") as {
      turnVotes?: Record<number, Record<string, Vote>>
    }).turnVotes ?? {}

    it("a relaunch (stored books name turn 0) seals NotPerson for every turn that ended before the load", async () => {
      W.store.set("jollity.votes", JSON.stringify({
        gameIndex: 7, account: ME, turnVotes: {}, banned: [], overrides: {}, autoSeals: {}, firstOpenedTurn: 0,
        videoRoleHistory: { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } },
      }))
      const gap = gapSource(G + 27) // relaunched in turn 2: turns 0 and 1 were missed
      mountSession()
      await vi.advanceTimersByTimeAsync(600)
      gap.at(G + 39) // still no game window when turn 3 opens
      await vi.advanceTimersByTimeAsync(600)
      gap.windowArrives()
      await vi.advanceTimersByTimeAsync(600)
      const turnVotes = storedVotes()
      // the host of turn t sits in seat t and is not votable in it
      const coPlayers = { 0: [B, C, D], 1: [C, D] } as const
      for (const turn of [0, 1] as const) {
        for (const id of coPlayers[turn]) expect(turnVotes[turn]?.[id], `turn ${turn} ${id}`).toBe("notperson")
      }
    })

    it("a crash before turn 0 (waiting-room marker) seals NotPerson for every turn that ended before the load", async () => {
      W.viaDoor = true
      const gap = gapSource(G + 27)
      mountSession()
      await vi.advanceTimersByTimeAsync(600)
      gap.windowArrives()
      await vi.advanceTimersByTimeAsync(600)
      const turnVotes = storedVotes()
      for (const turn of [0, 1]) {
        const votes = Object.values(turnVotes[turn] ?? {})
        expect(votes.length, `turn ${turn}`).toBeGreaterThan(0)
        expect(votes.every((v) => v === "notperson")).toBe(true)
      }
    })

    it.each([
      { where: "between rounds", load: G + 40, gapAt: G + 50, missed: [0, 1, 2] }, // turn 3, then the round change
      { where: "in reporting", load: G + 100, gapAt: G + 105, missed: [0, 1, 2, 3, 4, 5, 6] }, // turn 7, then reporting
    ])("a relaunch whose game window lands $where still seals the turns that ended before the load", async ({ load, gapAt, missed }) => {
      W.viaDoor = true
      const gap = gapSource(load)
      mountSession()
      await vi.advanceTimersByTimeAsync(600)
      gap.at(gapAt) // the load turn ends and is sealed live; no round is open when the window lands
      await vi.advanceTimersByTimeAsync(600)
      gap.windowArrives()
      await vi.advanceTimersByTimeAsync(600)
      const turnVotes = storedVotes()
      for (const turn of missed) {
        const votes = Object.values(turnVotes[turn] ?? {})
        expect(votes.length, `turn ${turn}`).toBeGreaterThan(0)
        expect(votes.every((v) => v === "notperson")).toBe(true)
      }
    })

    it("a genuine late join (no stored books, no marker) leaves the turns before the load without a verdict", async () => {
      const gap = gapSource(G + 27)
      mountSession()
      await vi.advanceTimersByTimeAsync(600)
      gap.at(G + 39)
      await vi.advanceTimersByTimeAsync(600)
      gap.windowArrives()
      await vi.advanceTimersByTimeAsync(600)
      const turnVotes = storedVotes()
      expect(turnVotes[0]).toBeUndefined()
      expect(turnVotes[1]).toBeUndefined()
    })
  })

  it("#429: a genuine late join keeps pre-load players unseen and skips the cold window", async () => {
    W.joined = true // the real late-join route writes this before /game mounts
    let sourceNow = G + 15
    let ready = false
    W.source = {
      ...makeSource(),
      nowSeconds: () => sourceNow,
      clockState: () => ready
        ? { ready: true, coldStartedAt: G + 15 }
        : { ready: false },
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    sourceNow = G + 39
    ready = true
    await vi.advanceTimersByTimeAsync(600)
    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
    }
    expect(Object.keys(stored.turnVotes)).toEqual([])
    expect(recorded.metrics).toContainEqual({ type: "count", name: "turn.skipped_cold", value: 2, attrs: {} })
  })

  it("#429: a defensive mid-game cold transition never seals its provisional turn", async () => {
    let sourceNow = G + 15
    let phase: "premature" | "cold" | "ready" = "premature"
    W.source = {
      ...makeSource(),
      nowSeconds: () => sourceNow,
      clockState: () => phase === "premature"
        ? { ready: true }
        : phase === "cold"
          ? { ready: false }
          : { ready: true, coldStartedAt: G + 15 },
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    phase = "cold"
    sourceNow = G + 27
    await vi.advanceTimersByTimeAsync(600)
    phase = "ready"
    sourceNow = G + 39
    await vi.advanceTimersByTimeAsync(600)
    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
    }
    expect(Object.keys(stored.turnVotes)).toEqual([])
    expect(W.logs.filter(([, message]) => message === "turn sealed")).toHaveLength(0)
  })

  it.each([
    { restore: "resolves", hangs: false },
    { restore: "times out", hangs: true },
  ])("#429: a reload that turns cold keeps its live screen when vote restore $restore", async ({ hangs }) => {
    W.readHangs = hangs
    W.readDelayMs = hangs ? 0 : 1_000
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7, account: ME, turnVotes: {}, banned: [], overrides: {}, autoSeals: {}, firstOpenedTurn: 0,
    }))
    let sourceNow = G + 79 // reloaded during global turn 6
    let phase: "initial" | "cold" | "ready" = "initial"
    W.source = {
      ...makeSource(),
      nowSeconds: () => sourceNow,
      clockState: () => phase === "initial"
        ? { ready: true }
        : phase === "cold"
          ? { ready: false }
          : { ready: true, coldStartedAt: G + 79 },
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    expect(view.screen).toBe("game")
    expect(view.turn).toMatchObject({ round: 1, turn: 2 })

    // A cold spell whose clock points before kickoff must not tear down the
    // current round screen while votes remain locked.
    phase = "cold"
    sourceNow = G - 5
    await vi.advanceTimersByTimeAsync(600)
    expect(view.screen).toBe("game")
    expect(view.turn).toMatchObject({ round: 1, turn: 2 })
    expect(view.votable(B)).toBe(false)

    // The clock settles while the stored-vote read has either resolved or is
    // still hung. Rendering resumes on the trustworthy turn immediately;
    // reconciliation/voting keeps the existing three-second restore bound.
    phase = "ready"
    sourceNow = G + 91
    await vi.advanceTimersByTimeAsync(600)
    expect(view.screen).toBe("game")
    expect(view.turn).toMatchObject({ round: 1, turn: 3 })
    expect(view.votable(B)).toBe(!hangs)
    if (hangs) await vi.advanceTimersByTimeAsync(2_000)
    expect(view.votable(B)).toBe(true)
  })

  it("#429: a fresh cold reload opens no room until the clock is ready, then opens it once", async () => {
    const E = "erin"
    const F = "frank"
    const H = "heidi"
    const base = makeSource()
    const gameView = (await base.gameView())!
    const sourceNow = G + 79 // reloaded during global turn 6, in round 1
    let ready = false
    W.source = {
      ...base,
      signalling: () => ({}),
      nowSeconds: () => sourceNow,
      clockState: () => ready
        ? { ready: true, coldStartedAt: G + 79 }
        : { ready: false },
      gameView: async () => ({
        ...gameView,
        seats: [group(), [seat(0, ME), seat(1, E), seat(2, F), seat(3, H)]],
      }),
    }
    MESH.link = () => "failed"
    const router = mountSession()
    await vi.advanceTimersByTimeAsync(600)

    expect(view.screen).toBe("joining")
    expect(MESH.roomKey).toBe("")
    expect(MESH.peers).toEqual([])
    await vi.advanceTimersByTimeAsync(30_001)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")

    ready = true
    await vi.advanceTimersByTimeAsync(600)
    expect(view.screen).toBe("game")
    expect(view.turn).toMatchObject({ round: 1, turn: 2 })
    expect(MESH.peers).toEqual([E, F, H])
    // the game's one room; the last round has no one left to stand by
    expect(MESH.standby).toEqual([])
    expect(MESH.openedRooms).toEqual(["g7"])
    expect(MESH.closedRooms).toEqual([])
  })

  it("#429: a trusted clock opens the game's room once, and a regroup moves its roster, not the room", async () => {
    const E = "erin"
    const F = "frank"
    const H = "heidi"
    const base = makeSource()
    const gameView = (await base.gameView())!
    let sourceNow = G + 20
    let ready = false
    W.source = {
      ...base,
      signalling: () => ({}),
      nowSeconds: () => sourceNow,
      clockState: () => ready
        ? { ready: true, coldStartedAt: G + 20 }
        : { ready: false },
      gameView: async () => ({
        ...gameView,
        seats: [group(), [seat(0, ME), seat(1, E), seat(2, F), seat(3, H)]],
      }),
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    expect(MESH.openedRooms).toEqual([])

    ready = true
    await vi.advanceTimersByTimeAsync(600)
    expect(MESH.openedRooms).toEqual(["g7"])
    // round 0's group with video, round 1's linked ahead on standby
    expect(MESH.peers).toEqual([B, C, D])
    expect(MESH.standby).toEqual([E, F, H].sort())
    sourceNow = G + 55
    await vi.advanceTimersByTimeAsync(600)

    expect(MESH.peers).toEqual([E, F, H])
    expect(MESH.standby).toEqual([])
    expect(MESH.openedRooms).toEqual(["g7"])
    expect(MESH.closedRooms).toEqual([])
  })

  it("#429: the game's room outlives a cold spell, and its roster moves on the next tick", async () => {
    const E = "erin"
    const F = "frank"
    const H = "heidi"
    const base = makeSource()
    const gameView = (await base.gameView())!
    let sourceNow = G + 39
    let phase: "initial" | "cold" | "ready" = "initial"
    W.source = {
      ...base,
      signalling: () => ({}),
      nowSeconds: () => sourceNow,
      clockState: () => phase === "initial"
        ? { ready: true }
        : phase === "cold"
          ? { ready: false }
          : { ready: true, coldStartedAt: G + 39 },
      gameView: async () => ({
        ...gameView,
        seats: [group(), [seat(0, ME), seat(1, E), seat(2, F), seat(3, H)]],
      }),
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    expect(MESH.openedRooms).toEqual(["g7"])

    phase = "cold"
    sourceNow = G + 55
    await vi.advanceTimersByTimeAsync(600)
    expect(MESH.openedRooms).toEqual(["g7"])

    phase = "ready"
    await vi.advanceTimersByTimeAsync(600)
    expect(MESH.peers).toEqual([E, F, H])
    expect(MESH.openedRooms).toEqual(["g7"])
    expect(MESH.closedRooms).toEqual([])
  })

  it("#429: restored seals survive pre-load replay without duplicate sealing", async () => {
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7,
      account: ME,
      turnVotes: { 0: { [B]: "notperson", [C]: "notperson", [D]: "notperson" } },
      banned: [],
      overrides: {},
      autoSeals: { 0: [B, C, D] },
      firstOpenedTurn: 0,
    }))
    const sourceNow = G + 15
    W.source = {
      ...makeSource(),
      nowSeconds: () => sourceNow,
      clockState: () => ({ ready: true, coldStartedAt: G + 15 }),
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
      autoSeals: Record<number, string[]>
    }
    expect(stored.turnVotes[0]).toEqual({ [B]: "notperson", [C]: "notperson", [D]: "notperson" })
    expect(stored.autoSeals[0]).toEqual([B, C, D])
    expect(W.logs.filter(([, message]) => message === "turn sealed")).toHaveLength(0)
  })

  it("#429: a hung vote restore releases the cold reconciliation after 3 seconds", async () => {
    W.readHangs = true
    const sourceNow = G + 15
    W.source = {
      ...makeSource(),
      nowSeconds: () => sourceNow,
      clockState: () => ({ ready: true, coldStartedAt: G + 15 }),
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    expect(view.votable(C)).toBe(false)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(view.votable(C)).toBe(true)
    expect(W.logs).toContainEqual(["vote", "stored votes read timed out"])
  })

  it("#429: a four-second vote read cannot be overwritten during timeout release", async () => {
    W.readDelayMs = 4_000
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7,
      account: ME,
      turnVotes: { 0: { [B]: "notperson" } },
      banned: [B],
      overrides: {},
      autoSeals: {},
      firstOpenedTurn: 0,
      videoRoleHistory: {
        [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 },
      },
    }))
    W.source = {
      ...makeSource(),
      nowSeconds: () => G + 39,
      clockState: () => ({ ready: true, coldStartedAt: G + 15 }),
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(3_100)
    expect(view.votable(C)).toBe(true)
    expect(W.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
      autoSeals: Record<number, string[]>
      firstOpenedTurn?: number
    }
    expect(stored.turnVotes[0]).toEqual({ [B]: "notperson", [C]: "notperson", [D]: "notperson" })
    expect(stored.autoSeals[0]).toEqual([C, D])
    expect(stored.firstOpenedTurn).toBe(0)
    expect(recorded.metrics.filter(({ name }) => name === "turn.skipped_cold")).toEqual([
      { type: "count", name: "turn.skipped_cold", value: 2, attrs: {} },
    ])
  })

  it("#429: a stored tap beats a local auto-seal when a slow read merges", async () => {
    W.readDelayMs = 4_000
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7,
      account: ME,
      turnVotes: { 1: { [C]: "person" } },
      banned: [],
      overrides: {},
      autoSeals: {},
      firstOpenedTurn: 0,
    }))
    let sourceNow = G + 15
    W.source = {
      ...makeSource(),
      nowSeconds: () => sourceNow,
      clockState: () => ({ ready: true, coldStartedAt: G + 15 }),
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(3_100)
    sourceNow = G + 27
    await vi.advanceTimersByTimeAsync(1_000)
    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
      autoSeals: Record<number, string[]>
    }
    expect(stored.turnVotes[1]?.[C]).toBe("person")
    expect(stored.autoSeals[1]).not.toContain(C)
  })

  it("#1214: a local Person tap removes the slow restore's stale auto-seal marker", async () => {
    W.readDelayMs = 10_000
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7,
      account: ME,
      turnVotes: { 0: { [B]: "notperson" } },
      banned: [],
      overrides: {},
      autoSeals: { 0: [B] },
      firstOpenedTurn: 0,
      videoRoleHistory: { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } },
    }))
    W.source = {
      ...makeSource(),
      nowSeconds: () => G + 3,
      clockState: () => ({ ready: true, coldStartedAt: G + 3 }),
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(3_100)
    expect(view.votable(B)).toBe(true)
    tap(B, "person")
    expect(view.voteShown(B)).toBe("person")

    await vi.advanceTimersByTimeAsync(7_000)
    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
      autoSeals: Record<number, string[]>
    }
    expect(stored.turnVotes[0]?.[B]).toBe("person")
    expect(stored.autoSeals[0]).not.toContain(B)
  })

  it("#429: a failed vote read retries and enables saving after success", async () => {
    W.readFailures = 1
    W.source = {
      ...makeSource(),
      nowSeconds: () => G + 15,
      clockState: () => ({ ready: true, coldStartedAt: G + 15 }),
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(1_100)
    expect(view.votable(C)).toBe(true)
    expect(W.writes).toContain("jollity.votes")
    expect(W.logs).not.toContainEqual(["vote", "stored votes read timed out"])
  })

  it("#429: a read-only source does not wait for vote restoration", async () => {
    W.readHangs = true
    W.source = {
      ...makeSource(),
      player: undefined,
      nowSeconds: () => G + 15,
      clockState: () => ({ ready: true, coldStartedAt: G + 15 }),
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    expect(view.votable(C)).toBe(true)
  })

  it("#429: a late stored entry without first-opened evidence keeps the observed turn", async () => {
    W.readDelayMs = 4_000
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7, account: ME, turnVotes: { 0: { [B]: "person" } }, banned: [], overrides: {}, autoSeals: {},
    }))
    W.source = {
      ...makeSource(),
      nowSeconds: () => G + 15,
      clockState: () => ({ ready: true, coldStartedAt: G + 15 }),
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(4_100)
    const stored = JSON.parse(W.store.get("jollity.votes")!) as { firstOpenedTurn?: number }
    expect(stored.firstOpenedTurn).toBe(1)
  })

  // S5. FiledIsShown, GameSession_Holds.cfg: the confirm tiles used to stay
  // flippable while the report was in flight (only the CTA was disabled), so
  // the grid could show a verdict the landing report did not carry. The tiles
  // lock once the report is built (#220), so a tap changes nothing.
  it("S5: while Submitting..., the grid shows what is being filed", async () => {
    const source = W.source as ReturnType<typeof makeSource>
    const real = source.submitReport
    let release: (() => void) | undefined
    source.submitReport = (report) =>
      new Promise<void>((resolve, reject) => (release = () => void real(report).then(resolve, reject)))
    mountSession()
    await runTo(GAME_END + 7)
    await waitForSubmitState("submitting", 1500)
    expect(view.submitState).toBe("submitting")
    const before = view.voteShown(C)
    const flipped: Vote = before === "person" ? "notperson" : "person"
    tap(C, flipped) // the tile must not turn
    const shownAtLanding = view.voteShown(C)
    expect(shownAtLanding).toBe(before)
    release!()
    await vi.advanceTimersByTimeAsync(0)
    const filedC = chain.reports[0][0][1] // C is the second co-player
    expect(filedC).toBe(shownAtLanding === "person" ? "Person" : "NotPerson")
  })

  // S6. FiledAsIntended, GameSession_Reload.cfg: votes, bans and overrides live in React
  // state alone. A rejoin in the confirm window starts from no votes, every
  // co-player reads "unseen" (Person with late join on), and the auto-confirm
  // files that — a player rejected and banned all game is reported Person.
  it("S6: a rejoin in the confirm window files the verdicts the player gave", async () => {
    mountSession()
    await runTo(3)
    R.act(() => view.ban(B)) // rejected for the whole game
    await runTo(GAME_END + 2) // the confirm stage is up: B reads NotPerson
    expect(view.voteShown(B)).toBe("notperson")
    R.unmount() // the page reloads
    mountSession() // rejoin (hasJoined)
    await runTo(GAME_END + 12)
    expect(chain.calls).toBe(1)
    expect(bobFiled()).toEqual(["NotPerson", "NotPerson"])
  })
})

// #215 S2 and #201 (decision B): the report goes out only while the window is
// open, and never on its own after the page was hidden or frozen.
describe("the report window and the background (S2, #201)", () => {
  const trailOff = () => W.logs.filter(([tag, message]) => tag === "vote" && message === "auto-confirm off")

  it("a hide of ten seconds during round 1 means no auto-file: the player confirms, and that files", async () => {
    mountSession()
    await runTo(60) // round 1
    setVisibility("hidden")
    await runTo(70)
    setVisibility("visible")
    await runTo(GAME_END + 1)
    expect(view.confirming).toBe(true) // the stage still opens, with its CTA
    expect(view.autoActive).toBe(false)
    expect(trailOff()).toHaveLength(1)
    await runTo(GAME_END + 15) // well past the 7 s auto-confirm
    expect(chain.calls).toBe(0)
    R.act(() => view.confirmVotes())
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.calls).toBe(1)
    expect(chain.reports).toHaveLength(1)
  })

  it("a background blip shorter than ten seconds keeps auto-confirm on (#729)", async () => {
    mountSession()
    await runTo(60)
    setVisibility("hidden")
    await runTo(69)
    setVisibility("visible")
    await runTo(GAME_END + 1)
    expect(view.autoActive).toBe(true)
    expect(trailOff()).toHaveLength(0)
    await runTo(GAME_END + 9)
    expect(chain.calls).toBe(1)
  })

  it("an absence that begins in the game and crosses into confirm still switches auto-confirm off (#729)", async () => {
    mountSession()
    await runTo(GAME_END - 2)
    setVisibility("hidden")
    await runTo(GAME_END + 10)
    setVisibility("visible")
    expect(view.autoActive).toBe(false)
    expect(trailOff()).toHaveLength(1)
    await runTo(GAME_END + 20)
    expect(chain.calls).toBe(0)
  })

  it("a sub-threshold absence crossing into confirm resumes auto-confirm only after return (#729)", async () => {
    mountSession()
    await runTo(GAME_END - 2)
    setVisibility("hidden")
    await runTo(GAME_END + 5)
    expect(chain.calls).toBe(0)
    setVisibility("visible")
    await vi.advanceTimersByTimeAsync(0)
    expect(view.autoActive).toBe(true)
    expect(trailOff()).toHaveLength(0)
    await runTo(GAME_END + 13)
    expect(chain.calls).toBe(1)
  })

  // the fake source reads Date.now(), so this models a game clock that MOVED
  // across the freeze; the step-free clock's own freeze rules and the peer
  // check after a step are tested in lib/device-clock.test.ts and
  // lib/game-source.test.ts (#331)
  it("a frozen page (the clock jumps between two ticks) is treated the same", async () => {
    mountSession()
    await runTo(3)
    await sleepTo(100) // iOS froze the timers for ~97 s
    await runTo(GAME_END + 1)
    expect(view.autoActive).toBe(false)
    await runTo(GAME_END + 15)
    expect(chain.calls).toBe(0)
    R.act(() => view.confirmVotes())
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.calls).toBe(1)
  })

  it("a peer correction that jumps the clock 12 s is no freeze (#1033)", async () => {
    let jumpedMs = 0
    W.source = { ...makeSource(), unexplainedJumpMs: () => jumpedMs }
    mountSession()
    await runTo(3)
    clockShift = 12 // the peers find the phone clock 12 s slow, with no device step
    jumpedMs = 12_000
    await runTo(GAME_END + 1 - clockShift)
    expect(view.autoActive).toBe(true)
    expect(trailOff()).toHaveLength(0)
    await runTo(GAME_END + 9 - clockShift)
    expect(chain.calls).toBe(1)
  })

  it("a silent freeze shorter than ten seconds keeps auto-confirm on (#729)", async () => {
    mountSession()
    await runTo(3)
    await sleepTo(12) // nine seconds passed without a tick
    await runTo(GAME_END + 1)
    expect(view.autoActive).toBe(true)
    expect(trailOff()).toHaveLength(0)
    await runTo(GAME_END + 9)
    expect(chain.calls).toBe(1)
  })

  it("a page that stayed in the foreground still auto-files", async () => {
    mountSession()
    await runTo(GAME_END + 1)
    expect(view.autoActive).toBe(true)
    expect(trailOff()).toHaveLength(0)
    await runTo(GAME_END + 9)
    expect(chain.calls).toBe(1)
  })

  it("a hide once the confirm stage is up does not switch the auto-confirm off", async () => {
    mountSession()
    await runTo(GAME_END + 1)
    setVisibility("hidden")
    setVisibility("visible")
    expect(view.autoActive).toBe(true)
    await runTo(GAME_END + 9)
    expect(chain.calls).toBe(1)
  })

  it("a confirm tap after report_ends with no report on chain sends nothing and hands over as missed", async () => {
    const router = mountSession()
    await runTo(60)
    setVisibility("hidden")
    await runTo(70)
    setVisibility("visible")
    await runTo(GAME_END + REPORT_WINDOW + 2)
    expect(view.confirming).toBe(true)
    expect(view.reportWindowClosed).toBe(true)
    R.act(() => view.confirmVotes())
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.calls).toBe(0)
    expect(view.submitState).toBe("idle")
    expect(wentToMissed(router)).toBe(true)
    expect(wentToDraw(router)).toBe(false)
  })

  it("the missed handover needs no tap: the window closing is enough (#303)", async () => {
    const router = mountSession()
    await runTo(3)
    await sleepTo(GAME_END + REPORT_WINDOW + 5) // backgrounded through the window
    await vi.advanceTimersByTimeAsync(10_000)
    expect(chain.calls).toBe(0)
    expect(wentToMissed(router)).toBe(true)
    expect(wentToDraw(router)).toBe(false)
  })

  it("a report that hangs past report_ends ends in the missed handover, not a retry loop (#303)", async () => {
    chain = fakeChain("hang")
    const router = mountSession()
    await runTo(GAME_END + 9)
    expect(view.submitState).toBe("submitting")
    expect(wentToMissed(router)).toBe(false) // the window is still open: keep today's behaviour
    await runTo(GAME_END + REPORT_WINDOW + 120)
    expect(wentToMissed(router)).toBe(true)
    expect(wentToDraw(router)).toBe(false)
  })

  it("a failed submit inside the window stays a retry, not a handover (#303)", async () => {
    const source = W.source as ReturnType<typeof makeSource>
    source.submitReport = () => {
      chain.calls++
      return Promise.reject(new Error("transient"))
    }
    const router = mountSession()
    await runTo(GAME_END + 9)
    expect(view.submitState).toBe("submitting")
    expect(wentToMissed(router)).toBe(false)
    expect(wentToDraw(router)).toBe(false)
  })

  it("a report the chain holds after report_ends is not missed: the draw opens (#303)", async () => {
    chain = fakeChain("fail-but-land")
    const router = mountSession()
    await runTo(GAME_END + 8)
    expect(chain.reports).toHaveLength(1) // it counted, the client heard a failure
    expect(view.submitState).toBe("submitting")
    await vi.advanceTimersByTimeAsync(1600)
    expect(wentToMissed(router)).toBe(false)
    expect(wentToDraw(router)).toBe(true)
  })

  it("a rejoin late in the window does not file on a countdown the window outlives", async () => {
    vi.setSystemTime((G + GAME_END + REPORT_WINDOW - 2) * 1000) // 2 s of window left
    mountSession()
    await vi.advanceTimersByTimeAsync(1000)
    expect(view.confirming).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000) // the 7 s countdown would end after report_ends
    expect(view.reportWindowClosed).toBe(true)
    expect(chain.calls).toBe(0)
  })
})

// #596: the pallet leaves Reporting at report_ends, or as soon as every
// attendance is decided, and gameView() then reads null. The end of the game
// must still hand over, on the chain's word. Found by a model check.
describe("the chain leaves Reporting (#596)", () => {
  const reportFailedCount = () => W.reportEvents.filter((event) => event === "failed").length
  const left = (router: { replace: ReturnType<typeof vi.fn> }) =>
    router.replace.mock.calls.some(([url]) => /^\/(prize-draw|collectables)\?/.test(String(url)))

  it("a hung submit whose window closes as the chain moves on still leaves /game, as missed", async () => {
    chain = fakeChain("hang")
    const router = mountSession()
    await runTo(GAME_END + REPORT_WINDOW + 30)
    expect(view.reportWindowClosed).toBe(true)
    expect(wentToMissed(router)).toBe(true)
    expect(reportFailedCount()).toBe(1)
  })

  it("with the last Reporting block gone, a non-attendee goes to the collectables screen and no failure is claimed", async () => {
    chain = fakeChain("hang")
    chain.reportingBlockHeld = false
    const router = mountSession()
    await runTo(GAME_END + REPORT_WINDOW + 30)
    expect(wentToMissed(router)).toBe(true)
    expect(wentToDraw(router)).toBe(false)
    expect(reportFailedCount()).toBe(0)
  })

  it("a report that landed unheard, as the last one in, reaches the draw", async () => {
    chain = fakeChain("land-unheard")
    const router = mountSession()
    await runTo(GAME_END + REPORT_WINDOW + 30)
    expect(chain.reports).toHaveLength(1)
    expect(wentToDraw(router)).toBe(true)
  })

  it("once the chain leaves Reporting early, the client stops filing a report the pallet must refuse", async () => {
    chain = fakeChain("land-unheard")
    chain.reportingBlockHeld = false
    mountSession()
    await runTo(GAME_END + REPORT_WINDOW - 1)
    expect(chain.calls).toBeLessThanOrEqual(2)
  })

  it("a report that landed while its watch hung, in a game where everyone reported, reaches the draw", async () => {
    chain = fakeChain("hang")
    const router = mountSession()
    await runTo(GAME_END + 8)
    expect(chain.calls).toBe(1)
    chain.reports.push([[], []]) // the transaction is in a block, the last report in
    chain.earlyProcess = true
    chain.reportingBlockHeld = false // only attendance is left to say it counted
    await runTo(GAME_END + REPORT_WINDOW + 30)
    expect(wentToDraw(router)).toBe(true)
    expect(wentToMissed(router)).toBe(false)
  })

  it("a player away during the game who never taps leaves /game once the chain moves on", async () => {
    const router = mountSession()
    await runTo(3)
    setVisibility("hidden")
    await runTo(13)
    setVisibility("visible")
    await runTo(GAME_END + REPORT_WINDOW + 30)
    expect(chain.calls).toBe(0)
    expect(left(router)).toBe(true)
  })

  it("a player the chain decided early sends nothing and leaves before report_ends", async () => {
    const router = mountSession()
    await runTo(GAME_END - 1)
    chain.earlyProcess = true // every attendance decided: the chain is in PlayerProcess
    await runTo(GAME_END + REPORT_WINDOW - 2)
    expect(chain.calls).toBe(0)
    expect(wentToMissed(router)).toBe(true)
    // the report was built and could not count: the chain confirms it absent
    expect(reportFailedCount()).toBe(1)
    expect(W.logData).toContainEqual({
      tag: "vote",
      message: "report chain closed",
      data: { gameIndex: 7, at: "pre-submit" },
    })
  })

  it("a relaunch after the chain moved on finds the counted report and opens the draw", async () => {
    chain.reports.push([[], []])
    vi.setSystemTime((REPORT_ENDS + 5) * 1000)
    const router = mountSession()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(wentToDraw(router)).toBe(true)
  })

  it("a hung watch hands over as soon as the chain closes early, not at report_ends", async () => {
    chain = fakeChain("hang")
    const router = mountSession()
    await runTo(GAME_END + 8)
    expect(chain.calls).toBe(1)
    chain.earlyProcess = true // decided early, with this report nowhere
    await runTo(GAME_END + 15)
    expect(wentToMissed(router)).toBe(true)
  })

  it("a relaunch after the game was cleared from the chain finds it in the stored books", async () => {
    chain.reports.push([[], []])
    chain.cleared = true
    vi.setSystemTime((REPORT_ENDS + 120) * 1000)
    const router = mountSession()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(wentToDraw(router)).toBe(true)
  })

  it("a relaunch after the chain moved on with no report goes to the collectables screen", async () => {
    vi.setSystemTime((REPORT_ENDS + 5) * 1000)
    const router = mountSession()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(wentToMissed(router)).toBe(true)
  })
})

// #597: a miss is the chain's word, never the page clock's and never a
// failed read's. Found by a model check.
describe("a missed report needs the chain to say so (#597)", () => {
  const reportFailedCount = () => W.reportEvents.filter((event) => event === "failed").length

  it("a failing status read at the handover never files 'report failed' for a report on chain", async () => {
    chain = fakeChain("hang")
    const router = mountSession()
    await runTo(GAME_END + 10)
    chain.reports.push([[], []]) // the transaction lands; its watch never answers
    chain.statusReadFailures = 1_000
    await runTo(GAME_END + REPORT_WINDOW + 20)
    expect(reportFailedCount()).toBe(0)
    expect(wentToMissed(router)).toBe(false)
  })

  it("a report in the last block before report_ends, seen a moment late, is not filed as missed", async () => {
    chain = fakeChain("hang") // the watch never answers; the transaction is in a block at report_ends - 0.5 s
    chain.bestLag = 1.5 // which reaches this node 1.5 s after its timestamp
    const router = mountSession()
    await runTo(GAME_END + REPORT_WINDOW + 1)
    chain.reports.push([[], []])
    await runTo(GAME_END + REPORT_WINDOW + 20)
    expect(reportFailedCount()).toBe(0)
    expect(wentToMissed(router)).toBe(false)
    expect(wentToDraw(router)).toBe(true)
  })
})

// #598: the #565 release must follow the chain clock, which re-syncs forward
// after a freeze. Found by a model check.
describe("the confirm release follows the source clock (#598)", () => {
  it("a confirm whose stored read hangs, on a page clock that re-syncs forward, opens before report_ends", async () => {
    W.readHangs = true
    clockShift = -6 // the page reads 6 s behind the chain as confirm opens (a freeze just before)
    mountSession()
    await runTo(GAME_END + 7) // the page clock reaches the last turn's end
    expect(view.confirming).toBe(true)
    expect(view.votesLoading).toBe(true)
    clockShift = 0 // two blocks later the clock re-syncs
    await runTo(GAME_END + REPORT_WINDOW - 1)
    expect(view.votesLoading).toBe(false)
  })
})

// #599: the #201 decision (no auto-file after the page was away during the
// game) must survive the page being killed. Found by a model check.
describe("a page killed during the game does not auto-file when reopened (#599)", () => {
  /** the books of a session that sealed turns 0 to `through`, every co-player seen from turn 0 */
  const sealedThrough = (through: number) =>
    JSON.stringify({
      gameIndex: 7,
      account: ME,
      turnVotes: Object.fromEntries(
        Array.from({ length: through + 1 }, (_, turn) => [turn, { [B]: "person", [C]: "person", [D]: "person" }]),
      ),
      banned: [],
      overrides: {},
      autoSeals: Object.fromEntries(Array.from({ length: through + 1 }, (_, turn) => [turn, []])),
      firstOpenedTurn: 0,
      videoRoleHistory: { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } },
    })
  /** a cold relaunch at G + sec: the clock comes up ready, marking where it started */
  const coldRelaunchAt = (sec: number) => {
    vi.setSystemTime((G + sec) * 1000)
    W.source = { ...makeSource(), clockState: () => ({ ready: true, coldStartedAt: G + sec }) }
    return mountSession(false)
  }

  it("a page hidden, then killed, and reopened before confirm files nothing without a tap", async () => {
    mountSession()
    await runTo(20)
    setVisibility("hidden") // backgrounded in round 0
    await runTo(30)
    R.unmount() // the OS kills it in the background
    vi.setSystemTime((G + 60) * 1000)
    setVisibility("visible")
    mountSession() // the player reopens the app in round 1
    await runTo(GAME_END + 12)
    expect(view.autoActive).toBe(false)
    expect(chain.calls).toBe(0)
    R.act(() => view.confirmVotes()) // the player confirms, and that files
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.calls).toBe(1)
  })

  it("a rejoin that cold-starts after turns no page lived through counts as away", async () => {
    W.viaDoor = true
    W.store.set("jollity.votes", sealedThrough(1)) // the old page sealed turns 0 and 1, then died
    coldRelaunchAt(39) // back in turn 3: turn 2 ended with no page alive
    await runTo(GAME_END + 12)
    expect(view.autoActive).toBe(false)
    expect(chain.calls).toBe(0)
  })

  it("a reload that missed no turn still auto-files", async () => {
    W.viaDoor = true
    W.store.set("jollity.votes", sealedThrough(2)) // the old page sealed turns 0 to 2
    coldRelaunchAt(39) // reloaded in turn 3
    await runTo(GAME_END + 9)
    expect(chain.calls).toBe(1)
  })

  it("a reload in a game with no eligible co-player (a dark mesh) still auto-files", async () => {
    W.viaDoor = true
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7, account: ME, turnVotes: {}, banned: [], overrides: {}, autoSeals: {}, videoRoleHistory: {},
    }))
    mountSession(false) // no co-player is ever seen: every turn seals with nobody to cast for
    await runTo(42) // turn 3
    R.unmount()
    coldRelaunchAt(44) // reloaded in the same turn: it missed nothing
    await runTo(GAME_END + 9)
    expect(chain.calls).toBe(1)
  })

  it("a rejoin after a missed turn whose stored read outlasts the release still counts as away", async () => {
    W.viaDoor = true
    W.readDelayMs = 4_000
    W.store.set("jollity.votes", sealedThrough(1))
    coldRelaunchAt(39)
    await runTo(GAME_END + 12)
    expect(chain.calls).toBe(0)
  })

  it("a first-time late join is not marked away (as today: an open question, #201)", async () => {
    W.store.clear()
    coldRelaunchAt(39)
    await runTo(GAME_END + 9)
    expect(chain.calls).toBe(1)
  })
})

// S6 (#215): the votes, bans and overrides survive a restart, in host storage
describe("votes, bans and overrides are kept across a restart (S6)", () => {
  const VOTES_KEY = "jollity.votes"
  const voteWrites = () => W.writes.filter((key) => key === VOTES_KEY).length
  const shownAll = () => [B, C, D].map((id) => view.voteShown(id))

  it("a remount in the confirm window restores the verdicts, the ban and an override", async () => {
    mountSession()
    await runTo(3)
    tap(C, "person")
    R.act(() => view.ban(B))
    await runTo(39) // D hosts round 0; C stays accepted by the early tap
    tap(D, "person")
    await runTo(GAME_END + 2)
    tap(D, "notperson") // an override on the confirm screen
    await vi.advanceTimersByTimeAsync(600) // the debounce settles
    const before = shownAll()
    expect(before[0]).toBe("notperson") // the ban
    expect(before[2]).toBe("notperson") // the override
    R.unmount()
    mountSession()
    await vi.advanceTimersByTimeAsync(100)
    expect(view.banned(B)).toBe(true)
    expect(shownAll()).toEqual(before)
  })

  it("an override tapped just before the restart survives it", async () => {
    mountSession()
    await runTo(GAME_END + 2)
    tap(C, "person")
    await vi.advanceTimersByTimeAsync(600) // saved
    tap(C, "notperson") // restored sessions read an untouched player as Person
    R.unmount()
    mountSession()
    await vi.advanceTimersByTimeAsync(100)
    expect(view.voteShown(C)).toBe("notperson")
  })

  it("the auto seals are restored, so the built-report summary stays truthful", async () => {
    mountSession()
    await runTo(GAME_END + 2)
    await vi.advanceTimersByTimeAsync(600)
    R.unmount()
    mountSession()
    await runTo(GAME_END + 12)
    expect(W.built).toHaveLength(1)
    const players = (W.built[0] as { players: Record<string, { autoTurns: number }> }).players
    // nobody was tapped: every sealed turn a co-player was votable in is a default
    expect(players[B].autoTurns).toBeGreaterThan(0)
  })

  it("#520: the report-built trail logs the verdict the report files, unseen co-players included", async () => {
    // B never decoded (no history entry); C and D were seen from turn 0
    W.store.set(
      "jollity.votes",
      JSON.stringify({
        gameIndex: 7,
        account: ME,
        turnVotes: {},
        banned: [],
        overrides: {},
        autoSeals: {},
        videoRoleHistory: { [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } },
      }),
    )
    mountSession(false) // the default marks every peer seen
    await runTo(GAME_END + 12)
    expect(chain.calls).toBe(1)
    const players = (W.built[0] as { players: Record<string, { verdict: string; source: string }> }).players
    expect(players[B]).toMatchObject({ verdict: "notperson", source: "unseen" })
    const filed = chain.reports[0][0] // one entry per co-player, in B, C, D order
    ;[B, C, D].forEach((id, i) => {
      expect(players[id].verdict === "person" ? "Person" : "NotPerson").toBe(filed[i])
    })
  })

  it("#871: a shared-turn never-seen tile starts NotPerson, flips, and files Person with telemetry", async () => {
    W.store.set(
      "jollity.votes",
      JSON.stringify({
        gameIndex: 7,
        account: ME,
        turnVotes: {},
        banned: [],
        overrides: {},
        autoSeals: {},
        videoRoleHistory: { [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } },
      }),
    )
    mountSession(false)
    await runTo(GAME_END + 1)
    expect(view.confirming).toBe(true)
    expect(view.roleFor(B)).toBe("unseen")
    expect(view.noVideo(B)).toBe(true)
    expect(view.votable(B)).toBe(true)
    expect(view.voteShown(B)).toBe("notperson")

    tap(B, "person")
    expect(view.voteShown(B)).toBe("person")
    R.act(() => view.confirmVotes())
    await vi.advanceTimersByTimeAsync(0)

    expect(bobFiled()).toEqual(["Person", "Person"])
    const players = (W.built[0] as {
      players: Record<string, { verdict: string; source: string; unseenChoice?: string }>
    }).players
    expect(players[B]).toMatchObject({
      verdict: "person",
      source: "unseen",
      unseenChoice: "flipped-person",
    })
  })

  it("#871: records an ever-flipped No-video tile even when the final choice returns to NotPerson", async () => {
    W.store.set(
      "jollity.votes",
      JSON.stringify({
        gameIndex: 7,
        account: ME,
        turnVotes: {},
        banned: [],
        overrides: {},
        autoSeals: {},
        videoRoleHistory: { [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } },
      }),
    )
    mountSession(false)
    await runTo(GAME_END + 1)
    tap(B, "person")
    tap(B, "notperson")
    await vi.advanceTimersByTimeAsync(600)
    R.unmount()
    mountSession(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(view.voteShown(B)).toBe("notperson")
    R.act(() => view.confirmVotes())
    await vi.advanceTimersByTimeAsync(0)

    const players = (W.built[0] as {
      players: Record<string, { verdict: string; unseenChoice?: string; unseenEverFlipped?: boolean }>
    }).players
    expect(players[B]).toMatchObject({
      verdict: "notperson",
      unseenChoice: "default-notperson",
      unseenEverFlipped: true,
    })
  })

  it("votes from game N are not restored into game N+1", async () => {
    mountSession()
    await runTo(3)
    R.act(() => view.ban(B))
    await vi.advanceTimersByTimeAsync(600)
    R.unmount()
    const source = W.source as ReturnType<typeof makeSource>
    const original = source.gameView
    source.gameView = async () => ({ ...(await original())!, gameIndex: 8 })
    mountSession()
    await vi.advanceTimersByTimeAsync(100)
    expect(view.banned(B)).toBe(false)
  })

  it("votes of another account are not restored", async () => {
    mountSession()
    await runTo(3)
    R.act(() => view.ban(B))
    await vi.advanceTimersByTimeAsync(600)
    R.unmount()
    ;(W.source as { player: string }).player = "someone-else"
    mountSession()
    await vi.advanceTimersByTimeAsync(100)
    expect(view.banned(B)).toBe(false)
  })

  it("after the report lands the stored entry is cleared", async () => {
    mountSession()
    await runTo(3)
    tap(B, "person")
    await vi.advanceTimersByTimeAsync(600)
    expect(W.store.get(VOTES_KEY)).toBeTruthy()
    await runTo(GAME_END + 12)
    expect(chain.calls).toBe(1)
    expect(view.submitState).toBe("submitting")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(JSON.parse(W.store.get(VOTES_KEY) ?? "null")).toBeNull()
  })

  it("identical consecutive values are written once", async () => {
    mountSession()
    await runTo(3)
    await vi.advanceTimersByTimeAsync(600)
    const before = voteWrites()
    tap(B, "person")
    const afterFirst = voteWrites()
    expect(afterFirst - before).toBe(1)
    tap(B, "person") // the same verdict again: the same value
    tap(B, "person")
    await vi.advanceTimersByTimeAsync(600)
    expect(voteWrites()).toBe(afterFirst)
  })

  it("a seal with no tap saves, and the entry carries the auto seal", async () => {
    mountSession()
    await runTo(3) // turn 0, nobody tapped
    await vi.advanceTimersByTimeAsync(600)
    const before = voteWrites()
    await runTo(15) // turn 0 closes: B, C, D are sealed NotPerson
    expect(voteWrites()).toBeGreaterThan(before)
    const stored = JSON.parse(W.store.get(VOTES_KEY)!)
    expect(stored.autoSeals["0"]).toEqual([B, C, D])
  })

})

// #220: a verdict changed after the report is built used to flip the tile and
// log an override while the report went out with the old one.
const overrideLines = () => W.logs.filter(([tag, message]) => tag === "vote" && message === "override")
const builtLines = () => W.logs.filter(([tag, message]) => tag === "vote" && message === "report built")

// #229: a player who left shows as away on the tile, and nothing else moves.
describe("a peer who is away (#229)", () => {
  afterEach(() => MESH.away.clear())

  /** play the same game and tap the same verdicts; B is away or not */
  async function playAndFile(bAway: boolean) {
    const away = MESH.away
    mountSession()
    await runTo(3)
    if (bAway) away.add(B)
    R.act(() => {}) // re-render over the mesh view
    tap(B, "person")
    tap(C, "person")
    const shown = { votable: view.votable(B), away: view.peerAway?.(B), awayC: view.peerAway?.(C) }
    await runTo(GAME_END + 9)
    return { shown, report: chain.reports[0] }
  }

  it("marks the tile away, and the filed report is identical with and without it", async () => {
    const plain = await playAndFile(false)
    R.unmount()
    W.source = makeSource()
    chain = fakeChain()
    vi.setSystemTime((G - 5) * 1000)
    const gone = await playAndFile(true)
    expect(plain.shown.away).toBe(false)
    expect(gone.shown).toEqual({ votable: plain.shown.votable, away: true, awayC: false })
    expect(gone.report).toEqual(plain.report)
    expect(gone.report).toBeDefined()
  })
})

describe("the confirm screen locks once the report is built (#220)", () => {
  it("a tap after the build changes no verdict, logs no override, and the filed report is unchanged", async () => {
    const source = W.source as ReturnType<typeof makeSource>
    const real = source.submitReport
    let release: (() => void) | undefined
    source.submitReport = (report) =>
      new Promise<void>((resolve, reject) => (release = () => void real(report).then(resolve, reject)))
    mountSession()
    await runTo(GAME_END + 7)
    await waitForSubmitState("submitting", 1500)
    expect(builtLines()).toHaveLength(1)
    expect(view.submitState).toBe("submitting")
    // the page flips a tile only while votable
    expect([B, C, D].some((id) => view.votable(id))).toBe(false)
    const before = [B, C, D].map((id) => view.voteShown(id))
    for (const id of [B, C, D]) tap(id, view.voteShown(id) === "person" ? "notperson" : "person")
    expect([B, C, D].map((id) => view.voteShown(id))).toEqual(before)
    expect(overrideLines()).toHaveLength(0)
    release!()
    await vi.advanceTimersByTimeAsync(0)
    for (const round of chain.reports[0]) expect(round).toEqual(before.map((v) => (v === "person" ? "Person" : "NotPerson")))
  })

  it("an override in the same tick as confirmVotes, before the re-render, is not filed or logged", async () => {
    mountSession()
    await runTo(GAME_END + 1) // confirm stage up, auto-confirm still counting
    const shown = view.voteShown(C)
    const flipped: Vote = shown === "person" ? "notperson" : "person"
    R.act(() => {
      view.confirmVotes()
      view.voteFor(C, flipped) // same closure, no render in between
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.calls).toBe(1)
    expect(overrideLines()).toHaveLength(0)
    expect(chain.reports[0][0][1]).toBe(shown === "person" ? "Person" : "NotPerson")
  })

  it("admits only one report attempt when confirm is called twice before React commits", async () => {
    mountSession()
    await runTo(GAME_END + 1)
    R.act(() => {
      view.confirmVotes()
      view.confirmVotes()
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.calls).toBe(1)
    expect(chain.reports).toHaveLength(1)
  })

  it("a failed submit keeps the tiles locked, and the retry files the built report", async () => {
    const source = W.source as ReturnType<typeof makeSource>
    const real = source.submitReport
    let first = true
    source.submitReport = (report) => {
      if (first) {
        first = false
        chain.calls++
        return Promise.reject(new Error("transient"))
      }
      return real(report)
    }
    mountSession()
    await runTo(GAME_END + 8)
    expect(view.submitState).toBe("submitting")
    expect(view.votable(C)).toBe(false)
    const before = view.voteShown(C)
    const flipped: Vote = view.voteShown(C) === "person" ? "notperson" : "person"
    tap(C, flipped)
    expect(view.voteShown(C)).toBe(before)
    await vi.advanceTimersByTimeAsync(1_600)
    expect(chain.reports[0][0][1]).toBe(before === "person" ? "Person" : "NotPerson")
  })
})

describe("the auto-confirm restarts when a confirm choice changes (#872)", () => {
  /** step the clock until the report goes out; returns the ms it took from `from` */
  async function untilFiled(): Promise<number> {
    for (let i = 0; i < 400 && chain.calls === 0; i++) await vi.advanceTimersByTimeAsync(50)
    return Date.now()
  }

  it.each([0, 1, 2, 3, 4, 5, 6])("a change %i seconds into the window restarts the full countdown", async (after) => {
    mountSession()
    await runTo(GAME_END)
    await vi.advanceTimersByTimeAsync(after * 1000)
    const flipped: Vote = view.voteShown(C) === "person" ? "notperson" : "person"
    const changedAt = Date.now()
    tap(C, flipped)
    expect(chain.calls).toBe(0)
    expect(view.autoCount).toBe(7)
    await vi.advanceTimersByTimeAsync(6_800)
    expect(chain.calls).toBe(0)
    const at = await untilFiled()
    expect(at - changedAt).toBeGreaterThanOrEqual(6_900)
    expect(at - changedAt).toBeLessThanOrEqual(7_100)
    expect(chain.reports[0][0][1]).toBe(flipped === "person" ? "Person" : "NotPerson")
    expect(overrideLines()).toHaveLength(1)
    const lastVote = W.logs.findLastIndex(([tag, m]) => tag === "vote" && m === "override")
    expect(W.logs.findIndex(([tag, m]) => tag === "vote" && m === "report built")).toBeGreaterThan(lastVote)
  })

  it("caps a restarted countdown at report_ends minus the safety margin", async () => {
    const source = W.source as { nowSeconds: () => number; gameView: () => Promise<{ timing: { reportEnds: number } }> }
    const view0 = source.gameView
    source.nowSeconds = () => Math.floor(Date.now() / 1000)
    source.gameView = async () => {
      const v = await view0()
      return { ...v, timing: { ...v.timing, reportEnds: G + GAME_END + 12 } }
    }
    mountSession()
    await runTo(GAME_END)
    await vi.advanceTimersByTimeAsync(5_600)
    const flipped: Vote = view.voteShown(C) === "person" ? "notperson" : "person"
    const changedAt = Date.now()
    tap(C, flipped)
    // The visible number measures time until the final Confirming beat, not
    // time until filing, so the capped restart never flashes one extra second.
    expect(view.autoCount).toBe(3)
    await vi.advanceTimersByTimeAsync(3_200)
    expect(chain.calls).toBe(0)
    const at = await untilFiled()
    expect(at - changedAt).toBeGreaterThanOrEqual(3_300)
    expect(at - changedAt).toBeLessThanOrEqual(3_500)
    expect(chain.reports[0][0][1]).toBe(flipped === "person" ? "Person" : "NotPerson")
  })

  it("uses the production whole-second chain offset without skipping the shortened restart", async () => {
    const source = W.source as { nowSeconds: () => number; gameView: () => Promise<{ timing: { reportEnds: number } }> }
    const view0 = source.gameView
    source.nowSeconds = () => Math.floor(Date.now() / 1000)
    source.gameView = async () => {
      const v = await view0()
      return { ...v, timing: { ...v.timing, reportEnds: G + GAME_END + 12 } }
    }
    // Production advances a millisecond device clock behind a whole-second
    // offset. Model its safe, sub-second-early bias rather than an exact clock.
    setChainNow(() => Date.now() - 600)
    mountSession()
    await runTo(GAME_END)
    await vi.advanceTimersByTimeAsync(5_600)
    const flipped: Vote = view.voteShown(C) === "person" ? "notperson" : "person"
    const changedAt = Date.now()
    tap(C, flipped)
    expect(view.autoCount).toBe(4)
    await vi.advanceTimersByTimeAsync(3_800)
    expect(chain.calls).toBe(0)
    const at = await untilFiled()
    expect(at - changedAt).toBeGreaterThanOrEqual(3_900)
    expect(at - changedAt).toBeLessThanOrEqual(4_100)
    expect(chain.reports[0][0][1]).toBe(flipped === "person" ? "Person" : "NotPerson")
  })

  it("gives a pre-sync fallback restart one monotonic second before filing", async () => {
    const source = W.source as { nowSeconds: () => number; gameView: () => Promise<{ timing: { reportEnds: number } }> }
    const view0 = source.gameView
    source.nowSeconds = () => Math.floor(Date.now() / 1000)
    source.gameView = async () => {
      const v = await view0()
      return { ...v, timing: { ...v.timing, reportEnds: G + GAME_END + 12 } }
    }
    resetChainClockForTests()
    mountSession()
    await runTo(GAME_END)
    await vi.advanceTimersByTimeAsync(5_600)
    const flipped: Vote = view.voteShown(C) === "person" ? "notperson" : "person"
    const changedAt = Date.now()
    tap(C, flipped)
    expect(view.autoCount).toBe(5)
    const at = await untilFiled()
    expect(at - changedAt).toBe(5_000)
    expect(chain.reports[0][0][1]).toBe(flipped === "person" ? "Person" : "NotPerson")
  })

  it("a tap after the last-call bound changes nothing", async () => {
    const source = W.source as ReturnType<typeof makeSource>
    source.nowSeconds = () => Math.floor(Date.now() / 1000)
    mountSession()
    await runTo(GAME_END)
    const before = view.voteShown(C)
    vi.setSystemTime((G + GAME_END + REPORT_WINDOW - 3 + 0.1) * 1000)
    tap(C, before === "person" ? "notperson" : "person")
    expect(view.voteShown(C)).toBe(before)
    expect(overrideLines()).toHaveLength(0)
  })

  it("records a same-state choice without restarting the countdown", async () => {
    mountSession()
    await runTo(GAME_END + 2)
    const shown = view.voteShown(C)!
    const count = view.autoCount
    tap(C, shown)
    expect(view.autoCount).toBe(count)
    expect(overrideLines()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(600)
    expect(JSON.parse(W.store.get("jollity.votes")!).overrides[C]).toBe(shown)
    const at = await untilFiled()
    expect(at).toBeLessThanOrEqual((G + GAME_END + 7.1) * 1000)
    expect(chain.reports[0][0][1]).toBe(shown === "person" ? "Person" : "NotPerson")
  })

  it("a change during the final confirming beat restarts the full countdown", async () => {
    mountSession()
    await runTo(GAME_END)
    await vi.advanceTimersByTimeAsync(6_200)
    expect(view.autoCount).toBe(0)
    const flipped: Vote = view.voteShown(C) === "person" ? "notperson" : "person"
    const changedAt = Date.now()
    tap(C, flipped)
    expect(view.autoCount).toBe(7)
    await vi.advanceTimersByTimeAsync(6_800)
    expect(chain.calls).toBe(0)
    const at = await untilFiled()
    expect(at - changedAt).toBeGreaterThanOrEqual(6_900)
    expect(at - changedAt).toBeLessThanOrEqual(7_100)
    expect(chain.reports[0][0][1]).toBe(flipped === "person" ? "Person" : "NotPerson")
  })

  it("a forward chain-clock resync after a restart pulls the report inside the new last call", async () => {
    let shiftSeconds = 0
    const source = W.source as ReturnType<typeof makeSource>
    source.nowSeconds = () => Math.floor(Date.now() / 1000) + shiftSeconds
    setChainNow(() => Date.now() + shiftSeconds * 1000)
    mountSession()
    await runTo(GAME_END + 3)
    const flipped: Vote = view.voteShown(C) === "person" ? "notperson" : "person"
    tap(C, flipped)
    expect(view.autoCount).toBe(7)
    await vi.advanceTimersByTimeAsync(1_000)
    shiftSeconds = 12
    await vi.advanceTimersByTimeAsync(200)
    expect(chain.calls).toBe(1)
    expect(chain.reports[0][0][1]).toBe(flipped === "person" ? "Person" : "NotPerson")
  })
})

describe("a phone clock stepped mid-game (#331)", () => {
  // game 192, bot 9: the wall clock stepped +30 s at turn 4 and -75 s at turn
  // 8. `vi.setSystemTime` with no timer run moves Date alone and leaves
  // `performance.now()` where it was: a STEP (the E2E's clock shift, an NTP
  // fix) or, with true time moving too, a FREEZE. `advanceTimersByTime` is
  // real elapsed time and moves both.
  //
  // The session's clock is the REAL doorway's (`makeSource`): the chain's
  // blocks arrive every 6 s on the true time, and its anchors, the game's
  // frozen window and its re-syncs decide what the session sees.
  // Round 1 seats another group, and the mesh connects only the group of the
  // round the TRUE time is in: a session on the wrong round is isolated, and
  // on main's clock that ends on /connection-help.
  const E = "erin"
  const F = "frank"
  const H = "heidi"
  const groups = [[ME, B, C, D], [ME, E, F, H]]
  /** the true time, seconds after G */
  let truth: () => number
  /** the round whose group is connected: round 1's forms from the gap on */
  const trueRound = () => (truth() < 48 ? 0 : 1)
  const turns: string[] = []
  /** the deadline a statement LANDS with, as the app wires it: the first
   *  stamp, and on a time rejection by a node that keeps the true time, the
   *  one re-stamp, which the clock then learns from (statementTransport) */
  const expiryNow = () => {
    const clock = storeClock()
    const first = clock.stamp()
    const passes = (ms: number) => Math.floor(ms / 1000) + TTL_S > G + truth()
    if (passes(first.ms)) return first.ms
    const retry = clock.retryStamp(first)
    if (passes(retry.ms)) clock.accepted(retry)
    else clock.rejected(retry, "alreadyExpired")
    return retry.ms
  }
  let nextBlock = 0
  let chainTick: ((seconds: number) => void) | undefined
  /** let real time run to G + sec in half-second steps: the blocks due arrive,
   *  and every turn the session shows is noted */
  async function liveTo(sec: number) {
    while (truth() < sec) {
      await vi.advanceTimersByTimeAsync(500)
      blocksDue()
      const at = view.turn ? `${view.turn.round}:${view.turn.turn}` : null
      if (at && at !== turns.at(-1)) turns.push(at)
    }
  }
  /** the newest block authored by now: a page back from a freeze hears the
   *  best block, not the ones it slept through */
  function blocksDue() {
    if (nextBlock > G + truth()) return
    while (nextBlock + 6 <= G + truth()) nextBlock += 6
    chainTick?.(nextBlock)
    nextBlock += 6
  }
  const step = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000)

  function chainSource(trueNow: () => number, window = REPORT_WINDOW) {
    truth = trueNow
    const pallet = {
      index: 7, game_date: G, report_ends: G + GAME_END + window, rounds: ROUNDS, max_group_size: SEATS,
    } as unknown as PalletGame
    const engine = new Proxy(
      {
        kind: "chain",
        watchNow: (cb: (seconds: number) => void) => {
          chainTick = cb
          return () => {}
        },
        game: async () => pallet,
        watchGame: (cb: (game: PalletGame) => void) => {
          cb(pallet)
          return () => {}
        },
      } as Record<string | symbol, unknown>,
      {
        get: (target, key) =>
          key in target
            ? target[key]
            : String(key).startsWith("watch")
              ? () => () => {}
              : () => new Promise(() => {}),
      },
    ) as unknown as GameEngine
    nextBlock = G + Math.floor(truth())
    const real = makeChainSource("host", engine, { deviceClock: createDeviceClock() })
    blocksDue()
    const base = makeSource()
    const seat = (index: number, who: string) => ({ index, player: { type: "Account", value: who } })
    return {
      ...base,
      nowSeconds: real.nowSeconds,
      meshClock: real.meshClock,
      // the mesh is the test's: a transport only has to exist
      signalling: () => ({}),
      gameView: async () => {
        const real = (await base.gameView())!
        return {
          ...real,
          timing: { ...real.timing, reportEnds: G + GAME_END + window },
          seats: groups.map((g) => g.map((who, i) => seat(i, who))),
        }
      },
      // the chain's phase is the TRUE time's, never the stepped wall's
      reportStatus: async (gameIndex?: number) => ({
        gameIndex,
        closed: truth() >= GAME_END + window,
        report: chain.reports.length > 0 ? ("sent" as const) : ("not-sent" as const),
      }),
      // the pallet judges the report window on the TRUE time
      submitReport: (report: ReportVote[][]) => {
        chain.calls++
        if (truth() >= GAME_END + window) return Promise.reject(new ReportWindowClosedError())
        chain.reports.push(report)
        return Promise.resolve()
      },
    }
  }

  beforeEach(() => {
    turns.length = 0
    resetChainClockForTests()
    resetStoreClockForTests()
    // a link holds when its peer is in the TRUE round's group and the
    // signalling is alive: a statement minted on the clock the app gives the
    // transport (lib/store-clock.ts) must not be born expired
    // on the node, which keeps the true time
    MESH.link = (peer) =>
      Math.floor(expiryNow() / 1000) + TTL_S <= G + truth()
        ? "failed"
        : groups[trueRound()].includes(peer)
          ? "connected"
          : "failed"
    vi.stubGlobal("navigator", { onLine: true })
  })
  afterEach(() => {
    MESH.link = null
    MESH.pathEvidence = false
  })

  it("+30 s then -75 s mid-round: every turn plays once, in order, and the report files from /game", async () => {
    W.source = chainSource(() => -5 + performance.now() / 1000)
    const router = mountSession()
    await liveTo(16) // round 0, turn 1
    step(30) // the session would be at round 0, turn 3
    await liveTo(40) // round 0, turn 3 (on main's clock: round 1, turn 1)
    step(-75) // net -45 s: main's clock goes back before kickoff, then replays round 0
    await liveTo(GAME_END + 1)
    expect(turns).toEqual(["0:0", "0:1", "0:2", "0:3", "1:0", "1:1", "1:2", "1:3"])
    expect(view.confirming).toBe(true)
    // a step is no freeze: the auto-confirm still runs
    expect(trailOffCount()).toBe(0)
    expect(view.autoActive).toBe(true)
    await liveTo(GAME_END + 9)
    expect(chain.reports).toHaveLength(1)
    expect(wentToDraw(router)).toBe(true)
    // on main's clocks every statement is born expired from the second step
    // and the session sits in round 0 for 48 s: the isolation verdict lands
    // at true 75, well inside this
    await liveTo(GAME_END + REPORT_WINDOW + 10)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")
  })

  it("a phone clock wrong from the start and corrected while visible: signalling stays alive", async () => {
    // the phone runs 75 s slow; its peers correct that. An NTP fix then steps
    // it +75 s with the page visible: the step-free device clock takes the
    // step out and reads 75 s slow again, and a statement minted on it alone
    // would be born expired. The mesh only holds if the expiry clock is right.
    // the test starts 30 s earlier than its neighbors, for the peer correction
    step(-30 - 75)
    const source = chainSource(() => -35 + performance.now() / 1000)
    W.source = source
    const mesh = source.meshClock!
    expect(mesh.wants()).toBe(true)
    for (const peer of [B, C, D]) mesh.offer(peer, 75_000, 100)
    // the median holds 2 s, then the waiting speed closes the 75 s gap in 25 s, before the session mounts
    await vi.advanceTimersByTimeAsync(2_000)
    mesh.offer(B, 75_000, 100)
    await vi.advanceTimersByTimeAsync(28_000)
    expect(source.nowSeconds() - G).toBe(Math.floor(truth()))
    const router = mountSession()
    await liveTo(30)
    step(75)
    await liveTo(GAME_END + 9)
    expect(Math.floor(expiryNow() / 1000) + TTL_S).toBeGreaterThan(G + truth() + 20)
    // every statement of the game landed on its first, chain-time stamp
    expect(storeClock().marginMs()).toBe(0)
    expect(chain.reports).toHaveLength(1)
    expect(router.replace).not.toHaveBeenCalledWith("/connection-help")
  })

  it("a step back in the confirm window neither holds the auto-file past its count nor fires it early", async () => {
    W.source = chainSource(() => -5 + performance.now() / 1000)
    mountSession()
    await liveTo(GAME_END + 1)
    expect(view.autoActive).toBe(true)
    step(-60)
    await liveTo(GAME_END + 9)
    expect(chain.reports).toHaveLength(1)
  })

  it("a step forward in the confirm window does not file before the count lands", async () => {
    W.source = chainSource(() => -5 + performance.now() / 1000)
    mountSession()
    await liveTo(GAME_END + 1)
    step(30)
    await vi.advanceTimersByTimeAsync(500)
    expect(chain.calls).toBe(0)
    await liveTo(GAME_END + 9)
    expect(chain.reports).toHaveLength(1)
  })
})

const trailOffCount = () => W.logs.filter(([tag, message]) => tag === "vote" && message === "auto-confirm off").length

describe("#426 decoded-video roles", () => {
  it("starts occupied peers Unseen and flips a decoded peer exactly once", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(3)

    expect(view.roleFor(ME)).toBe("you")
    expect(view.roleFor(B)).toBe("unseen")
    expect(view.roleFor("ghost:0:9")).toBe("empty")
    expect(view.votable(B)).toBe(false)

    R.act(() => view.markVideoArrived(B))
    expect(view.roleFor(B)).toBe("coplayer")
    expect(view.videoSeen(B)).toBe(true)
    expect(view.votable(B)).toBe(true)
    R.act(() => view.markVideoArrived(B))

    expect(recorded.metrics.filter(({ name }) => name === "game.unseen_to_coplayer_ms")).toHaveLength(1)
    expect(W.logData.filter(({ tag, message }) => tag === "role" && message === "presented first frame")).toEqual([
      { tag: "role", message: "presented first frame", data: { peer: B, round: 0, turn: 0 } },
    ])
    const stored = JSON.parse(W.store.get("jollity.votes")!)
    expect(stored.videoRoleHistory[B]).toEqual({ fromTurn: 0 })
  })

  it("does not count a frame decoded in final waiting, before the first turn opens (#602)", async () => {
    W.store.clear()
    mountSession(false)
    await vi.advanceTimersByTimeAsync(10)
    R.act(() => view.markVideoArrived(B))
    expect(view.videoSeen(B)).toBe(false)

    await runTo(3)
    expect(view.videoSeen(B)).toBe(false)
    R.act(() => view.markVideoArrived(B))
    expect(view.videoSeen(B)).toBe(true)
    expect(JSON.parse(W.store.get("jollity.votes")!).videoRoleHistory[B]).toEqual({ fromTurn: 0 })
  })

  it("counts a frame in the ending stage of an open turn (#602)", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(11) // turn 0's ending (10-12 s)
    R.act(() => view.markVideoArrived(B))
    expect(view.videoSeen(B)).toBe(true)
  })

  it("a first frame in the round change after the last shared turn leaves the co-player unseen at confirm (#602)", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(3)
    R.act(() => view.markVideoArrived(C)) // C is seen in a shared open turn
    await runTo(49) // round 0's last turn has sealed; the gap
    R.act(() => view.markVideoArrived(B))
    expect(view.videoSeen(B)).toBe(false)
    await runTo(GAME_END + 1)

    expect(view.confirming).toBe(true)
    expect(view.roleFor(B)).toBe("unseen")
    // filed exactly as D, a co-player whose video never decoded at all
    expect(view.roleFor(D)).toBe("unseen")
    expect(view.voteShown(B)).toBe(view.voteShown(D))
    expect(Object.keys(JSON.parse(W.store.get("jollity.votes")!).videoRoleHistory)).toEqual([C])
  })

  it("a frame in the round change counts only once a later shared turn is open and a frame arrives in it (#602)", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(50) // round change before round 1
    R.act(() => view.markVideoArrived(B))
    expect(view.videoSeen(B)).toBe(false)
    await runTo(56) // round 1, turn 0 open
    expect(view.videoSeen(B)).toBe(false)
    R.act(() => view.markVideoArrived(B))
    expect(view.videoSeen(B)).toBe(true)
    // bound to the turn it arrived in (round 1 turn 0 = global turn 4), never back-dated
    expect(JSON.parse(W.store.get("jollity.votes")!).videoRoleHistory[B]).toEqual({ fromTurn: 4 })
  })

  it("a stream whose only first frame landed in the connect phase is seen and votable in turn 0 (#602)", async () => {
    W.store.clear()
    mountSession(false)
    offerLikeThePage([B, C, D])
    await vi.advanceTimersByTimeAsync(10) // connect phase: the offer lands outside any turn
    expect(view.videoSeen(B)).toBe(false)
    await runTo(3) // turn 0 opens; the watcher re-arms and reads the playing stream
    expect(view.videoSeen(B)).toBe(true)
    expect(view.votable(B)).toBe(true)
    expect(JSON.parse(W.store.get("jollity.votes")!).videoRoleHistory[B]).toEqual({ fromTurn: 0 })
  })

  it("round 2's group, whose first frame landed in the round change, is seen in that round's first turn (#602)", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(49) // round change: the group's streams arrive and decode here
    offerLikeThePage([B, C, D])
    await vi.advanceTimersByTimeAsync(200)
    R.act(() => view.markVideoArrived(B))
    expect(view.videoSeen(B)).toBe(false)
    await runTo(56) // round 1, turn 0
    expect(view.videoSeen(B)).toBe(true)
    expect(view.votable(B)).toBe(true)
  })

  it("the epoch holds still once a peer is seen (#602)", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(3)
    R.act(() => view.markVideoArrived(B))
    const epoch = view.videoObservationEpoch(B)
    await runTo(30)
    expect(view.videoObservationEpoch(B)).toBe(epoch)
    expect(view.videoObservationEpoch(C)).toBeGreaterThan(epoch)
  })

  it("never retroactively seals turns from before the first decoded frame", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(39) // global turn 3, D hosts
    R.act(() => view.markVideoArrived(B))
    await sleepTo(GAME_END + 1)

    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
      videoRoleHistory: Record<string, { fromTurn: number | null }>
    }
    expect(stored.videoRoleHistory[B]).toEqual({ fromTurn: 3 })
    expect([0, 1, 2].every((turn) => stored.turnVotes[turn]?.[B] === undefined)).toBe(true)
    expect(stored.turnVotes[3]?.[B]).toBe("notperson")
  })

  it("merges a local first frame with a slower restored history", async () => {
    W.readDelayMs = 4_000
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7,
      account: ME,
      turnVotes: {},
      banned: [],
      overrides: {},
      autoSeals: {},
      firstOpenedTurn: 0,
      videoRoleHistory: { [B]: { fromTurn: 0 } },
    }))
    vi.setSystemTime((G + 3) * 1000)
    mountSession(false)
    await vi.advanceTimersByTimeAsync(3_100)
    R.act(() => view.markVideoArrived(C))
    expect(view.videoSeen(C)).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(view.videoSeen(B)).toBe(true)
    expect(view.videoSeen(C)).toBe(true)
  })

  it("freezes roles and emits one aggregate recap pair on first confirm", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(3)
    R.act(() => view.markVideoArrived(B))
    await runTo(GAME_END + 1)

    expect(view.confirming).toBe(true)
    expect(view.roleFor(B)).toBe("coplayer")
    expect(view.roleFor(C)).toBe("unseen")
    expect(view.voteShown(C)).toBe("notperson")
    expect(view.noVideo(C)).toBe(true)
    expect(view.votable(C)).toBe(true)
    R.act(() => view.markVideoArrived(C))
    expect(view.roleFor(C)).toBe("unseen")
    await vi.advanceTimersByTimeAsync(1_000)

    expect(recorded.metrics.filter(({ name }) => name === "game.recap_coplayer")).toEqual([
      { type: "count", name: "game.recap_coplayer", value: 1, attrs: {} },
    ])
    expect(recorded.metrics.filter(({ name }) => name === "game.recap_unseen")).toEqual([
      { type: "count", name: "game.recap_unseen", value: 2, attrs: {} },
    ])
  })

  it("keeps video intake closed after confirm when the chain clock jumps backward 35 seconds", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(3)
    await runTo(GAME_END + 1)
    expect(view.confirming).toBe(true)
    expect(view.evidenceFrozen).toBe(true)

    vi.setSystemTime(Date.now() - 35_000)
    await vi.advanceTimersByTimeAsync(600)
    expect(view.confirming).toBe(false)

    let admitted = true
    R.act(() => {
      admitted = view.markVideoArrived(B)
    })
    expect(admitted).toBe(false)
    expect(view.videoSeen(B)).toBe(false)

    await runTo(GAME_END + 2)
    expect(view.confirming).toBe(true)
    expect(view.roleFor(B)).toBe("unseen")
    expect(view.voteShown(B)).toBe("notperson")
    await runTo(GAME_END + 9)
    expect(bobFiled()).toEqual(["NotPerson", "NotPerson"])
  })

  it("#1223 refuses a tap on a re-lived sealed turn after the evidence freeze", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(3)
    R.act(() => view.markVideoArrived(C))
    R.act(() => view.markVideoArrived(D))
    R.act(() => view.ban(D))
    expect(view.banned(D)).toBe(true)
    await runTo(GAME_END + 1)

    expect(view.confirming).toBe(true)
    expect(view.evidenceFrozen).toBe(true)
    const confirmGateVerdict = view.voteShown(C)
    expect(confirmGateVerdict).toBe("notperson")

    vi.setSystemTime(Date.now() - 35_000)
    await vi.advanceTimersByTimeAsync(600)
    expect(view.confirming).toBe(false)
    expect(view.votable(C)).toBe(false)
    expect(view.voteShown(C)).toBe(confirmGateVerdict)
    const frozenBooks = W.store.get("jollity.votes")

    tap(C, "person")
    R.act(() => view.ban(C))
    R.act(() => view.unban(D))
    expect(view.voteShown(C)).toBe(confirmGateVerdict)
    expect(view.banned(C)).toBe(false)
    expect(view.banned(D)).toBe(true)
    expect(W.store.get("jollity.votes")).toBe(frozenBooks)

    await runTo(GAME_END + 2)
    expect(view.confirming).toBe(true)
    expect(view.voteShown(C)).toBe(confirmGateVerdict)
    await runTo(GAME_END + 9)
    expect(chain.reports.at(-1)?.map((round) => round[1])).toEqual([
      "NotPerson",
      "NotPerson",
    ])
  })

  it("keeps confirm role and report evidence frozen when a restore resolves after the release", async () => {
    // the read answers only after confirm gave up waiting for it (#565) and
    // filed (the submit hangs, so the confirm screen stays up)
    chain = fakeChain("hang")
    W.readDelayMs = 126_000
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7,
      account: ME,
      turnVotes: {},
      banned: [],
      overrides: {},
      autoSeals: {},
      firstOpenedTurn: 0,
      videoRoleHistory: { [B]: { fromTurn: 0 } },
    }))
    mountSession(false)
    await runTo(GAME_END + 1)
    expect(view.confirming).toBe(true)
    expect(view.roleFor(B)).toBe("unseen")
    expect(view.voteShown(B)).toBe("notperson")

    await runTo(REPORT_WINDOW + GAME_END - 2) // released, frozen empty, filed
    expect(chain.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(3_000) // the read lands
    expect(view.roleFor(B)).toBe("unseen")
    expect(view.voteShown(B)).toBe("notperson")
  })
})

describe("the store-clock calibration before the mesh opens (Rule 2)", () => {
  const transport = () => () => ({}) as never
  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }

  it("a late join: the mesh gets the transport only once the calibration settled", async () => {
    vi.setSystemTime((G + 20) * 1000) // round 0 is running: no waiting room
    const calibration = deferred()
    const signalling = transport()
    const calibrate = vi.fn(() => calibration.promise.then(() => ({ outcome: "accepted", marginMs: 0, durationMs: 1, attempts: 1 }) as const))
    W.source = { ...makeSource(), signalling, calibrateSignalling: calibrate }
    mountSession()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calibrate).toHaveBeenCalled()
    expect(MESH.transport).toBeUndefined()
    calibration.resolve()
    await vi.advanceTimersByTimeAsync(600)
    expect(MESH.transport).toBe(signalling)
  })

  it("calibrated in the waiting room already: the transport goes to the mesh at once", async () => {
    const signalling = transport()
    const done = Promise.resolve({ outcome: "learned", marginMs: 60_000, durationMs: 1, attempts: 2 } as const)
    const calibrate = vi.fn(() => done)
    W.source = { ...makeSource(), signalling, calibrateSignalling: calibrate }
    mountSession()
    await vi.advanceTimersByTimeAsync(10)
    expect(calibrate).toHaveBeenCalledTimes(1) // asked, and it answered at once
    expect(MESH.transport).toBe(signalling)
  })

  it("a calibration that never finishes holds the mesh back CALIBRATION_WAIT_MS at most: the in-game re-stamp is the fallback", async () => {
    vi.setSystemTime((G + 20) * 1000)
    const signalling = transport()
    W.source = { ...makeSource(), signalling, calibrateSignalling: () => new Promise<never>(() => {}) }
    mountSession()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(MESH.transport).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(MESH.transport).toBe(signalling)
  })
})

describe("a late join before the first chain value", () => {
  const signallingTransport = () => () => ({}) as never

  it.each([
    ["between rounds", G + 50],
    ["reporting", G + GAME_END + 1],
  ])("shows joining during a cold post-kickoff %s phase", async (_phase, now) => {
    vi.setSystemTime(now * 1000)
    W.source = {
      ...makeSource(),
      signalling: signallingTransport(),
      nowSeconds: () => now,
      clockState: () => ({ ready: false }),
    }

    mountSession(false)
    await vi.advanceTimersByTimeAsync(600)
    expect(view.screen).toBe("joining")
  })

  it("warms TURN once for a cold late join with a stable account value, and not for an on-time mount", async () => {
    const late = makeSource()
    const returnedAccounts: Uint8Array[] = []
    Object.defineProperty(late, "playerAccountId", {
      get: () => {
        const account = new Uint8Array(32).fill(7)
        returnedAccounts.push(account)
        return account
      },
    })
    W.source = {
      ...late,
      signalling: signallingTransport(),
      nowSeconds: () => G + 32,
      clockState: () => ({ ready: false }),
    }
    // Preserve the value-returning getter after the object spread above.
    Object.defineProperty(W.source, "playerAccountId", {
      get: Object.getOwnPropertyDescriptor(late, "playerAccountId")?.get,
    })

    mountSession(false)
    await vi.advanceTimersByTimeAsync(1_800)
    expect(TURN.warmups).toBe(1)
    expect(TURN.players).toHaveLength(1)
    expect(TURN.players[0]).toBe(returnedAccounts[0])

    R.unmount()
    TURN.warmups = 0
    W.source = {
      ...makeSource(),
      playerAccountId: new Uint8Array(32).fill(7),
      nowSeconds: () => G + 32,
      clockState: () => ({ ready: true }),
    }
    mountSession(false)
    await vi.advanceTimersByTimeAsync(600)
    expect(TURN.warmups).toBe(0)
  })

  it("opens no room and decides nothing, but warms TURN and shows the round's progress", async () => {
    vi.setSystemTime((G + 20) * 1000)
    W.source = {
      ...makeSource(),
      playerAccountId: new Uint8Array(32).fill(7),
      signalling: signallingTransport(),
      nowSeconds: () => G + 20,
      clockState: () => ({ ready: false }),
    }

    mountSession(false)
    await vi.advanceTimersByTimeAsync(600)

    expect(view.screen).toBe("joining")
    expect(view.joining).toEqual({ round: 1, elapsed: 20, duration: 48 })
    expect(MESH.roomKey).toBe("")
    expect(MESH.peers).toEqual([])
    expect(TURN.warmups).toBe(1)
    expect(view.turn).toBeNull()
    expect(view.hostId).toBeNull()
    expect(view.votable(B)).toBe(false)
    tap(B, "person")
    expect(view.voteShown(B)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(13_000)
    expect(W.logs.filter(([, message]) => message === "turn sealed")).toHaveLength(0)
  })
})

describe("#565: a relaunch into the confirm window stands on the stored votes", () => {
  /** C (and B, D) tapped Person in every turn of both rounds, then the app was lost */
  const storedGame = () =>
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7,
      account: ME,
      turnVotes: Object.fromEntries(
        Array.from({ length: SEATS * ROUNDS }, (_, turn) => [turn, { [B]: "person", [C]: "person", [D]: "person" }]),
      ),
      banned: [],
      overrides: {},
      autoSeals: {},
      firstOpenedTurn: 0,
      videoRoleHistory: { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } },
    }))
  const relaunchAt = async (sec: number) => {
    vi.setSystemTime((G + sec) * 1000)
    mountSession(false)
    await vi.advanceTimersByTimeAsync(100)
  }
  const filedC = () => chain.reports.at(-1)?.map((round) => round[1])

  it("a clock ready at mount inside the game and a 4 s stored read files the player's own taps", async () => {
    storedGame()
    W.readDelayMs = 4_000
    W.source = { ...makeSource(), clockState: () => ({ ready: true }) }
    await relaunchAt(GAME_END + 1)
    expect(view.confirming).toBe(true)
    // the books are not in: nothing is armed and the CTA says so
    expect(view.votesLoading).toBe(true)
    expect(view.autoActive).toBe(false)
    expect(ctaLabel(view)).toBe("Loading your votes…")
    await vi.advanceTimersByTimeAsync(3_000) // the release lands; the read is still out
    expect(chain.calls).toBe(0)
    await vi.advanceTimersByTimeAsync(1_100) // the read lands
    expect(view.votesLoading).toBe(false)
    expect(view.voteShown(C)).toBe("person")
    expect(view.votable(C)).toBe(true)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(chain.calls).toBe(1)
    expect(filedC()).toEqual(["Person", "Person"])
  })

  it("the same with the source carrying no clockState at all", async () => {
    storedGame()
    W.readDelayMs = 4_000
    await relaunchAt(GAME_END + 1)
    expect(view.autoActive).toBe(false)
    await vi.advanceTimersByTimeAsync(4_100)
    expect(view.voteShown(C)).toBe("person")
    await vi.advanceTimersByTimeAsync(9_000)
    expect(filedC()).toEqual(["Person", "Person"])
  })

  it("a tap on the CTA before the read lands files nothing", async () => {
    storedGame()
    W.readDelayMs = 4_000
    await relaunchAt(GAME_END + 1)
    R.act(() => view.rushConfirm())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(chain.calls).toBe(0)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(view.voteShown(C)).toBe("person")
    await vi.advanceTimersByTimeAsync(9_000)
    expect(filedC()).toEqual(["Person", "Person"])
  })

  it("control: a clock that settles after the read files Person too", async () => {
    storedGame()
    W.readDelayMs = 1_000
    let ready = false
    W.source = { ...makeSource(), clockState: () => ({ ready }) }
    await relaunchAt(GAME_END + 1)
    await vi.advanceTimersByTimeAsync(3_000)
    ready = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(filedC()).toEqual(["Person", "Person"])
  })

  it("a read that never answers releases near the report margin and files what the session has", async () => {
    storedGame()
    W.readHangs = true
    await relaunchAt(GAME_END + 1)
    await runTo(GAME_END + 14) // well past the normal 7 s auto-confirm
    expect(view.votesLoading).toBe(true)
    expect(chain.calls).toBe(0)
    await runTo(REPORT_WINDOW + GAME_END - 2)
    expect(chain.calls).toBe(1)
    expect(W.logs).toContainEqual(["vote", "confirm released without the stored votes"])
    // nothing was restored, so the session files what it has: unseen
    expect(filedC()).toEqual(["NotPerson", "NotPerson"])
  })

  it("a clock that never settles and a read that never answers still file at the release", async () => {
    storedGame()
    W.readHangs = true
    let ready = true
    W.source = { ...makeSource(), clockState: () => ({ ready }) }
    await relaunchAt(GAME_END + 1)
    ready = false // the clock stops being trusted for good
    await runTo(GAME_END + 14)
    expect(view.votesLoading).toBe(true)
    expect(chain.calls).toBe(0)
    await runTo(REPORT_WINDOW + GAME_END - 2)
    expect(chain.calls).toBe(1)
    expect(W.logs).toContainEqual(["vote", "confirm released without the stored votes"])
  })

  it("a clock that never settles with a read that answers still files by the release", async () => {
    storedGame()
    W.readDelayMs = 1_000
    let ready = true
    W.source = { ...makeSource(), clockState: () => ({ ready }) }
    await relaunchAt(GAME_END + 1)
    ready = false
    await runTo(GAME_END + 14)
    expect(chain.calls).toBe(0)
    await runTo(REPORT_WINDOW + GAME_END - 2)
    expect(chain.calls).toBe(1)
    expect(filedC()).toEqual(["Person", "Person"])
  })

  it("a read answering after the release does not blink the gate or restart the countdown", async () => {
    storedGame()
    chain = fakeChain("hang")
    W.readDelayMs = 126_000
    W.source = {
      ...makeSource(),
      clockState: () => ({ ready: true, coldStartedAt: G + 15 }),
    }
    await relaunchAt(GAME_END + 1)
    await runTo(REPORT_WINDOW + GAME_END - 3) // released
    expect(view.autoActive).toBe(true)
    const seen: boolean[] = []
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(100)
      seen.push(view.autoActive)
    }
    expect(seen.every(Boolean)).toBe(true)
    expect(view.votesLoading).toBe(false)
  })

  it("a normal confirm is unchanged: armed at once, no loading label", async () => {
    mountSession()
    await runTo(GAME_END + 1)
    expect(view.confirming).toBe(true)
    expect(view.votesLoading).toBe(false)
    expect(view.autoActive).toBe(true)
    expect(ctaLabel(view)).not.toBe("Loading your votes…")
  })
})

describe("relaunch books: every clock path reconciles, a late restore tops up (#566 #567 #568 #570)", () => {
  type Books = { turnVotes: Record<number, Record<string, Vote>>; autoSeals: Record<number, string[]> }
  const storedBooks = () => JSON.parse(W.store.get("jollity.votes")!) as Books
  /** every vote of the turn is a NotPerson, and there is at least one */
  const allNotPerson = (votes: Record<string, Vote> | undefined) =>
    Object.keys(votes ?? {}).length > 0 && Object.values(votes ?? {}).every((v) => v === "notperson")
  /** the books of a session that sealed turns 0 and 1, every co-player seen from turn 0 */
  const sealedThroughTurn1 = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      gameIndex: 7,
      account: ME,
      turnVotes: { 0: { [B]: "notperson", [C]: "notperson", [D]: "notperson" }, 1: { [C]: "notperson", [D]: "notperson" } },
      banned: [],
      overrides: {},
      autoSeals: { 0: [B, C, D], 1: [C, D] },
      firstOpenedTurn: 0,
      videoRoleHistory: { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } },
      ...extra,
    })

  it("#566: a door relaunch on the window-fallback clock seals the turn it missed", async () => {
    // the real doorway's clock, with a game window that never arrives: it
    // releases on the 12 s fallback
    W.viaDoor = true
    W.store.set("jollity.votes", sealedThroughTurn1())
    vi.setSystemTime((G + 29) * 1000) // relaunched in turn 2
    let chainTick: ((seconds: number) => void) | undefined
    const engine = new Proxy(
      {
        kind: "chain",
        watchNow: (cb: (seconds: number) => void) => {
          chainTick = cb
          return () => {}
        },
        game: async () => undefined,
        watchGame: () => () => {},
      } as Record<string | symbol, unknown>,
      {
        get: (target, key) =>
          key in target ? target[key] : String(key).startsWith("watch") ? () => () => {} : () => new Promise(() => {}),
      },
    ) as unknown as GameEngine
    const real = makeChainSource("host", engine, { deviceClock: createDeviceClock() })
    W.source = { ...makeSource(), nowSeconds: real.nowSeconds, clockState: real.clockState }
    chainTick?.(G + 29)
    mountSession(false)
    for (let at = 35; at <= 47; at += 6) {
      await vi.advanceTimersByTimeAsync(6_000)
      chainTick?.(G + at)
    }
    // released at G + 41, in turn 3: turn 2 ended while the app was gone or
    // settling, and the relaunched player sat it out (#527)
    expect(real.clockState?.()).toMatchObject({ ready: true })
    expect(allNotPerson(storedBooks().turnVotes[2])).toBe(true)
  })

  it("#567: a door rejoin whose read lands after the 3 s release tops up the missed turns, the ban included, and keeps a tap", async () => {
    W.viaDoor = true
    W.readDelayMs = 4_000
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7,
      account: ME,
      turnVotes: { 1: { [C]: "person" } },
      banned: [B],
      overrides: {},
      autoSeals: {},
      firstOpenedTurn: 0,
      videoRoleHistory: { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } },
    }))
    W.source = {
      ...makeSource(),
      nowSeconds: () => G + 39, // relaunched in turn 3
      clockState: () => ({ ready: true, coldStartedAt: G + 39 }),
    }
    mountSession(false)
    // the release seals turns 0 to 2 against an empty history: nothing to cast
    await vi.advanceTimersByTimeAsync(3_100)
    expect(W.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    const books = storedBooks()
    // what a prompt read gives: every missed turn sealed for the co-players
    // the stored history makes eligible, the banned one as a deliberate reject
    expect(books.turnVotes[0]).toEqual({ [B]: "notperson", [C]: "notperson", [D]: "notperson" })
    expect(books.turnVotes[1]).toEqual({ [C]: "person", [D]: "notperson" })
    expect(books.turnVotes[2]).toEqual({ [B]: "notperson", [D]: "notperson" })
    expect(books.autoSeals[0]).toEqual([C, D])
    expect(books.autoSeals[1]).toEqual([D])
    expect(books.autoSeals[2]).toEqual([D])
  })

  it("#567: a relaunch into the report window with a slow read files what the screen shows, the missed turns counted", async () => {
    // C tapped Person in turns 0 and 1; the app was lost in turn 3 and comes
    // back once the last turn is over, with a stored read slower than the release
    W.viaDoor = true
    W.readDelayMs = 4_000
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7,
      account: ME,
      turnVotes: {
        0: { [B]: "notperson", [C]: "person", [D]: "notperson" },
        1: { [C]: "person", [D]: "notperson" },
        2: { [B]: "notperson", [D]: "notperson" },
      },
      banned: [],
      overrides: {},
      autoSeals: { 0: [B, D], 1: [D], 2: [B, D] },
      firstOpenedTurn: 0,
      videoRoleHistory: { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } },
    }))
    vi.setSystemTime((G + GAME_END + 1) * 1000)
    W.source = { ...makeSource(), clockState: () => ({ ready: true, coldStartedAt: G + GAME_END + 1 }) }
    mountSession(false)
    await vi.advanceTimersByTimeAsync(4_100) // the release, then the read
    const books = storedBooks()
    expect(books.turnVotes[0]?.[C]).toBe("person")
    expect(books.turnVotes[1]?.[C]).toBe("person")
    for (const turn of [3, 4, 5, 6, 7]) expect(allNotPerson(books.turnVotes[turn])).toBe(true)
    // two taps against four missed turns: C is NotPerson on the screen, where
    // the untopped books (Person, Person and nothing else) would show Person
    const shown = [B, C, D].map((id) => (view.voteShown(id) === "person" ? "Person" : "NotPerson"))
    expect(shown).toEqual(["NotPerson", "NotPerson", "NotPerson"])
    // no page lived through turns 3 to 7: the relaunch was away during the
    // game, so nothing files without a tap (#201, #599), and the tap files
    // what the screen shows
    await vi.advanceTimersByTimeAsync(9_000)
    expect(chain.calls).toBe(0)
    R.act(() => view.confirmVotes())
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.calls).toBe(1)
    for (const round of chain.reports[0]) expect(round).toEqual(shown)
  })

  it("#568: a stored read that hangs once is retried, so the session's taps are saved and survive a relaunch", async () => {
    W.viaDoor = true
    W.readHangsFirst = 1
    let sourceNow = G + 3 // turn 0
    W.source = { ...makeSource(), nowSeconds: () => sourceNow }
    mountSession()
    await vi.advanceTimersByTimeAsync(600)
    tap(C, "person")
    // the hung attempt is abandoned and a retry answers: saving starts
    await vi.advanceTimersByTimeAsync(5_000)
    expect(storedBooks().turnVotes[0]?.[C]).toBe("person")
    sourceNow = G + 15 // turn 0 sealed with the tap in it
    await vi.advanceTimersByTimeAsync(600)
    expect(storedBooks().turnVotes[0]).toEqual({ [B]: "notperson", [C]: "person", [D]: "notperson" })
    R.unmount()

    // the app is lost in turn 1 and relaunched in turn 2: the door rejoin
    // seals the turns it missed and never reseals the tapped one
    sourceNow = G + 27
    let ready = false
    W.source = {
      ...makeSource(),
      nowSeconds: () => sourceNow,
      clockState: () => (ready ? { ready: true, coldStartedAt: G + 27 } : { ready: false }),
    }
    mountSession(false)
    await vi.advanceTimersByTimeAsync(600)
    ready = true
    await vi.advanceTimersByTimeAsync(600)
    const books = storedBooks()
    expect(books.turnVotes[0]?.[C]).toBe("person")
    expect(books.autoSeals[0]).not.toContain(C)
    expect(allNotPerson(books.turnVotes[1])).toBe(true)
  })

  it("#570: the re-run after a slow read does not swallow a turn the page attended", async () => {
    // a genuine late join in turn 1 with nothing stored; the read answers at 3.75 s
    W.store = new Map()
    W.readDelayMs = 3_750
    let sourceNow = G + 15
    W.source = {
      ...makeSource(),
      nowSeconds: () => sourceNow,
      clockState: () => ({ ready: true, coldStartedAt: G + 15 }),
    }
    mountSession()
    await vi.advanceTimersByTimeAsync(3_700)
    expect(view.votable(C)).toBe(true) // the release opened turn 1 and C is seen in it
    sourceNow = G + 27 // turn 1 ends, and the read lands before the next tick
    await vi.advanceTimersByTimeAsync(1_000)
    expect(storedBooks().turnVotes[1]).toEqual({ [C]: "notperson", [D]: "notperson" })
    expect(recorded.metrics).not.toContainEqual(expect.objectContaining({ name: "turn.skipped_cold" }))
  })

  it.each([
    { name: "stored first-opened turn", viaDoor: false, firstOpenedTurn: 0 as number | undefined },
    { name: "waiting-room door", viaDoor: true, firstOpenedTurn: undefined as number | undefined },
  ])("#1470/#1489 F8: a warm-clock remount mid-game seals the missed turns ($name)", async ({ viaDoor, firstOpenedTurn }) => {
    // the behaviour the deleted source-text test stood for: the hook feeds the
    // restored evidence into remountClockState, so the first warm mid-game
    // tick becomes the cold boundary once the stored read proves a rejoin
    W.viaDoor = viaDoor
    W.store.set("jollity.votes", JSON.stringify({
      gameIndex: 7, account: ME, turnVotes: {}, banned: [], overrides: {}, autoSeals: {},
      ...(firstOpenedTurn === undefined ? {} : { firstOpenedTurn }),
      videoRoleHistory: { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } },
    }))
    W.source = { ...makeSource(), nowSeconds: () => G + 39, clockState: () => ({ ready: true }) }
    mountSession(false)
    await vi.advanceTimersByTimeAsync(600)
    const books = storedBooks()
    for (const turn of [0, 1, 2]) expect(allNotPerson(books.turnVotes[turn])).toBe(true)
  })
})

/** chain second inside global turn t's gameplay: round r starts at 55r, a turn is 12 s */
const inTurnOf = (t: number) => 55 * Math.floor(t / SEATS) + 12 * (t % SEATS) + 3

// ── #569: a real tap on a replayed sealed turn wins ─────────────────────────
// A backward snapshot (#390) re-opens a turn the page already sealed.
// A tap or a ban during that replay replaces the
// seal's auto-reject, and the player leaves that turn's autoSeals entry so the
// trail (autoTurns, countReport.autoOnly) stays true. Every id an autoSeals
// entry lists must hold the seal's NotPerson in that turn's votes.
describe("#569 a replayed sealed turn", () => {
  type Books = { turnVotes: TurnVotes; autoSeals: AutoSeals }
  const books = () => JSON.parse(W.store.get("jollity.votes")!) as Books
  /** every auto seal still names a NotPerson the seal filed */
  const sealsHoldTheirVotes = (b: Books) =>
    Object.entries(b.autoSeals).every(([turn, ids]) => ids.every((id) => b.turnVotes[Number(turn)]?.[id] === "notperson"))
  type Built = { players: Record<string, { verdict: string; source: string; personTurns: number; notPersonTurns: number; autoTurns: number }> }
  /** tap `who` Person in every turn from `from` on where the tile takes it, then file */
  async function playOutTapping(who: string, from: number) {
    for (let t = from; t < ROUNDS * SEATS; t++) {
      await runTo(inTurnOf(t))
      if (view.votable(who)) tap(who, "person")
    }
    await runTo(GAME_END + 2)
    // the forward step back out of the replay reads as a freeze (#201), so
    // the player confirms by hand; the report is the same either way
    if (chain.calls === 0) R.act(() => view.confirmVotes())
    await vi.advanceTimersByTimeAsync(0)
  }

  it("the formal trace: y decodes during the replay of sealed turn 0 and a Person tap is filed as a tap", async () => {
    W.store.clear()
    mountSession(false) // the door player: on the page before turn 0
    await runTo(inTurnOf(0))
    R.act(() => view.markVideoArrived(B))
    R.act(() => view.markVideoArrived(D))
    await runTo(15) // turn 0 seals as the clock moves to turn 1; C (y) is unseen
    expect(books().autoSeals[0]).toEqual([B, D])
    expect(books().turnVotes[0]?.[C]).toBeUndefined()

    clockShift = -12 // the corrected chain clock steps back into turn 0
    await vi.advanceTimersByTimeAsync(600)
    R.act(() => view.markVideoArrived(C)) // y's frame decodes in the re-opened turn
    expect(view.votable(C)).toBe(true)
    tap(C, "person")
    clockShift = 0
    await vi.advanceTimersByTimeAsync(600)

    const b = books()
    expect(b.turnVotes[0]?.[C]).toBe("person")
    expect(b.autoSeals[0]).toEqual([B, D])
    expect(sealsHoldTheirVotes(b)).toBe(true)

    await playOutTapping(C, 1)
    expect(chain.calls).toBe(1)
    const c = (W.built[0] as Built).players[C]
    expect(c).toMatchObject({ verdict: "person", source: "majority", notPersonTurns: 0, autoTurns: 0 })
    expect(chain.reports[0].map((round) => round[1])).toEqual(["Person", "Person"])
  })

  it("a Person tap on a co-player the seal auto-rejected replaces the seal and leaves its autoSeals entry", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(inTurnOf(0))
    for (const id of [B, C, D]) R.act(() => view.markVideoArrived(id))
    await runTo(15)
    expect(books().autoSeals[0]).toEqual([B, C, D])

    clockShift = -12
    await vi.advanceTimersByTimeAsync(600)
    tap(C, "person")
    clockShift = 0
    await vi.advanceTimersByTimeAsync(600)

    const b = books()
    expect(b.turnVotes[0]?.[C]).toBe("person")
    expect(b.autoSeals[0]).toEqual([B, D]) // the turn stays sealed, C is no longer a default
    expect(sealsHoldTheirVotes(b)).toBe(true)
    expect(W.logs.filter(([, message]) => message === "turn sealed")).toHaveLength(1)

    await playOutTapping(C, 1)
    const players = (W.built[0] as Built).players
    expect(players[C]).toMatchObject({ verdict: "person", notPersonTurns: 0, autoTurns: 0 })
    // the untouched co-players' trails still count every default they got
    expect(players[B].autoTurns).toBe(players[B].notPersonTurns)
  })

  it("a ban during the replay is a deliberate reject, and the undo restores the seal's auto-reject", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(inTurnOf(0))
    for (const id of [B, C, D]) R.act(() => view.markVideoArrived(id))
    await runTo(15)

    clockShift = -12
    await vi.advanceTimersByTimeAsync(600)
    R.act(() => view.ban(C))
    let b = books()
    expect(b.turnVotes[0]?.[C]).toBe("notperson")
    expect(b.autoSeals[0]).toEqual([B, D]) // a ban is not a default

    R.act(() => view.unban(C))
    await vi.advanceTimersByTimeAsync(0)
    b = books()
    // a sealed vote is never deleted: the seal's reject comes back, and its record
    expect(b.turnVotes[0]?.[C]).toBe("notperson")
    expect([...(b.autoSeals[0] ?? [])].sort()).toEqual([B, C, D].sort())
    expect(sealsHoldTheirVotes(b)).toBe(true)
  })

  it("an undo on a replayed turn leaves a vote the seal itself filed alone", async () => {
    W.store.clear()
    mountSession(false)
    await runTo(inTurnOf(0))
    for (const id of [B, C, D]) R.act(() => view.markVideoArrived(id))
    await runTo(15) // turn 0 sealed: C auto-rejected
    await runTo(inTurnOf(1))
    R.act(() => view.ban(C)) // banned in turn 1

    clockShift = -12 // back into turn 0: the ban re-applies, but the seal's vote stands
    await vi.advanceTimersByTimeAsync(600)
    R.act(() => view.unban(C))
    await vi.advanceTimersByTimeAsync(0)
    const b = books()
    expect(b.turnVotes[0]?.[C]).toBe("notperson")
    expect(b.autoSeals[0]).toContain(C)
    expect(sealsHoldTheirVotes(b)).toBe(true)
  })
})

// ── #520: late join wins for co-players the latecomer never shared a turn with
// A genuine late joiner files Person (UNSEEN_VERDICT)
// for a co-player no turn of theirs had in it, as lib/late-join.ts says. #445
// still holds for a co-player they DID share an open turn with but never saw
// (no decoded video in a shared turn: NotPerson). The vote trail logs exactly
// the filed verdict.
describe("#520 the late joiner's never-shared co-players", () => {
  const E = "erin"
  // D sits in round 0 only; E arrives in round 1. B and C stay.
  const reshuffled = [group(), [seat(0, ME), seat(1, B), seat(2, C), seat(3, E)]]
  function reshuffledSource() {
    const base = makeSource()
    return {
      ...base,
      gameView: async () => {
        const v = await base.gameView()
        return v && { ...v, seats: reshuffled }
      },
    }
  }
  type Built = { players: Record<string, { verdict: string; source: string }> }
  /** round r's report lists its co-players in seat order */
  const filedFor = (id: string) =>
    reshuffled.flatMap((seats, round) => {
      const at = seats.filter((s) => s.player.value !== ME).findIndex((s) => s.player.value === id)
      return at < 0 ? [] : [chain.reports[0][round][at]]
    })
  /** the trail's verdict for every co-player is the one the report filed */
  const trailMatchesFiled = () => {
    const players = (W.built[0] as Built).players
    for (const id of [B, C, D, E]) {
      const filed = filedFor(id)
      expect(filed.length, id).toBeGreaterThan(0)
      for (const v of filed) expect(players[id].verdict === "person" ? "Person" : "NotPerson", id).toBe(v)
    }
  }
  /** a page that enters at round 1's first turn and sees C and E there */
  async function lateJoinAtRound1() {
    W.store.clear()
    W.source = reshuffledSource()
    vi.setSystemTime((G + 56) * 1000)
    mountSession(false)
    await vi.advanceTimersByTimeAsync(600)
    R.act(() => view.markVideoArrived(C))
    R.act(() => view.markVideoArrived(E))
    await runTo(GAME_END + 1)
    // D belongs only to the round before this player joined. #520 still
    // files Person without asking the latecomer to judge a face they never met.
    expect(view.noVideo(D)).toBe(false)
    expect(view.votable(D)).toBe(false)
    await runTo(GAME_END + 12)
    expect(chain.calls).toBe(1)
  }

  it("a latecomer files Person for a co-player they never shared a turn with, and the trail logs Person", async () => {
    await lateJoinAtRound1()
    expect(filedFor(D)).toEqual(["Person"])
    expect((W.built[0] as Built).players[D]).toMatchObject({ verdict: "person", source: "never-shared" })
    trailMatchesFiled()
  })

  it("a latecomer still files NotPerson for a co-player they shared a turn with but never saw (#445)", async () => {
    await lateJoinAtRound1()
    // B sits in round 1 with the latecomer, and no frame of B ever decoded
    expect(filedFor(B)).toEqual(["NotPerson", "NotPerson"])
    expect((W.built[0] as Built).players[B]).toMatchObject({ verdict: "notperson", source: "unseen" })
    trailMatchesFiled()
  })

  it("a player present from turn 0 files NotPerson for an unseen co-player, round-0-only ones included", async () => {
    W.store.clear()
    W.source = reshuffledSource()
    mountSession(false)
    await runTo(inTurnOf(0))
    R.act(() => view.markVideoArrived(C))
    await runTo(56)
    R.act(() => view.markVideoArrived(C))
    R.act(() => view.markVideoArrived(E))
    await runTo(GAME_END + 12)
    expect(chain.calls).toBe(1)
    expect(filedFor(D)).toEqual(["NotPerson"])
    expect((W.built[0] as Built).players[D]).toMatchObject({ verdict: "notperson", source: "unseen" })
    trailMatchesFiled()
  })

  it("a rejoin is not a late join: the books' first turn makes round 0 shared", async () => {
    W.store.set(
      "jollity.votes",
      JSON.stringify({ gameIndex: 7, account: ME, turnVotes: {}, banned: [], overrides: {}, autoSeals: { 0: [] }, firstOpenedTurn: 0, videoRoleHistory: {} }),
    )
    W.source = reshuffledSource()
    vi.setSystemTime((G + 56) * 1000)
    mountSession(false)
    await vi.advanceTimersByTimeAsync(600)
    R.act(() => view.markVideoArrived(C))
    R.act(() => view.markVideoArrived(E))
    await runTo(GAME_END + 2)
    if (chain.calls === 0) R.act(() => view.confirmVotes())
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.calls).toBe(1)
    expect(filedFor(D)).toEqual(["NotPerson"])
    trailMatchesFiled()
  })
})

describe("#699 /game never sends a registered player home, whatever the turn", () => {
  // the home marks the players it lets in, but a page that reached /game
  // some other way plays too: late join is open at any turn
  afterEach(() => {
    W.joined = true
    W.viaDoor = false
  })

  async function arriveUnmarkedAt(sec: number) {
    W.store.clear()
    W.joined = false
    W.viaDoor = false
    vi.setSystemTime((G + sec) * 1000)
    const router = mountSession(false)
    await vi.advanceTimersByTimeAsync(600)
    return router
  }

  it("keeps an unmarked page in round 1", async () => {
    const router = await arriveUnmarkedAt(36)
    expect(router.replace).not.toHaveBeenCalledWith("/")
  })

  it("keeps an unmarked page in round 2", async () => {
    const router = await arriveUnmarkedAt(GAME_END - 20)
    expect(router.replace).not.toHaveBeenCalledWith("/")
  })
})

describe("passive committed game replay capture", () => {
  function snapshots() {
    return W.logData
      .filter((row) => row.tag === "replay" && row.message === "game.snapshot")
      .map((row) => (row.data as { observation: {
        observation: string
        current: { globalTurn: number | null; stage: string | null; roomKey: string }
        previous: { globalTurn: number | null } | null
        skippedTurnCount: number
        unobservedCompletedTurnRanges: { from: number; toExclusive: number }[]
      } }).observation)
  }

  it("emits after commit with the exact room/host stage and suppresses stable ticks", async () => {
    mountSession(false)
    await runTo(3)
    const gamePlay = snapshots().filter((row) => row.current.globalTurn === 0 && row.current.stage === "gameplay")
    expect(gamePlay).toHaveLength(1)
    expect(gamePlay[0].current.roomKey).toBe("g7")
    const before = snapshots().length
    await runTo(9)
    expect(snapshots()).toHaveLength(before)
    await runTo(10.5)
    expect(snapshots().at(-1)?.current).toMatchObject({ globalTurn: 0, stage: "ending" })
  })

  it("does not turn synthetic seal replay into observed intermediate turns", async () => {
    mountSession(false)
    await runTo(3)
    const before = snapshots().length
    await sleepTo(39)
    const after = snapshots().slice(before)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      observation: "catch-up", previous: { globalTurn: 0 }, current: { globalTurn: 3 },
      skippedTurnCount: 2, unobservedCompletedTurnRanges: [{ from: 1, toExclusive: 3 }],
    })
    // Vote defaults still execute the unchanged catch-up policy.
    const sealed = W.logData.filter((row) => row.tag === "vote" && row.message === "turn sealed")
    expect(sealed.length).toBeGreaterThanOrEqual(3)
  })

  it("distinguishes first late observation, clock-backward revisit and resume", async () => {
    vi.setSystemTime((G + 25) * 1000)
    mountSession(false)
    await vi.advanceTimersByTimeAsync(600)
    expect(snapshots()[0]).toMatchObject({ observation: "initial", previous: null, current: { globalTurn: 2 }, skippedTurnCount: 0 })
    clockShift = -24
    await vi.advanceTimersByTimeAsync(600)
    expect(snapshots().at(-1)).toMatchObject({ observation: "backward", current: { globalTurn: 0 }, skippedTurnCount: 0 })
    setVisibility("hidden")
    setVisibility("visible")
    await vi.advanceTimersByTimeAsync(600)
    expect(snapshots().at(-1)?.observation).toBe("resume")
  })

  it("ends capture on unmount without inventing a turn end and isolates subsequent mounts", async () => {
    mountSession(false)
    await runTo(3)
    R.unmount()
    const stops = W.logData.filter((row) => row.tag === "replay" && row.message === "game.snapshot.stop")
    expect(stops).toHaveLength(1)
    expect(stops[0].data).toMatchObject({ observation: { reason: "observer-cleanup", turnEndingObserved: false } })
    vi.setSystemTime((G + 39) * 1000)
    mountSession(false)
    await vi.advanceTimersByTimeAsync(600)
    expect(snapshots().at(-1)).toMatchObject({ observation: "initial", previous: null, current: { globalTurn: 3 }, skippedTurnCount: 0 })
  })

})

describe("repeat hosts: a group of 4 in six chairs wraps around its own seats", () => {
  // one round of a cap-6 game: you, B, C and D hold seats 0-3, chairs 4 and 5
  // are empty. Six 12 s turns: seats 0-3 host turns 1-4, then seats 0 and 1
  // host turns 5 and 6 (A B C D A B), and no turn goes to an empty chair.
  const shortGroupSource = () => ({
    ...makeSource(),
    gameView: async () => ({
      gameIndex: 7,
      timing: { gameDate: G, reportEnds: G + 92, rounds: 1, maxGroupSize: 6 },
      mySeat: [0],
      seats: [[...group(), { index: 4, player: null }, { index: 5, player: null }]],
      reportSent: false,
    }),
  })

  it("resolves seats 0 and 1 as the hosts of turns 5 and 6", async () => {
    W.source = shortGroupSource()
    mountSession()
    const hosts: (string | null)[] = []
    for (const at of [3, 15, 27, 39, 51, 63]) {
      await runTo(at)
      hosts.push(view.hostId)
    }
    expect(hosts).toEqual([ME, B, C, D, ME, B])
    // turn 6: B hosts again, so B sits it out and you judge C and D
    expect(view.roleFor(B)).toBe("host")
    expect(view.votable(B)).toBe(false)
    expect(view.votable(C)).toBe(true)
    expect(view.votable(D)).toBe(true)
    expect(view.roleFor("ghost:0:4")).toBe("empty")
    // the grid brings B to the top-left, and the empty chairs have no tile (#1347)
    expect(view.display[0]).toBe(B)
    expect(view.display).toHaveLength(4)
    expect(view.display.filter((id) => id.startsWith("ghost:"))).toEqual([])
  })

  it("seals a repeated turn without its host: turn 6 defaults C and D, never B", async () => {
    W.source = shortGroupSource()
    mountSession()
    await runTo(73)
    const sealed = W.logData
      .filter((row) => row.tag === "vote" && row.message === "turn sealed")
      .map((row) => row.data as { turn: number; host: string; auto: string[] })
    expect(sealed.map(({ turn, host }) => [turn, host])).toEqual([
      [0, ME],
      [1, B],
      [2, C],
      [3, D],
      [4, ME],
      [5, B],
    ])
    expect(sealed[4]?.auto).toEqual([B, C, D])
    expect(sealed[5]?.auto).toEqual([C, D])
    const stored = JSON.parse(W.store.get("jollity.votes")!) as {
      turnVotes: Record<number, Record<string, Vote>>
    }
    expect(stored.turnVotes[5]).toEqual({ [C]: "notperson", [D]: "notperson" })
  })
})

// The host's static at a turn change: the tile of a host whose feed is here
// turned near-black for a moment because the LAST host's was not (game 1244,
// PR 1124's bots: a late joiner hosted turn 5 unseen, and turn 6's live host
// was static through its whole intro).
describe("the host's static at a turn change", () => {
  beforeEach(() => {
    MESH.link = () => "connected"
    // B hosts turn 2 with no feed; C hosts turn 3 with one
    MESH.streams = new Map([[C, {}], [D, {}]])
  })

  it("never shows a host whose feed is here as missing because the last host's was", async () => {
    mountSession()
    await runTo(16)
    expect(view.hostId).toBe(B)
    expect(view.hostFeedMissing).toBe(true)

    const readings: [number, string | null, boolean][] = []
    for (const at of [24.1, 24.6, 25.1, 25.6, 26.5]) {
      await runTo(at)
      readings.push([at, view.hostId, view.hostFeedMissing])
    }
    expect(readings).toEqual([
      [24.1, C, false],
      [24.6, C, false],
      [25.1, C, false],
      [25.6, C, false],
      [26.5, C, false],
    ])
  })

  it("still waits a second before showing the host's own feed gone, and back", async () => {
    mountSession()
    await runTo(28) // C's gameplay
    expect(view.hostId).toBe(C)
    expect(view.hostFeedMissing).toBe(false)

    // a blip under a second never reaches the screen
    MESH.streams.delete(C)
    await runTo(28.6)
    expect(view.hostFeedMissing).toBe(false)
    MESH.streams.set(C, {})
    await runTo(30)
    expect(view.hostFeedMissing).toBe(false)

    // a real drop shows after a second, and its return after another
    MESH.streams.delete(C)
    await runTo(30.6)
    expect(view.hostFeedMissing).toBe(false)
    await runTo(32)
    expect(view.hostFeedMissing).toBe(true)
    MESH.streams.set(C, {})
    await runTo(32.6)
    expect(view.hostFeedMissing).toBe(true)
    await runTo(34)
    expect(view.hostFeedMissing).toBe(false)
  })
})

describe("the kickoff on the device clock does not flip with the render instant", () => {
  /** the kickoffs of renders at many instants inside the seconds of the final wait */
  async function kickoffs(): Promise<number[]> {
    mountSession()
    const seen: number[] = []
    for (let read = 0; read < 40; read++) {
      await vi.advanceTimersByTimeAsync(137) // a step that lands on every part of a second
      R.rerender()
      seen.push(view.gameAt!)
    }
    return seen
  }

  for (const aheadMs of [300, 700]) {
    it(`a game clock ${aheadMs} ms ahead gives one kickoff, ${aheadMs} ms before the chain's`, async () => {
      vi.setSystemTime((G - 40) * 1000)
      setChainNow(() => Date.now() + aheadMs)
      W.source = { ...makeSource(), nowSeconds: () => Math.floor((Date.now() + aheadMs) / 1000) }
      const seen = await kickoffs()
      expect(new Set(seen).size).toBe(1)
      expect(seen[0]).toBeCloseTo(G - aheadMs / 1000, 6)
    })

    it(`a whole-second game clock ${aheadMs} ms ahead, with no ms value yet, still gives one kickoff`, async () => {
      vi.setSystemTime((G - 40) * 1000)
      resetChainClockForTests()
      W.source = { ...makeSource(), nowSeconds: () => Math.floor((Date.now() + aheadMs) / 1000) }
      const seen = await kickoffs()
      expect(new Set(seen).size).toBe(1)
      expect(Math.abs(seen[0] - (G - aheadMs / 1000))).toBeLessThan(1)
    })
  }
})

describe("the waiting dial through a game-clock correction", () => {
  /** a game clock `startMs` off the true time, moved back by the real clock reducer */
  function slewingClock(startMs: number) {
    const sync = { ...createClockSync(), shownMs: startMs }
    const gameNow = () => {
      advance(sync, Date.now(), (G - TILES_ENTER_SECONDS) * 1000)
      return Date.now() + sync.shownMs
    }
    setChainNow(gameNow)
    W.source = { ...makeSource(), nowSeconds: () => Math.floor(gameNow() / 1000) }
  }

  const cases = [
    { name: "3000 ms ahead, at 0.5x", startMs: 3_000, maxSpeed: 1 },
    { name: "2000 ms behind, at 2x", startMs: -2_000, maxSpeed: 2 },
    { name: "8000 ms behind, at 4x then 2x", startMs: -8_000, maxSpeed: 4 },
  ]
  for (const { name, startMs, maxSpeed } of cases) {
    it(`${name}: the time left never rises, never skips, and ends on the kickoff`, async () => {
      vi.setSystemTime((G - 64) * 1000)
      slewingClock(startMs)
      mountSession()
      await vi.advanceTimersByTimeAsync(0)
      const left = () => view.gameDate! - TILES_ENTER_SECONDS - sessionNowMs() / 1000
      let last = left()
      // every frame until the true time reaches the end of the dial's 00 second
      while (Date.now() < (G - TILES_ENTER_SECONDS) * 1000) {
        await vi.advanceTimersByTimeAsync(16)
        R.rerender()
        const now = left()
        const stepMs = (last - now) * 1000
        expect(stepMs).toBeGreaterThan(0)
        expect(stepMs).toBeLessThanOrEqual(16 * maxSpeed + 1)
        // the screen switch reads the same clock as the dial: the tiles move in as its 00 second ends
        expect(view.secondsToStart).toBe(Math.ceil(now + TILES_ENTER_SECONDS))
        expect(view.screen).toBe(now > 0 ? "final-waiting" : "tiles-enter")
        last = now
      }
      expect(Math.abs(last)).toBeLessThan(0.02)
    })
  }
})
