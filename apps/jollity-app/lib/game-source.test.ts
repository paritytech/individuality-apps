// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The doorway's BIND ORCHESTRATION, over a fake engine whose host holds a lite
 * key or not: who is remembered, when a bind is asked for, what a failure does
 * to the next attempt, and which seat read the page ends up showing. The
 * sign-up flow underneath is tested in packages/individuality-sign-up, and this
 * file checks that `makeSource` wires it the way the home screen relies on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { REGISTERING_TTL_MS, SENT_TTL_MS } from "@individuality/shared-records"
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"
import {
  deriveSeat,
  GAME_REGISTRATION_RETRY_MS as BIND_RETRY_MS,
  type GameRegistrationCapabilities,
  type GameSeat,
  type GameSeatBindRefusal,
  type LiteSignUpBlocker,
} from "@parity/product-sdk-individuality"
import type { GameEngine, PalletGame, PalletPlayerRow } from "@jollity/protocol"
import { BIND_TIMEOUT_MS, type BindResult, type RegisterOptions, type SignUpDraws } from "@individuality/sign-up"
import { readChainClock, readChainGapMs, resetChainClockForTests } from "./chain-clock"
import { resetStoreClockForTests, storeClock } from "./store-clock"
import { nextSlotExpiry } from "@jollity/statement-core"
import { resetDeviceClockForTests, type DeviceClock } from "./device-clock"
import { getClockSnapshot } from "./debug/clock"
import { PEER_CHECK_MS } from "./clock-sync"
import { ReadTimeoutError } from "./read-retry"
import { journeysNamed, recorded, resetRecorded } from "./telemetry/testing"
import { resetAppOpenForTests } from "./journeys/app-open"
import { reportPageActivity } from "./page-lifecycle"
import { clearDevLog, getDevLogEntries } from "./debug/log-store"
import { resetWarnThrottled } from "./debug/warn-throttled"
import { noteOwnReload } from "./telemetry/session-record"
import type { HostConnectionSource } from "./host/safe-call"

// the engine seam pulls papi and the descriptors; the worker bridge pulls
// React. Neither is exercised here, only the signer wrapper the seam re-exports.
vi.mock("./engine", async (importOriginal) => ({
  resolveDevEngine: () => null,
  resolveHostEngine: async () => null,
  withExtrinsicLogging: (await importOriginal<typeof import("./engine")>()).withExtrinsicLogging,
}))
vi.mock("./telemetry", async () => (await import("./telemetry/testing")).fakeTelemetryModule())
vi.mock("./telemetry/session-record", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./telemetry/session-record")>()),
  noteOwnReload: vi.fn(),
  noteHostChannelLost: vi.fn(),
  noteHostChannelRestored: vi.fn(),
}))
vi.mock("./host/identity", () => ({ knownDisplayName: vi.fn() }))
vi.mock("./collectable-art", () => ({ loadCollectableImage: vi.fn() }))
vi.mock("./host/game-reminder", () => ({
  holdGameReminder: vi.fn(async (_time: number, _startsAt: number, onAsked?: (outcome: string) => void) => {
    onAsked?.("held")
    return "held"
  }),
  reminderForSignup: vi.fn(async () => "held"),
}))
// the host SDK: the factory runs when resolveSource first imports it, so what
// the app-open journey holds at that moment is what the import did not time
const atImport = vi.hoisted(() => ({ steps: [] as string[] }))
const retryTurnAfterHostReconnect = vi.hoisted(() => vi.fn(async () => []))
vi.mock("./webrtc/ice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webrtc/ice")>()),
  retryIceServersAfterHostReconnect: retryTurnAfterHostReconnect,
}))
vi.mock("@parity/product-sdk-host", async () => {
  const { journeysNamed } = await import("./telemetry/testing")
  atImport.steps = journeysNamed("app-open").flatMap((journey) => journey.steps.map((step) => step.name))
  return {
    isInsideContainerSync: () => true,
    subscribeConnectionStatus: (cb: (status: string) => void) => {
      cb("connected")
      return () => {}
    },
  }
})
// the sign-up of the chat card, read through its doorway as the record
// `stored` holds. The real doorway opens host storage, which imports the host
// SDK before the app-open test below looks for its first import.
const chatStore = vi.hoisted(() => ({ stored: undefined as unknown, writes: [] as unknown[] }))
vi.mock("./host/game-registration", async () => {
  const { liveGameRegistration } = await import("@individuality/shared-records")
  return {
    readGameRegistration: vi.fn(async () => liveGameRegistration(chatStore.stored, Date.now())),
    recordSignUp: vi.fn(async (record: unknown) => {
      chatStore.writes.push(record)
      chatStore.stored = record
    }),
    writeGameRegistration: vi.fn(async (record: unknown) => {
      chatStore.writes.push(record)
      chatStore.stored = record
    }),
  }
})
// the communication key of a sign-up, kept in host storage through its doorway,
// kept out for the same reason. A settled stand-in keeps the retry loops on the
// fake clock; a test that wants the key to fail says so.
const commKey = vi.hoisted(() => ({ fail: false }))
vi.mock("./host/communication-key", () => ({
  communicationIdentifier: vi.fn(async () => {
    if (commKey.fail) throw new Error("no key")
    return new Uint8Array(65).fill(4)
  }),
}))
// the chain-lost streak lives in host storage, whose first use imports the
// host SDK: kept out, so the app-open test below sees the first import. Its
// count is whatever the test sets here.
const streak = vi.hoisted(() => ({ value: undefined as number | undefined }))
vi.mock("./chain-lost-streak", () => ({ noteChainLostStreak: async () => streak.value }))
vi.mock("./permissions", () => ({
  isSigningDeclined: (detail: string) => /declined|UnableToSign|createTransaction failed: Rejected/i.test(detail),
}))
const mocks = vi.hoisted(() => ({ sweep: vi.fn() }))
vi.mock("./prize-sweep", () => ({ sweepClaimedPrizes: mocks.sweep }))
import { knownDisplayName } from "./host/identity"
import { holdGameReminder, reminderForSignup } from "./host/game-reminder"
import { readGameRegistration } from "./host/game-registration"
import { acceptFallbackGame, getGameSource, heldStatus, makeSource, NOT_READ, statusGate, watchHostChannel, logHostExtrinsic, type GameStatus } from "./game-source"
import { withExtrinsicLogging } from "./engine"
import { noteHostChannelLost, noteHostChannelRestored } from "./telemetry/session-record"

const PLAYER = "5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw"
const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"
/** what the host's key lookup answers for a lite person (null: no lite key),
 *  as the SDK's `holdsLiteKey` reads it */
const PERSON = "the person's lite key"
const liteKey = vi.fn<(capabilities: GameRegistrationCapabilities) => Promise<typeof PERSON | null>>()
const NOW = 1_700_000_000
const GAME: PalletGame = {
  index: 3,
  state: { type: "Registration" },
  airdrops_scheduled: 1,
  // a wide window: a test walks the clock past the whole retry ladder
  registration_ends: NOW + 7200,
  shuffle_deadline: NOW + 7260,
  game_date: NOW + 7300,
  report_ends: NOW + 7600,
  rounds: 2,
  max_group_size: 6,
}
const signer = { publicKey: new Uint8Array(32).fill(1) } as unknown as CommonSignerTxCreator
/** what the host does for PLAYER's sign-up: the fake engine never submits, so
 *  only the account and the personhood keys the bind proves with matter */
const CAPS: GameRegistrationCapabilities = {
  account: { address: PLAYER, publicKey: signer.publicKey },
  signer,
  submit: vi.fn(),
  signVrf: vi.fn(),
  personhood: { holds: vi.fn(async () => true), prove: vi.fn(async () => ({}) as never) },
}
const BOUND: BindResult = { kind: "bound" }
/** a bind the chain refused: for good unless it is one the chain may take later */
const refused = (refusal: GameSeatBindRefusal, code: string, account?: string): BindResult => ({
  kind: "refused",
  permanent: code !== "CallBlockOutOfRange",
  refusal,
  code,
  detail: `${refusal}: ${code}`,
  ...(account ? { account } : {}),
})
/** a bind that minted its proof with the personhood keys it was handed, then landed */
const proves = async (capabilities: GameRegistrationCapabilities): Promise<BindResult> => {
  await capabilities.personhood!.prove({} as never, {} as never, new Uint8Array(32))
  return BOUND
}
/** what a sign-up carried for the draws: `entered` of the one scheduled, or none and why */
const draws = (entered: number, skipped?: string, facts: Partial<SignUpDraws> = {}): SignUpDraws => ({
  entered,
  scheduled: 1,
  waitedMs: 0,
  retries: 0,
  ...(skipped === undefined ? {} : { skipped }),
  ...facts,
})

/** a promise whose settlement the test holds */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** the chain's facts for a seat read: the requirement's blockers, and no funds */
const facts = (blockers: string[]) => ({ blockers, free: 0n })
type SeatSpec = ReturnType<typeof facts>

/** The SDK's seat over `spec`, its route decided by the SDK's own `deriveSeat`. */
function seatOf(spec: SeatSpec, seatFacts: { litePerson: boolean; bound?: boolean }): GameSeat {
  const blockers = spec.blockers.map((tag) => ({ tag })) as unknown as LiteSignUpBlocker[]
  return {
    ...deriveSeat({ blockers, free: spec.free, required: 20_000_000_000n, ...seatFacts }),
    registered: spec.blockers.includes("AlreadyRegistered"),
    open: true,
    required: 20_000_000_000n,
    requirement: { blockers } as unknown as GameSeat["requirement"],
    funds: { free: spec.free, deposit: 20_000_000_000n, estimatedFee: 0n, decimals: 10, symbol: "PAS" } as GameSeat["funds"],
  }
}
/** an engine `seat` that answers every read with `spec` */
const seatsOf = (spec: SeatSpec) => async (_account: string, seatFacts: { litePerson: boolean; bound?: boolean }) => seatOf(spec, seatFacts)

/** the engine the doorway reads: the game's watch is driven by the test, each
 *  seat read is a deferred the test settles, and `bind` is whatever the test
 *  makes of it */
function fakeEngine() {
  // the source's clock and `watchStatus` both watch the game
  const gameCbs = new Set<(game: PalletGame | undefined) => void>()
  let nowCb: ((seconds: number, block?: number) => void) | undefined
  let nowErrorCb: ((error: unknown) => void) | undefined
  const nowCbs: Array<(seconds: number, block?: number) => void> = []
  const nowErrorCbs: Array<((error: unknown) => void) | undefined> = []
  let clockWatchCount = 0
  let bestSecond = NOW
  let playerCb: ((player: { registered: boolean } | undefined) => void) | undefined
  const rowCbs = new Set<(row: PalletPlayerRow | undefined) => void>()
  const seatReads: Array<ReturnType<typeof deferred<SeatSpec>>> = []
  const bind = vi.fn<GameEngine["bind"]>(async () => BOUND)
  const waitUntilFollowing = vi.fn<NonNullable<GameEngine["waitUntilFollowing"]>>()
  const engine = {
    kind: "chain",
    now: async () => NOW,
    // the fake reports NOW once; a test ticks it further with `now`
    watchNow: (cb: (seconds: number, block?: number) => void, onError?: (error: unknown) => void) => {
      clockWatchCount += 1
      nowCb = cb
      nowErrorCb = onError
      nowCbs.push(cb)
      nowErrorCbs.push(onError)
      cb(NOW)
      return () => {
        if (nowCb === cb) nowCb = undefined
        if (nowErrorCb === onError) nowErrorCb = undefined
      }
    },
    game: async () => GAME,
    schedules: async () => [],
    phases: async () => ({ registration: 300, shuffle: 60, post_shuffle_margin: 30 }),
    player: async () => undefined,
    playerIndices: async () => undefined,
    groupMembers: async () => [],
    participant: async () => undefined,
    personhoodThreshold: async () => 21,
    draws: async () => [],
    eligibility: async () => ({ eligible: false, reason: null }),
    seat: vi.fn((_account: string, seatFacts: { litePerson: boolean; bound?: boolean }) => {
      const read = deferred<SeatSpec>()
      seatReads.push(read)
      return read.promise.then((spec) => seatOf(spec, seatFacts))
    }),
    holdsLiteKey: vi.fn(async (capabilities: GameRegistrationCapabilities) => (await liteKey(capabilities)) !== null),
    bind,
    waitUntilFollowing,
    register: vi.fn(),
    report: vi.fn(),
    watchGame: (cb: (game: PalletGame | undefined) => void) => {
      gameCbs.add(cb)
      return () => {
        gameCbs.delete(cb)
      }
    },
    watchPlayer: (_address: string, cb: (player: { registered: boolean } | undefined) => void) => {
      playerCb = cb
      return () => {}
    },
    watchPlayerRow: (_address: string, cb: (row: PalletPlayerRow | undefined) => void) => {
      rowCbs.add(cb)
      return () => {
        rowCbs.delete(cb)
      }
    },
    watchFreeBalance: () => () => {},
    destroy: () => {},
  } as unknown as GameEngine
  const publishGame = (game: PalletGame | undefined) => {
    gameCbs.forEach((cb) => cb(game))
  }
  return {
    engine,
    bind,
    seatReads,
    /** the chain reports the game (or reports it again — a seat input moved) */
    game: (...args: [PalletGame | undefined] | []) => {
      const game = args.length === 0 ? GAME : args[0]
      publishGame(game)
      // A Registration storage watch emission belongs to a best block. The
      // source's clock watch delivers that block too; that is the finalized
      // confirmation trigger exercised by these registration fixtures.
      if (game?.state.type === "Registration" && gameCbs.size > 1) {
        bestSecond += 1
        nowCb?.(bestSecond)
      }
    },
    /** a storage watch emission without the accompanying best-block clock */
    gameWithoutTick: (...args: [PalletGame | undefined] | []) => {
      publishGame(args.length === 0 ? GAME : args[0])
    },
    /** a new best block with this chain second */
    now: (seconds: number, block?: number) => {
      bestSecond = Math.max(bestSecond, seconds)
      nowCb?.(seconds, block)
    },
    clockError: (error: unknown) => nowErrorCb?.(error),
    clockAnchorAt: (generation: number, seconds: number, block?: number) => nowCbs[generation]?.(seconds, block),
    clockErrorAt: (generation: number, error: unknown) => nowErrorCbs[generation]?.(error),
    clockWatchCount: () => clockWatchCount,
    player: (record: { registered: boolean } | undefined) => playerCb?.(record),
    /** the player's row with the votes moves on a best block */
    playerRow: (row: PalletPlayerRow | undefined) => rowCbs.forEach((cb) => cb(row)),
    /** how many row watches are still open */
    rowWatches: () => rowCbs.size,
  }
}

/** let every settled promise run its continuations */
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

/** a source watching status; the test reads the last seat it published */
function watching(engine: GameEngine) {
  const source = makeSource("host", engine, { player: PLAYER, signer, capabilities: CAPS })
  const statuses: GameStatus[] = []
  const stop = source.watchStatus((status) => statuses.push(status))
  const lastSeat = () => {
    const last = statuses[statuses.length - 1]
    return last?.kind === "registration" ? last.seat : undefined
  }
  return { source, statuses, lastSeat, stop }
}

beforeEach(() => {
  resetChainClockForTests()
  resetRecorded()
  vi.useFakeTimers({ now: NOW * 1000 })
  resetDeviceClockForTests()
  resetWarnThrottled()
  vi.mocked(liteKey).mockReset().mockResolvedValue(null)
  vi.mocked(knownDisplayName).mockReset().mockResolvedValue(null)
  vi.mocked(noteHostChannelLost).mockClear()
  vi.mocked(noteHostChannelRestored).mockClear()
  vi.mocked(noteOwnReload).mockReset()
  retryTurnAfterHostReconnect.mockClear()
  mocks.sweep.mockClear()
  chatStore.stored = undefined
  chatStore.writes.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

const RESUME_CUT = new Error(
  "Could not process the host's response to createTransaction failed: TrUAPI host connection interrupted. The usual cause is a protocol-version skew between the host app and the @parity/truapi version this product is built against; a host channel that closed mid-call looks the same.",
  { cause: Object.assign(new Error("TrUAPI host connection interrupted"), { name: "ConnectionResetError" }) },
)

describe("the host chain-health probe safety latch", () => {
  it("stops further probes on this page after a confirmation decline", async () => {
    const chain = fakeEngine()
    const build = vi.fn(async () => {
      throw new Error("createTransaction failed: Rejected")
    })
    chain.engine.probeChainHealth = build
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })

    await expect(source.probeChainHealth!("open")).resolves.toMatchObject({ outcome: "declined" })
    await expect(source.probeChainHealth!("waiting")).resolves.toMatchObject({
      outcome: "declined",
    })
    expect(build).toHaveBeenCalledTimes(1)
  })

  it("shares one running probe between callers, then probes afresh", async () => {
    const chain = fakeEngine()
    let release!: () => void
    const build = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    chain.engine.probeChainHealth = build
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })

    const first = source.probeChainHealth!("signup")
    const second = source.probeChainHealth!("open")
    expect(second).toBe(first)
    expect(build).toHaveBeenCalledTimes(1)
    release()
    await first
    void source.probeChainHealth!("open")
    expect(build).toHaveBeenCalledTimes(2)
  })
  it("promotes the second consecutive five-second timeout to a stuck host", async () => {
    const chain = fakeEngine()
    chain.engine.probeChainHealth = vi.fn(() => new Promise<void>(() => {}))
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })

    const first = source.probeChainHealth!("open")
    await vi.advanceTimersByTimeAsync(5000)
    await expect(first).resolves.toMatchObject({ outcome: "unknown", errorClass: "timeout" })

    const second = source.probeChainHealth!("waiting")
    await vi.advanceTimersByTimeAsync(5000)
    await expect(second).resolves.toMatchObject({
      outcome: "host-chain-lost",
      errorClass: "timeout",
      error: "two chain health probes timed out in a row",
    })
  })
  it("does not join distant timeouts when the wall clock steps back", async () => {
    const chain = fakeEngine()
    chain.engine.probeChainHealth = vi.fn(() => new Promise<void>(() => {}))
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })

    const first = source.probeChainHealth!("open")
    await vi.advanceTimersByTimeAsync(5000)
    await expect(first).resolves.toMatchObject({ outcome: "unknown", errorClass: "timeout" })

    await vi.advanceTimersByTimeAsync(30_001)
    vi.setSystemTime(NOW * 1000 - 10_000)
    const second = source.probeChainHealth!("waiting")
    await vi.advanceTimersByTimeAsync(5000)
    await expect(second).resolves.toMatchObject({ outcome: "unknown", errorClass: "timeout" })
  })
  it("keeps adjacent timeouts together when the wall clock steps forward", async () => {
    const chain = fakeEngine()
    chain.engine.probeChainHealth = vi.fn(() => new Promise<void>(() => {}))
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })

    const first = source.probeChainHealth!("open")
    await vi.advanceTimersByTimeAsync(5000)
    await expect(first).resolves.toMatchObject({ outcome: "unknown", errorClass: "timeout" })

    vi.setSystemTime(NOW * 1000 + 60_000)
    const second = source.probeChainHealth!("waiting")
    await vi.advanceTimersByTimeAsync(5000)
    await expect(second).resolves.toMatchObject({
      outcome: "host-chain-lost",
      errorClass: "timeout",
      error: "two chain health probes timed out in a row",
    })
  })
  it("does not let a timed-out build keep later recovery probes in single-flight", async () => {
    const chain = fakeEngine()
    let recovered = false
    const build = vi.fn(() => recovered ? Promise.resolve() : new Promise<void>(() => {}))
    chain.engine.probeChainHealth = build
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })

    const hung = source.probeChainHealth!("recheck")
    await vi.advanceTimersByTimeAsync(5000)
    await expect(hung).resolves.toMatchObject({ outcome: "unknown", errorClass: "timeout" })

    recovered = true
    await expect(source.probeChainHealth!("recheck")).resolves.toMatchObject({ outcome: "healthy" })
    expect(build).toHaveBeenCalledTimes(2)
  })
  it("hands the doorway's chain-lost count on with the result", async () => {
    const chain = fakeEngine()
    chain.engine.probeChainHealth = vi.fn(async () => {
      throw new Error("createTransaction failed: cannot get the current block: subscription dropped")
    })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    streak.value = 2
    try {
      await expect(source.probeChainHealth!("open", { registered: true })).resolves.toMatchObject({
        outcome: "host-chain-lost",
        consecutiveLost: 2,
      })
    } finally {
      streak.value = undefined
    }
  })

  function hostLink(initial: "connected" | "disconnected") {
    let status: "connecting" | "connected" | "disconnected" = initial
    const listeners = new Set<(status: "connecting" | "connected" | "disconnected") => void>()
    const source: HostConnectionSource = {
      subscribeConnectionStatus(callback) {
        listeners.add(callback)
        callback(status)
        return () => void listeners.delete(callback)
      },
    }
    return {
      source,
      report(next: "connecting" | "connected" | "disconnected") {
        status = next
        for (const listener of [...listeners]) listener(next)
      },
    }
  }

  it("reruns a build the resume cut once the host reports connected, and reports it healthy", async () => {
    const chain = fakeEngine()
    const link = hostLink("connected")
    const build = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        link.report("disconnected")
        throw RESUME_CUT
      })
      .mockResolvedValueOnce(undefined)
    chain.engine.probeChainHealth = build
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS, hostConnection: link.source })

    const probed = source.probeChainHealth!("recheck")
    await vi.advanceTimersByTimeAsync(140)
    link.report("connected")
    await expect(probed).resolves.toMatchObject({ outcome: "healthy" })
    expect(build).toHaveBeenCalledTimes(2)
    expect(recorded.metrics).toContainEqual({
      type: "count",
      name: "chain.retries",
      value: 1,
      attrs: { "chain.retry_reason": "host-interrupted", "chain.retry_operation": "chain-health", "chain.retry_succeeded": "true" },
    })
  })

  it("reports a link that stays down as unknown, not as a lost chain", async () => {
    const chain = fakeEngine()
    const link = hostLink("disconnected")
    const build = vi.fn(async () => {
      throw RESUME_CUT
    })
    chain.engine.probeChainHealth = build
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS, hostConnection: link.source })

    const probed = source.probeChainHealth!("signup")
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(probed).resolves.toMatchObject({ outcome: "unknown", errorClass: "host-interrupted" })
    expect(build).toHaveBeenCalledOnce()
    expect(recorded.metrics.filter((metric) => metric.name === "chain.health" || metric.name === "chain.retries")).toEqual([
      expect.objectContaining({
        name: "chain.health",
        attrs: { "chain.health.where": "signup", "chain.health.outcome": "unknown", "chain.health.error_class": "host-interrupted" },
      }),
    ])
  })

  it("reports a rebuild the cut leaves running past the bound as unknown, and the next timeout as the first miss", async () => {
    const chain = fakeEngine()
    const link = hostLink("connected")
    const build = vi
      .fn<() => Promise<void>>(() => new Promise<void>(() => {}))
      .mockImplementationOnce(async () => {
        link.report("disconnected")
        throw RESUME_CUT
      })
    chain.engine.probeChainHealth = build
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS, hostConnection: link.source })

    const first = source.probeChainHealth!("recheck")
    await vi.advanceTimersByTimeAsync(1_000)
    link.report("connected")
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(first).resolves.toMatchObject({ outcome: "unknown", errorClass: "host-interrupted" })
    expect(build).toHaveBeenCalledTimes(2)

    const second = source.probeChainHealth!("waiting")
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(second).resolves.toMatchObject({ outcome: "unknown", errorClass: "timeout" })
  })

  it("counts a rebuild that starts after the bound once it settles", async () => {
    const chain = fakeEngine()
    const link = hostLink("connected")
    const build = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) =>
            setTimeout(() => {
              link.report("disconnected")
              reject(RESUME_CUT)
            }, 4_900),
          ),
      )
      .mockResolvedValueOnce(undefined)
    chain.engine.probeChainHealth = build
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS, hostConnection: link.source })

    const probed = source.probeChainHealth!("recheck")
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(probed).resolves.toMatchObject({ outcome: "unknown", errorClass: "timeout" })
    expect(recorded.metrics.filter((metric) => metric.name === "chain.retries")).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)
    link.report("connected")
    await vi.advanceTimersByTimeAsync(0)
    expect(build).toHaveBeenCalledTimes(2)
    expect(recorded.metrics).toContainEqual({
      type: "count",
      name: "chain.retries",
      value: 1,
      attrs: { "chain.retry_reason": "host-interrupted", "chain.retry_operation": "chain-health", "chain.retry_succeeded": "true" },
    })
  })

  it("reports a rebuild the cut fails again as unknown, and counts the rerun failed", async () => {
    const chain = fakeEngine()
    const link = hostLink("connected")
    const build = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        link.report("disconnected")
        throw RESUME_CUT
      })
      .mockRejectedValueOnce(RESUME_CUT)
    chain.engine.probeChainHealth = build
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS, hostConnection: link.source })

    const probed = source.probeChainHealth!("recheck")
    await vi.advanceTimersByTimeAsync(140)
    link.report("connected")
    await expect(probed).resolves.toMatchObject({ outcome: "unknown", errorClass: "host-interrupted" })
    expect(build).toHaveBeenCalledTimes(2)
    expect(recorded.metrics).toContainEqual({
      type: "count",
      name: "chain.retries",
      value: 1,
      attrs: { "chain.retry_reason": "host-interrupted", "chain.retry_operation": "chain-health", "chain.retry_succeeded": "false" },
    })
  })
})

// #289: a home that settled on "No game scheduled" while the chain had a game
// in Registration. The status learned of the game only from the watch, so a
// watch that stayed silent (or a read that came in empty) left "none" for good.
describe("the home's game read (#289)", () => {
  const last = (statuses: GameStatus[]) => statuses[statuses.length - 1]?.kind

  it("shows the game as scheduled when only best has the registration game", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => undefined
    const { statuses, stop } = watching(chain.engine)
    await flush()
    expect(last(statuses)).toBe("none")

    chain.game(GAME)
    await flush()

    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "scheduled", gameAt: GAME.game_date })
    expect(statuses.some((status) => status.kind === "registration")).toBe(false)
    stop()
  })

  it("keeps the held game scheduled when best wins the fresh-mount race without a chain tick", async () => {
    const chain = fakeEngine()
    const read = deferred<PalletGame | undefined>()
    chain.engine.game = () => read.promise
    const { statuses, stop } = watching(chain.engine)

    chain.gameWithoutTick(GAME)
    await flush()
    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "scheduled", gameAt: GAME.game_date })

    read.resolve(undefined)
    await flush()
    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "scheduled", gameAt: GAME.game_date })
    expect(statuses.some((status) => status.kind === "registration")).toBe(false)
    stop()
  })

  it("shows registration within the next block once finalized catches up", async () => {
    const chain = fakeEngine()
    const finalized: { current?: PalletGame } = {}
    chain.engine.game = async () => finalized.current
    const { statuses, stop } = watching(chain.engine)
    await flush()
    expect(last(statuses)).toBe("none")
    chain.game(GAME)
    await flush()
    expect(last(statuses)).not.toBe("registration")

    finalized.current = GAME
    await vi.advanceTimersByTimeAsync(24_000)
    chain.now(NOW + 24, 2)
    await flush()

    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "registration", offerRegister: true })
    expect(recorded.metrics).toContainEqual({
      type: "distribution",
      name: "registration.finalized_lag_ms",
      value: 24_000,
      unit: "millisecond",
      attrs: {},
    })
    stop()
  })

  it("records a fresh mount's finalized registration lag", async () => {
    const chain = fakeEngine()
    const finalized: { current?: PalletGame } = {}
    chain.engine.game = async () => finalized.current
    const { statuses, stop } = watching(chain.engine)
    chain.game(GAME)
    await flush()

    finalized.current = GAME
    await vi.advanceTimersByTimeAsync(6_000)
    chain.now(NOW + 6, 2)
    await flush()

    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "registration" })
    expect(recorded.metrics).toContainEqual({
      type: "distribution",
      name: "registration.finalized_lag_ms",
      value: 6_000,
      unit: "millisecond",
      attrs: {},
    })
    stop()
  })

  it.each([60_000, -60_000])("keeps finalized registration lag steady across a %i ms wall-clock jump", async (jumpMs) => {
    const chain = fakeEngine()
    const finalized: { current?: PalletGame } = {}
    chain.engine.game = async () => finalized.current
    const { stop } = watching(chain.engine)
    await flush()
    chain.game(GAME)
    await flush()

    vi.setSystemTime(Date.now() + jumpMs)
    finalized.current = GAME
    await vi.advanceTimersByTimeAsync(6_000)
    chain.now(NOW + 6, 2)
    await flush()

    expect(recorded.metrics).toContainEqual({
      type: "distribution",
      name: "registration.finalized_lag_ms",
      value: 6_000,
      unit: "millisecond",
      attrs: {},
    })
    stop()
  })

  it("settles a fresh home from a later finalized read after its first read hangs", async () => {
    const chain = fakeEngine()
    const hangingRead = deferred<PalletGame | undefined>()
    const game = vi.fn<GameEngine["game"]>().mockReturnValue(hangingRead.promise)
    chain.engine.game = game
    const { statuses, stop } = watching(chain.engine)

    chain.game(GAME)
    await flush()
    expect(last(statuses)).toBe("scheduled")

    await vi.advanceTimersByTimeAsync(20_000)
    game.mockResolvedValue(undefined)
    chain.now(NOW + 20, 2)
    await flush()
    expect(last(statuses)).toBe("scheduled")
    expect(statuses.some((status) => status.kind === "registration")).toBe(false)

    game.mockResolvedValue(GAME)
    await vi.advanceTimersByTimeAsync(6_000)
    chain.now(NOW + 26, 3)
    await flush()
    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "registration", offerRegister: true })
    expect(recorded.metrics).toContainEqual({
      type: "distribution",
      name: "registration.finalized_lag_ms",
      value: 26_000,
      unit: "millisecond",
      attrs: {},
    })
    stop()
  })

  it("shows the game when the watch stays silent: one read at subscribe", async () => {
    const chain = fakeEngine()
    const { statuses, stop } = watching(chain.engine)
    await flush()
    expect(last(statuses)).toBe("registration")
    stop()
  })

  it("re-reads on the next chain tick while there is no game, and shows it", async () => {
    const chain = fakeEngine()
    const game = vi.fn<GameEngine["game"]>().mockResolvedValue(undefined)
    chain.engine.game = game
    const { statuses, stop } = watching(chain.engine)
    await flush()
    expect(last(statuses)).toBe("none")
    game.mockResolvedValue(GAME) // the game lands a block later
    chain.now(NOW + 6, 1)
    await flush()
    expect(last(statuses)).toBe("registration")
    stop()
  })

  it("never lets a read begun before the watch's value overwrite it", async () => {
    const chain = fakeEngine()
    const read = deferred<PalletGame | undefined>()
    const watched = {
      ...GAME,
      index: 4,
      state: { type: "Shuffle", value: { player_count: 4 } } as const,
      game_date: GAME.game_date + 100,
      registration_ends: GAME.registration_ends + 100,
    }
    chain.engine.game = vi.fn<GameEngine["game"]>().mockReturnValueOnce(read.promise).mockResolvedValue(watched)
    const { statuses, stop } = watching(chain.engine)
    chain.game(watched)
    await flush()
    read.resolve(GAME)
    await flush()
    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "starting", gameAt: watched.game_date })
    stop()
  })

  it("runs at most one finalized registration read per best block and backs off after a timeout", async () => {
    const chain = fakeEngine()
    const hung = new Promise<PalletGame | undefined>(() => {})
    const game = vi.fn<GameEngine["game"]>().mockResolvedValueOnce(undefined).mockReturnValue(hung)
    chain.engine.game = game
    const { stop } = watching(chain.engine)
    await flush()
    const beforeWatch = game.mock.calls.length
    chain.game(GAME)
    expect(game.mock.calls.length).toBe(beforeWatch + 1)

    chain.now(NOW + 6, 1)
    chain.now(NOW + 12, 2)
    await flush()
    expect(game.mock.calls.length).toBe(beforeWatch + 1)

    await vi.advanceTimersByTimeAsync(10_000)
    chain.now(NOW + 18, 3)
    await flush()
    expect(game.mock.calls.length).toBe(beforeWatch + 1)

    await vi.advanceTimersByTimeAsync(10_000)
    chain.now(NOW + 24, 4)
    await flush()
    expect(game.mock.calls.length).toBe(beforeWatch + 2)
    stop()
  })

  it("does not end finalized-read backoff early on a forward wall-clock jump", async () => {
    const chain = fakeEngine()
    const game = vi.fn<GameEngine["game"]>().mockResolvedValueOnce(undefined).mockReturnValue(new Promise(() => {}))
    chain.engine.game = game
    const { stop } = watching(chain.engine)
    await flush()
    chain.game(GAME)
    await vi.advanceTimersByTimeAsync(10_000)
    const afterTimeout = game.mock.calls.length

    vi.setSystemTime(Date.now() + 60_000)
    chain.now(NOW + 12, 2)
    await flush()

    expect(game).toHaveBeenCalledTimes(afterTimeout)
    stop()
  })

  it("ends finalized-read backoff on monotonic time after a backward wall-clock jump", async () => {
    const chain = fakeEngine()
    const game = vi.fn<GameEngine["game"]>().mockResolvedValueOnce(undefined).mockReturnValue(new Promise(() => {}))
    chain.engine.game = game
    const { stop } = watching(chain.engine)
    await flush()
    chain.game(GAME)
    await vi.advanceTimersByTimeAsync(10_000)
    const afterTimeout = game.mock.calls.length

    vi.setSystemTime(Date.now() - 60_000)
    await vi.advanceTimersByTimeAsync(10_000)
    chain.now(NOW + 24, 4)
    await flush()

    expect(game).toHaveBeenCalledTimes(afterTimeout + 1)
    stop()
  })

  it("does not bring back a game the watch has already seen end", async () => {
    const chain = fakeEngine()
    const read = deferred<PalletGame | undefined>()
    const game = vi.fn<GameEngine["game"]>().mockResolvedValue(undefined)
    chain.engine.game = game
    const { statuses, stop } = watching(chain.engine)
    chain.game(GAME)
    await flush()
    chain.game(undefined) // the slot is cleared at best
    await flush()
    game.mockReturnValue(read.promise)
    chain.now(NOW + 6, 1) // the poll reads finalized, a block or two behind
    read.resolve(GAME)
    await flush()
    expect(last(statuses)).toBe("none")
    stop()
  })

  // game 173 (CI 37145473682, main 7f7e564): all three homes settled on
  // "none" ~5 s after load, then offered Register. The first game read over a
  // cold public RPC had not landed yet, but the once-a-second re-derive, the
  // phases read and the (already empty) schedule read each emitted with no
  // game, and no game reads as "none".
  it("says nothing about the game until it has been read: loading, never none", async () => {
    const chain = fakeEngine()
    const read = deferred<PalletGame | undefined>()
    chain.engine.game = () => read.promise
    const { statuses, stop } = watching(chain.engine)
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(statuses.map((status) => status.kind)).not.toContain("none")
    expect(last(statuses)).toBe("loading")
    read.resolve(GAME)
    await flush()
    expect(last(statuses)).toBe("registration")
    stop()
  })

  it("says none only once both the game slot and the schedule queue have been read empty", async () => {
    const chain = fakeEngine()
    const schedules = deferred<Awaited<ReturnType<GameEngine["schedules"]>>>()
    chain.engine.game = async () => undefined
    chain.engine.schedules = () => schedules.promise
    const { statuses, stop } = watching(chain.engine)
    await flush()
    await vi.advanceTimersByTimeAsync(3000)
    expect(statuses.map((status) => status.kind)).not.toContain("none")
    schedules.resolve([])
    await flush()
    expect(last(statuses)).toBe("none")
    stop()
  })

  it("reads again on a later block when the first read hangs", async () => {
    const chain = fakeEngine()
    const hung = new Promise<PalletGame | undefined>(() => {})
    // the source's clock reads the game once too: both first reads hang
    const game = vi.fn<GameEngine["game"]>().mockReturnValueOnce(hung).mockReturnValueOnce(hung).mockResolvedValue(GAME)
    chain.engine.game = game
    const { statuses, stop } = watching(chain.engine)
    const reads = game.mock.calls.length
    await vi.advanceTimersByTimeAsync(6000)
    chain.now(NOW + 6, 1) // the hung read still holds the one slot in flight
    await flush()
    expect(game.mock.calls.length).toBe(reads)
    expect(last(statuses)).toBe("loading")
    await vi.advanceTimersByTimeAsync(6000) // past the read's deadline
    chain.now(NOW + 12, 2)
    await flush()
    expect(game.mock.calls.length).toBe(reads + 1)
    expect(last(statuses)).toBe("registration")
    stop()
  })

  it("retries a failed schedule read on the next block, then says none", async () => {
    const chain = fakeEngine()
    // the slot is answered empty by the watch alone: the read fails, so only
    // the tick's own schedule retry can settle the queue
    chain.engine.game = vi.fn<GameEngine["game"]>().mockRejectedValue(new Error("rpc down"))
    const schedules = vi.fn<GameEngine["schedules"]>().mockRejectedValue(new Error("rpc down"))
    chain.engine.schedules = schedules
    const { statuses, stop } = watching(chain.engine)
    chain.game(undefined)
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    expect(last(statuses)).toBe("loading")
    schedules.mockResolvedValue([])
    chain.now(NOW + 6, 1)
    await flush()
    expect(last(statuses)).toBe("none")
    stop()
  })

  it("stops re-reading once a game is known", async () => {
    const chain = fakeEngine()
    const game = vi.fn<GameEngine["game"]>().mockResolvedValue(GAME)
    chain.engine.game = game
    const { stop } = watching(chain.engine)
    await flush()
    const reads = game.mock.calls.length
    chain.now(NOW + 6, 1)
    chain.now(NOW + 12, 2)
    await flush()
    expect(game.mock.calls.length).toBe(reads)
    stop()
  })

  // the game just played, past its play window: the slot holds one game, so best has moved on
  const PLAYED: PalletGame = {
    ...GAME,
    index: GAME.index - 1,
    state: { type: "Reporting", value: { player_count: 6 } },
    game_date: NOW - 600,
    registration_ends: NOW - 700,
    shuffle_deadline: NOW - 650,
    report_ends: NOW + 300,
  }

  // the queue still names the next game while the game just played holds the slot
  const QUEUE = [{ game_play_time: GAME.game_date, rounds: 2, max_group_size: 6 }]

  it("shows the next game as scheduled, never the game just played, on a fresh mount (#1418)", async () => {
    const chain = fakeEngine()
    chain.engine.schedules = async () => QUEUE
    const finalized: { current?: PalletGame } = { current: PLAYED }
    chain.engine.game = async () => finalized.current
    const { statuses, stop } = watching(chain.engine)
    chain.player({ registered: true })

    chain.game(GAME)
    await flush()

    expect(statuses.some((status) => ["live", "starting", "processing"].includes(status.kind))).toBe(false)
    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "scheduled", gameAt: GAME.game_date })

    finalized.current = GAME
    await vi.advanceTimersByTimeAsync(6_000)
    chain.now(NOW + 6, 2)
    await flush()

    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "registration" })
    expect(statuses.some((status) => ["live", "starting", "processing"].includes(status.kind))).toBe(false)
    stop()
  })

  it("moves a mounted home from the game just played to the next game at once (#1418)", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => PLAYED
    chain.engine.schedules = async () => QUEUE
    const { statuses, stop } = watching(chain.engine)
    chain.player({ registered: true })
    await flush()
    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "scheduled", gameAt: GAME.game_date })

    chain.game(GAME)
    await flush()

    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "scheduled", gameAt: GAME.game_date })
    await vi.advanceTimersByTimeAsync(6_000)
    chain.now(NOW + 6, 2)
    await flush()
    expect(statuses.some((status) => ["live", "starting", "processing"].includes(status.kind))).toBe(false)
    stop()
  })
})

describe("the waiting-room draw schedule (#515)", () => {
  it("returns the authoritative count only for the expected Game.Game", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => ({ ...GAME, airdrops_scheduled: 0 })
    const source = makeSource("host", chain.engine)

    await expect(source.drawSchedule(GAME.game_date)).resolves.toEqual({
      gameIndex: GAME.index,
      gameAt: GAME.game_date,
      scheduled: 0,
    })
    await expect(source.drawSchedule(GAME.game_date + 1)).resolves.toBeNull()
  })

  it("does not turn an engine read failure into a no-draw answer", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => {
      throw new Error("rpc unavailable")
    }
    const source = makeSource("host", chain.engine)

    await expect(source.drawSchedule(GAME.game_date)).rejects.toThrow("rpc unavailable")
  })
})

describe("home status before the first chain read works", () => {
  it("reveals registration when the first finalized answer matches best", async () => {
    const chain = fakeEngine()
    const read = deferred<PalletGame | undefined>()
    chain.engine.game = () => read.promise
    const statuses: GameStatus[] = []
    const stop = makeSource("host", chain.engine).watchStatus((status) => statuses.push(status))

    chain.game(GAME)
    await flush()
    expect(statuses[statuses.length - 1]?.kind).toBe("scheduled")
    read.resolve(GAME)
    await flush()

    expect(statuses[statuses.length - 1]?.kind).toBe("registration")
    stop()
  })
})

describe("the player's registration read on app open (#357)", () => {
  it("shows registered when Players is at best while the finalized seat still says AliasNotBound", async () => {
    const chain = fakeEngine()
    chain.engine.player = vi.fn(async () => ({ registered: true }) as never)
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    const { statuses, stop } = watching(chain.engine)

    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()

    expect(statuses[statuses.length - 1]).toMatchObject({
      kind: "registration",
      registered: true,
      offerRegister: false,
    })
    stop()
  })

  it("keeps a positive startup read when an unversioned false watch arrives first", async () => {
    const chain = fakeEngine()
    const playerRead = deferred<Awaited<ReturnType<GameEngine["player"]>>>()
    chain.engine.player = () => playerRead.promise
    const { statuses, stop } = watching(chain.engine)

    await flush()
    chain.player(undefined)
    playerRead.resolve({ registered: true })
    await flush()

    expect(statuses[statuses.length - 1]).toMatchObject({
      kind: "registration",
      registered: true,
      offerRegister: false,
    })
    stop()
  })

  it("does not let a later unversioned false watch undo a positive read for the same game", async () => {
    const chain = fakeEngine()
    chain.engine.player = vi.fn(async () => ({ registered: true }) as never)
    const { statuses, stop } = watching(chain.engine)

    await flush()
    chain.player(undefined)
    await flush()

    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "registration", registered: true, offerRegister: false })
    stop()
  })

  it("reconciles a landed registration on the next chain tick when the watch stays silent", async () => {
    const chain = fakeEngine()
    let landed = false
    const player = vi.fn<GameEngine["player"]>(async () => (landed ? ({ registered: true } as never) : undefined))
    chain.engine.player = player
    const { statuses, stop } = watching(chain.engine)

    await flush()
    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "registration", registered: false })
    landed = true
    chain.now(NOW + 6, 1)
    await flush()

    expect(player).toHaveBeenCalledTimes(2)
    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "registration", registered: true, offerRegister: false })
    stop()
  })

  it("reconciles a landed registration when the same page returns to the foreground", async () => {
    const chain = fakeEngine()
    let landed = false
    chain.engine.player = vi.fn(async () => (landed ? ({ registered: true } as never) : undefined))
    const { statuses, stop } = watching(chain.engine)

    await flush()
    landed = true
    reportPageActivity(false, true)
    await flush()

    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "registration", registered: true, offerRegister: false })
    stop()
  })

  it("does not carry a late positive read from the previous game into the next slot", async () => {
    const chain = fakeEngine()
    const oldGameRead = deferred<Awaited<ReturnType<GameEngine["player"]>>>()
    chain.engine.player = vi.fn<GameEngine["player"]>().mockReturnValueOnce(oldGameRead.promise).mockResolvedValue(undefined)
    const { statuses, stop } = watching(chain.engine)

    await flush()
    const nextGame = { ...GAME, index: GAME.index + 1 }
    chain.engine.game = async () => nextGame
    chain.game(nextGame)
    oldGameRead.resolve({ registered: true })
    await flush()

    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "registration", registered: false, offerRegister: true })
    stop()
  })
})

// redherring.07, game 270 (22 Oct): the alarm opened the app 28 s before the
// start, and the home said "You missed this one" until the player read landed.
describe("a registered player opening the app just before the game (#1108)", () => {
  const SOON: PalletGame = {
    ...GAME,
    state: { type: "Reporting", value: { player_count: 6 } },
    registration_ends: NOW - 60,
    shuffle_deadline: NOW - 30,
    game_date: NOW + 28,
    report_ends: NOW + 328,
  }
  const last = (statuses: GameStatus[]) => statuses[statuses.length - 1]
  const missed = (statuses: GameStatus[]) =>
    statuses.some((status) => (status.kind === "starting" || status.kind === "live") && !status.registered)

  it("stays on loading until the player read answers, then opens the waiting room", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => SOON
    const read = deferred<Awaited<ReturnType<GameEngine["player"]>>>()
    chain.engine.player = () => read.promise
    const { statuses, stop } = watching(chain.engine)

    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(last(statuses)?.kind).toBe("loading")

    read.resolve({ registered: true } as never)
    await flush()

    expect(missed(statuses)).toBe(false)
    expect(last(statuses)).toMatchObject({ kind: "waiting", gameAt: SOON.game_date })
    stop()
  })

  it("says the game started without the player only once the chain answers no", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => SOON
    const read = deferred<Awaited<ReturnType<GameEngine["player"]>>>()
    chain.engine.player = () => read.promise
    const { statuses, stop } = watching(chain.engine)

    await flush()
    expect(missed(statuses)).toBe(false)

    read.resolve(undefined)
    await flush()

    expect(last(statuses)).toMatchObject({ kind: "starting", registered: false })
    stop()
  })

  it("asks again on the wall clock when the read hangs and no block ticks (#530)", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => SOON
    const player = vi
      .fn<GameEngine["player"]>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue({ registered: true } as never)
    chain.engine.player = player
    const { statuses, stop } = watching(chain.engine)

    await flush()
    expect(last(statuses)?.kind).toBe("loading")
    await vi.advanceTimersByTimeAsync(11_000)

    expect(player).toHaveBeenCalledTimes(2)
    expect(missed(statuses)).toBe(false)
    expect(last(statuses)).toMatchObject({ kind: "waiting" })
    stop()
  })

  it("keeps none on screen while a game appearing over it waits for the player read", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => undefined
    const read = deferred<Awaited<ReturnType<GameEngine["player"]>>>()
    chain.engine.player = () => read.promise
    const { statuses, stop } = watching(chain.engine)
    await flush()
    expect(last(statuses)?.kind).toBe("none")
    const before = statuses.length

    chain.engine.game = async () => SOON
    chain.game(SOON)
    await flush()
    expect(statuses.slice(before).map((status) => status.kind)).toEqual(
      expect.not.arrayContaining(["loading", "starting"]),
    )
    expect(last(statuses)?.kind).toBe("none")

    read.resolve({ registered: true } as never)
    await flush()
    expect(last(statuses)).toMatchObject({ kind: "waiting", gameAt: SOON.game_date })
    stop()
  })

  it("stops holding none once the player read times out, and still lands the answer", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => undefined
    // an empty slot asks nothing about the player: the first read is the game's
    const player = vi
      .fn<GameEngine["player"]>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue({ registered: true } as never)
    chain.engine.player = player
    const { statuses, stop } = watching(chain.engine)
    await flush()
    expect(last(statuses)?.kind).toBe("none")
    const before = statuses.length

    chain.engine.game = async () => SOON
    chain.game(SOON)
    await flush()
    expect(last(statuses)?.kind).toBe("none")

    await vi.advanceTimersByTimeAsync(10_000)
    await flush()

    const after = statuses.slice(before).map((status) => status.kind)
    expect(after.indexOf("loading")).toBeGreaterThan(-1)
    expect(after.lastIndexOf("none")).toBeLessThan(after.indexOf("loading"))
    expect(player).toHaveBeenCalledTimes(2)
    expect(missed(statuses)).toBe(false)
    expect(last(statuses)).toMatchObject({ kind: "waiting", gameAt: SOON.game_date })
    stop()
  })

  it("stops holding none once the player read fails, and lands the answer on the retry", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => undefined
    const player = vi
      .fn<GameEngine["player"]>()
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValue({ registered: true } as never)
    chain.engine.player = player
    const { statuses, stop } = watching(chain.engine)
    await flush()
    expect(last(statuses)?.kind).toBe("none")

    chain.engine.game = async () => SOON
    chain.game(SOON)
    await flush()
    expect(player).toHaveBeenCalledTimes(1)
    expect(last(statuses)?.kind).toBe("loading")

    await vi.advanceTimersByTimeAsync(3_000)
    expect(player).toHaveBeenCalledTimes(2)
    expect(missed(statuses)).toBe(false)
    expect(last(statuses)).toMatchObject({ kind: "waiting", gameAt: SOON.game_date })
    stop()
  })

  it("ignores a read that fails after the watch has answered", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => SOON
    const read = deferred<Awaited<ReturnType<GameEngine["player"]>>>()
    chain.engine.player = () => read.promise
    const { statuses, stop } = watching(chain.engine)
    await flush()
    expect(last(statuses)?.kind).toBe("loading")

    chain.player({ registered: true })
    await flush()
    expect(last(statuses)?.kind).toBe("waiting")
    const answered = statuses.length

    read.reject(new Error("rpc down"))
    await flush()

    expect(statuses.slice(answered).map((status) => status.kind)).not.toContain("loading")
    expect(last(statuses)?.kind).toBe("waiting")
    stop()
  })

  it("ignores a read for the previous game that fails after the slot moved on", async () => {
    const NEXT: PalletGame = { ...SOON, index: SOON.index + 1, game_date: NOW + 40 }
    const chain = fakeEngine()
    chain.engine.game = async () => undefined
    const oldRead = deferred<Awaited<ReturnType<GameEngine["player"]>>>()
    const player = vi
      .fn<GameEngine["player"]>()
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValue({ registered: true } as never)
    chain.engine.player = player
    const { statuses, stop } = watching(chain.engine)
    await flush()
    const before = statuses.length

    chain.engine.game = async () => SOON
    chain.game(SOON)
    await flush()
    chain.engine.game = async () => NEXT
    chain.game(NEXT)
    await flush()
    expect(last(statuses)?.kind).toBe("none")

    oldRead.reject(new Error("rpc down"))
    await flush()

    // the old game's failure neither ends the next game's hold nor answers it
    expect(statuses.slice(before).map((status) => status.kind)).not.toContain("loading")
    expect(player).toHaveBeenCalledTimes(2)
    expect(last(statuses)).toMatchObject({ kind: "waiting", gameAt: NEXT.game_date })
    stop()
  })

  it("does not emit again when the read fails a second time", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => SOON
    const player = vi.fn<GameEngine["player"]>().mockRejectedValue(new Error("rpc down"))
    chain.engine.player = player
    const { statuses, stop } = watching(chain.engine)
    await flush()
    expect(player).toHaveBeenCalledTimes(1)
    expect(last(statuses)?.kind).toBe("loading")
    const afterFirst = statuses.length

    chain.now(NOW + 6, 1) // a block: the tick reads the player again
    await flush()

    expect(player.mock.calls.length).toBeGreaterThan(1)
    expect(statuses.length).toBe(afterFirst)

    player.mockResolvedValue({ registered: true } as never)
    chain.now(NOW + 12, 2)
    await flush()
    expect(last(statuses)).toMatchObject({ kind: "waiting", gameAt: SOON.game_date })
    stop()
  })

  it("lets a broadcast sign-up answer before the read", async () => {
    const chain = fakeEngine()
    const read = deferred<Awaited<ReturnType<GameEngine["player"]>>>()
    chain.engine.player = () => read.promise
    chain.engine.seat = seatsOf(facts(["AlreadyPlaying"]))
    liteKey.mockRejectedValue(new Error("no lite ring"))
    chain.engine.register = vi.fn<GameEngine["register"]>(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      return new Promise(() => {})
    })
    const first = watching(chain.engine)
    chain.game()
    read.resolve(undefined)
    await flush()
    await first.source.register!()
    await flush()
    first.stop()

    // a second home mounts while the chain has not answered the new read yet
    const held = deferred<Awaited<ReturnType<GameEngine["player"]>>>()
    chain.engine.player = () => held.promise
    const second: GameStatus[] = []
    const stopSecond = first.source.watchStatus((status) => second.push(status))
    chain.game()
    await flush()

    expect(last(second)).toMatchObject({ kind: "registration", registered: true })
    stopSecond()
  })
})

// The home page subscribes to watchStatus again whenever it mounts. A subscriber
// that starts between the broadcast and the block must still see the player
// registered, or the Register button comes back.
describe("broadcast sign-up on a home screen that mounts again works", () => {
  function chainWithSignupInFlight() {
    const chain = fakeEngine()
    chain.engine.seat = seatsOf(facts(["AlreadyPlaying"]))
    liteKey.mockRejectedValue(new Error("no lite ring"))
    chain.engine.register = vi.fn<GameEngine["register"]>(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      return new Promise(() => {})
    })
    return chain
  }

  function lastRegistered(statuses: GameStatus[]): boolean | undefined {
    const last = statuses[statuses.length - 1]
    return last?.kind === "registration" ? last.registered : undefined
  }

  async function mountWithTheGame() {
    const chain = chainWithSignupInFlight()
    const mount = watching(chain.engine)
    chain.game()
    await flush()
    return { chain, ...mount }
  }

  async function registerOnFirstMount() {
    const mount = await mountWithTheGame()
    await mount.source.register!()
    await flush()
    return mount
  }

  it("shows the player registered on the open watcher once the sign-up is broadcast", async () => {
    // Given
    const { source, statuses, stop } = await mountWithTheGame()
    const beforeSignUp = lastRegistered(statuses)

    // When
    await source.register!()
    await flush()

    // Then
    expect(beforeSignUp).toBe(false)
    expect(lastRegistered(statuses)).toBe(true)
    stop()
  })

  it("keeps the player registered for a status watcher that starts before the sign-up lands (#250)", async () => {
    // Given
    const { chain, source, stop } = await registerOnFirstMount()

    // When
    stop()
    const secondMount: GameStatus[] = []
    const stopSecond = source.watchStatus((status) => secondMount.push(status))
    chain.game()
    await flush()

    // Then
    expect(lastRegistered(secondMount)).toBe(true)
    stopSecond()
  })

  it("drops the optimism once the chain moves on to the next game", async () => {
    // Given
    const { chain, statuses, stop } = await registerOnFirstMount()

    // When
    const nextGame = { ...GAME, index: GAME.index + 1 }
    chain.engine.game = async () => nextGame
    chain.game(nextGame)
    await flush()

    // Then
    expect(lastRegistered(statuses)).toBe(false)
    stop()
  })
})

describe("a sign-up the chat has on its way shows on the home (issue 694)", () => {
  function last(statuses: GameStatus[]): GameStatus | undefined {
    return statuses[statuses.length - 1]
  }

  async function mountWithTheGame() {
    const chain = fakeEngine()
    chain.engine.seat = seatsOf(facts(["AlreadyPlaying"]))
    liteKey.mockRejectedValue(new Error("no lite ring"))
    const mount = watching(chain.engine)
    chain.game()
    await flush()
    return { chain, ...mount }
  }

  it("shows Registering while the chat signs the player up for this game", async () => {
    // Given
    chatStore.stored = { gameIndex: GAME.index, phase: "registering", surface: "chat", at: Date.now(), attempt: 1 }

    // When
    const { statuses, stop } = await mountWithTheGame()

    // Then
    expect(last(statuses)).toMatchObject({ kind: "registration", registered: false, signup: "chat" })
    stop()
  })

  it("shows the player registered once the sign-up of the chat is on the wire", async () => {
    // Given
    const { chain, statuses, stop } = await mountWithTheGame()
    expect(last(statuses)).toMatchObject({ kind: "registration", registered: false, signup: "idle" })

    // When
    chatStore.stored = { gameIndex: GAME.index, phase: "sent", surface: "chat", at: Date.now(), attempt: 1 }
    chain.now(NOW + 100)
    await flush()

    // Then
    expect(last(statuses)).toMatchObject({ kind: "registration", registered: true, offerRegister: false })
    stop()
  })

  it("picks the sign-up up when the player comes back to the page from the chat", async () => {
    // Given
    const { statuses, stop } = await mountWithTheGame()

    // When
    chatStore.stored = { gameIndex: GAME.index, phase: "registering", surface: "chat", at: Date.now(), attempt: 1 }
    reportPageActivity(true)
    reportPageActivity(false)
    await flush()

    // Then
    expect(last(statuses)).toMatchObject({ kind: "registration", signup: "chat" })
    stop()
  })

  it("offers Register again once the chat clears its sign-up", async () => {
    // Given
    chatStore.stored = { gameIndex: GAME.index, phase: "registering", surface: "chat", at: Date.now(), attempt: 1 }
    const { chain, statuses, stop } = await mountWithTheGame()

    // When
    chatStore.stored = null
    chain.now(NOW + 100)
    await flush()

    // Then
    expect(last(statuses)).toMatchObject({ kind: "registration", registered: false, signup: "idle" })
    stop()
  })

  it("starts no sign-up of its own while the chat signs the player up for this game", async () => {
    // Given
    chatStore.stored = { gameIndex: GAME.index, phase: "registering", surface: "chat", at: Date.now(), attempt: 1 }
    const { chain, source, stop } = await mountWithTheGame()
    vi.mocked(chain.engine.register).mockImplementation(() => new Promise(() => {}))

    // When
    void source.register!()
    await vi.advanceTimersByTimeAsync(5_000)

    // Then
    expect(chain.engine.register).not.toHaveBeenCalled()
    stop()
  })

  it("still signs up while the chat signs the player up for another game", async () => {
    // Given
    chatStore.stored = { gameIndex: GAME.index + 1, phase: "registering", surface: "chat", at: Date.now(), attempt: 1 }
    const { chain, source, stop } = await mountWithTheGame()
    vi.mocked(chain.engine.register).mockImplementation(() => new Promise(() => {}))

    // When
    void source.register!().catch(() => {})

    // Then
    await vi.waitFor(() => expect(chain.engine.register).toHaveBeenCalledTimes(1))
    source.cancelRegister!()
    stop()
  })

  it("logs the sign-up of the chat when it changes, not on every block", async () => {
    // Given
    clearDevLog()
    chatStore.stored = { gameIndex: GAME.index, phase: "registering", surface: "chat", at: Date.now(), attempt: 1 }
    const { chain, stop } = await mountWithTheGame()

    // When
    chain.now(NOW + 6)
    await flush()
    chain.now(NOW + 12)
    await flush()

    // Then
    expect(getDevLogEntries().filter((entry) => entry.message === "sign-up from the chat registering")).toHaveLength(1)
    stop()
  })

  it("reads the record of the chat one read at a time", async () => {
    // Given
    const { chain, stop } = await mountWithTheGame()
    const held = deferred<null>()
    vi.mocked(readGameRegistration).mockClear().mockReturnValueOnce(held.promise)
    chain.now(NOW + 6)
    await flush()

    // When
    chain.now(NOW + 12)
    await flush()
    const whileHeld = vi.mocked(readGameRegistration).mock.calls.length
    held.resolve(null)
    await flush()
    chain.now(NOW + 18)
    await flush()

    // Then
    expect(whileHeld).toBe(1)
    expect(readGameRegistration).toHaveBeenCalledTimes(2)
    stop()
  })

  it("shows the sign-up of the app over the one of the chat", async () => {
    // Given
    const { chain, source, statuses, stop } = await mountWithTheGame()
    vi.mocked(chain.engine.register).mockImplementation(() => new Promise(() => {}))
    void source.register!().catch(() => {})
    await flush()
    expect(last(statuses)).toMatchObject({ kind: "registration", signup: "sending" })

    // When
    chatStore.stored = { gameIndex: GAME.index, phase: "registering", surface: "chat", at: Date.now(), attempt: 1 }
    chain.now(NOW + 100)
    await flush()

    // Then
    expect(last(statuses)).toMatchObject({ kind: "registration", signup: "sending" })
    source.cancelRegister!()
    stop()
  })

  it("records its own sign-up registering from the tap, sent from the broadcast and registered once it lands (#1316)", async () => {
    // Given
    const { chain, source, stop } = await mountWithTheGame()
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      return { ok: true }
    })

    // When
    await source.register!()
    await flush()

    // Then
    const attempt = (chatStore.writes[0] as { attempt: number }).attempt
    expect(chatStore.writes).toEqual([
      { gameIndex: GAME.index, phase: "registering", surface: "app", at: expect.any(Number), attempt },
      { gameIndex: GAME.index, phase: "sent", surface: "app", at: expect.any(Number), attempt },
      { gameIndex: GAME.index, phase: "registered", surface: "app", at: expect.any(Number), attempt },
    ])
    stop()
  })

  it("records its own sign-up failed when the player refuses the signing", async () => {
    // Given
    const { chain, source, stop } = await mountWithTheGame()
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      return { ok: false, error: "Transaction signing was rejected." }
    })

    // When
    await source.register!().catch(() => {})
    await flush()

    // Then
    expect(chatStore.writes).toEqual([
      expect.objectContaining({ gameIndex: GAME.index, phase: "registering", surface: "app" }),
      expect.objectContaining({ gameIndex: GAME.index, phase: "failed", surface: "app", reason: "refused" }),
    ])
    stop()
  })

  it("clears its own record when the page leaves before anything went out", async () => {
    // Given
    const { chain, source, stop } = await mountWithTheGame()
    vi.mocked(chain.engine.register).mockImplementation(() => new Promise(() => {}))
    void source.register!().catch(() => {})
    await vi.waitFor(() => expect(chain.engine.register).toHaveBeenCalledTimes(1))

    // When
    source.cancelRegister!()
    await flush()

    // Then
    expect(chatStore.writes).toEqual([expect.objectContaining({ phase: "registering", surface: "app" }), null])
    stop()
  })

  it("shows the player registered once the sign-up of the chat landed, before the chain read says so", async () => {
    // Given
    const { chain, statuses, stop } = await mountWithTheGame()

    // When
    chatStore.stored = { gameIndex: GAME.index, phase: "registered", surface: "chat", at: Date.now(), attempt: 1 }
    chain.now(NOW + 100)
    await flush()

    // Then
    expect(last(statuses)).toMatchObject({ kind: "registration", registered: true, offerRegister: false })
    stop()
  })

  it("offers Register when the sign-up of the chat failed, and when the app's own record is the one on its way", async () => {
    // Given
    const { chain, statuses, stop } = await mountWithTheGame()

    // When
    chatStore.stored = { gameIndex: GAME.index, phase: "failed", surface: "chat", at: Date.now(), attempt: 1, reason: "register" }
    chain.now(NOW + 100)
    await flush()
    // Then
    expect(last(statuses)).toMatchObject({ kind: "registration", registered: false, signup: "idle" })

    // When: a record of an app sign-up a stopped page left is nobody's to show
    chatStore.stored = { gameIndex: GAME.index, phase: "registering", surface: "app", at: Date.now(), attempt: 2 }
    chain.now(NOW + 106)
    await flush()
    // Then
    expect(last(statuses)).toMatchObject({ kind: "registration", registered: false, signup: "idle" })
    stop()
  })

  it.each([
    ["another game", { gameIndex: GAME.index + 1, phase: "registering", surface: "chat", at: NOW * 1000, attempt: 1 }],
    ["a stale record", { gameIndex: GAME.index, phase: "registering", surface: "chat", at: NOW * 1000 - REGISTERING_TTL_MS - 1, attempt: 1 }],
    ["a sent record past the watch of the chat", { gameIndex: GAME.index, phase: "sent", surface: "chat", at: NOW * 1000 - SENT_TTL_MS - 1, attempt: 1 }],
  ])("ignores a sign-up of %s", async (_case, record) => {
    // Given
    chatStore.stored = record

    // When
    const { statuses, stop } = await mountWithTheGame()

    // Then
    expect(last(statuses)).toMatchObject({ kind: "registration", registered: false, signup: "idle" })
    stop()
  })
})

describe("statusGate: not read is not empty (#289)", () => {
  it("is loading until the game slot has been answered", () => {
    expect(statusGate(NOT_READ, NOT_READ, false, NOW)).toBeNull()
    expect(statusGate(NOT_READ, undefined, false, NOW)).toBeNull()
    expect(statusGate(NOT_READ, NOW, true, NOW)).toBeNull()
  })
  it("is loading on an empty slot until the schedule queue has been answered", () => {
    expect(statusGate(undefined, NOT_READ, false, NOW)).toBeNull()
    expect(statusGate(undefined, undefined, false, NOW)).toEqual({ game: undefined, nextScheduleAt: undefined, registered: false })
    expect(statusGate(undefined, NOW, false, NOW)).toEqual({ game: undefined, nextScheduleAt: NOW, registered: false })
  })
  it("derives at once from a game, whatever the queue", () => {
    expect(statusGate(GAME, NOT_READ, false, NOW)).toEqual({ game: GAME, nextScheduleAt: undefined, registered: false })
    expect(statusGate(GAME, NOW, true, NOW)).toEqual({ game: GAME, nextScheduleAt: NOW, registered: true })
  })
  it("is loading on a game until the player's registration has been answered (#1108)", () => {
    expect(statusGate(GAME, NOW, NOT_READ, NOW)).toBeNull()
  })
  it("does not wait on the player's registration for an empty slot", () => {
    expect(statusGate(undefined, NOW, NOT_READ, NOW)).toEqual({ game: undefined, nextScheduleAt: NOW, registered: false })
  })
  // two rounds of six 12 s turns and the 7 s gap between them: 151 s of play
  const OVER: PalletGame = { ...GAME, state: { type: "Reporting", value: { player_count: 6 } }, game_date: NOW - 151 }
  it("waits on the queue, not on the player, for a game past its last turn (#1418)", () => {
    expect(statusGate(OVER, NOT_READ, true, NOW)).toBeNull()
    expect(statusGate(OVER, NOW + 600, NOT_READ, NOW)).toEqual({ game: OVER, nextScheduleAt: NOW + 600, registered: false })
  })
})

describe("heldStatus: what stays on screen while the gate waits (#1108)", () => {
  it("keeps an answer about no game", () => {
    expect(heldStatus({ kind: "none" }, false)).toEqual({ kind: "none" })
    const scheduled: GameStatus = { kind: "scheduled", gameAt: NOW + 600, registrationAt: NOW, withinHour: true }
    expect(heldStatus(scheduled, false)).toBe(scheduled)
  })
  it("drops anything about a game back to loading", () => {
    expect(heldStatus({ kind: "starting", gameAt: NOW + 28, registered: false, withinHour: true }, false)).toEqual({ kind: "loading" })
    expect(heldStatus({ kind: "waiting", gameAt: NOW + 28 }, false)).toEqual({ kind: "loading" })
    expect(heldStatus({ kind: "processing" }, false)).toEqual({ kind: "loading" })
  })
  it("ends the hold once the read it waits on has failed", () => {
    expect(heldStatus({ kind: "none" }, true)).toEqual({ kind: "loading" })
  })
})

describe("acceptFallbackGame: a read beside the watch (#289)", () => {
  it("never lands once the watch has spoken since the read began", () => {
    expect(acceptFallbackGame(GAME, false, undefined)).toBe(false)
    expect(acceptFallbackGame(undefined, false, undefined)).toBe(false)
  })
  it("lands a game only when it is newer than any seen", () => {
    expect(acceptFallbackGame(GAME, true, undefined)).toBe(true)
    expect(acceptFallbackGame(GAME, true, GAME.index - 1)).toBe(true)
    expect(acceptFallbackGame(GAME, true, GAME.index)).toBe(false)
    expect(acceptFallbackGame(GAME, true, GAME.index + 1)).toBe(false)
  })
  it("lands an empty slot: that is an answer too", () => {
    expect(acceptFallbackGame(undefined, true, undefined)).toBe(true)
    expect(acceptFallbackGame(undefined, true, GAME.index)).toBe(true)
  })
})

describe("who is remembered", () => {
  it("re-resolves a null personhood on the next seat read, and keeps a person once found", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValueOnce(null).mockResolvedValue(PERSON)
    const { lastSeat, stop } = watching(chain.engine)

    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(liteKey).toHaveBeenCalledTimes(1)
    expect(lastSeat()).toEqual({ path: "unfunded", ready: true })

    // the key was registered meanwhile: the next read asks again
    chain.player(undefined)
    await flush()
    chain.seatReads[1].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(liteKey).toHaveBeenCalledTimes(2)
    expect(lastSeat()).toEqual({ path: "free", ready: false })

    // and once a person, never asked again
    chain.player(undefined)
    await flush()
    expect(liteKey).toHaveBeenCalledTimes(2)
    stop()
  })

  it("re-resolves after the lite-key lookup failed to read", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockRejectedValueOnce(new Error("node mid-restart")).mockResolvedValue(PERSON)
    const { lastSeat, stop } = watching(chain.engine)

    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(lastSeat()?.path).toBe("unfunded")

    chain.player(undefined)
    await flush()
    chain.seatReads[1].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(liteKey).toHaveBeenCalledTimes(2)
    expect(lastSeat()?.path).toBe("free")
    stop()
  })
})

describe("a lite-key lookup the host never answers (#578)", () => {
  // found by a model check: one dropped listRingVrfKeys answer held every
  // later seat read and the bind for the life of the page
  it("gives the lookup up, forgets it, and asks the host again on the next seat read", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey)
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(PERSON)
    const { lastSeat, stop } = watching(chain.engine)

    chain.game()
    await flush()
    expect(liteKey).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50_000) // the lookup is given up for a fresh one
    // a seat input moves: the next read asks the host again
    chain.player(undefined)
    await flush()
    expect(liteKey).toHaveBeenCalledTimes(2)
    chain.seatReads[chain.seatReads.length - 1].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(lastSeat()).toEqual({ path: "free", ready: false })
    expect(chain.bind).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe("the bind's deadline and ladder", () => {
  it("aborts an attempt at the deadline and tries again on the ladder", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    // a host channel that went quiet: the bind settles only when aborted
    chain.bind.mockImplementation(
      (_capabilities, options) =>
        new Promise<BindResult>((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason))
        }),
    )
    const { lastSeat, stop } = watching(chain.engine)

    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(chain.bind).toHaveBeenCalledTimes(1)
    expect(chain.bind.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)

    await vi.advanceTimersByTimeAsync(BIND_TIMEOUT_MS - 1)
    expect(chain.bind.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(chain.bind.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await flush()
    // the failure re-reads the seat; the seat still wants a bind, on the ladder
    expect(chain.seatReads).toHaveLength(2)
    chain.seatReads[1].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(chain.bind).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(BIND_RETRY_MS[0])
    chain.seatReads[2].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(chain.bind).toHaveBeenCalledTimes(2)
    expect(lastSeat()).toEqual({ path: "free", ready: false })
    stop()
  })

  it("retries a refusal the chain may not repeat", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    chain.bind.mockResolvedValueOnce(refused("rejected", "CallBlockOutOfRange")).mockResolvedValue(BOUND)
    const { lastSeat, stop } = watching(chain.engine)

    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(chain.bind).toHaveBeenCalledTimes(1)
    chain.seatReads[1].resolve(facts(["AliasNotBound"]))
    await vi.advanceTimersByTimeAsync(BIND_RETRY_MS[0])
    chain.seatReads[2].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(chain.bind).toHaveBeenCalledTimes(2)
    // the second attempt landed: the read it triggered carries `bound`
    chain.seatReads[3].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(lastSeat()).toEqual({ path: "free", ready: true })
    stop()
  })

  it("waits for a fresh follow and retries a not-pinned bind once", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    chain.bind.mockRejectedValueOnce(new Error("BlockNotPinnedError: stop-call")).mockResolvedValue(BOUND)
    const { lastSeat, stop } = watching(chain.engine)

    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(chain.engine.waitUntilFollowing).toHaveBeenCalledTimes(1)
    expect(chain.bind).toHaveBeenCalledTimes(2)
    // the landed retry's own re-read
    await vi.waitFor(() => expect(chain.seatReads).toHaveLength(2))
    chain.seatReads[1].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(lastSeat()).toEqual({ path: "free", ready: true })
    expect(recorded.metrics).toContainEqual(expect.objectContaining({
      name: "chain.retries",
      value: 1,
      attrs: expect.objectContaining({
        "chain.retry_reason": "block-not-pinned",
        "chain.retry_operation": "person-bind",
        "chain.retry_succeeded": "true",
      }),
    }))
    stop()
  })
})

describe("a refusal for good", () => {
  it.each([
    ["the person's free seat is on another account", refused("pinned-elsewhere", "AnotherAccountInvited", OTHER)],
    ["the account carries another binding", refused("rejected", "AccountInUse")],
  ])("%s: no retry, and the seat falls to the deposit route", async (_name, refusal) => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    chain.bind.mockResolvedValue(refusal)
    const { lastSeat, stop } = watching(chain.engine)

    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(chain.bind).toHaveBeenCalledTimes(1)
    // the failure's own re-read: the person no longer counts
    chain.seatReads[1].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(lastSeat()).toEqual({ path: "unfunded", ready: true })

    // no rung of the ladder, and no later seat read, asks again
    await vi.advanceTimersByTimeAsync(BIND_RETRY_MS[BIND_RETRY_MS.length - 1] * 2)
    chain.player(undefined)
    await flush()
    chain.seatReads[2].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(chain.bind).toHaveBeenCalledTimes(1)
    expect(lastSeat()).toEqual({ path: "unfunded", ready: true })
    stop()
  })
})

describe("overlapping seat reads", () => {
  it("drops a read begun before the bind landed when a newer one has been applied", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    const bind = deferred<BindResult>()
    chain.bind.mockReturnValue(bind.promise)
    const { lastSeat, stop } = watching(chain.engine)

    // read 0: unbound → preparing, and the bind starts
    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(lastSeat()).toEqual({ path: "free", ready: false })
    expect(chain.bind).toHaveBeenCalledTimes(1)

    // read 1 starts BEFORE the bind lands (a player-record tick) and hangs
    chain.player(undefined)
    await flush()
    expect(chain.seatReads).toHaveLength(2)

    // the bind lands: read 2 starts, carrying `bound`, and arrives first
    bind.resolve(BOUND)
    await flush()
    expect(chain.seatReads).toHaveLength(3)
    chain.seatReads[2].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(lastSeat()).toEqual({ path: "free", ready: true })

    // the stale read 1 arrives last and must not put "preparing" back
    chain.seatReads[1].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(lastSeat()).toEqual({ path: "free", ready: true })
    stop()
  })
})

describe("the game clock", () => {
  const replayAnchors = () => getDevLogEntries()
    .filter(({ tag, message }) => tag === "replay" && message === "clock-anchor")
    .map(({ data }) => (data as { observation: Record<string, unknown> }).observation)
  const clockLines = (message: string) =>
    getDevLogEntries().filter((entry) => entry.tag === "clock" && entry.message === message).map(({ data }) => data)

  it("captures the injected source device clock and supplied block, ignoring duplicate timestamps", async () => {
    clearDevLog()
    const chain = fakeEngine()
    const sourceDeviceMs = NOW * 1000 + 1234
    makeSource("host", chain.engine, { deviceClock: { nowMs: () => sourceDeviceMs, stepMs: () => 0 } })
    await flush()
    expect(replayAnchors()[0]).toMatchObject({
      engine: "chain",
      block: null,
      chainMs: NOW * 1000,
      receipt: { deviceMs: sourceDeviceMs },
      first: true,
      gapMs: 1234,
      beforeOffsetMs: 0,
      afterOffsetMs: 0,
      decision: "held",
      reason: "chain-first-value",
      rules: { version: 3, offsetUnit: "millisecond", deliveryLatency: "unknown", alignmentUncertainty: "not-measured" },
    })
    const count = replayAnchors().length
    chain.now(NOW)
    chain.clockAnchorAt(0, NOW - 1, 55)
    expect(replayAnchors()).toHaveLength(count)
    chain.clockAnchorAt(0, NOW + 6, 56)
    expect(replayAnchors().at(-1)).toMatchObject({
      block: 56,
      chainMs: (NOW + 6) * 1000,
      receipt: { deviceMs: sourceDeviceMs },
      first: false,
      reason: "chain-first-change",
      decision: "held",
    })
  })
  /** A source whose device clock reads `at` (chain seconds) and whose first chain value is
   *  `chainAt`. `block` sends a new chain value `elapsed` device seconds later. */
  async function clock({ at = NOW, chainAt = at }: { at?: number; chainAt?: number } = {}) {
    vi.setSystemTime(at * 1000)
    resetDeviceClockForTests()
    const chain = fakeEngine()
    let tick: ((seconds: number, block?: number) => void) | undefined
    chain.engine.watchNow = (cb) => {
      tick = cb
      cb(chainAt)
      return () => {}
    }
    const source = makeSource("host", chain.engine)
    await flush()
    let device = at
    const pass = (seconds: number) => {
      vi.advanceTimersByTime(seconds * 1000)
      device += seconds
    }
    /** a new chain value `gap` seconds behind this device's time */
    const block = (gap: number, elapsed = 6) => {
      pass(elapsed)
      tick?.(device - gap)
    }
    const offset = () => source.nowSeconds() - device
    const mesh = source.meshClock!
    return { chain, source, mesh, pass, block, offset, device: () => device }
  }
  it("resubscribes the clock watch one second after its subscription fails (#869)", async () => {
    clearDevLog()
    const chain = fakeEngine()
    const source = makeSource("host", chain.engine)
    await flush()
    expect(chain.clockWatchCount()).toBe(1)

    chain.clockError(new Error("HostFailure: remote_chain_head_storage"))
    vi.advanceTimersByTime(999)
    expect(chain.clockWatchCount()).toBe(1)
    vi.advanceTimersByTime(1)
    expect(chain.clockWatchCount()).toBe(2)

    vi.advanceTimersByTime(6_000)
    chain.now(NOW + 7)
    expect(source.nowSeconds()).toBe(NOW + 7)
    expect(getDevLogEntries()).toContainEqual(expect.objectContaining({
      tag: "clock",
      level: "warn",
      message: "chain clock subscription failed; resubscribing",
    }))
    expect(getDevLogEntries()).toContainEqual(expect.objectContaining({
      tag: "clock",
      message: "chain clock subscription recovered",
    }))
  })

  it("backs repeated synchronous watch throws off and throttles their warning (#869)", async () => {
    clearDevLog()
    const chain = fakeEngine()
    const watchNow = vi.fn(() => {
      throw new Error("HostFailure: remote_chain_head_storage")
    })
    chain.engine.watchNow = watchNow
    makeSource("host", chain.engine)
    await flush()

    expect(watchNow).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_000)
    expect(watchNow).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1_999)
    expect(watchNow).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    expect(watchNow).toHaveBeenCalledTimes(3)
    expect(getDevLogEntries().filter(({ message }) => message === "chain clock subscription failed; resubscribing")).toHaveLength(1)
  })

  it("recovers when watchNow reports an error synchronously before returning (#869)", async () => {
    const chain = fakeEngine()
    const stops = [vi.fn(), vi.fn()]
    const watchNow = vi.fn((_cb: (seconds: number, block?: number) => void, onError?: (error: unknown) => void) => {
      const attempt = watchNow.mock.calls.length
      if (attempt === 1) onError?.(new Error("synchronous watch failure"))
      return stops[attempt - 1] ?? vi.fn()
    })
    chain.engine.watchNow = watchNow
    makeSource("host", chain.engine)
    await flush()

    expect(stops[0]).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_000)
    expect(watchNow).toHaveBeenCalledTimes(2)
  })

  it("ignores callbacks from a failed watch generation after its replacement starts (#869)", async () => {
    const chain = fakeEngine()
    makeSource("host", chain.engine)
    await flush()
    expect(getClockSnapshot()?.chainSeconds).toBe(NOW)

    chain.clockErrorAt(0, new Error("first watch failed"))
    vi.advanceTimersByTime(1_000)
    expect(chain.clockWatchCount()).toBe(2)
    chain.clockAnchorAt(0, NOW + 100, 88)
    chain.clockErrorAt(0, new Error("late duplicate failure"))
    vi.advanceTimersByTime(2_000)

    expect(chain.clockWatchCount()).toBe(2)
    expect(getClockSnapshot()?.chainSeconds).toBe(NOW)
  })


  it("restarts a stale clock watch on return only after a healthy host probe (#869)", async () => {
    clearDevLog()
    const chain = fakeEngine()
    chain.engine.probeChainHealth = vi.fn(async () => {})
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    const stop = source.watchStatus(() => {})
    await flush()
    expect(chain.clockWatchCount()).toBe(1)

    vi.advanceTimersByTime(30_001)
    reportPageActivity(false)
    await flush()

    expect(chain.engine.probeChainHealth).toHaveBeenCalledTimes(1)
    expect(chain.clockWatchCount()).toBe(2)
    expect(getDevLogEntries()).toContainEqual(expect.objectContaining({
      tag: "clock",
      level: "warn",
      message: "stale clock watch; resubscribing",
    }))
    stop()
    vi.unstubAllGlobals()
  })

  it("keeps a stale clock watch when the host health probe is not healthy (#869)", async () => {
    clearDevLog()
    const chain = fakeEngine()
    chain.engine.probeChainHealth = vi.fn(async () => {
      throw new Error("HostFailure: remote_chain_head_storage")
    })
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    const stop = source.watchStatus(() => {})
    await flush()

    vi.advanceTimersByTime(30_001)
    reportPageActivity(false)
    await flush()

    expect(chain.engine.probeChainHealth).toHaveBeenCalledTimes(1)
    expect(chain.clockWatchCount()).toBe(1)
    stop()
    vi.unstubAllGlobals()
  })

  it("recovers a stale clock watch for a /game clock consumer without a status subscriber (#869)", async () => {
    const chain = fakeEngine()
    chain.engine.probeChainHealth = vi.fn(async () => {})
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    await flush()

    vi.advanceTimersByTime(30_001)
    source.clockState?.()
    await flush()

    expect(chain.engine.probeChainHealth).toHaveBeenCalledTimes(1)
    expect(chain.clockWatchCount()).toBe(2)
    vi.unstubAllGlobals()
  })

  it("recovers when a source constructed hidden goes straight to /game without a status subscriber (#869)", async () => {
    const chain = fakeEngine()
    chain.engine.probeChainHealth = vi.fn(async () => {})
    const document = Object.assign(new EventTarget(), { visibilityState: "hidden" })
    vi.stubGlobal("document", document)
    vi.stubGlobal("window", { location: { pathname: "/" } })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    await flush()

    document.visibilityState = "visible"
    window.location.pathname = "/game"
    vi.advanceTimersByTime(30_001)
    source.clockState?.()
    await flush()

    expect(chain.engine.probeChainHealth).toHaveBeenCalledTimes(1)
    expect(chain.clockWatchCount()).toBe(2)
    vi.unstubAllGlobals()
  })

  it("stops a /game clock consumer's unhealthy retry as soon as its route leaves (#869)", async () => {
    const chain = fakeEngine()
    chain.engine.probeChainHealth = vi.fn(async () => {
      throw new Error("HostFailure: remote_chain_head_storage")
    })
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    await flush()

    vi.advanceTimersByTime(30_001)
    source.clockState?.()
    await flush()
    expect(chain.engine.probeChainHealth).toHaveBeenCalledTimes(1)

    window.location.pathname = "/"
    source.clockState?.()
    vi.advanceTimersByTime(30_000)
    await flush()
    expect(chain.engine.probeChainHealth).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it("retries an unhealthy stale probe and recovers when the host becomes healthy (#869)", async () => {
    const chain = fakeEngine()
    chain.engine.probeChainHealth = vi.fn()
      .mockRejectedValueOnce(new Error("HostFailure: remote_chain_head_storage"))
      .mockResolvedValue(undefined)
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    const stop = source.watchStatus(() => {})
    await flush()

    vi.advanceTimersByTime(30_001)
    source.clockState?.()
    await flush()
    expect(chain.engine.probeChainHealth).toHaveBeenCalledTimes(1)
    expect(chain.clockWatchCount()).toBe(1)

    vi.advanceTimersByTime(1_000)
    await flush()
    expect(chain.engine.probeChainHealth).toHaveBeenCalledTimes(2)
    expect(chain.clockWatchCount()).toBe(2)
    stop()
    vi.unstubAllGlobals()
  })

  it.each([
    ["the page hides", (source: ReturnType<typeof makeSource>, stop: () => void) => {
      void source
      void stop
      reportPageActivity(true)
    }],
    ["the route leaves /game", (source: ReturnType<typeof makeSource>, stop: () => void) => {
      void stop
      window.location.pathname = "/"
      source.clockState?.()
    }],
    ["the status subscription tears down", (source: ReturnType<typeof makeSource>, stop: () => void) => {
      void source
      stop()
    }],
  ])("stops unhealthy stale-probe retries when %s (#869)", async (_label, leave) => {
    const chain = fakeEngine()
    chain.engine.probeChainHealth = vi.fn(async () => {
      throw new Error("HostFailure: remote_chain_head_storage")
    })
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    const stop = source.watchStatus(() => {})
    await flush()

    vi.advanceTimersByTime(30_001)
    source.clockState?.()
    await flush()
    expect(chain.engine.probeChainHealth).toHaveBeenCalledTimes(1)

    leave(source, stop)
    vi.advanceTimersByTime(30_000)
    await flush()
    expect(chain.engine.probeChainHealth).toHaveBeenCalledTimes(1)

    stop()
    vi.unstubAllGlobals()
  })

  it("measures staleness from the newer watch start instead of its older anchor (#869)", async () => {
    const chain = fakeEngine()
    chain.engine.probeChainHealth = vi.fn(async () => {})
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    const stop = source.watchStatus(() => {})
    await flush()

    vi.advanceTimersByTime(29_000)
    chain.clockError(new Error("watch failed near the stale boundary"))
    vi.advanceTimersByTime(1_000)
    vi.advanceTimersByTime(1_001)
    source.clockState?.()
    await flush()

    expect(chain.clockWatchCount()).toBe(2)
    expect(chain.engine.probeChainHealth).not.toHaveBeenCalled()
    stop()
    vi.unstubAllGlobals()
  })

  it("is ready before any chain value, with offset 0", async () => {
    clearDevLog()
    const silent = fakeEngine()
    silent.engine.watchNow = () => () => {}
    const waiting = makeSource("host", silent.engine)
    await flush()
    expect(waiting.clockState?.()).toEqual({ ready: true })
    expect(waiting.nowSeconds() - Math.floor(Date.now() / 1000)).toBe(0)
    expect(clockLines("clock chain check")).toEqual([])

    clearDevLog()
    const { source, offset } = await clock()
    expect(source.clockState?.()).toEqual({ ready: true })
    expect(offset()).toBe(0)
    expect(readChainClock()?.offset).toBe(0)
    expect(clockLines("clock chain check")).toEqual([{ check: "first-value", gapMs: 0 }])
    expect(clockLines("clock ready")).toEqual([{ late: false }])
    expect(clockLines("handover offset")).toEqual([{ game: GAME.index, offsetMs: 0, method: "none" }])
    expect(recorded.metrics).toContainEqual({
      type: "distribution", name: "clock.chain_gap_ms", value: 0, unit: "millisecond",
      attrs: { "clock.check": "first-value" },
    })
  })

  it("moves nothing for a 5-minute chain gap, and records the gap as device minus block", async () => {
    clearDevLog()
    const { offset, block } = await clock({ at: NOW + 300, chainAt: NOW })
    expect(offset()).toBe(0)
    expect(readChainClock()?.offset).toBe(0)
    expect(clockLines("clock chain check")).toEqual([{ check: "first-value", gapMs: 300_000 }])
    expect(recorded.metrics).toContainEqual({
      type: "distribution", name: "clock.chain_gap_ms", value: 300_000, unit: "millisecond",
      attrs: { "clock.check": "first-value" },
    })
    expect(readChainGapMs()).toBe(300_000) // the TURN proof stamps from it (#1397)
    block(-300)
    expect(offset()).toBe(0)
    expect(clockLines("clock chain check").at(-1)).toEqual({ check: "first-change", gapMs: -300_000 })
    expect(readChainGapMs()).toBe(-300_000) // the live block replaces the first value
    expect(clockLines("clock correction")).toEqual([])
    expect(clockLines("clock jumped")).toEqual([])
    expect(recorded.metrics.some((m) => m.name === "clock.correction_ms")).toBe(false)
  })

  it("writes one first-change check, and nothing after it", async () => {
    clearDevLog()
    const { offset, block } = await clock()
    // a value must be newer than the last one to count, so these wait long enough
    block(12, 20)
    expect(clockLines("clock chain check").at(-1)).toEqual({ check: "first-change", gapMs: 12_000 })
    block(-30)
    block(40, 80)
    expect(offset()).toBe(0)
    expect(clockLines("clock chain check")).toHaveLength(2)
  })

  it("applies the peer median before the game, and a later chain gap moves nothing", async () => {
    clearDevLog()
    const { offset, block, pass, mesh } = await clock()
    expect(mesh.wants()).toBe(true)
    mesh.offer("a", 8_000, 100)
    mesh.offer("b", 8_100, 100)
    expect(clockLines("clock peers").at(-1)).toEqual({ window: "pregame", peers: 2, result: "few" })
    mesh.offer("c", 7_900, 100)
    expect(clockLines("clock peers").at(-1)).toEqual({ window: "pregame", peers: 3, medianMs: 8_000, agree: 3, result: "held" })
    pass(2)
    mesh.offer("a", 8_000, 100)
    expect(clockLines("clock peers").at(-1)).toEqual({ window: "pregame", peers: 3, medianMs: 8_000, agree: 3, result: "applied" })
    expect(recorded.metrics).toContainEqual({
      type: "distribution", name: "clock.correction_ms", value: 8_000, unit: "millisecond", attrs: { "clock.via": "peer" },
    })
    pass(3)
    expect(offset()).toBe(8)
    block(-20)
    expect(clockLines("clock chain check").at(-1)).toEqual({ check: "first-change", gapMs: -20_000 })
    expect(offset()).toBe(8)
  })

  it("keeps its own clock with too few peers, a peer median in the dead band, or a split group", async () => {
    clearDevLog()
    const { offset, pass, mesh } = await clock()
    mesh.wants()
    mesh.offer("a", 0, 100)
    mesh.offer("b", 8_000, 100)
    expect(clockLines("clock peers").at(-1)).toEqual({ window: "pregame", peers: 2, result: "few" })
    pass(5)
    expect(offset()).toBe(0)
    mesh.offer("c", 100, 100)
    expect(clockLines("clock peers").at(-1)).toEqual({ window: "pregame", peers: 3, medianMs: 100, agree: 2, result: "dead-band" })
    mesh.offer("d", 8_100, 100)
    expect(clockLines("clock peers").at(-1)).toEqual({ window: "pregame", peers: 4, medianMs: 4_050, agree: 0, result: "split" })
    pass(5)
    expect(offset()).toBe(0)
  })

  it("replies with the device time, never the peer move", async () => {
    const { block, pass, offset, mesh } = await clock()
    block(-40)
    mesh.wants()
    for (const peer of ["a", "b", "c"]) mesh.offer(peer, 48_000, 100)
    pass(2)
    mesh.offer("a", 48_000, 100)
    pass(5)
    expect(offset()).toBeGreaterThan(0)
    expect(mesh.reply()).toBe(Date.now())
  })

  it("keeps a pregame window with 2 peers open after the tiles enter, and closes it after a 3-peer verdict", async () => {
    clearDevLog()
    const { mesh, pass } = await clock()
    expect(mesh.wants()).toBe(true)
    expect(clockLines("clock peer check")).toEqual([{ window: "pregame" }])
    mesh.offer("a", 0, 100)
    mesh.offer("b", 100, 100)
    pass(GAME.game_date - NOW + 5)
    expect(mesh.wants()).toBe(true)
    expect(clockLines("clock peer check done")).toEqual([])
    mesh.offer("c", 50, 100)
    expect(mesh.wants()).toBe(false)
    expect(clockLines("clock peer check done")).toEqual([
      { window: "pregame", peers: 3, medianMs: 50, rttMs: 100, quorumMs: (GAME.game_date - NOW + 5) * 1000, result: "dead-band", method: "none", offsetMs: 0 },
    ])
  })

  it("keeps the faster sample of a peer when a slower reply comes", async () => {
    clearDevLog()
    const { mesh, pass } = await clock()
    mesh.wants()
    mesh.offer("a", 0, 100)
    mesh.offer("b", 50, 100)
    mesh.offer("c", 8_000, 900)
    expect(clockLines("clock peers").at(-1)).toEqual({ window: "pregame", peers: 3, medianMs: 50, agree: 2, result: "dead-band" })
    mesh.offer("c", 20, 40)
    mesh.offer("c", 8_000, 300)
    pass(GAME.game_date - NOW)
    expect(mesh.wants()).toBe(false)
    expect(clockLines("clock peer check done")).toEqual([
      { window: "pregame", peers: 3, medianMs: 20, rttMs: 100, quorumMs: 0, result: "dead-band", method: "none", offsetMs: 0 },
    ])
  })

  it("records the kept round trip of each peer and the time to the first ok verdict when a window closes", async () => {
    clearDevLog()
    const { mesh, pass } = await clock()
    mesh.wants()
    mesh.offer("a", 0, 300)
    mesh.offer("b", 50, 80)
    pass(3)
    mesh.offer("a", 10, 120)
    pass(2)
    mesh.offer("c", 20, 200)
    pass(GAME.game_date - NOW - 5)
    expect(mesh.wants()).toBe(false)
    expect(clockLines("clock peer check done")).toEqual([
      { window: "pregame", peers: 3, medianMs: 20, rttMs: 120, quorumMs: 5_000, result: "dead-band", method: "none", offsetMs: 0 },
    ])
    const rtts = recorded.metrics.filter((m) => m.name === "clock.peer_rtt_ms")
    expect(rtts.map((m) => m.value)).toEqual([120, 80, 200])
    expect(rtts.map((m) => m.attrs)).toEqual(Array(3).fill({ "clock.window": "pregame" }))
    expect(recorded.metrics).toEqual(expect.arrayContaining([
      { type: "distribution", name: "clock.peer_quorum_ms", value: 5_000, unit: "millisecond", attrs: { "clock.window": "pregame" } },
      {
        type: "distribution", name: "clock.peer_window_ms", value: (GAME.game_date - NOW) * 1000, unit: "millisecond",
        attrs: { "clock.window": "pregame", "clock.result": "dead-band" },
      },
      {
        type: "distribution", name: "clock.peer_count", value: 3, unit: "none",
        attrs: { "clock.window": "pregame", "clock.result": "dead-band" },
      },
    ]))
  })

  it("holds an ok median out of the dead band, and moves only on a reply 2 s or more later", async () => {
    clearDevLog()
    const { mesh, pass, offset } = await clock()
    mesh.wants()
    for (const peer of ["a", "b", "c"]) mesh.offer(peer, 3_000, 100)
    expect(clockLines("clock peers").at(-1)).toEqual({ window: "pregame", peers: 3, medianMs: 3_000, agree: 3, result: "held" })
    pass(1)
    mesh.offer("a", 3_000, 100)
    expect(clockLines("clock peers").at(-1)).toEqual({ window: "pregame", peers: 3, medianMs: 3_000, agree: 3, result: "held" })
    expect(recorded.metrics.some((m) => m.name === "clock.correction_ms")).toBe(false)
    pass(1)
    mesh.offer("b", 3_000, 100)
    expect(clockLines("clock peers").at(-1)).toEqual({ window: "pregame", peers: 3, medianMs: 3_000, agree: 3, result: "applied" })
    expect(recorded.metrics).toContainEqual({
      type: "distribution", name: "clock.correction_ms", value: 3_000, unit: "millisecond", attrs: { "clock.via": "peer" },
    })
    pass(5)
    expect(offset()).toBe(3)
  })

  it("never moves the clock for medians of -477 ms then +425 ms 2 s apart", async () => {
    clearDevLog()
    const { mesh, pass, offset } = await clock()
    mesh.wants()
    for (const peer of ["a", "b", "c"]) mesh.offer(peer, -477, 100)
    for (const peer of ["d", "e"]) mesh.offer(peer, 425, 100)
    expect(clockLines("clock peers").at(-1)).toEqual({ window: "pregame", peers: 5, medianMs: -477, agree: 5, result: "held" })
    // each faster reply flips the median, so no median holds for 2 s
    pass(2)
    mesh.offer("c", 425, 50)
    pass(2)
    mesh.offer("d", -477, 50)
    pass(2)
    mesh.offer("b", 425, 50)
    expect(recorded.metrics.some((m) => m.name === "clock.correction_ms")).toBe(false)
    pass(5)
    expect(offset()).toBe(0)
  })

  it("keeps a held window open after its end time until it settles", async () => {
    clearDevLog()
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const { mesh, pass } = await clock({ at: GAME.game_date + 40 })
    expect(mesh.wants()).toBe(true)
    pass(PEER_CHECK_MS / 1000 - 1)
    for (const peer of ["a", "b", "c"]) mesh.offer(peer, 3_000, 100)
    pass(1)
    expect(mesh.wants()).toBe(true)
    pass(1)
    mesh.offer("a", 3_000, 100)
    expect(mesh.wants()).toBe(false)
    expect(clockLines("clock peer check done")).toEqual([
      { window: "late", peers: 3, medianMs: 3_000, rttMs: 100, quorumMs: 19_000, result: "applied", method: "peer", offsetMs: 3_000 },
    ])
    vi.unstubAllGlobals()
  })

  it("opens a late window on the first ask of a late join, and closes it with no quorum at the game end", async () => {
    clearDevLog()
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const at = GAME.game_date + 40
    const { source, mesh, pass } = await clock({ at })
    expect(clockLines("clock ready")).toEqual([{ late: true }])
    expect(clockLines("clock peer check")).toEqual([])
    expect(source.clockState?.()).toEqual({ ready: true, coldStartedAt: at })
    expect(mesh.wants()).toBe(true)
    expect(clockLines("clock peer check")).toEqual([{ window: "late" }])
    mesh.offer("a", 300, 100)
    pass(PEER_CHECK_MS / 1000)
    expect(mesh.wants()).toBe(true)
    pass(GAME.report_ends - at - PEER_CHECK_MS / 1000 - 1)
    expect(mesh.wants()).toBe(true)
    pass(1)
    expect(mesh.wants()).toBe(false)
    expect(clockLines("clock peer check done")).toEqual([
      { window: "late", peers: 1, medianMs: 300, rttMs: 100, result: "few", method: "none", offsetMs: 0 },
    ])
    const tags = { "clock.window": "late", "clock.result": "few" }
    expect(recorded.metrics).toEqual(expect.arrayContaining([
      { type: "distribution", name: "clock.peer_count", value: 1, unit: "none", attrs: tags },
      { type: "distribution", name: "clock.peer_offset_ms", value: 300, unit: "millisecond", attrs: tags },
      { type: "distribution", name: "clock.peer_rtt_ms", value: 100, unit: "millisecond", attrs: { "clock.window": "late" } },
      { type: "distribution", name: "clock.peer_window_ms", value: (GAME.report_ends - at) * 1000, unit: "millisecond", attrs: tags },
      { type: "distribution", name: "clock.offset_ms", value: 0, unit: "millisecond", attrs: { "clock.window": "late", "clock.method": "none" } },
    ]))
    expect(recorded.metrics.some((m) => m.name === "clock.peer_quorum_ms")).toBe(false)
    vi.unstubAllGlobals()
  })

  it("opens a late window when the mesh first asks after the tiles enter, on a page ready before them", async () => {
    clearDevLog()
    const { mesh, pass } = await clock({ at: GAME.game_date - 30 })
    expect(clockLines("clock ready")).toEqual([{ late: false }])
    pass(29)
    expect(mesh.wants()).toBe(true)
    expect(clockLines("clock peer check")).toEqual([{ window: "late" }])
  })

  it("opens no window on a new ask after a settled one, and still a 20 s window on a resume and a wall step", async () => {
    clearDevLog()
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const { source, mesh, pass } = await clock({ at: GAME.game_date + 40, chainAt: GAME.game_date + 40 })
    expect(mesh.wants()).toBe(true)
    for (const peer of ["a", "b", "c"]) mesh.offer(peer, 0, 100)
    pass(PEER_CHECK_MS / 1000)
    expect(mesh.wants()).toBe(false)
    expect(mesh.wants()).toBe(false)
    expect(clockLines("clock peer check")).toEqual([{ window: "late" }])
    reportPageActivity(false)
    expect(clockLines("clock peer check").at(-1)).toEqual({ window: "resume" })
    expect(mesh.wants()).toBe(true)
    for (const peer of ["a", "b", "c"]) mesh.offer(peer, 0, 100)
    pass(PEER_CHECK_MS / 1000 - 1)
    expect(mesh.wants()).toBe(true)
    pass(1)
    expect(mesh.wants()).toBe(false)
    vi.setSystemTime(Date.now() + 30_000)
    source.nowSeconds()
    expect(clockLines("clock peer check").at(-1)).toEqual({ window: "step" })
    expect(mesh.wants()).toBe(true)
    vi.unstubAllGlobals()
  })

  it("counts a peer jump with no wall step as unexplained (#1033)", async () => {
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const { source, mesh, pass } = await clock({ at: GAME.game_date + 40, chainAt: GAME.game_date + 40 })
    expect(mesh.wants()).toBe(true)
    for (const peer of ["a", "b", "c"]) mesh.offer(peer, 12_000, 100)
    pass(2)
    mesh.offer("a", 12_000, 100)
    pass(1)
    source.nowSeconds()
    expect(source.unexplainedJumpMs?.()).toBeCloseTo(12_000, -3)
    vi.unstubAllGlobals()
  })

  it("counts no peer jump that a forward wall step explains (#1033)", async () => {
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const { source, mesh, pass } = await clock({ at: GAME.game_date + 40, chainAt: GAME.game_date + 40 })
    expect(mesh.wants()).toBe(true)
    vi.setSystemTime(Date.now() + 15_000)
    source.nowSeconds()
    for (const peer of ["a", "b", "c"]) mesh.offer(peer, 15_000, 100)
    pass(2)
    mesh.offer("a", 15_000, 100)
    pass(1)
    source.nowSeconds()
    expect(source.unexplainedJumpMs?.()).toBe(0)
    vi.unstubAllGlobals()
  })

  it("keeps no step credit after the step window closes (#1033)", async () => {
    vi.stubGlobal("window", { location: { pathname: "/game" } })
    const { source, mesh, pass } = await clock({ at: GAME.game_date + 40, chainAt: GAME.game_date + 40 })
    vi.setSystemTime(Date.now() + 30_000)
    source.nowSeconds()
    for (const peer of ["a", "b", "c"]) mesh.offer(peer, 0, 100)
    pass(PEER_CHECK_MS / 1000)
    expect(mesh.wants()).toBe(false)
    reportPageActivity(false)
    for (const peer of ["a", "b", "c"]) mesh.offer(peer, 12_000, 100)
    pass(2)
    mesh.offer("a", 12_000, 100)
    pass(1)
    source.nowSeconds()
    expect(source.unexplainedJumpMs?.()).toBeCloseTo(12_000, -3)
    vi.unstubAllGlobals()
  })

  it("opens no resume or step window off /game", async () => {
    vi.stubGlobal("window", { location: { pathname: "/" } })
    const { source } = await clock({ at: GAME.game_date + 40, chainAt: GAME.game_date + 40 })
    clearDevLog()
    reportPageActivity(false)
    vi.setSystemTime(Date.now() + 30_000)
    source.nowSeconds()
    expect(clockLines("clock peer check")).toEqual([])
    expect(clockLines("clock peer check done")).toEqual([])
    vi.unstubAllGlobals()
  })

  it("sets coldStartedAt only for a clock that became ready inside the game", async () => {
    const before = await clock({ at: GAME.game_date - 30 })
    expect(before.source.clockState?.()).toEqual({ ready: true })
    expect(before.mesh.wants()).toBe(true)
    const after = await clock({ at: GAME.report_ends + 5 })
    expect(after.source.clockState?.()).toEqual({ ready: true })
    expect(after.mesh.wants()).toBe(false)
  })

  it("publishes the best block number with the clock", async () => {
    const chain = fakeEngine()
    makeSource("host", chain.engine)
    await flush()
    expect(readChainClock()?.block).toBeNull()
    vi.advanceTimersByTime(6000)
    chain.now(NOW + 6, 1000)
    expect(readChainClock()?.block).toBe(1000)
  })

  it("resubscribes the clock game watch after an error (#429)", async () => {
    const chain = fakeEngine()
    let watches = 0
    chain.engine.watchGame = (_cb, onError) => {
      watches += 1
      if (watches === 1) onError?.(new Error("watch failed"))
      return () => {}
    }
    makeSource("host", chain.engine)
    expect(watches).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(watches).toBe(2)
  })

  it("keeps the window when the game watch reports no game", async () => {
    const { chain, mesh } = await clock()
    chain.game(GAME)
    chain.game(undefined)
    expect(mesh.wants()).toBe(true)
  })
})

describe("a wall clock stepped mid-game (#331)", () => {
  // `vi.setSystemTime` steps Date alone, as the live E2E's clock shift and an
  // OS time sync do; `advanceTimersByTime` is real elapsed time
  const step = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000)
  /** a source that has anchored at NOW and is `inGame` seconds into the game */
  async function inGame(seconds: number, deviceClock?: DeviceClock) {
    const chain = fakeEngine()
    const source = makeSource("host", chain.engine, { deviceClock })
    await flush()
    vi.advanceTimersByTime((GAME.game_date + seconds - NOW) * 1000)
    const base = Math.floor(performance.now() / 1000)
    const chainNow = () => GAME.game_date + seconds + Math.floor(performance.now() / 1000) - base
    return { chain, source, chainNow }
  }

  it("+30 s then -75 s leaves the game clock on the chain's time", async () => {
    const { source, chainNow } = await inGame(40)
    expect(source.nowSeconds()).toBe(chainNow())
    step(30)
    expect(source.nowSeconds()).toBe(chainNow())
    vi.advanceTimersByTime(25_000)
    expect(source.nowSeconds()).toBe(chainNow())
    step(-75)
    expect(source.nowSeconds()).toBe(chainNow())
    vi.advanceTimersByTime(60_000)
    expect(source.nowSeconds()).toBe(chainNow())
  })

  it("blocks inside the game after the steps re-anchor nothing", async () => {
    const { chain, source, chainNow } = await inGame(40)
    step(30)
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(6000)
      chain.now(chainNow())
    }
    step(-75)
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(6000)
      chain.now(chainNow())
    }
    expect(source.nowSeconds()).toBe(chainNow())
  })

  it("publishes the offset against the wall, so Date.now() + offset is still the chain's time", async () => {
    const { source, chainNow } = await inGame(40)
    step(-75)
    source.nowSeconds()
    expect(Math.floor(Date.now() / 1000) + readChainClock()!.offset).toBe(chainNow())
    step(30)
    source.nowSeconds()
    expect(Math.floor(Date.now() / 1000) + readChainClock()!.offset).toBe(chainNow())
  })

  it("a late block, even several, moves nothing inside the game", async () => {
    const { chain, source, chainNow } = await inGame(40)
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(6000)
      chain.now(chainNow() - 10) // a block + 4 s late
    }
    expect(source.nowSeconds()).toBe(chainNow())
  })

  it("a phone clock wrong at the start and corrected while visible: no statement is born expired (#331 review)", async () => {
    // the phone runs 75 s slow: its peers say so
    vi.setSystemTime((NOW - 75) * 1000)
    resetDeviceClockForTests()
    const chain = fakeEngine()
    const source = makeSource("host", chain.engine)
    await flush()
    const mesh = source.meshClock!
    expect(mesh.wants()).toBe(true)
    for (const peer of ["a", "b", "c"]) mesh.offer(peer, 75_000, 100)
    vi.advanceTimersByTime(2000)
    mesh.offer("a", 75_000, 100)
    const trueNow = () => Date.now() + 75_000
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(6000)
      chain.now(Math.floor(trueNow() / 1000))
    }
    // an NTP fix steps it +75 s while the page is visible: the device clock
    // takes that step out, so it still reads 75 s slow
    step(75)
    vi.advanceTimersByTime(2000)
    resetStoreClockForTests()
    const deadlineMs = Number(nextSlotExpiry(storeClock().stamp().ms) >> 32n) * 1000
    expect(deadlineMs).toBeGreaterThan(Date.now() + 20_000)
    expect(deadlineMs).toBeGreaterThan(Math.floor(Date.now() / 1000) * 1000)
  })

  it("a step before the first block keeps the published clock on the device time", async () => {
    const chain = fakeEngine()
    chain.engine.watchNow = () => () => {}
    const source = makeSource("host", chain.engine)
    await flush()
    const before = source.nowSeconds()
    step(-75)
    expect(source.nowSeconds()).toBe(before)
    expect(readChainClock()?.offset).toBe(75)
  })

  it("a step before the game is not an offset sample either", async () => {
    const chain = fakeEngine()
    const source = makeSource("host", chain.engine)
    await flush()
    step(-75)
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(6000)
      chain.now(NOW + 6 * i)
    }
    expect(source.nowSeconds()).toBe(NOW + 30)
  })
})

describe("submitReport", () => {
  const submit = (result: unknown) => {
    const chain = fakeEngine()
    vi.mocked(chain.engine.report).mockResolvedValue(result as never)
    return makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS }).submitReport!([["Person"]])
  }

  it("resolves when the pallet says the report was already sent: it counted", async () => {
    await expect(submit({ ok: false, error: "ReportAlreadySent" })).resolves.toBeUndefined()
  })

  it("rejects with the pallet's name for any other refusal", async () => {
    await expect(submit({ ok: false, error: "NoReporting" })).rejects.toThrow("NoReporting")
  })

  it("waits for a fresh follow and retries a not-pinned report once", async () => {
    const chain = fakeEngine()
    vi.mocked(chain.engine.report)
      .mockResolvedValueOnce({ ok: false, error: "Block 0x123 is not pinned (stop-call)" })
      .mockResolvedValueOnce({ ok: true })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    await expect(source.submitReport!([["Person"]])).resolves.toBeUndefined()
    expect(chain.engine.waitUntilFollowing).toHaveBeenCalledTimes(1)
    expect(chain.engine.report).toHaveBeenCalledTimes(2)
    expect(recorded.metrics).toContainEqual(expect.objectContaining({
      name: "chain.retries",
      value: 1,
      attrs: expect.objectContaining({
        "chain.retry_reason": "block-not-pinned",
        "chain.retry_operation": "report",
        "chain.retry_succeeded": "true",
      }),
    }))
  })
})

describe("telemetry", () => {
  it("names the player to Sentry", () => {
    const chain = fakeEngine()
    makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    expect(recorded.player).toContainEqual([PLAYER, undefined])
  })

  it("adds the username once knownDisplayName resolves (asked at app open), without waiting for it", async () => {
    let resolveName!: (name: string | null) => void
    vi.mocked(knownDisplayName).mockReturnValue(new Promise((resolve) => (resolveName = resolve)))
    const chain = fakeEngine()
    makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    expect(recorded.player).toEqual([[PLAYER, undefined]])
    expect(knownDisplayName).toHaveBeenCalledWith({ ask: true })
    resolveName("alice.dot")
    await vi.waitFor(() => expect(recorded.player).toContainEqual([PLAYER, "alice.dot"]))
  })

  it("keeps the account-only user when the name is unknown or the lookup throws", async () => {
    const chain = fakeEngine()
    vi.mocked(knownDisplayName).mockResolvedValueOnce(null)
    makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    vi.mocked(knownDisplayName).mockRejectedValueOnce(new Error("host gone"))
    makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    await vi.advanceTimersByTimeAsync(0)
    expect(knownDisplayName).toHaveBeenCalledTimes(2)
    expect(recorded.player).toEqual([
      [PLAYER, undefined],
      [PLAYER, undefined],
    ])
  })
})

describe("the host channel on app open", () => {
  const stubSessionStorage = () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    vi.stubGlobal("sessionStorage", storage)
    return storage
  }

  it("persists a connected channel loss and clears it on restoration", () => {
    vi.stubGlobal("window", { location: { reload: vi.fn() } })
    let emit: (status: "connecting" | "connected" | "disconnected") => void = () => {}
    watchHostChannel({
      subscribeConnectionStatus: (cb) => {
        emit = cb
        return () => {}
      },
    })
    emit("connected")
    emit("disconnected")
    expect(noteHostChannelLost).toHaveBeenCalledOnce()
    emit("connected")
    expect(noteHostChannelRestored).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })

  it("retries TURN after an established host channel reconnects", () => {
    vi.stubGlobal("window", { location: { reload: vi.fn() } })
    let emit: (status: "connecting" | "connected" | "disconnected") => void = () => {}
    watchHostChannel({
      subscribeConnectionStatus: (cb) => {
        emit = cb
        return () => {}
      },
    })

    emit("connected")
    expect(retryTurnAfterHostReconnect).not.toHaveBeenCalled()
    emit("disconnected")
    emit("connected")

    expect(retryTurnAfterHostReconnect).toHaveBeenCalledOnce()
    emit("connected")
    expect(retryTurnAfterHostReconnect).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it("measures connecting to connected once", () => {
    resetAppOpenForTests()
    vi.stubGlobal("window", { location: { reload: vi.fn() } })
    let emit: (status: "connecting" | "connected" | "disconnected") => void = () => {}
    watchHostChannel({
      subscribeConnectionStatus: (cb) => {
        emit = cb
        return () => {}
      },
    })
    emit("connecting")
    emit("connected")
    emit("disconnected")
    emit("connected")
    const [journey] = journeysNamed("app-open")
    expect(journey.steps).toHaveLength(1)
    expect(journey.steps[0]).toMatchObject({ name: "host.connect", ended: true })
    vi.unstubAllGlobals()
  })

  it("reloads two seconds after an established host channel stays disconnected", () => {
    resetAppOpenForTests()
    const reload = vi.fn()
    vi.stubGlobal("window", { location: { reload } })
    const storage = stubSessionStorage()
    let emit: (status: "connecting" | "connected" | "disconnected") => void = () => {}
    watchHostChannel({
      subscribeConnectionStatus: (cb) => {
        emit = cb
        return () => {}
      },
    })
    emit("connected")
    emit("disconnected")
    vi.advanceTimersByTime(1_999)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(noteOwnReload).toHaveBeenCalledOnce()
    expect(reload).toHaveBeenCalledOnce()
    expect(JSON.parse(storage.getItem("jollity:host-reloads") ?? "[]")).toEqual([NOW * 1000 + 2_000])
    vi.unstubAllGlobals()
  })

  it("cancels a pending self-reload when the host channel reconnects", () => {
    resetAppOpenForTests()
    const reload = vi.fn()
    vi.stubGlobal("window", { location: { reload } })
    let emit: (status: "connecting" | "connected" | "disconnected") => void = () => {}
    watchHostChannel({
      subscribeConnectionStatus: (cb) => {
        emit = cb
        return () => {}
      },
    })
    emit("connected")
    emit("disconnected")
    vi.advanceTimersByTime(1_000)
    emit("connected")
    vi.advanceTimersByTime(10_000)
    expect(noteOwnReload).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("caps self-reloads at three in ten minutes", () => {
    resetAppOpenForTests()
    const reload = vi.fn()
    vi.stubGlobal("window", { location: { reload } })
    const storage = stubSessionStorage()
    storage.setItem("jollity:host-reloads", JSON.stringify([NOW * 1000 - 9 * 60_000, NOW * 1000 - 1_000, NOW * 1000]))
    let emit: (status: "connecting" | "connected" | "disconnected") => void = () => {}
    watchHostChannel({
      subscribeConnectionStatus: (cb) => {
        emit = cb
        return () => {}
      },
    })
    emit("connected")
    emit("disconnected")
    vi.advanceTimersByTime(2_000)
    expect(noteOwnReload).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe("the app-open steps span their real interval", () => {
  it("starts host.connect before the host SDK is imported, not once it is attached", async () => {
    resetAppOpenForTests()
    vi.stubGlobal("window", { location: { reload: vi.fn() } })
    await getGameSource()
    expect(atImport.steps).toEqual(["host.connect"])
    const [journey] = journeysNamed("app-open")
    expect(journey.steps.filter((step) => step.name === "host.connect")).toHaveLength(1)
    expect(journey.steps[0]).toMatchObject({ ended: true })
    vi.unstubAllGlobals()
  })
})

describe("journey.person", () => {
  it("ends bound with the lookup, the proof and the broadcast", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    chain.bind.mockImplementation(proves)
    const { stop } = watching(chain.engine)
    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    const [journey] = journeysNamed("person")
    expect(journey.steps.map((step) => [step.name, step.ended])).toEqual([
      ["key.find", true],
      ["proof", true],
      ["bind.broadcast", true],
    ])
    expect(journey.outcome).toBe("bound")
    stop()
  })

  it("ends already-bound when the engine found the binding there", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    chain.bind.mockResolvedValue({ kind: "already-bound" })
    const { stop } = watching(chain.engine)
    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    const [journey] = journeysNamed("person")
    expect(journey.steps.map((step) => step.name)).toEqual(["key.find"])
    expect(journey.outcome).toBe("already-bound")
    stop()
  })

  it("ends failed on a refusal for good, and reports it at its stage", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    chain.bind.mockImplementation(async (capabilities) => {
      await capabilities.personhood!.prove({} as never, {} as never, new Uint8Array(32))
      return refused("rejected", "AccountInUse")
    })
    const { stop } = watching(chain.engine)
    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    const [journey] = journeysNamed("person")
    expect(journey.outcome).toBe("failed")
    expect(journey.endAttrs?.["person.stage"]).toBe("bind.broadcast")
    expect(recorded.failures).toEqual([
      expect.objectContaining({ kind: "person-bind-failed", details: expect.objectContaining({ reason: "bind.broadcast" }) }),
    ])
    stop()
  })

  it("keeps one sad journey across a retry that lands", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    chain.bind.mockResolvedValueOnce(refused("rejected", "CallBlockOutOfRange")).mockImplementation(proves)
    const { stop } = watching(chain.engine)
    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    chain.seatReads[1].resolve(facts(["AliasNotBound"]))
    await vi.advanceTimersByTimeAsync(BIND_RETRY_MS[0])
    chain.seatReads[2].resolve(facts(["AliasNotBound"]))
    await flush()
    const journeys = journeysNamed("person")
    expect(journeys).toHaveLength(1)
    expect(journeys[0].sad).toEqual(["bind-retry"])
    expect(journeys[0].outcome).toBe("bound")
    expect(recorded.failures).toHaveLength(0)
    stop()
  })

  it("reports the third failure in a row and closes the journey", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    chain.bind.mockResolvedValue(refused("rejected", "CallBlockOutOfRange"))
    const { stop } = watching(chain.engine)
    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    for (let i = 0; i < 2; i += 1) {
      chain.seatReads[2 * i + 1].resolve(facts(["AliasNotBound"]))
      await vi.advanceTimersByTimeAsync(BIND_RETRY_MS[i])
      chain.seatReads[2 * i + 2].resolve(facts(["AliasNotBound"]))
      await flush()
    }
    expect(chain.bind).toHaveBeenCalledTimes(3)
    const [journey] = journeysNamed("person")
    expect(journey.sad).toHaveLength(3)
    expect(journey.outcome).toBe("failed")
    expect(journey.endAttrs?.["person.stage"]).toBe("proof")
    expect(recorded.failures.filter((failure) => failure.kind === "person-bind-failed")).toHaveLength(1)
    stop()
  })

  it("opens no journey for someone who is not a lite person", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    const { stop } = watching(chain.engine)
    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AliasNotBound"]))
    await flush()
    expect(journeysNamed("person")).toHaveLength(0)
    stop()
  })
})
describe("journey.game-signup", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })
  // the retry loop walks a backoff of tens of seconds on the fake clock, a second at a time
  vi.setConfig({ testTimeout: 30_000 })
  async function signUp(chain: ReturnType<typeof fakeEngine>, seat: SeatSpec) {
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    const attempt = source.register!()
    await vi.waitFor(() => expect(chain.seatReads).toHaveLength(1))
    chain.seatReads[0].resolve(seat)
    const settled = await attempt.then(
      () => "resolved",
      () => "rejected",
    )
    await flush()
    return settled
  }

  it("ends landed with route, build, broadcast and landing", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      return { ok: true }
    })
    await expect(signUp(chain, facts(["AlreadyPlaying"]))).resolves.toBe("resolved")
    const [journey] = journeysNamed("game-signup")
    expect(journey.steps.map((step) => [step.name, step.ended])).toEqual([
      ["route", true],
      ["tx.build", true],
      ["tx.broadcast", true],
      ["tx.landed", true],
    ])
    expect(journey.steps[0].endAttrs).toEqual({ "signup.route": "returning" })
    expect(journey.attrs["draw.entered"]).toBe("1")
    expect(journey.outcome).toBe("landed")
    expect(recorded.signupBroadcasts).toEqual([{ account: PLAYER, gameIndex: GAME.index, attempt: 1, route: "returning" }])
  })

  it("asks the host to remind the player of the game once the sign-up lands, a minute ahead of the start on the device clock", async () => {
    // Given
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(holdGameReminder).mockClear()
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onBroadcast?.()
      return { ok: true }
    })

    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    vi.setSystemTime(Date.now() + 3_600_000)

    // When
    const attempt = source.register!()
    await vi.waitFor(() => expect(chain.seatReads).toHaveLength(1))
    chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
    await attempt
    await flush()

    // Then
    await vi.waitFor(() => expect(holdGameReminder).toHaveBeenCalledTimes(1))
    const [gamePlayTime, startsAt] = vi.mocked(holdGameReminder).mock.calls[0]!
    expect(gamePlayTime).toBe(GAME.game_date)
    expect(startsAt).toBe(GAME.game_date * 1000 - 60_000)
    // and the answer is counted, as the chat worker's is
    await vi.waitFor(() => expect(recorded.reminderAsks).toContainEqual({ outcome: "held" }))
  })

  it("asks the host for no reminder after a sign-up that does not land", async () => {
    // Given
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(holdGameReminder).mockClear()

    // When
    await signUp(chain, facts([]))

    // Then
    expect(holdGameReminder).not.toHaveBeenCalled()
  })

  it("waits for the host to hold the game reminder before the sign-up goes out", async () => {
    // Given
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.seat).mockImplementation(seatsOf(facts(["AlreadyPlaying"])))
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onBroadcast?.()
      return { ok: true }
    })
    let answer!: (outcome: "held") => void
    vi.mocked(reminderForSignup).mockClear().mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const { source, statuses, stop } = watching(chain.engine)
    chain.game()
    await flush()

    // When
    const attempt = source.register!()
    await flush()
    const phaseWhileAsking = lastSignup(statuses)
    const signUpsWhileAsking = vi.mocked(chain.engine.register).mock.calls.length
    answer("held")
    await attempt

    // Then
    expect(phaseWhileAsking).toBe("reminders")
    expect(signUpsWhileAsking).toBe(0)
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    const [gamePlayTime, startsAt] = vi.mocked(reminderForSignup).mock.calls[0]!
    expect(gamePlayTime).toBe(GAME.game_date)
    expect(Math.abs(startsAt - (GAME.game_date - 60) * 1000)).toBeLessThan(5_000)
    stop()
  })

  it.each([
    ["failed", "alarm-required", "ask-failed"],
    ["denied", "reminders-off", "reminders-denied"],
  ] as const)("holds the sign-up back when the host answers %s, and says why", async (answer, phase, reason) => {
    // Given
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.seat).mockImplementation(seatsOf(facts(["AlreadyPlaying"])))
    vi.mocked(reminderForSignup).mockClear().mockResolvedValueOnce(answer)
    const { source, statuses, stop } = watching(chain.engine)
    chain.game()
    await flush()

    // When
    await source.register!()
    await flush()

    // Then
    expect(chain.engine.register).not.toHaveBeenCalled()
    expect(lastSignup(statuses)).toBe(phase)
    expect(recorded.metrics).toContainEqual({ type: "count", name: "register.blocked", value: 1, attrs: { reason, surface: "app" } })
    expect(signupJourneys()).toHaveLength(0)
    stop()
  })

  it("signs up without a reminder when the host refuses one as StartsInPast", async () => {
    // Given
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.seat).mockImplementation(seatsOf(facts(["AlreadyPlaying"])))
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onBroadcast?.()
      return { ok: true }
    })
    vi.mocked(reminderForSignup).mockClear().mockImplementationOnce(async (_gamePlayTime, _startsAtMs, onAsked) => {
      onAsked?.("starts-in-past", "Domain.V1: StartsInPast")
      return "starts-in-past"
    })
    const { source, stop } = watching(chain.engine)
    chain.game()
    await flush()

    // When
    await source.register!()
    await flush()

    // Then
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    expect(recorded.reminderAsks).toContainEqual({ outcome: "starts-in-past", error: "Domain.V1: StartsInPast" })
    expect(recorded.metrics.filter((metric) => metric.name === "register.blocked")).toHaveLength(0)
    expect(signupJourneys()).toHaveLength(1)
    expect(signupJourneys()[0].outcome).toBe("landed")
    stop()
  })

  it("asks the host again on the next tap after it gave no reminder, and signs up once it holds one", async () => {
    // Given
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.seat).mockImplementation(seatsOf(facts(["AlreadyPlaying"])))
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onBroadcast?.()
      return { ok: true }
    })
    vi.mocked(reminderForSignup).mockClear().mockResolvedValueOnce("failed").mockResolvedValueOnce("held")
    const { source, statuses, stop } = watching(chain.engine)
    chain.game()
    await flush()
    await source.register!()
    await flush()

    // When
    await source.register!()

    // Then
    expect(reminderForSignup).toHaveBeenCalledTimes(2)
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    expect(lastSignup(statuses)).not.toBe("alarm-required")
    stop()
  })

  it("signs up without the reminder in a host that cannot remind", async () => {
    // Given
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.seat).mockImplementation(seatsOf(facts(["AlreadyPlaying"])))
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onBroadcast?.()
      return { ok: true }
    })
    vi.mocked(reminderForSignup).mockClear().mockResolvedValueOnce("unsupported")
    const { source, stop } = watching(chain.engine)
    chain.game()
    await flush()

    // When
    await source.register!()

    // Then
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    expect(recorded.metrics.filter((metric) => metric.name === "register.blocked")).toHaveLength(0)
    stop()
  })

  it.each([
    ["a record it cannot keep", "unrecorded"],
    ["no host", null],
  ] as const)("signs up without the reminder with %s", async (_, answer) => {
    // Given
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.seat).mockImplementation(seatsOf(facts(["AlreadyPlaying"])))
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onBroadcast?.()
      return { ok: true }
    })
    vi.mocked(reminderForSignup).mockClear().mockResolvedValueOnce(answer)
    const { source, stop } = watching(chain.engine)
    chain.game()
    await flush()

    // When
    await source.register!()

    // Then
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    expect(recorded.metrics.filter((metric) => metric.name === "register.blocked")).toHaveLength(0)
    stop()
  })

  it("marks an actual broadcast once even if the engine repeats its callback", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      options?.onBroadcast?.()
      return { ok: true }
    })
    await signUp(chain, facts(["AlreadyPlaying"]))
    expect(recorded.signupBroadcasts).toEqual([{ account: PLAYER, gameIndex: GAME.index, attempt: 1, route: "returning" }])
  })

  it("tags the game index at sign-up, before the join", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      return { ok: true }
    })
    await signUp(chain, facts(["AlreadyPlaying"]))
    expect(recorded.gameIndex).toContain(GAME.index)
  })

  it("keeps the engine's reason for skipping the draws", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(0, "no draw scheduled"))
      options?.onBroadcast?.()
      return { ok: true }
    })
    await signUp(chain, facts(["AlreadyPlaying"]))
    expect(journeysNamed("game-signup")[0].attrs).toMatchObject({ "draw.entered": "0", "draw.skipped": "no draw scheduled" })
  })

  it("ends not-eligible for an account that cannot pay, as an expected failure", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    await expect(signUp(chain, facts([]))).resolves.toBe("rejected")
    const [journey] = journeysNamed("game-signup")
    expect(journey.outcome).toBe("not-eligible")
    expect(journey.attrs["journey.expected"]).toBe("true")
    expect(recorded.failures[0]).toMatchObject({ kind: "signup-failed", details: { reason: "not-eligible" }, expected: true })
  })

  /** signup-failed events that ended a sign-up (not an attempt that goes again) */
  const signupFailures = () =>
    recorded.failures.filter((failure) => failure.kind === "signup-failed" && failure.details.context?.retrying !== "true")
  const retryFailures = () =>
    recorded.failures.filter((failure) => failure.kind === "signup-failed" && failure.details.context?.retrying === "true")
  const signupJourneys = () => journeysNamed("game-signup")

  /** a sign-up the player tapped: the seat read answered, the loop is the source's.
   *  `done` ends the loop (the page left) so a test never leaves one running. */
  async function tap(chain: ReturnType<typeof fakeEngine>, seat: SeatSpec | null = facts(["AlreadyPlaying"])) {
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    const outcome = source.register!().then(
      () => "resolved",
      (error: Error) => error.message,
    )
    if (seat) {
      await vi.waitFor(() => expect(chain.seatReads).toHaveLength(1))
      chain.seatReads[0].resolve(seat)
    }
    await flush()
    return { source, outcome }
  }
  /** every seat read asked for gets an answer, and the clock moves on a few
   *  blocks at a time: the bound flag takes a free seat over the finalized blockers */
  const answerReads = async (chain: ReturnType<typeof fakeEngine>, ms = 36_000, blockers = ["AlreadyPlaying"], step = 1_000) => {
    for (let at = 0; at < ms; at += step) {
      for (const read of chain.seatReads) read.resolve(facts(blockers))
      await flush()
      await vi.advanceTimersByTimeAsync(step)
    }
  }
  const fails = (chain: ReturnType<typeof fakeEngine>, error: string, times: number) => {
    let seen = 0
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      if (seen < times) {
        seen += 1
        return { ok: false, error }
      }
      options?.onBroadcast?.()
      return { ok: true }
    })
  }
  const lastSignup = (statuses: GameStatus[]) => {
    const last = statuses[statuses.length - 1]
    return last?.kind === "registration" ? last.signup : undefined
  }

  it("keeps trying when the identifier cannot be made, and says so on the journey", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    commKey.fail = true
    try {
      const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
      void source.register!().catch(() => {})
      await flush()
      const [journey] = signupJourneys()
      expect(journey.outcome).toBe("retrying")
      expect(journey.attrs["signup.retry_reason"]).toBe("other")
      expect(journey.steps[0].ended).toBe(true)
      expect(signupFailures()).toHaveLength(0)
      source.cancelRegister!()
      await vi.advanceTimersByTimeAsync(2_000)
    } finally {
      commKey.fail = false
    }
  })

  it("calls a cancelled signing signing-refused, and expected", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      return { ok: false, error: "Transaction signing was rejected." }
    })
    await expect(signUp(chain, facts(["AlreadyPlaying"]))).resolves.toBe("rejected")
    const [journey] = journeysNamed("game-signup")
    expect(journey.outcome).toBe("failed")
    expect(journey.endAttrs).toEqual({ "signup.stage": "signing-refused" })
    expect(recorded.failures[0]).toMatchObject({ kind: "signup-failed", details: { reason: "signing-refused" }, expected: true })
  })

  it("keeps retrying a host that drops, past several failures, and then lands", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    fails(chain, "HostDisconnectedError: host went away", 4)
    const { outcome } = await tap(chain)
    await answerReads(chain, 50_000)
    await expect(outcome).resolves.toBe("resolved")
    expect(chain.engine.register).toHaveBeenCalledTimes(5)
    const journeys = signupJourneys()
    expect(journeys.map((journey) => journey.outcome)).toEqual(["retrying", "retrying", "retrying", "retrying", "landed"])
    expect(journeys.map((journey) => journey.attrs["signup.attempt"])).toEqual(["1", "2", "3", "4", "5"])
    expect(journeys.slice(0, 4).every((journey) => journey.attrs["signup.retry_reason"] === "network")).toBe(true)
    expect(journeys.map((journey) => journey.attrs["signup.taps"])).toEqual(["1", "1", "1", "1", "1"])
    expect(signupFailures()).toHaveLength(0)
    expect(recorded.metrics.filter((metric) => metric.name === "signup.retries")).toHaveLength(4)
    expect(recorded.metrics.find((metric) => metric.name === "signup.landed_ms")).toMatchObject({ unit: "millisecond" })
  })

  it("says it is taking longer once it has been at it a while, and clears when it lands", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    fails(chain, "HostDisconnectedError: host went away", 6)
    const { statuses, stop, source } = (() => {
      const w = watching(chain.engine)
      return { ...w }
    })()
    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
    await flush()
    void source.register!().catch(() => {})
    await answerReads(chain, 10_000)
    expect(lastSignup(statuses)).toBe("sending")
    await answerReads(chain, 20_000)
    expect(lastSignup(statuses)).toBe("slow")
    await answerReads(chain, 60_000)
    expect(statuses.some((status) => status.kind === "registration" && status.signup === "slow")).toBe(true)
    stop()
  })

  it("surfaces a repeated host-chain failure after 60 seconds and records that the player saw it", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    fails(chain, "createTransaction failed: RPC error: subscription dropped", 1000)
    const { statuses, stop, source } = watching(chain.engine)
    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
    await flush()
    void source.register!().catch(() => {})
    await answerReads(chain, 80_000)
    expect(lastSignup(statuses)).toBe("host-chain")
    expect(recorded.metrics.find((metric) => metric.name === "signup.error_surfaced")).toMatchObject({
      type: "count",
      value: 1,
      attrs: { "signup.retry_reason": "host-chain" },
    })
    expect(signupJourneys()).toHaveLength(vi.mocked(chain.engine.register).mock.calls.length)
    source.cancelRegister!()
    stop()
  })

  it("files a player read the resume cut as an interruption, which never asks the player to act", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    chain.engine.player = vi.fn(async () => {
      throw RESUME_CUT
    })
    const { source } = await tap(chain, null)
    await answerReads(chain, 80_000)
    expect(signupJourneys().length).toBeGreaterThan(1)
    expect(signupJourneys().every((journey) => journey.attrs["signup.retry_reason"] === "host-interrupted")).toBe(true)
    expect(recorded.metrics).toContainEqual({ type: "count", name: "signup.retries", value: 1, attrs: { "signup.retry_reason": "host-interrupted" } })
    expect(recorded.metrics.filter((metric) => metric.name === "signup.error_surfaced")).toEqual([])
    source.cancelRegister!()
  })

  it("files a player read that never answers as a timeout, which never asks the player to act", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    chain.engine.player = () => new Promise(() => {})
    const { source } = await tap(chain, null)
    await answerReads(chain, 80_000)
    expect(signupJourneys().length).toBeGreaterThan(1)
    expect(signupJourneys().every((journey) => journey.attrs["signup.retry_reason"] === "timeout")).toBe(true)
    expect(recorded.metrics.filter((metric) => metric.name === "signup.error_surfaced")).toEqual([])
    source.cancelRegister!()
  })

  it("does not take a re-read that fails after the broadcast for a landing", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    chain.engine.player = vi.fn<GameEngine["player"]>().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("rpc down"))
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      return { ok: false, error: "Tracking stopped", landingUnknown: true as const }
    })
    await tap(chain)
    await answerReads(chain, 15_000)
    expect(signupJourneys()[0].outcome).toBe("retrying")
    // the retry reason is the failed re-read's own ("rpc down"), not the
    // dispatch error's: the re-read is what left the landing unknown (row 3)
    expect(signupJourneys()[0].attrs["signup.retry_reason"]).toBe("other")
  })

  it("continues sign-up after a game-window read hangs, and records the bounded timeout", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    const attempts: number[] = []
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      attempts.push(Date.now())
      options?.onDraws?.(draws(1))
      if (attempts.length === 1) return { ok: false, error: "createTransaction failed: subscription dropped" }
      options?.onBroadcast?.()
      return { ok: true }
    })
    const { statuses, stop, source } = watching(chain.engine)
    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
    await flush()

    const outcome = source.register!()
    for (let i = 0; attempts.length === 0 && i < 3; i += 1) await answerReads(chain, 1_000)
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    chain.engine.game = () => new Promise(() => {})
    await answerReads(chain, 8_000)

    await expect(outcome).resolves.toBeUndefined()
    expect(attempts[1]! - attempts[0]!).toBe(7_000)
    expect(lastSignup(statuses)).toBe("idle")
    expect(recorded.metrics).toContainEqual({
      type: "count",
      name: "signup.window_check_timeout",
      value: 1,
      attrs: { "signup.retry_reason": "host-chain" },
    })
    stop()
  })

  it("closes after the bounded check when a known deadline passes during a hung read", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    const closing = { ...GAME, registration_ends: NOW + 3 }
    chain.engine.game = async () => closing
    const { source, stop } = watching(chain.engine)
    chain.game(closing)
    await flush()
    chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
    await flush()
    const reads = vi.fn<GameEngine["game"]>(() => new Promise(() => {}))
    chain.engine.game = reads

    const outcome = source.register!()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(chain.engine.register).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(chain.engine.register).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(outcome).resolves.toBeUndefined()

    expect(reads).toHaveBeenCalledTimes(1)
    expect(chain.engine.register).not.toHaveBeenCalled()
    expect(signupFailures().map((failure) => failure.details.reason)).toEqual(["window-closed"])
    stop()
  })

  it("does not let game N's deadline close game N+1", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    const first = { ...GAME, registration_ends: NOW + 3 }
    const next = { ...GAME, index: GAME.index + 1, registration_ends: NOW + 120 }
    const { source, stop } = watching(chain.engine)
    chain.game(first)
    await flush()
    chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
    await flush()
    // A later finalized-registration gate may hold this best-block game until
    // the finalized read sees the same index. Keep the rollover assertion
    // valid both before and after that gate is integrated.
    chain.engine.game = async () => next
    chain.game(next)
    await flush()
    chain.seatReads[1].resolve(facts(["AlreadyPlaying"]))
    await flush()
    chain.engine.game = () => new Promise(() => {})
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      return { ok: true }
    })

    void source.register!().catch(() => {})
    await answerReads(chain, 6_000)
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    expect(signupFailures()).toHaveLength(0)
    source.cancelRegister!()
    stop()
  })

  it("does not use game N's deadline when game N+1 arrives through the fallback read", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    chain.engine.seat = seatsOf(facts(["AlreadyPlaying"]))
    const first = { ...GAME, registration_ends: NOW + 3 }
    const next = { ...GAME, index: GAME.index + 1, registration_ends: NOW + 120 }
    const { source, stop } = watching(chain.engine)
    chain.game(first)
    await flush()

    // The watch reports the old slot empty but stays quiet for the successor;
    // only the finalized fallback read discovers game N+1.
    chain.game(undefined)
    chain.engine.game = async () => next
    chain.now(NOW + 4, 1)
    await flush()
    chain.engine.game = () => new Promise(() => {})
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      return { ok: true }
    })

    void source.register!().catch(() => {})
    await answerReads(chain, 6_000)
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    expect(signupFailures()).toHaveLength(0)
    source.cancelRegister!()
    stop()
  })

  it("moves the retry deadline to game N+1, then closes when its host goes silent", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    const first = { ...GAME, registration_ends: NOW + 15 }
    const next = { ...GAME, index: GAME.index + 1, registration_ends: NOW + 30 }
    chain.engine.game = async () => first
    fails(chain, "HostDisconnectedError: host went away", 1000)
    const { source, stop } = watching(chain.engine)
    chain.game(first)
    await flush()
    chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
    await flush()

    const outcome = source.register!()
    for (let i = 0; i < 10 && vi.mocked(chain.engine.register).mock.calls.length === 0; i += 1)
      await answerReads(chain, 1_000)
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    chain.engine.game = async () => next
    for (let i = 0; i < 15 && vi.mocked(chain.engine.register).mock.calls.length < 2; i += 1)
      await answerReads(chain, 1_000)
    expect(chain.engine.register).toHaveBeenCalledTimes(2)
    chain.engine.game = () => new Promise(() => {})
    let settled = false
    void outcome.then(() => (settled = true))
    chain.now(NOW + 16, 2)
    await answerReads(chain, Math.max(1_000, (NOW + 16) * 1_000 - Date.now()))
    expect(Date.now()).toBeGreaterThanOrEqual((NOW + 16) * 1_000)
    expect(settled).toBe(false)
    chain.now(NOW + 31, 3)
    // the next attempt, after its 15 s backoff, finds the window closed
    await answerReads(chain, Math.max(1_000, (NOW + 31) * 1_000 - Date.now()) + 10_000)
    expect(signupFailures().map((failure) => failure.details.reason)).toEqual(["window-closed"])
    const attempts = vi.mocked(chain.engine.register).mock.calls.length
    await answerReads(chain, 15_000)
    expect(chain.engine.register).toHaveBeenCalledTimes(attempts)
    await expect(outcome).resolves.toBeUndefined()
    stop()
  })

  it("stops when the registration window closes, and ends the journey closed", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    fails(chain, "Invalid transaction: Custom(172)", 1000)
    const { outcome } = await tap(chain)
    await answerReads(chain, 5_000)
    // the window shuts on the chain's clock
    chain.engine.game = async () => ({ ...GAME, registration_ends: Math.floor(Date.now() / 1000) - 1 })
    await answerReads(chain, 40_000)
    await expect(outcome).resolves.toBe("resolved")
    const after = vi.mocked(chain.engine.register).mock.calls.length
    await answerReads(chain, 40_000)
    expect(vi.mocked(chain.engine.register).mock.calls.length).toBe(after)
    const journeys = signupJourneys()
    expect(journeys[journeys.length - 1].outcome).toBe("closed")
    expect(signupFailures().map((failure) => failure.details.reason)).toEqual(["window-closed"])
  })

  it("never rejects a tap as window-closed after finalized registration is shown", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    const finalized: { current?: PalletGame } = {}
    chain.engine.game = async () => finalized.current
    landsOnce(chain)
    const { statuses, stop, source } = watching(chain.engine)
    chain.game(GAME)
    await flush()
    expect(statuses[statuses.length - 1]?.kind).not.toBe("registration")

    finalized.current = GAME
    chain.now(NOW + 6, 1)
    await flush()
    expect(statuses[statuses.length - 1]).toMatchObject({ kind: "registration", offerRegister: true })
    chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
    await flush()

    const outcome = source.register!()
    await answerReads(chain, 5_000)
    await expect(outcome).resolves.toBeUndefined()
    expect(signupFailures().map((failure) => failure.details.reason)).not.toContain("window-closed")
    stop()
  })

  it("stops retrying when the page leaves (cancelRegister)", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    fails(chain, "HostDisconnectedError: host went away", 1000)
    const { source } = await tap(chain)
    await answerReads(chain, 3_000)
    source.cancelRegister!()
    await answerReads(chain, 20_000)
    const calls = vi.mocked(chain.engine.register).mock.calls.length
    await answerReads(chain, 40_000)
    expect(vi.mocked(chain.engine.register).mock.calls.length).toBe(calls)
  })

  /** a tap while the free seat is still being prepared: the first seat read
   *  says unbound, the bind is the test's to land, the next read sees it */
  async function tapUnbound(chain: ReturnType<typeof fakeEngine>) {
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    const bind = deferred<BindResult>()
    chain.bind.mockReturnValue(bind.promise)
    const { source, outcome } = await tap(chain, facts(["AliasNotBound"]))
    return { source, outcome, bind }
  }
  const landsOnce = (chain: ReturnType<typeof fakeEngine>) =>
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      return { ok: true }
    })

  it("reconciles attempt one as landed before an AliasNotBound seat can be filed unbound", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    vi.mocked(holdGameReminder).mockClear()
    chain.engine.player = vi
      .fn<GameEngine["player"]>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ registered: true } as never)
    const { outcome } = await tap(chain, facts(["AliasNotBound"]))

    await expect(outcome).resolves.toBe("resolved")
    expect(chain.bind).not.toHaveBeenCalled()
    expect(chain.engine.register).not.toHaveBeenCalled()
    expect(signupJourneys()).toHaveLength(1)
    expect(signupJourneys()[0]).toMatchObject({ outcome: "landed", endAttrs: { "signup.landed_by": "reread" } })
    expect(signupJourneys()[0].attrs["signup.retry_reason"]).toBeUndefined()
    await vi.waitFor(() => expect(holdGameReminder).toHaveBeenCalledTimes(1))
  })

  it("files the sign-up by itself once the bind lands: one tap, one landed journey", async () => {
    const chain = fakeEngine()
    landsOnce(chain)
    const { outcome, bind } = await tapUnbound(chain)
    expect(chain.engine.register).not.toHaveBeenCalled()
    bind.resolve(BOUND)
    await answerReads(chain, 10_000, ["AliasNotBound"])
    await expect(outcome).resolves.toBe("resolved")
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    const journeys = signupJourneys()
    expect(journeys[0].outcome).toBe("unbound")
    expect(journeys[0].sad).toEqual(["seat-preparing"])
    expect(journeys[0].attrs["signup.retry_reason"]).toBe("bind-pending")
    expect(journeys[journeys.length - 1].outcome).toBe("landed")
    expect(journeys.every((journey) => journey.attrs["signup.taps"] === "1")).toBe(true)
    expect(signupFailures()).toHaveLength(0)
  })

  it("does nothing for a tap while a sign-up is in flight: one loop per player", async () => {
    const chain = fakeEngine()
    landsOnce(chain)
    const { source, outcome, bind } = await tapUnbound(chain)
    void source.register!().catch(() => {})
    void source.register!().catch(() => {})
    await flush()
    expect(chain.seatReads).toHaveLength(1)
    bind.resolve(BOUND)
    await answerReads(chain, 15_000, ["AliasNotBound"])
    await outcome
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    expect(signupJourneys().every((journey) => journey.attrs["signup.taps"] === "1")).toBe(true)
  })

  it("keeps waiting for a bind that is slow, and files the moment it lands", async () => {
    const chain = fakeEngine()
    landsOnce(chain)
    const { outcome, bind } = await tapUnbound(chain)
    await answerReads(chain, 60_000, ["AliasNotBound"])
    expect(chain.engine.register).not.toHaveBeenCalled()
    bind.resolve(BOUND)
    await answerReads(chain, 20_000, ["AliasNotBound"])
    await expect(outcome).resolves.toBe("resolved")
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
  })

  /** a free seat whose bind already landed: the route a Custom(17x) refusal belongs to */
  async function boundFreeSource(chain: ReturnType<typeof fakeEngine>) {
    vi.mocked(liteKey).mockResolvedValue(PERSON)
    chain.bind.mockResolvedValue(BOUND)
    const { source } = watching(chain.engine)
    chain.game()
    await flush()
    await answerReads(chain, 3_000, ["AliasNotBound"])
    return source
  }

  it("sends a Custom(175) refusal back through the bind and files again", async () => {
    const chain = fakeEngine()
    const source = await boundFreeSource(chain)
    fails(chain, "Invalid transaction: Custom(175)", 1)
    const outcome = source.register!().then(
      () => "resolved",
      (error: Error) => error.message,
    )
    await answerReads(chain, 15_000, ["AliasNotBound"])
    await expect(outcome).resolves.toBe("resolved")
    expect(chain.engine.register).toHaveBeenCalledTimes(2)
    expect(chain.bind).toHaveBeenCalledTimes(2)
    expect(signupJourneys().map((journey) => journey.outcome)).toEqual(["unbound", "landed"])
    expect(signupJourneys()[0].attrs["signup.retry_reason"]).toBe("no-alias")
    expect(signupFailures()).toHaveLength(0)
  })

  it("keeps retrying a Custom(172) refusal (stale ring revision) until the ring is read", async () => {
    const chain = fakeEngine()
    const source = await boundFreeSource(chain)
    fails(chain, "Invalid transaction: Custom(172)", 3)
    const outcome = source.register!().then(
      () => "resolved",
      () => "rejected",
    )
    await answerReads(chain, 40_000, ["AliasNotBound"])
    await expect(outcome).resolves.toBe("resolved")
    expect(chain.engine.register).toHaveBeenCalledTimes(4)
    expect(signupJourneys()[0].attrs["signup.retry_reason"]).toBe("stale-alias")
    expect(signupFailures()).toHaveLength(0)
  })

  /** a sign-up that reached the wire, then the landing watch gave up with `error` */
  function trackingLost(chain: ReturnType<typeof fakeEngine>, error: string, registered: boolean, landingUnknown = true) {
    vi.mocked(liteKey).mockResolvedValue(null)
    let reads = 0
    chain.engine.player = vi.fn(async () => {
      reads += 1
      return reads > 1 && registered ? ({ registered: true } as never) : undefined
    })
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      return { ok: false, error, ...(landingUnknown ? { landingUnknown: true as const } : {}) }
    })
    return tap(chain)
  }

  it("ends landed when the landing watch stops but the chain has the player", async () => {
    const chain = fakeEngine()
    await trackingLost(chain, "Tracking stopped", true)
    await answerReads(chain, 15_000) // two blocks of waiting, then the re-read
    const [journey] = signupJourneys()
    expect(journey.outcome).toBe("landed")
    expect(journey.endAttrs).toEqual({ "signup.landed_by": "reread" })
    expect(signupFailures()).toHaveLength(0)
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
  })

  it("re-reads the chain when the landing watch stops before the sign-up reached the wire", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    chain.engine.player = vi
      .fn<GameEngine["player"]>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ registered: true } as never)
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      return { ok: false, error: "Tracking stopped", landingUnknown: true as const }
    })
    const { outcome } = await tap(chain)
    await expect(outcome).resolves.toBe("resolved")
    expect(signupJourneys()[0].outcome).toBe("landed")
    expect(signupFailures()).toHaveLength(0)
  })

  it("goes again when the landing watch stops and the chain does not have the player", async () => {
    const chain = fakeEngine()
    await trackingLost(chain, "Tracking stopped", false)
    await answerReads(chain, 15_000)
    expect(signupJourneys()[0].outcome).toBe("retrying")
    expect(signupJourneys()[0].attrs["signup.retry_reason"]).toBe("tracking-lost")
    expect(signupFailures()).toHaveLength(0)
  })

  it("re-reads after any error past the broadcast, whatever flag the engine set", async () => {
    const chain = fakeEngine()
    await trackingLost(chain, "Tracking stopped", true, false)
    await answerReads(chain, 15_000)
    expect(chain.engine.player).toHaveBeenCalled()
    expect(signupJourneys()[0].outcome).toBe("landed")
  })

  describe("a page that sleeps while the sign-up is in flight (#521)", () => {
    let doc: EventTarget & { visibilityState: string }
    beforeEach(() => {
      doc = Object.assign(new EventTarget(), { visibilityState: "visible" })
      vi.stubGlobal("document", doc)
      vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "", href: "" } }))
      vi.mocked(holdGameReminder).mockClear()
    })
    afterEach(() => vi.unstubAllGlobals())
    /** the central tracker's edge, as the foreground tracker reports it */
    const setHidden = (hidden: boolean) => {
      doc.visibilityState = hidden ? "hidden" : "visible"
      reportPageActivity(hidden)
    }
    /** broadcast, then a landing watch that never reports (a frozen page) */
    function broadcastsThenHangs(chain: ReturnType<typeof fakeEngine>) {
      vi.mocked(liteKey).mockResolvedValue(null)
      const state = { registered: false }
      chain.engine.player = vi.fn(async () => (state.registered ? ({ registered: true } as never) : undefined))
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(1))
        options?.onBroadcast?.()
        return new Promise(() => {})
      })
      return state
    }

    it("ends landed from one chain read when the page returns after a wall jump, timers not yet fired", async () => {
      const chain = fakeEngine()
      const state = broadcastsThenHangs(chain)
      const { source } = await tap(chain)
      await answerReads(chain, 2_000)
      setHidden(true)
      vi.setSystemTime(Date.now() + 1_688_000) // frozen: no timer runs
      state.registered = true
      const reads = vi.mocked(chain.engine.player).mock.calls.length
      setHidden(false)
      await flush()
      const [journey] = signupJourneys()
      expect(journey.outcome).toBe("landed")
      expect(journey.endAttrs).toEqual({ "signup.landed_by": "reread", "signup.on_return": "true" })
      expect(journey.attrs["signup.hidden_ms"]).toBe("1688000")
      expect(vi.mocked(chain.engine.player).mock.calls.length - reads).toBe(1)
      expect(chain.engine.register).toHaveBeenCalledTimes(1)
      expect(signupFailures()).toHaveLength(0)
      source.cancelRegister!()
    })

    it("ends closed with the page-asleep reason when registration closed and the player is not in", async () => {
      const chain = fakeEngine()
      broadcastsThenHangs(chain)
      let closed = false
      chain.engine.game = async () => (closed ? ({ ...GAME, state: { type: "Shuffle" } } as PalletGame) : GAME)
      const { source } = await tap(chain)
      await answerReads(chain, 2_000)
      setHidden(true)
      closed = true
      vi.setSystemTime(Date.now() + 1_688_000)
      setHidden(false)
      await flush()
      const [journey] = signupJourneys()
      expect(journey.outcome).toBe("closed")
      expect(journey.attrs["signup.retry_reason"]).toBe("page-asleep")
      expect(journey.attrs["signup.on_return"]).toBe("asleep")
      expect(signupFailures()[0]).toMatchObject({ details: { reason: "window-closed" } })
      expect(chain.engine.register).toHaveBeenCalledTimes(1)
      source.cancelRegister!()
    })

    it("waits two blocks and re-reads when the deadline passed with the transaction possibly in the pool", async () => {
      const chain = fakeEngine()
      const state = broadcastsThenHangs(chain)
      const { source } = await tap(chain)
      await answerReads(chain, 2_000)
      setHidden(true)
      vi.setSystemTime(Date.now() + 100_000) // past the 45 s wire deadline, timer unfired
      const monotonic = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 100_000)
      setHidden(false)
      await flush()
      monotonic.mockRestore()
      expect(signupJourneys()[0].outcome).toBeUndefined() // no early second sign-up
      state.registered = true // the queued transaction lands as the host wakes
      await vi.advanceTimersByTimeAsync(12_000)
      expect(signupJourneys()[0].outcome).toBe("landed")
      expect(chain.engine.register).toHaveBeenCalledTimes(1)
      source.cancelRegister!()
    })

    it("goes again after the wait when the re-read still finds nobody", async () => {
      const chain = fakeEngine()
      broadcastsThenHangs(chain)
      const { source } = await tap(chain)
      await answerReads(chain, 2_000)
      setHidden(true)
      vi.setSystemTime(Date.now() + 100_000)
      const monotonic = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 100_000)
      setHidden(false)
      await flush()
      monotonic.mockRestore()
      await vi.advanceTimersByTimeAsync(12_000)
      expect(signupJourneys()[0].outcome).toBe("retrying")
      expect(signupJourneys()[0].attrs["signup.retry_reason"]).toBe("timeout")
      expect(signupJourneys()[0].attrs["signup.on_return"]).toBe("expired")
      source.cancelRegister!()
    })

    it("ends the journey once when the overdue timer fires before the page's return", async () => {
      const chain = fakeEngine()
      const state = broadcastsThenHangs(chain)
      const { source } = await tap(chain)
      await answerReads(chain, 2_000)
      setHidden(true)
      await vi.advanceTimersByTimeAsync(44_000) // the 45 s timer has fired, settle is in its wait
      state.registered = true
      setHidden(false)
      await vi.advanceTimersByTimeAsync(13_000) // settle wakes and re-reads
      expect(signupJourneys()[0].outcome).toBe("landed")
      expect(signupJourneys()).toHaveLength(1)
      expect(holdGameReminder).toHaveBeenCalledTimes(1)
      source.cancelRegister!()
    })

    it("does not abandon a broadcast that lands during the window read", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      chain.engine.player = vi.fn(async () => undefined)
      let broadcast!: () => void
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(1))
        broadcast = () => options?.onBroadcast?.()
        return new Promise(() => {})
      })
      const { source } = await tap(chain)
      await answerReads(chain, 2_000)
      setHidden(true)
      vi.setSystemTime(Date.now() + 100_000) // past the 90 s pre-wire deadline
      const monotonic = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 100_000)
      const read = deferred<PalletGame>()
      let held = false
      chain.engine.game = () => (held ? read.promise : Promise.resolve(GAME))
      held = true
      setHidden(false)
      await flush()
      monotonic.mockRestore()
      broadcast() // lands while the window is being read
      read.resolve(GAME)
      await flush()
      expect(signupJourneys()[0].outcome).toBeUndefined()
      expect(chain.engine.register).toHaveBeenCalledTimes(1)
      source.cancelRegister!()
    })

    it("re-reads on return for an attempt that began while the page was hidden", async () => {
      const chain = fakeEngine()
      const state = broadcastsThenHangs(chain)
      doc.visibilityState = "hidden"
      const { source } = await tap(chain)
      await answerReads(chain, 2_000)
      state.registered = true
      setHidden(false)
      await flush()
      expect(signupJourneys()[0].outcome).toBe("landed")
      source.cancelRegister!()
    })

    it("changes nothing for a sign-up that stays in front", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(1))
        options?.onBroadcast?.()
        return { ok: true }
      })
      await tap(chain)
      setHidden(false)
      await flush()
      const [journey] = signupJourneys()
      expect(journey.outcome).toBe("landed")
      expect(journey.endAttrs).toEqual({})
      expect(journey.attrs["signup.hidden_ms"]).toBeUndefined()
    })
  })

  it("does not hang on a quiet host channel: the attempt times out, the chain is re-read, and it goes again", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    let call = 0
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      call += 1
      if (call === 1) return new Promise(() => {}) // finalization never reports
      return { ok: true }
    })
    const { outcome, source } = await tap(chain)
    await expect(outcome).resolves.toBe("resolved") // on the wire
    await answerReads(chain, 120_000)
    expect(chain.engine.register).toHaveBeenCalledTimes(2)
    expect(signupJourneys().map((journey) => journey.outcome)).toEqual(["retrying", "landed"])
    expect(signupJourneys()[0].attrs["signup.retry_reason"]).toBe("timeout")
    source.cancelRegister!()
  })

  it("times out an attempt that never reached the wire too", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    let call = 0
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      call += 1
      if (call === 1) return new Promise(() => {}) // a signer that never answers
      options?.onBroadcast?.()
      return { ok: true }
    })
    const { outcome } = await tap(chain)
    await answerReads(chain, 150_000)
    await expect(outcome).resolves.toBe("resolved")
    expect(chain.engine.register).toHaveBeenCalledTimes(2)
    expect(signupJourneys()[0].outcome).toBe("retrying")
    expect(recorded.signupBroadcasts).toEqual([{ account: PLAYER, gameIndex: GAME.index, attempt: 2, route: "returning" }])
  })

  it("says it is taking longer while one attempt hangs", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      return new Promise(() => {})
    })
    const w = watching(chain.engine)
    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
    await flush()
    void w.source.register!().catch(() => {})
    await answerReads(chain, 25_000)
    expect(lastSignup(w.statuses)).toBe("slow")
    w.source.cancelRegister!()
    w.stop()
  })

  it("cancelRegister ends an attempt that is still waiting, and closes its journey", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      return new Promise(() => {})
    })
    const { source, outcome } = await tap(chain)
    await answerReads(chain, 2_000)
    source.cancelRegister!()
    await answerReads(chain, 3_000)
    await expect(outcome).resolves.toMatch(/cancel/)
    expect(signupJourneys().every((journey) => journey.ended)).toBe(true)
    expect(signupJourneys()[0].outcome).toBe("retrying")
  })

  it("coming back while it waits keeps the sign-up going and returns it", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    fails(chain, "HostDisconnectedError: host went away", 1)
    const { source } = await tap(chain)
    await answerReads(chain, 500)
    source.cancelRegister!()
    const again = source.register!().then(
      () => "resolved",
      (error: Error) => error.message,
    )
    await answerReads(chain, 40_000)
    await expect(again).resolves.toBe("resolved")
    expect(chain.engine.register).toHaveBeenCalledTimes(2)
  })

  it("never hands the engine a draw question: Register always signs up (#607)", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    const seen: Array<RegisterOptions | undefined> = []
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      seen.push(options)
      options?.onDraws?.(draws(0, "draw #0 is not taking entries yet (gave up waiting)", { kind: "not-open", scheduled: 1, waitedMs: 20_000, retries: 9 }))
      options?.onBroadcast?.()
      return { ok: true }
    })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    const outcome = source.register!().then(() => "resolved")
    await vi.waitFor(() => expect(chain.seatReads).toHaveLength(1))
    chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
    await answerReads(chain, 40_000)
    await expect(outcome).resolves.toBe("resolved")
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toHaveProperty("confirmWithoutDraws")
  })

  it("waits about two blocks after an error past the broadcast, and files again only if the player is still absent", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    let known = false
    chain.engine.player = vi.fn(async () => (known ? ({ registered: true } as never) : undefined))
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      setTimeout(() => (known = true), 5_000) // the chain takes it a few blocks later
      return { ok: false, error: "HostDisconnectedError: host went away" } // no landingUnknown flag
    })
    await tap(chain)
    await answerReads(chain, 30_000)
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    expect(signupJourneys()[0].outcome).toBe("landed")
  })

  it.each([
    ["AlreadyRegistered", "registered"],
    ["InvalidGameState", "closed"],
    // the pallet's word for a sign-up after the window closed (#581)
    ["NoRegistration", "closed"],
    ["UseInviteButAlreadyPlaying", "refused"],
    ["Invalid transaction: Payment", "refused"],
  ])("does not retry %s: the chain's word", async (error, end) => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      return { ok: false, error }
    })
    const w = watching(chain.engine)
    chain.game()
    await flush()
    chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
    await flush()
    void w.source.register!().catch(() => {})
    await answerReads(chain, 60_000)
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    expect(lastSignup(w.statuses)).toBe(end === "registered" ? "idle" : end === "closed" ? "closed" : "refused")
    w.stop()
  })

  it("reports each failed attempt with its stage, tagged as retrying, and closes every journey", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    fails(chain, "HostDisconnectedError: host went away", 2)
    const { outcome } = await tap(chain)
    await answerReads(chain, 30_000)
    await outcome
    expect(retryFailures().map((failure) => failure.details.reason)).toEqual(["tx.broadcast", "tx.broadcast"])
    expect(signupJourneys().slice(0, 2).every((journey) => journey.attrs["signup.retrying"] === "true")).toBe(true)
    expect(signupJourneys().every((journey) => journey.ended)).toBe(true)
    expect(signupFailures()).toHaveLength(0)
  })

  it("a sign-up the chain took after the watch gave up is found by the re-read, and nothing is filed twice", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    let known = false
    chain.engine.player = vi.fn(async () => (known ? ({ registered: true } as never) : undefined))
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      options?.onBroadcast?.()
      known = true // the chain took it after the watch gave up
      return { ok: false, error: "Tracking stopped" }
    })
    const { outcome } = await tap(chain)
    await answerReads(chain, 20_000)
    await expect(outcome).resolves.toBe("resolved")
    expect(chain.engine.register).toHaveBeenCalledTimes(1)
    expect(signupJourneys().map((journey) => journey.outcome)).toEqual(["landed"])
  })

  // #579 (found by a model check): a landing the re-read finds is a landing,
  // whether or not the host ever reported "broadcasted"
  it("shows the player registered when the re-read finds a sign-up whose broadcast was never reported", async () => {
    const chain = fakeEngine()
    vi.mocked(liteKey).mockResolvedValue(null)
    let onChain = false
    chain.engine.player = vi.fn(async () => (onChain ? ({ registered: true } as never) : undefined))
    vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
      options?.onDraws?.(draws(1))
      // the host signed and submitted, but its "broadcasted" never comes
      setTimeout(() => (onChain = true), 20_000)
      return new Promise(() => {})
    })
    const w = watching(chain.engine)
    chain.game()
    await flush()
    void w.source.register!().catch(() => {})
    // the pre-wire deadline, then its re-read; no block tick in between
    await answerReads(chain, 100_000)
    expect(signupJourneys().map((journey) => journey.outcome)).toContain("landed")
    const last = w.statuses[w.statuses.length - 1]
    expect(last.kind === "registration" && last.registered).toBe(true)
    w.stop()
  })

  // #582 (found by a model check): before a closed window ends a sign-up, the
  // chain is asked whether the player is already in
  describe("a closed window and a player who is in (#582)", () => {
    it("does not end a registered player's sign-up as window-closed", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      let onChain = false
      let closed = false
      chain.engine.player = vi.fn(async () => (onChain ? ({ registered: true } as never) : undefined))
      chain.engine.game = async () => (closed ? ({ ...GAME, state: { type: "Shuffle" } } as unknown as PalletGame) : GAME)
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(1))
        // the host fails before the wire; meanwhile the chat's sign-up lands
        // and registration closes
        onChain = true
        closed = true
        return { ok: false, error: "HostDisconnectedError: host went away" }
      })
      const w = watching(chain.engine)
      chain.game()
      await flush()
      void w.source.register!().catch(() => {})
      await answerReads(chain, 20_000)
      expect(signupJourneys().map((journey) => journey.outcome)).toEqual(["retrying", "landed"])
      expect(signupFailures().filter((failure) => failure.details.reason === "window-closed")).toEqual([])
      const last = w.statuses[w.statuses.length - 1]
      expect(last.kind === "registration" && last.registered).toBe(true)
      w.stop()
    })

    it("does not end it as window-closed when the chain refuses with NoRegistration and the player is in", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      let onChain = false
      chain.engine.player = vi.fn(async () => (onChain ? ({ registered: true } as never) : undefined))
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(1))
        // an earlier sign-up landed late, and this one is refused: the window shut
        onChain = true
        return { ok: false, error: "NoRegistration" }
      })
      const { outcome } = await tap(chain)
      await answerReads(chain, 20_000)
      await expect(outcome).resolves.toBe("resolved")
      expect(signupJourneys().map((journey) => journey.outcome)).toEqual(["landed"])
      expect(signupFailures().filter((failure) => failure.details.reason === "window-closed")).toEqual([])
    })

    it("keeps you're in up while it asks, when a broadcast sign-up is refused closed and the player is in", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      let onChain = false
      chain.engine.player = vi.fn(async () => (onChain ? ({ registered: true } as never) : undefined))
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(1))
        options?.onBroadcast?.()
        // an earlier sign-up landed; this one is refused because the window shut
        onChain = true
        return { ok: false, error: "NoRegistration" }
      })
      const w = watching(chain.engine)
      chain.game()
      await flush()
      void w.source.register!().catch(() => {})
      await answerReads(chain, 20_000)
      const registered = w.statuses.map((status) => status.kind === "registration" && status.registered)
      const up = registered.indexOf(true)
      expect(up).toBeGreaterThanOrEqual(0)
      expect(registered.slice(up)).not.toContain(false) // no flicker back to Register
      w.stop()
    })

    it("still ends closed when the Players read fails, and says it was not verified", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      let closed = false
      chain.engine.player = vi.fn(async () => {
        if (closed) throw new Error("host hiccup")
        return undefined
      })
      chain.engine.game = async () => (closed ? ({ ...GAME, state: { type: "Shuffle" } } as unknown as PalletGame) : GAME)
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(1))
        closed = true
        return { ok: false, error: "HostDisconnectedError: host went away" }
      })
      const { outcome } = await tap(chain)
      await answerReads(chain, 20_000)
      await outcome
      const journeys = signupJourneys()
      expect(journeys[journeys.length - 1].outcome).toBe("closed")
      expect(journeys[journeys.length - 1].endAttrs?.["signup.closed_unverified"]).toBe("true")
    })
  })

  // #578 (found by a model check): the route step has a deadline, so one
  // dropped host answer is a retry and never holds the sign-up
  describe("a route step the host never answers (#578)", () => {
    it("files the sign-up once the host answers again after dropping one lite-key lookup", async () => {
      const chain = fakeEngine()
      let calls = 0
      vi.mocked(liteKey).mockImplementation(() => {
        calls += 1
        return calls === 1 ? new Promise(() => {}) : Promise.resolve(null) // dropped once, then answers
      })
      chain.engine.player = vi.fn(async () => undefined)
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(1))
        options?.onBroadcast?.()
        return { ok: true }
      })
      const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
      void source.register!().catch(() => {})
      // the dropped lookup is waited on for 10 s per attempt, then given up
      // for a fresh one once it is stale
      await answerReads(chain, 120_000, ["AlreadyPlaying"], 5_000)
      expect(chain.engine.register).toHaveBeenCalledTimes(1)
      expect(signupJourneys().map((journey) => journey.outcome).slice(-1)).toEqual(["landed"])
      expect(signupJourneys()[0].attrs["signup.retry_reason"]).toBe("timeout")
      source.cancelRegister!()
    })

    it("signs a lite person up on the next attempt when the host answers the lookup in 11 s", async () => {
      const chain = fakeEngine()
      let calls = 0
      vi.mocked(liteKey).mockImplementation(() => {
        calls += 1
        // the first answer comes after the attempt's 10 s; a second ask would never be answered
        return calls === 1 ? new Promise((resolve) => setTimeout(() => resolve(PERSON), 11_000)) : new Promise(() => {})
      })
      chain.engine.player = vi.fn(async () => undefined)
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(1))
        options?.onBroadcast?.()
        return { ok: true }
      })
      const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
      void source.register!().catch(() => {})
      await answerReads(chain, 30_000, [])
      expect(chain.engine.register).toHaveBeenCalledTimes(1)
      expect(recorded.signupBroadcasts).toEqual([expect.objectContaining({ route: "free" })])
      expect(signupJourneys().map((journey) => journey.outcome)).toEqual(["retrying", "landed"])
      source.cancelRegister!()
    })

    it("ends the sign-up closed when registration closes behind a hung lookup", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockImplementation(() => new Promise(() => {}))
      chain.engine.player = vi.fn(async () => undefined)
      const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
      let settled = false
      void source.register!().then(
        () => (settled = true),
        () => (settled = true),
      )
      await answerReads(chain, 7_300_000, ["AlreadyPlaying"], 60_000) // past registration_ends (NOW + 7200)
      const journeys = signupJourneys()
      expect(journeys[journeys.length - 1].outcome).toBe("closed")
      expect(journeys.every((journey) => journey.ended)).toBe(true)
      expect(settled).toBe(true)
      expect(chain.engine.register).not.toHaveBeenCalled()
    })

    it("ends a route step held when the page leaves", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockImplementation(() => new Promise(() => {}))
      chain.engine.player = vi.fn(async () => undefined)
      const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
      const outcome = source.register!().then(
        () => "resolved",
        (error: Error) => error.message,
      )
      await answerReads(chain, 2_000)
      source.cancelRegister!()
      expect(await Promise.race([outcome, flush().then(() => "still held")])).toBe("the sign-up was cancelled")
    })
  })

  // #580 (found by a model check): the call that put the optimistic flag up
  // takes it down on a refusal, even after its attempt was given up on
  describe("an abandoned sign-up's refusal (#580)", () => {
    async function broadcastThenLeave(refusal: string, onChainAfter = false) {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      let onChain = false
      chain.engine.player = vi.fn(async () => (onChain ? ({ registered: true } as never) : undefined))
      const result = deferred<{ ok: false; error: string }>()
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(1))
        options?.onBroadcast?.()
        return result.promise
      })
      const w = watching(chain.engine)
      chain.game()
      await flush()
      void w.source.register!().catch(() => {})
      await answerReads(chain, 3_000)
      w.source.cancelRegister!() // the home unmounts
      await flush()
      onChain = onChainAfter
      result.resolve({ ok: false, error: refusal })
      await answerReads(chain, 30_000)
      w.stop()
      // the home mounts again
      const statuses: GameStatus[] = []
      const stop = w.source.watchStatus((status) => statuses.push(status))
      chain.game()
      await flush()
      stop()
      const last = statuses[statuses.length - 1]
      return last.kind === "registration" && last.registered
    }

    it("rolls the optimistic flag back when an abandoned sign-up's dispatch fails", async () => {
      expect(await broadcastThenLeave("NoRegistration")).toBe(false)
    })

    it("rolls it back on a failure that may still land only once the chain says the player is not in", async () => {
      expect(await broadcastThenLeave("Tracking stopped")).toBe(false)
    })

    it("keeps it when the chain has the player all the same", async () => {
      expect(await broadcastThenLeave("Tracking stopped", true)).toBe(true)
    })

    it("keeps it on a closed refusal when the chain has the player all the same", async () => {
      expect(await broadcastThenLeave("NoRegistration", true)).toBe(true)
    })
  })

  // #577 (found by a model check): an attempt given up on never reaches the
  // wire afterwards. #607: there is no draw question any more, and the sign-up
  // says what it did about the draw on its journey instead.
  describe("an abandoned call, and the draw on the sign-up (#577, #607)", () => {
    const onDrawsSkipped = (options: RegisterOptions | undefined, kind: "not-open" | "signature" = "not-open") =>
      options?.onDraws?.(draws(0, `draw #0 raw ${kind} text (gave up waiting)`, { kind, scheduled: 2, waitedMs: 19_000, retries: 8 }))
    const drawFailures = () => recorded.failures.filter((failure) => failure.kind === "draw-skipped")

    async function signedUp(chain: ReturnType<typeof fakeEngine>, ms = 40_000) {
      const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
      const outcome = source.register!().then(() => "resolved")
      await vi.waitFor(() => expect(chain.seatReads).toHaveLength(1))
      chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
      await answerReads(chain, ms)
      return { source, outcome }
    }

    it("puts the draw on the sign-up's span and reports one draw-skipped event with the kind and the raw text", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        onDrawsSkipped(options)
        options?.onBroadcast?.()
        return { ok: true }
      })
      const { outcome } = await signedUp(chain)
      await expect(outcome).resolves.toBe("resolved")
      const [journey] = signupJourneys()
      expect(journey.attrs).toMatchObject({
        "signup.draw.outcome": "skipped",
        "signup.draw.kind": "not-open",
        "signup.draw.scheduled": 2,
        "signup.draw.waited_ms": 19000,
        "signup.draw.retries": 8,
        "draw.skipped": "draw #0 raw not-open text (gave up waiting)",
      })
      expect(drawFailures()).toHaveLength(1)
      expect(drawFailures()[0]).toMatchObject({
        details: { reason: "not-open", context: { kind: "not-open", skipped: "draw #0 raw not-open text (gave up waiting)" } },
        journey: "game-signup",
        expected: true,
      })
    })

    it("reports the draw-skipped event once per sign-up, though a retry decides the draw again", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      let call = 0
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        call += 1
        onDrawsSkipped(options)
        if (call === 1) return { ok: false, error: "HostDisconnectedError: host went away" }
        options?.onBroadcast?.()
        return { ok: true }
      })
      const { outcome } = await signedUp(chain, 60_000)
      await expect(outcome).resolves.toBe("resolved")
      expect(chain.engine.register).toHaveBeenCalledTimes(2)
      expect(drawFailures()).toHaveLength(1)
      // every attempt's own span still says what it did
      expect(signupJourneys().map((journey) => journey.attrs["signup.draw.outcome"])).toEqual(["skipped", "skipped"])
    })

    it("waits for a fresh follow and retries a not-pinned sign-up transaction once", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      vi.mocked(chain.engine.register)
        .mockResolvedValueOnce({ ok: false, error: "Block 0x123 is not pinned (stop-call)" })
        .mockImplementationOnce(async (_capabilities, _id, options) => {
          options?.onBroadcast?.()
          return { ok: true }
        })
      const { outcome } = await signedUp(chain)

      await expect(outcome).resolves.toBe("resolved")
      expect(chain.engine.waitUntilFollowing).toHaveBeenCalledTimes(1)
      expect(chain.engine.register).toHaveBeenCalledTimes(2)
      expect(recorded.metrics).toContainEqual(expect.objectContaining({
        name: "chain.retries",
        value: 1,
        attrs: expect.objectContaining({
          "chain.retry_reason": "block-not-pinned",
          "chain.retry_operation": "signup-tx",
          "chain.retry_succeeded": "true",
        }),
      }))
    })

    it("does not file a second sign-up after a broadcast not-pinned failure", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      let registered = false
      chain.engine.player = vi.fn(async () => (registered ? ({ registered: true } as never) : undefined))
      vi.mocked(chain.engine.register).mockImplementationOnce(async (_capabilities, _id, options) => {
        options?.onBroadcast?.()
        registered = true
        return { ok: false, error: "Block 0x123 is not pinned (stop-call)" }
      })
      const { outcome } = await signedUp(chain)

      await expect(outcome).resolves.toBe("resolved")
      expect(chain.engine.register).toHaveBeenCalledTimes(1)
      expect(chain.engine.waitUntilFollowing).not.toHaveBeenCalled()
      expect(chain.engine.player).toHaveBeenCalledTimes(2)
      expect(signupJourneys()[0]).toMatchObject({
        outcome: "landed",
        endAttrs: { "signup.landed_by": "reread" },
      })
    })

    it("files no draw-skipped event for an attempt that skipped but never went out, when the next one enters", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      let call = 0
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        call += 1
        if (call === 1) {
          onDrawsSkipped(options)
          return { ok: false, error: "HostDisconnectedError: host went away" } // never reached the wire
        }
        options?.onDraws?.(draws(2, undefined, { scheduled: 2, waitedMs: 0, retries: 0 }))
        options?.onBroadcast?.()
        return { ok: true }
      })
      const { outcome } = await signedUp(chain, 60_000)
      await expect(outcome).resolves.toBe("resolved")
      expect(chain.engine.register).toHaveBeenCalledTimes(2)
      expect(drawFailures()).toEqual([])
    })

    it("files no draw-skipped event when the sign-up that skipped is refused before the wire", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        onDrawsSkipped(options)
        return { ok: false, error: "Transaction signing was rejected." }
      })
      const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
      const outcome = source.register!().then(
        () => "resolved",
        (error: Error) => error.message,
      )
      await vi.waitFor(() => expect(chain.seatReads).toHaveLength(1))
      chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
      await answerReads(chain, 5_000)
      await expect(outcome).resolves.toMatch(/signing was rejected/)
      expect(drawFailures()).toEqual([])
    })

    it("calls a sign-up that carried its tickets entered, and sends no event", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(2, undefined, { scheduled: 2, waitedMs: 2_000, retries: 1 }))
        options?.onBroadcast?.()
        return { ok: true }
      })
      const { outcome } = await signedUp(chain)
      await expect(outcome).resolves.toBe("resolved")
      expect(signupJourneys()[0].attrs).toMatchObject({ "signup.draw.outcome": "entered", "signup.draw.scheduled": 2, "signup.draw.retries": 1 })
      expect(signupJourneys()[0].attrs["signup.draw.kind"]).toBeUndefined()
      expect(drawFailures()).toEqual([])
    })

    it("calls a game with no draw no-draw, and sends no event", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(0, "the game has no prize draw", { scheduled: 0, waitedMs: 0, retries: 0 }))
        options?.onBroadcast?.()
        return { ok: true }
      })
      const { outcome } = await signedUp(chain)
      await expect(outcome).resolves.toBe("resolved")
      expect(signupJourneys()[0].attrs["signup.draw.outcome"]).toBe("no-draw")
      expect(drawFailures()).toEqual([])
    })

    it("says nothing of the draw for a call given up on, and files nothing", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      chain.engine.player = vi.fn(async () => undefined)
      const broadcasts: number[] = []
      const drawWait = deferred<void>()
      let call = 0
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        call += 1
        const mine = call
        if (mine === 1) await drawWait.promise // the engine waits for the draw to open
        if (options?.signal?.aborted) return { ok: false, error: "aborted" }
        onDrawsSkipped(options)
        options?.onBroadcast?.()
        broadcasts.push(mine)
        return new Promise(() => {})
      })
      const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
      void source.register!().catch(() => {})
      await vi.waitFor(() => expect(chain.seatReads).toHaveLength(1))
      await answerReads(chain, 3_000)
      source.cancelRegister!() // the page leaves while the engine waits
      await flush()
      drawWait.resolve()
      await answerReads(chain, 2_000)
      expect(broadcasts).toEqual([])
      expect(drawFailures()).toEqual([])
    })

    it("aborts a call the host was too slow to sign, and it sends nothing", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      chain.engine.player = vi.fn(async () => undefined)
      const broadcasts: number[] = []
      const signals: Array<AbortSignal | undefined> = []
      const firstSigning = deferred<void>()
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        signals.push(options?.signal)
        const mine = signals.length
        options?.onDraws?.(draws(1))
        if (mine === 1) await firstSigning.promise // the host takes two minutes
        if (options?.signal?.aborted) throw options.signal.reason
        options?.onBroadcast?.()
        broadcasts.push(mine)
        return new Promise(() => {})
      })
      const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
      void source.register!().catch(() => {})
      await vi.waitFor(() => expect(chain.seatReads).toHaveLength(1))
      await answerReads(chain, 110_000)
      expect(signals[0]?.aborted).toBe(true)
      firstSigning.resolve()
      await answerReads(chain, 5_000)
      expect(broadcasts).toEqual([2])
      source.cancelRegister!()
    })

    it("does not put the flag up from an abandoned call that broadcasts anyway", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      chain.engine.player = vi.fn(async () => undefined)
      const firstSigning = deferred<void>()
      let call = 0
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        call += 1
        options?.onDraws?.(draws(1))
        if (call > 1) return new Promise(() => {}) // the next attempt stays in signing
        await firstSigning.promise // an engine that does not honour the signal
        options?.onBroadcast?.()
        return new Promise(() => {})
      })
      const w = watching(chain.engine)
      chain.game()
      await flush()
      void w.source.register!().catch(() => {})
      await answerReads(chain, 110_000) // the first call is given up on
      firstSigning.resolve()
      await answerReads(chain, 2_000)
      const last = w.statuses[w.statuses.length - 1]
      expect(last.kind === "registration" && last.registered).toBe(false)
      w.stop()
      w.source.cancelRegister!()
    })
  })

  // The names on the prize-draw wheel (#456): the player's username is linked to
  // the account that holds their tickets in the background, and no sign-up
  // goes without it.
  describe("the name link before a sign-up", () => {
    const landsAtOnce = (chain: ReturnType<typeof fakeEngine>) =>
      vi.mocked(chain.engine.register).mockImplementation(async (_capabilities, _id, options) => {
        options?.onDraws?.(draws(1))
        options?.onBroadcast?.()
        return { ok: true }
      })
    function tapWithName(chain: ReturnType<typeof fakeEngine>, linkName: (trigger: string) => Promise<string>) {
      const link = vi.fn(linkName)
      const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS, linkName: link as never })
      const outcome = source.register!().then(
        () => "resolved",
        (error: Error) => error.message,
      )
      return { link, source, outcome }
    }

    it("does not reread the chain while a name link is pending, and makes one attempt when it settles", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      const player = vi.fn(async () => undefined)
      chain.engine.player = player
      landsAtOnce(chain)
      const linking = deferred<string>()
      const { link, outcome } = tapWithName(chain, () => linking.promise)

      await vi.waitFor(() => expect(chain.seatReads).toHaveLength(1))
      chain.seatReads[0].resolve(facts(["AlreadyPlaying"]))
      await flush()
      expect(link).toHaveBeenCalledWith("register", expect.any(AbortSignal))
      expect(player).toHaveBeenCalledTimes(2)

      // The retry ladder's 2s, 4s and 8s waits must not start new reads while
      // the one name-link request is still in flight.
      await answerReads(chain, 20_000)
      expect(chain.seatReads).toHaveLength(1)
      expect(player).toHaveBeenCalledTimes(2)
      expect(chain.engine.register).not.toHaveBeenCalled()

      linking.resolve("linked")
      await answerReads(chain, 10_000)
      await expect(outcome).resolves.toBe("resolved")
      expect(chain.seatReads).toHaveLength(2)
      expect(player).toHaveBeenCalledTimes(3)
      expect(chain.engine.register).toHaveBeenCalledTimes(1)
      expect(link).toHaveBeenCalledTimes(1)
    })

    it("keeps the signup retry ladder after a name link settles without linking", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      landsAtOnce(chain)
      const { link, source } = tapWithName(chain, async () => "skipped")

      await answerReads(chain, 20_000)

      // Attempts may happen at the ladder's 0s, 2s, 6s and 14s steps, but a
      // fast skipped result must not turn link → chain read → link into a spin.
      expect(link).toHaveBeenCalledTimes(4)
      expect(chain.engine.register).not.toHaveBeenCalled()
      source.cancelRegister!()
    })

    it("holds the sign-up while the name links, then signs up and links no second time", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      landsAtOnce(chain)
      const linking = deferred<string>()
      const { link, outcome } = tapWithName(chain, () => linking.promise)
      await answerReads(chain, 10_000)
      // the seat waits on the name: nothing is signed yet
      expect(link).toHaveBeenCalledWith("register", expect.any(AbortSignal))
      expect(chain.engine.register).not.toHaveBeenCalled()
      expect(signupJourneys()[0]?.attrs["signup.retry_reason"]).toBe("name-pending")
      expect(signupJourneys()[0]?.outcome).toBe("retrying")
      linking.resolve("linked")
      await answerReads(chain, 20_000)
      await expect(outcome).resolves.toBe("resolved")
      expect(chain.engine.register).toHaveBeenCalledTimes(1)
      expect(link).toHaveBeenCalledTimes(1)
    })

    it("checks an unowned username again at once when the player comes back from Humanity (#1115)", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      landsAtOnce(chain)
      const answers = ["unowned", "linked"]
      const { link, outcome } = tapWithName(chain, async () => answers.shift() ?? "linked")
      await answerReads(chain, 40_000)
      // held: the sign-up loop alone asks for no second link
      expect(link).toHaveBeenCalledTimes(1)
      expect(chain.engine.register).not.toHaveBeenCalled()

      // the player went to Humanity, set the username up and came back
      reportPageActivity(true)
      reportPageActivity(false)
      await answerReads(chain, 20_000)

      expect(link).toHaveBeenCalledTimes(2)
      await expect(outcome).resolves.toBe("resolved")
      expect(chain.engine.register).toHaveBeenCalledTimes(1)
    })

    it("signs up at once for a name the account already carries", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      landsAtOnce(chain)
      const { link, outcome } = tapWithName(chain, async () => "already-linked")
      await answerReads(chain, 20_000)
      await expect(outcome).resolves.toBe("resolved")
      expect(link).toHaveBeenCalledTimes(1)
    })

    it.each(["not-signed", "unfunded", "skipped", "failed"])(
      "never signs up without the name after a link that ended %s: it links again, and signs up once linked",
      async (first) => {
        const chain = fakeEngine()
        vi.mocked(liteKey).mockResolvedValue(null)
        landsAtOnce(chain)
        const answers = [first, first, "linked"]
        const { link, outcome } = tapWithName(chain, async () => answers.shift() ?? "linked")
        await answerReads(chain, 3_000)
        expect(chain.engine.register).not.toHaveBeenCalled()
        await answerReads(chain, 40_000)
        await expect(outcome).resolves.toBe("resolved")
        expect(link).toHaveBeenCalledTimes(3)
        expect(chain.engine.register).toHaveBeenCalledTimes(1)
      },
    )

    it("keeps waiting, and links again, however long the name will not link", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      landsAtOnce(chain)
      const { link } = tapWithName(chain, async () => "skipped")
      await answerReads(chain, 10 * 60_000, undefined, 5_000)
      expect(chain.engine.register).not.toHaveBeenCalled()
      expect(link.mock.calls.length).toBeGreaterThan(10)
    })

    it("asks for no second link after a sign-up that did not land", async () => {
      const chain = fakeEngine()
      vi.mocked(liteKey).mockResolvedValue(null)
      vi.mocked(chain.engine.register).mockImplementation(async () => ({ ok: false, error: "NoRegistration" }))
      const { link, outcome } = tapWithName(chain, async () => "linked")
      await answerReads(chain, 20_000)
      await outcome
      expect(link).toHaveBeenCalledTimes(1)
    })
  })
})

// #1096: the pallet decides a player once the votes still to come cannot
// change it, and writes their score row then, long before the game settles.
describe("the verdict before the game settles (#1096)", () => {
  const REPORTING: PalletGame = { ...GAME, state: { type: "Reporting", value: { player_count: 6 } } }
  const ROW: PalletPlayerRow = {
    registered: true,
    sent_report: true,
    vote_weight: 1,
    yes_person: 2,
    no_not_person: 0,
    expected_max_vote_weight: 5,
    early_attendance_enactment: null,
  }
  const ENACTED: PalletPlayerRow = { ...ROW, yes_person: 4, early_attendance_enactment: { attendance: true, disposition: "Keep" } }

  it("watches the verdict while the chain holds the game, and lets go once PlayerProcess resets the row", () => {
    const chain = fakeEngine()
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    const seen: unknown[] = []
    const other: unknown[] = []
    source.watchAttendance!(REPORTING.index, (view) => seen.push(view))
    source.watchAttendance!(REPORTING.index + 1, (view) => other.push(view))

    chain.game(REPORTING)
    chain.playerRow(ROW)
    chain.playerRow(ENACTED)
    // the same verdict in PlayerProcess says nothing new
    chain.game({ ...REPORTING, state: { type: "PlayerProcess" } })
    // step 1 resets a kept row: registered false, the votes and the enactment gone
    chain.playerRow({ ...ROW, registered: false, sent_report: false, yes_person: 0, expected_max_vote_weight: 0 })

    expect(seen).toEqual([
      { gameIndex: REPORTING.index, verdict: "pending", final: false, reported: true, personWeightNeeded: 1 },
      { gameIndex: REPORTING.index, verdict: "passed", final: true, reported: true, personWeightNeeded: 0 },
      null,
    ])
    expect(other).toEqual([null])
  })

  it("no verdict outside Reporting and PlayerProcess", () => {
    const chain = fakeEngine()
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    const seen: unknown[] = []
    source.watchAttendance!(GAME.index, (view) => seen.push(view))
    chain.game(GAME)
    chain.playerRow(ROW)
    expect(seen).toEqual([null])
  })

  it("is absent with no player to watch", () => {
    expect(makeSource("ws", fakeEngine().engine).watchAttendance).toBeUndefined()
  })

  it("knows the attendance is applied as soon as the chain enacted it, while the game is still to settle", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => REPORTING
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })

    let settled = false
    void source.gameSettled(REPORTING.index).then(() => (settled = true))
    let applied = false
    const wait = source.attendanceApplied!(REPORTING.index).then(() => (applied = true))
    await flush()
    chain.game(REPORTING)
    chain.playerRow(ROW)
    await flush()
    expect(applied).toBe(false)

    chain.playerRow(ENACTED)
    await wait
    await flush()
    expect(settled).toBe(false)
    // the wait let go of its row watch
    expect(chain.rowWatches()).toBe(0)
  })

  it("knows it off the settle when the row never shows a verdict", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => ({ ...GAME, index: REPORTING.index + 1 })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    await source.attendanceApplied!(REPORTING.index)
    expect(chain.rowWatches()).toBe(0)
  })

  it("logs one host retry naming the settle read when it times out and is read again", async () => {
    // Given
    const chain = fakeEngine()
    const game = vi.fn<GameEngine["game"]>().mockResolvedValue({ ...GAME, index: REPORTING.index + 1 })
    chain.engine.game = game
    const source = makeSource("host", chain.engine, { player: PLAYER, signer })
    game.mockRejectedValueOnce(new ReadTimeoutError(15_000))

    // When
    const settled = source.gameSettled(REPORTING.index)
    await vi.advanceTimersByTimeAsync(1_000)
    await settled

    // Then
    expect(recorded.hostRetries).toEqual([
      expect.objectContaining({ operation: "chain-read.settle", attempt: 2, reason: "read-timeout", waitedMs: 1_000 }),
    ])
  })

  it("logs one host retry naming the interruption when the settle read loses the host", async () => {
    // Given
    const chain = fakeEngine()
    const game = vi.fn<GameEngine["game"]>().mockResolvedValue({ ...GAME, index: REPORTING.index + 1 })
    chain.engine.game = game
    const source = makeSource("host", chain.engine, { player: PLAYER, signer })
    game.mockRejectedValueOnce(new Error("TrUAPI host connection interrupted"))

    // When
    const settled = source.gameSettled(REPORTING.index)
    await vi.advanceTimersByTimeAsync(1_000)
    await settled

    // Then
    expect(recorded.hostRetries).toEqual([
      expect.objectContaining({ operation: "chain-read.settle", attempt: 2, reason: "host-interrupted" }),
    ])
  })
})

// #596: gameView() is null once the game leaves Reporting, which it can do
// before report_ends. The report's status is read in every phase, from one block.
describe("the report's status past Reporting (#596)", () => {
  const PROCESS: PalletGame = { ...GAME, state: { type: "PlayerProcess" } }

  it("reads a processed player's counted report off attendance, where gameView() reads nothing", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => PROCESS
    ;(chain.engine as { reportStanding: GameEngine["reportStanding"] }).reportStanding = async () => ({
      game: PROCESS,
      player: undefined,
      lastAttendedGame: PROCESS.index,
    })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    expect(await source.gameView()).toBeNull()
    expect(await source.reportStatus(PROCESS.index)).toMatchObject({ closed: true, report: "sent" })
  })

  it("a failed read is unknown, never a miss", async () => {
    const chain = fakeEngine()
    ;(chain.engine as { reportStanding: GameEngine["reportStanding"] }).reportStanding = () =>
      Promise.reject(new Error("rpc down"))
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    expect(await source.reportStatus(GAME.index)).toEqual({ gameIndex: GAME.index, closed: false, report: "unknown" })
  })
})

// #597: a failed Players(me) read is "not known", never "not sent"
describe("the live view's report flag (#597)", () => {
  it("is undefined when the player row read fails", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => ({ ...GAME, state: { type: "Reporting", value: { player_count: 1 } } })
    chain.engine.playerIndices = async () => [0]
    chain.engine.groupMembers = async () => [{ index: 0, player: { type: "Account", value: PLAYER } }]
    chain.engine.player = () => Promise.reject(new Error("rpc down"))
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })
    const view = await source.gameView()
    expect(view).not.toBeNull()
    expect(view?.reportSent).toBeUndefined()
  })
})

// #530: a launch stuck on the bare title. The first reads were retried only
// from a block tick, and a host whose chain subscription is dead never ticks.
describe("the home's first reads retry on a wall-clock timer (#530)", () => {
  const last = (statuses: GameStatus[]) => statuses[statuses.length - 1]?.kind

  it("lands the status from the timer when the first read times out and no block ever arrives", async () => {
    const chain = fakeEngine()
    let answering = false
    const game = vi.fn<GameEngine["game"]>(() => (answering ? Promise.resolve(undefined) : new Promise(() => {})))
    chain.engine.game = game
    const { statuses, stop } = watching(chain.engine)
    await flush()
    expect(last(statuses)).toBe("loading")

    // no chain.now(...) anywhere: only wall-clock time passes
    await vi.advanceTimersByTimeAsync(10_000) // the first read gives up
    expect(last(statuses)).toBe("loading")
    answering = true // the host recovers
    await vi.advanceTimersByTimeAsync(10_000) // and the timer asks again
    await flush()

    expect(game.mock.calls.length).toBeGreaterThan(1)
    expect(last(statuses)).toBe("none")
    stop()
  })

  it("retries the schedule read too, and stops asking once everything landed", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => undefined
    const schedules = vi
      .fn<GameEngine["schedules"]>()
      .mockRejectedValueOnce(new Error("host hiccup"))
      .mockResolvedValue([])
    chain.engine.schedules = schedules
    const { statuses, stop } = watching(chain.engine)
    await flush()
    expect(last(statuses)).toBe("loading")

    await vi.advanceTimersByTimeAsync(4_000)
    await flush()
    expect(last(statuses)).toBe("none")
    const calls = schedules.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(schedules.mock.calls.length).toBe(calls)
    stop()
  })

  // #583 (found by a model check): the status can fall back to loading after
  // its first answer, and the timer must come back with it
  it("leaves loading once the host answers again, with no block tick", async () => {
    const chain = fakeEngine()
    const RUNNING = { ...GAME, state: { type: "Shuffle" } } as unknown as PalletGame
    let slot: PalletGame | undefined = RUNNING
    chain.engine.game = async () => slot
    let answering = false
    chain.engine.schedules = vi.fn<GameEngine["schedules"]>(() =>
      answering ? Promise.resolve([]) : Promise.reject(new Error("host hiccup")),
    )
    const { statuses, stop } = watching(chain.engine)
    await flush()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(last(statuses)).not.toBe("loading") // the running game is known
    slot = undefined
    chain.gameWithoutTick(undefined) // the slot empties; the queue read fails again
    await flush()
    expect(last(statuses)).toBe("loading")
    answering = true // the host answers again, its subscription stays silent
    await vi.advanceTimersByTimeAsync(4_000) // one backoff step
    await flush()
    expect(last(statuses)).toBe("none")
    stop()
  })

  it("stops the timer when the watch stops", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => undefined
    const schedules = vi.fn<GameEngine["schedules"]>().mockRejectedValue(new Error("down"))
    chain.engine.schedules = schedules
    const { stop } = watching(chain.engine)
    await vi.advanceTimersByTimeAsync(4_000)
    stop()
    const calls = schedules.mock.calls.length
    expect(calls).toBeGreaterThan(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(schedules.mock.calls.length).toBe(calls)
  })
})

describe("the live status says until when a registered player can join (#699)", () => {
  const LIVE: PalletGame = {
    ...GAME,
    index: 9,
    state: { type: "Reporting", value: { player_count: 6 } },
    game_date: NOW - 40,
    report_ends: NOW + 600,
  }

  it("names the game, its shape and the end of its last turn", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => LIVE
    const { statuses, stop } = watching(chain.engine)
    await flush()
    expect(statuses[statuses.length - 1]).toMatchObject({
      kind: "live",
      gameAt: NOW - 40,
      gameIndex: 9,
      rounds: 2,
      maxGroupSize: 6,
      // two rounds of six 12 s turns and the 7 s gap between them
      playEndsAt: NOW - 40 + 151,
    })
    stop()
  })
})

describe("the home after the last turn (#1418)", () => {
  // two rounds of six 12 s turns and the 7 s gap between them: play ends at NOW + 111
  const PLAYING: PalletGame = {
    ...GAME,
    index: 9,
    state: { type: "Reporting", value: { player_count: 6 } },
    game_date: NOW - 40,
    report_ends: NOW + 600,
  }
  const PLAY_ENDS = NOW - 40 + 151
  const NEXT_AT = NOW + 3_600
  const QUEUE = [{ game_play_time: NEXT_AT, rounds: 2, max_group_size: 6 }]
  const last = (statuses: GameStatus[]) => statuses[statuses.length - 1]

  /** a mounted home for a registered player in the game that is on */
  async function playing(schedules: GameEngine["schedules"]) {
    const chain = fakeEngine()
    chain.engine.game = async () => PLAYING
    chain.engine.player = async () => ({ registered: true }) as never
    chain.engine.schedules = schedules
    const watch = watching(chain.engine)
    chain.player({ registered: true })
    await flush()
    expect(last(watch.statuses)).toMatchObject({ kind: "live", registered: true, playEndsAt: PLAY_ENDS })
    return { chain, ...watch }
  }

  /** the chain and the wall clock move past the last turn */
  async function pastLastTurn(chain: ReturnType<typeof fakeEngine>) {
    await vi.advanceTimersByTimeAsync((PLAY_ENDS - NOW + 1) * 1000)
    chain.now(PLAY_ENDS + 1, 2)
    await flush()
  }

  it("shows the next game when the last turn ends", async () => {
    const { chain, statuses, stop } = await playing(async () => QUEUE)

    await pastLastTurn(chain)

    expect(last(statuses)).toMatchObject({ kind: "scheduled", gameAt: NEXT_AT, reportingGameAt: PLAYING.game_date })
    stop()
  })

  it("shows no game when the queue is empty at the last turn's end", async () => {
    const { chain, statuses, stop } = await playing(async () => [])

    await pastLastTurn(chain)

    expect(last(statuses)).toEqual({ kind: "none", reportingGameAt: PLAYING.game_date })
    stop()
  })

  it("shows the next game, never the game just played, on a fresh mount for a player not registered", async () => {
    const chain = fakeEngine()
    chain.engine.game = async () => ({ ...PLAYING, game_date: NOW - 151 })
    chain.engine.schedules = async () => QUEUE
    const { statuses, stop } = watching(chain.engine)
    chain.player(undefined)
    await flush()

    expect(last(statuses)).toMatchObject({ kind: "scheduled", gameAt: NEXT_AT, reportingGameAt: NOW - 151 })
    expect(statuses.some((status) => status.kind === "live")).toBe(false)
    stop()
  })

  it("reads the queue again on a chain tick, so a game added in the report window shows", async () => {
    let queue: Awaited<ReturnType<GameEngine["schedules"]>> = []
    const { chain, statuses, stop } = await playing(async () => queue)
    await pastLastTurn(chain)
    expect(last(statuses)).toEqual({ kind: "none", reportingGameAt: PLAYING.game_date })

    queue = QUEUE
    chain.now(PLAY_ENDS + 7, 3)
    await flush()

    expect(last(statuses)).toMatchObject({ kind: "scheduled", gameAt: NEXT_AT, reportingGameAt: PLAYING.game_date })
    stop()
  })

  it("names no game in its report window for an empty slot", async () => {
    for (const queue of [QUEUE, []]) {
      const chain = fakeEngine()
      chain.engine.game = async () => undefined
      chain.engine.schedules = async () => queue
      const { statuses, stop } = watching(chain.engine)
      chain.player(undefined)
      await flush()

      expect(last(statuses)?.kind).toBe(queue.length ? "scheduled" : "none")
      expect(last(statuses)).not.toHaveProperty("reportingGameAt")
      stop()
    }
  })

  it("does not read the queue on a chain tick while turns remain", async () => {
    const schedules = vi.fn<GameEngine["schedules"]>().mockResolvedValue(QUEUE)
    const { chain, stop } = await playing(schedules)
    const calls = schedules.mock.calls.length

    chain.now(NOW + 6, 2)
    chain.now(NOW + 12, 3)
    await flush()

    expect(schedules.mock.calls.length).toBe(calls)
    stop()
  })
})

describe("a prize claimed from the draw screen", () => {
  it("sweeps the game account under the claim that landed", async () => {
    // Given
    const chain = fakeEngine()
    chain.engine.draws = async () => [
      { airdropIndex: 1, status: "Claiming", prize: null, drawTime: null, ticket: null, winningTickets: [], totalEntries: 1, won: true },
    ]
    chain.engine.eligibility = async () => ({ eligible: true, reason: null })
    chain.engine.claimPrize = async () => ({ ok: true })
    const source = makeSource("host", chain.engine, { player: PLAYER, signer, capabilities: CAPS })

    // When
    await source.claimPrize!(7, 1)

    // Then
    expect(mocks.sweep).toHaveBeenCalledWith(PLAYER, expect.any(Function), { gameIndex: 7, airdropIndex: 1 })
  })
})

describe("the host signer byte log", () => {
  const built = "0x0400abff"
  const hostSigner = Object.assign(vi.fn().mockResolvedValue(built), {
    publicKey: new Uint8Array(32).fill(1),
    signBytes: vi.fn(),
  }) as unknown as CommonSignerTxCreator
  const payload = {} as Parameters<CommonSignerTxCreator>[0]
  const bindings = {} as Parameters<CommonSignerTxCreator>[2]

  beforeEach(() => clearDevLog())

  it("writes the extrinsic the host built for the wire with its byte length", async () => {
    expect(await withExtrinsicLogging(hostSigner, logHostExtrinsic)(payload, {}, bindings, false)).toBe(built)
    expect(getDevLogEntries().filter((entry) => entry.tag === "signtx")).toMatchObject([
      { message: "host built extrinsic (4B)", data: { hex: built } },
    ])
  })
})
