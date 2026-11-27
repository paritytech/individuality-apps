// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tests the one sign-up flow (./sign-up-flow.ts) over a fake chain: each gate
 * a tap passes, and the re-read that keeps one tap from filing two sign-ups.
 * The Jollity app's lib/game-source.test.ts runs the same flow through its
 * source, with its telemetry and its screens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  deriveSeat,
  GAME_REGISTRATION_RETRY_MS,
  type GameRegistrationCapabilities,
  type GameSeat,
  type LiteSignUpBlocker,
} from "@parity/product-sdk-individuality"
import { createNameGate, NAME_UNOWNED_RECHECK_MS, NAME_UNOWNED_RETRY_MS, type NameLinkResult } from "@individuality/name-link"
import { SeatUnfundedError } from "./seat"
import type { DispatchResult } from "@individuality/people-chain"
import type { RegisterOptions, SignUpDraws, SignUpFlowChain } from "./sign-up-types"
import type { GameRegistration } from "@individuality/shared-records"
import { createSignUpFlow, type SignUpFlowOptions, type SignUpTelemetry } from "./sign-up-flow"

const PLAYER = "5F...player"
const NOW = 1_000
const WINDOW = { index: 7, registrationEnds: NOW + 600, gamePlayTime: NOW + 900 }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()))

/** what a host does for the sign-up, as the SDK takes it */
const capabilities = (overrides: Partial<GameRegistrationCapabilities> = {}): GameRegistrationCapabilities => ({
  account: { address: PLAYER, publicKey: new Uint8Array(32) },
  signer: {} as GameRegistrationCapabilities["signer"],
  submit: vi.fn(async () => ({ ok: true as const })),
  ...overrides,
})

/** the SDK's seat over these funds and blockers, its route decided by the SDK's `deriveSeat` */
const gameSeat =
  (funds: { free?: bigint; required?: bigint; blockers?: string[] } = {}) =>
  (_account: string, facts: { litePerson: boolean; bound?: boolean }): GameSeat => {
    const free = funds.free ?? 5000n
    const required = funds.required ?? 2020n
    const blockers = (funds.blockers ?? []).map((tag) => ({ tag })) as unknown as LiteSignUpBlocker[]
    return {
      ...deriveSeat({ blockers, free, required, litePerson: facts.litePerson, bound: facts.bound }),
      registered: false,
      open: true,
      required,
      requirement: { blockers } as unknown as GameSeat["requirement"],
      funds: { free, deposit: 2000n, estimatedFee: 10n, decimals: 10, symbol: "PAS" } as GameSeat["funds"],
    }
  }

/** a chain whose player is not registered, whose game is open, and whose
 *  sign-up goes on the wire and lands */
function fakeChain(overrides: Partial<SignUpFlowChain> = {}) {
  const register = vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
    options?.onDraws?.({ entered: 0, scheduled: 0, waitedMs: 0, retries: 0 })
    options?.onBroadcast?.()
    return { ok: true }
  })
  const chain: SignUpFlowChain = {
    seat: vi.fn(async (account, facts) => gameSeat()(account, facts)),
    holdsLiteKey: vi.fn(async () => false),
    bind: vi.fn(async () => ({ kind: "bound" as const })),
    register,
    player: vi.fn(async () => ({ registered: false })),
    game: vi.fn(async () => ({ index: 7, state: { type: "Registration" }, registration_ends: WINDOW.registrationEnds })),
    ...overrides,
  }
  return chain
}

function fakeTelemetry() {
  const ends: Array<[string, string]> = []
  const failures: string[] = []
  const attrs: Record<string, string | number> = {}
  const telemetry: SignUpTelemetry = {
    journey: (name) => ({
      set: (next) => Object.assign(attrs, next),
      step: () => ({ end() {} }),
      markSad() {},
      end: (outcome) => void ends.push([name, outcome]),
    }),
    failure: (kind, details) => void failures.push(`${kind}:${details.reason}${details.context?.retrying ? ":retrying" : ""}`),
    count() {},
    distribution() {},
  }
  return { telemetry, ends, failures, attrs }
}

function flowOver(chain: SignUpFlowChain, overrides: Partial<SignUpFlowOptions> = {}) {
  const { telemetry, ends, failures, attrs } = fakeTelemetry()
  const flow = createSignUpFlow({
    chain,
    capabilities: capabilities(),
    communicationIdentifier: async () => new Uint8Array(65),
    nowSeconds: () => NOW,
    telemetry,
    log() {},
    ...overrides,
  })
  flow.setSlot(WINDOW.index, WINDOW)
  return { flow, ends, failures, attrs }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("a sign-up goes", () => {
  it("signs up on the tap, and counts the player in from the broadcast", async () => {
    // Given
    const chain = fakeChain()
    const { flow, ends } = flowOver(chain)

    // When
    await flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(chain.register).toHaveBeenCalledTimes(1)
    expect(flow.optimistic()).toEqual({ registered: true, game: 7 })
    expect(ends).toContainEqual(["game-signup", "landed"])
  })

  it("signs up for a surface that keeps no telemetry and no log", async () => {
    // Given
    const chain = fakeChain()
    const flow = createSignUpFlow({
      chain,
      capabilities: capabilities(),
      communicationIdentifier: async () => new Uint8Array(65),
      nowSeconds: () => NOW,
    })
    flow.setSlot(WINDOW.index, WINDOW)

    // When
    await flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(chain.register).toHaveBeenCalledTimes(1)
    expect(flow.optimistic()).toEqual({ registered: true, game: 7 })
  })

  it("files nothing for a player the chain already has", async () => {
    // Given
    const chain = fakeChain({ player: vi.fn(async () => ({ registered: true })) })
    const { flow } = flowOver(chain)

    // When
    await flow.register!()

    // Then
    expect(chain.register).not.toHaveBeenCalled()
    expect(flow.optimistic().registered).toBe(true)
  })

  it("waits for the name link, and goes once it is linked", async () => {
    // Given
    const answers: NameLinkResult[] = ["skipped", "linked"]
    const nameGate = createNameGate({
      link: async () => answers.shift() ?? "linked",
      retryDelay: (failures) => GAME_REGISTRATION_RETRY_MS[Math.min(failures, GAME_REGISTRATION_RETRY_MS.length) - 1]!,
    })
    const chain = fakeChain()
    const { flow } = flowOver(chain, { nameGate })

    // When
    const tap = flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then: the seat waits on the name
    expect(chain.register).not.toHaveBeenCalled()
    expect(flow.phase()).toBe("waiting-seat")
    expect(flow.waitingOn()).toBe("name")
    await vi.advanceTimersByTimeAsync(10_000)
    await tap
    expect(chain.register).toHaveBeenCalledTimes(1)
  })

  it("says the username is not registered while nobody owns it, and goes once it is linked", async () => {
    // Given
    const answers: NameLinkResult[] = ["unowned", "linked"]
    const link = vi.fn(async () => answers.shift() ?? "linked")
    const nameGate = createNameGate({
      link,
      retryDelay: (failures) => GAME_REGISTRATION_RETRY_MS[Math.min(failures, GAME_REGISTRATION_RETRY_MS.length) - 1]!,
    })
    const chain = fakeChain()
    const { flow } = flowOver(chain, { nameGate })
    const phases: string[] = []
    const waitsDuringNotice: Array<string | null> = []
    flow.onChange(() => {
      phases.push(flow.phase())
      if (flow.phase() === "name-unowned") waitsDuringNotice.push(flow.waitingOn())
    })

    // When
    const tap = flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(chain.register).not.toHaveBeenCalled()
    expect(flow.waitingOn()).toBe("name")
    await vi.advanceTimersByTimeAsync(30_000)
    expect(phases).toContain("name-unowned")
    expect(waitsDuringNotice).toContain("name")
    expect(link).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(NAME_UNOWNED_RETRY_MS)
    await tap
    expect(phases).not.toContain("slow")
    expect(link).toHaveBeenCalledTimes(2)
    expect(chain.register).toHaveBeenCalledTimes(1)
  })

  it("reads the seat no more while a link of an unowned username is under way", async () => {
    // Given: the player asks again past the hold, and that link takes its time
    const held = deferred<NameLinkResult>()
    const answers: Array<NameLinkResult | Promise<NameLinkResult>> = ["unowned", held.promise]
    const link = vi.fn(async () => answers.shift() ?? "linked")
    const nameGate = createNameGate({
      link,
      retryDelay: (failures) => GAME_REGISTRATION_RETRY_MS[Math.min(failures, GAME_REGISTRATION_RETRY_MS.length) - 1]!,
    })
    const chain = fakeChain()
    const { flow } = flowOver(chain, { nameGate })
    const tap = flow.register!()
    await vi.advanceTimersByTimeAsync(NAME_UNOWNED_RECHECK_MS)
    expect(flow.phase()).toBe("name-unowned")

    // When
    nameGate.recheck()
    await vi.advanceTimersByTimeAsync(20_000)
    const reads = vi.mocked(chain.seat).mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)

    // Then
    expect(link).toHaveBeenCalledTimes(2)
    expect(chain.seat).toHaveBeenCalledTimes(reads)
    held.resolve("linked")
    await vi.advanceTimersByTimeAsync(0)
    await tap
    expect(chain.register).toHaveBeenCalledTimes(1)
  })

  it("links once per hold, not on its own ladder, while the sign-up waits on an unowned username (#1115)", async () => {
    // Given: game 271 linked 134 times in one window
    const answers: NameLinkResult[] = ["unowned", "unowned", "unowned", "linked"]
    const link = vi.fn(async () => answers.shift() ?? "linked")
    const nameGate = createNameGate({
      link,
      retryDelay: (failures) => GAME_REGISTRATION_RETRY_MS[Math.min(failures, GAME_REGISTRATION_RETRY_MS.length) - 1]!,
    })
    const chain = fakeChain()
    const { flow } = flowOver(chain, { nameGate })

    // When
    const tap = flow.register!()
    await vi.advanceTimersByTimeAsync(2.5 * NAME_UNOWNED_RETRY_MS)

    // Then: once at the tap, then once per hold
    expect(flow.phase()).toBe("name-unowned")
    expect(link).toHaveBeenCalledTimes(3)
    expect(chain.register).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(NAME_UNOWNED_RETRY_MS)
    await tap
    expect(link).toHaveBeenCalledTimes(4)
    expect(chain.register).toHaveBeenCalledTimes(1)
  })

  it("reads the chain again after a failure past the broadcast, and finds the sign-up landed", async () => {
    // Given: the watch loses the transaction it broadcast, which landed
    let registered = false
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        options?.onBroadcast?.()
        registered = true
        return { ok: false, error: "Tracking stopped", landingUnknown: true }
      }),
      player: vi.fn(async () => ({ registered })),
    })
    const { flow, ends } = flowOver(chain)

    // When
    await flow.register!()
    await vi.advanceTimersByTimeAsync(20_000)

    // Then: one sign-up, found by the re-read
    expect(chain.register).toHaveBeenCalledTimes(1)
    expect(ends).toContainEqual(["game-signup", "landed"])
    expect(flow.optimistic().registered).toBe(true)
  })

  it("keeps the optimistic registered when the landing re-read fails, and settles on a later read (#1355)", async () => {
    // Given: the broadcast goes out, the landing watch fails, and the chain
    // re-read that would say whether it landed fails too (g285's dropped
    // host connection); a later read finds the player registered
    let reads = 0
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        options?.onBroadcast?.()
        return { ok: false, error: "Tracking stopped", landingUnknown: true }
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads === 2) throw new Error("the host's chain connection dropped")
        return { registered: reads > 2 }
      }),
    })
    const { flow, ends } = flowOver(chain)
    const optimisticSeen: boolean[] = []
    flow.onChange(() => optimisticSeen.push(flow.optimistic().registered))

    // When
    await flow.register!()
    await vi.advanceTimersByTimeAsync(30_000)

    // Then: "you're in" was up from the broadcast and never went down, and
    // the later read settles it
    expect(optimisticSeen).toContain(true)
    const afterWire = optimisticSeen.slice(optimisticSeen.indexOf(true))
    expect(afterWire).not.toContain(false)
    expect(flow.optimistic().registered).toBe(true)
    expect(ends).toContainEqual(["game-signup", "landed"])
    expect(chain.register).toHaveBeenCalledTimes(1)
  })

  it("never files a second sign-up, and never a non-retrying failure, while the landing re-read keeps failing (#1355)", async () => {
    // Given: broadcast, landing failure, and every chain read failing — the
    // loop retries on its backoff, and each attempt re-reads the player row
    // before any register call
    // the player row answers "not registered" (a definitive read), so the
    // attempt reaches the wire; only the post-broadcast landing re-read fails
    let reads = 0
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        options?.onBroadcast?.()
        return { ok: false, error: "Tracking stopped", landingUnknown: true }
      }),
      game: vi.fn(async () => ({ index: 7, state: { type: "Registration" as const }, registration_ends: WINDOW.registrationEnds + 10_000 })),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads > 1) throw new Error("the host's chain connection dropped")
        return { registered: false }
      }),
    })
    const { flow, failures } = flowOver(chain, { nowSeconds: () => NOW })

    // When: the whole retry ladder runs with reads still failing
    const tap = flow.register!().catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await Promise.race([tap, vi.advanceTimersByTimeAsync(0).then(() => "pending")])

    // Then: one sign-up only, every failure on it tagged as one that goes
    // again (the fake telemetry's failure string carries retrying: "true"), the
    // flag still up
    expect(chain.register).toHaveBeenCalledTimes(1)
    const failed = failures.filter((failure) => failure.startsWith("signup-failed"))
    expect(failed.length).toBeGreaterThan(0)
    expect(failed.every((failure) => failure.includes("retrying"))).toBe(true)
    expect(flow.optimistic().registered).toBe(true)
    flow.cancelRegister()
  }, 30_000)

  it("takes the optimistic flag down when a later read says the player is not in, after the landing re-read failed", async () => {
    // Given: broadcast, the landing re-read fails, and the next attempt's read
    // answers definitively "not registered"
    let reads = 0
    let calls = 0
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        calls += 1
        if (calls === 1) {
          options?.onBroadcast?.()
          return { ok: false, error: "Tracking stopped", landingUnknown: true }
        }
        // the second attempt never reaches the wire: the flag must already be down
        return new Promise<DispatchResult>(() => {})
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads === 2) throw new Error("the host's chain connection dropped")
        return { registered: false }
      }),
    })
    const { flow } = flowOver(chain)

    // When: the tap wires the sign-up, the landing re-read fails, and the loop
    // goes again until the next read answers
    const tap = flow.register!()
    await vi.advanceTimersByTimeAsync(0)
    expect(flow.optimistic().registered).toBe(true)
    await vi.advanceTimersByTimeAsync(12_000) // the landing wait, its re-read fails
    await vi.advanceTimersByTimeAsync(2_000) // the first backoff
    await vi.advanceTimersByTimeAsync(0) // the window check and the next attempt's read

    // Then: the flag this tap put up is down, the chain said so
    expect(reads).toBeGreaterThanOrEqual(3)
    expect(chain.register).toHaveBeenCalledTimes(2)
    expect(flow.optimistic().registered).toBe(false)
    flow.cancelRegister()
    await vi.advanceTimersByTimeAsync(60_000)
    await tap
  }, 30_000)

  it("keeps the optimistic flag when the loop ends closed unverified (the Players read never answered)", async () => {
    // Given: broadcast, the landing re-read fails, every later read fails too,
    // and the window shuts between attempts
    let now = NOW
    let reads = 0
    let calls = 0
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        calls += 1
        if (calls === 1) {
          options?.onBroadcast?.()
          return { ok: false, error: "Tracking stopped", landingUnknown: true }
        }
        // never reached: the loop's window check ends it before attempt 2
        return new Promise<DispatchResult>(() => {})
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads === 1) return { registered: false } // attempt 1's pre-route read answers
        throw new Error("the host's chain connection dropped") // every later read fails
      }),
      game: vi.fn(async () => ({ index: 7, state: { type: "Registration" as const }, registration_ends: WINDOW.registrationEnds })),
    })
    const { flow, ends, failures } = flowOver(chain, { nowSeconds: () => now })
    flow.setSlot(7, { index: 7, registrationEnds: WINDOW.registrationEnds, gamePlayTime: WINDOW.gamePlayTime })

    // When: the window shuts while the attempt waits; the landing wait runs
    // (its re-read fails), the backoff passes, and the loop's window check
    // ends it closed with the Players read unverified
    const tap = flow.register!()
    await vi.advanceTimersByTimeAsync(0)
    expect(flow.optimistic().registered).toBe(true)
    now = NOW + 1_000 // the window shut while the attempt waited
    await vi.advanceTimersByTimeAsync(12_000) // the landing wait, re-read fails
    await vi.advanceTimersByTimeAsync(2_000) // the first backoff, then the window check (its read fails)
    await vi.advanceTimersByTimeAsync(90_000) // the post-loop reader's reads fail too

    // Then: the loop ended closed, but the flag this tap's wire put up stays,
    // and no window-closed journey or failure is filed (Ionut 7.1)
    expect(ends).not.toContainEqual(["game-signup", "closed"])
    expect(flow.phase()).toBe("closed")
    expect(flow.optimistic().registered).toBe(true)
    expect(failures).not.toContain("signup-failed:window-closed")
    await tap
  }, 30_000)

  it("keeps the optimistic flag when the tap is stopped after the landing re-read failed", async () => {
    // Given: broadcast, the landing re-read fails, and the page leaves
    let reads = 0
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        options?.onBroadcast?.()
        return { ok: false, error: "Tracking stopped", landingUnknown: true }
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads > 1) throw new Error("the host's chain connection dropped")
        return { registered: false }
      }),
    })
    const { flow } = flowOver(chain)

    // When
    const tap = flow.register!()
    await vi.advanceTimersByTimeAsync(0)
    expect(flow.optimistic().registered).toBe(true)
    await vi.advanceTimersByTimeAsync(12_000) // the landing wait, re-read fails
    flow.cancelRegister()
    await vi.advanceTimersByTimeAsync(5_000)

    // Then: the loop ended stopped, but the flag of this tap's wire stays up
    // until a read that answers says the player is not in
    expect(flow.optimistic().registered).toBe(true)
    await tap
  }, 30_000)

  it("keeps the optimistic flag when the tap is stopped while the landing wait is still running", async () => {
    // Given: broadcast, and the page leaves before the post-failure wait ends
    let reads = 0
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        options?.onBroadcast?.()
        return { ok: false, error: "Tracking stopped", landingUnknown: true }
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads === 1) return { registered: false } // the pre-route read answers
        if (reads <= 2) throw new Error("the host's chain connection dropped")
        return { registered: false }
      }),
    })
    const { flow } = flowOver(chain)

    // When: the page leaves before the post-failure wait ends
    const tap = flow.register!()
    await vi.advanceTimersByTimeAsync(0)
    expect(flow.optimistic().registered).toBe(true)
    flow.cancelRegister()
    await vi.advanceTimersByTimeAsync(20_000)

    // Then: the loop ended stopped, and the flag of this tap's wire stays up
    // (only failed reads so far)
    expect(flow.optimistic().registered).toBe(true)
    await tap
  }, 30_000)

  it("keeps the flag up when a wired attempt is stopped, its late result is non-ok, and the read fails (row 20)", async () => {
    // Given: the sign-up is broadcast, the page leaves before the wire deadline,
    // the register call answers non-ok only afterwards, and every Players read
    // after the pre-route one fails — the abandoned attempt's rollback must
    // not take the flag down on a failed read
    let late: ((result: DispatchResult) => void) | undefined
    let reads = 0
    const chain = fakeChain({
      register: vi.fn((_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions) => {
        options?.onDraws?.({ entered: 0, scheduled: 0, waitedMs: 0, retries: 0 })
        options?.onBroadcast?.()
        return new Promise<DispatchResult>((resolve) => (late = resolve))
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads === 1) return { registered: false } // the pre-route read answers
        throw new Error("the host's chain connection dropped")
      }),
    })
    const { flow } = flowOver(chain)

    // When
    const tap = flow.register!().catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(flow.optimistic().registered).toBe(true)
    flow.cancelRegister()
    await vi.advanceTimersByTimeAsync(0)
    late!({ ok: false, error: "Tracking stopped", landingUnknown: true })
    await vi.advanceTimersByTimeAsync(30_000)

    // Then: the late non-ok after the abandon saw only a failed read, so the
    // flag this tap's wire put up stays
    expect(flow.optimistic().registered).toBe(true)
    await tap
  }, 30_000)

  it("keeps the flag up when a wired attempt times out, its late result is non-ok, and the read fails (row 20, timeout variant)", async () => {
    // Given: the sign-up is broadcast and the wire deadline passes with no
    // answer, the register call answers non-ok only after that, and every
    // Players read after the pre-route one fails
    let late: ((result: DispatchResult) => void) | undefined
    let reads = 0
    const chain = fakeChain({
      register: vi.fn((_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions) => {
        options?.onDraws?.({ entered: 0, scheduled: 0, waitedMs: 0, retries: 0 })
        options?.onBroadcast?.()
        return new Promise<DispatchResult>((resolve) => (late = resolve))
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads === 1) return { registered: false } // the pre-route read answers
        throw new Error("the host's chain connection dropped")
      }),
    })
    const { flow } = flowOver(chain)

    // When: the wire deadline passes (WIRE_TIMEOUT_MS = 45s), then the late
    // non-ok arrives
    const tap = flow.register!().catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(flow.optimistic().registered).toBe(true)
    await vi.advanceTimersByTimeAsync(45_000) // the wire timeout fires
    late!({ ok: false, error: "Tracking stopped", landingUnknown: true })
    await vi.advanceTimersByTimeAsync(30_000)

    // Then: the timed-out attempt's rollback saw only failed reads, so the
    // flag stays
    expect(flow.optimistic().registered).toBe(true)
    flow.cancelRegister()
    await vi.advanceTimersByTimeAsync(60_000)
    await tap
  }, 30_000)

  it("clears the flag when a later answered read says not-in after the loop ended stopped (row 9, the post-loop reader)", async () => {
    // Given: broadcast, the tap stops, and the reads fail at first — the
    // post-loop reader keeps reading, and one that answers not-in takes the
    // flag down
    let reads = 0
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        options?.onBroadcast?.()
        return { ok: false, error: "Tracking stopped", landingUnknown: true }
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads === 1) return { registered: false } // the pre-route read answers
        if (reads <= 3) throw new Error("the host's chain connection dropped")
        return { registered: false }
      }),
    })
    const { flow } = flowOver(chain)

    // When
    const tap = flow.register!().catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(flow.optimistic().registered).toBe(true)
    flow.cancelRegister()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(flow.optimistic().registered).toBe(true) // still only failed reads
    await vi.advanceTimersByTimeAsync(60_000) // the post-loop reader's next read answers

    // Then
    expect(reads).toBeGreaterThan(3)
    expect(flow.optimistic().registered).toBe(false)
    await tap
  }, 30_000)

  it("clears the flag when a later answered read says not-in after the loop ended closed unverified (row 6, the post-loop reader)", async () => {
    // Given: broadcast, the landing re-read fails, the window shuts between
    // attempts with its Players read failing too, and a later read answers
    // not-in — the post-loop reader takes the flag down
    let now = NOW
    let reads = 0
    let calls = 0
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        calls += 1
        if (calls === 1) {
          options?.onBroadcast?.()
          return { ok: false, error: "Tracking stopped", landingUnknown: true }
        }
        // never reached: the loop's window check ends it before attempt 2
        return new Promise<DispatchResult>(() => {})
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads === 1) return { registered: false } // attempt 1's pre-route read answers
        // the landing re-read (2) and the window check's read (3) fail; the
        // post-loop reader's first read (4) answers
        if (reads <= 3) throw new Error("the host's chain connection dropped")
        return { registered: false }
      }),
      game: vi.fn(async () => ({ index: 7, state: { type: "Registration" as const }, registration_ends: WINDOW.registrationEnds })),
    })
    const { flow } = flowOver(chain, { nowSeconds: () => now })
    flow.setSlot(7, { index: 7, registrationEnds: WINDOW.registrationEnds, gamePlayTime: WINDOW.gamePlayTime })

    // When
    const tap = flow.register!().catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(flow.optimistic().registered).toBe(true)
    now = NOW + 1_000 // the window shut while the attempt waited
    await vi.advanceTimersByTimeAsync(12_000) // the landing wait, re-read fails
    await vi.advanceTimersByTimeAsync(2_000) // the first backoff, then the window check (its read fails)
    expect(flow.phase()).toBe("closed")
    expect(flow.optimistic().registered).toBe(true) // closed unverified: still up
    await vi.advanceTimersByTimeAsync(15_000) // the post-loop reader's first read answers not-in

    // Then
    expect(reads).toBeGreaterThan(3)
    expect(flow.optimistic().registered).toBe(false)
    await tap
  }, 30_000)

  it("does not let a later tap's pre-wire refusal take the earlier tap's wired flag down (row 22, the ownership-checked clear at settle)", async () => {
    // Given: the first tap wires the sign-up and is stopped (its flag stays up
    // for the post-loop reader); a second tap then fails before the wire with
    // a permanent refusal — the clear at settle must not touch a flag this
    // attempt does not own
    let reads = 0
    let calls = 0
    let secondTap = false
    const chain = fakeChain({
      register: vi.fn((_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions) => {
        calls += 1
        if (calls === 1) {
          options?.onDraws?.({ entered: 0, scheduled: 0, waitedMs: 0, retries: 0 })
          options?.onBroadcast?.()
          return new Promise<DispatchResult>(() => {}) // the first tap's wire never answers
        }
        return Promise.resolve({ ok: false, error: "NoInvites" })
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        // the first tap's pre-route read answers not-in; the first tap's
        // later reads (the post-loop reader's) fail, so nothing of the first
        // tap answers. The second tap's pre-route read answers not-in, so it
        // reaches register — and the pre-route clear only ever takes down its
        // own tap's wire flag, which it has none of
        if (reads === 1 || secondTap) return { registered: false }
        throw new Error("the host's chain connection dropped")
      }),
    })
    const { flow, ends } = flowOver(chain)

    // When: the first tap wires and is stopped (its late result never
    // arrives), and a second tap ends refused before the wire
    const first = flow.register!().catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(flow.optimistic().registered).toBe(true)
    flow.cancelRegister()
    await vi.advanceTimersByTimeAsync(45_000) // the first attempt's wire deadline, then the loop ends stopped
    await first
    await vi.advanceTimersByTimeAsync(0) // let the first loop's finally run
    expect(flow.signingUp()).toBe(false)
    expect(flow.optimistic().registered).toBe(true)
    // the second tap runs the loop to its refusal: its window check and its
    // one attempt (which refuses before the wire with NoInvites)
    secondTap = true
    const second = flow.register!().catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await second
    expect(flow.optimistic().registered).toBe(true)

    // Then: the second tap's refusal was filed, but the first tap's flag is
    // still up — only its owner or an answered read may take it down
    expect(ends.filter(([name, outcome]) => name === "game-signup" && outcome === "failed")).toHaveLength(1)
  }, 30_000)

  it("the post-loop reader stops on a new slot and leaves no timer behind", async () => {
    // Given: broadcast, the tap stops, and reads keep failing
    let reads = 0
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        options?.onBroadcast?.()
        return { ok: false, error: "Tracking stopped", landingUnknown: true }
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads === 1) return { registered: false }
        throw new Error("the host's chain connection dropped")
      }),
    })
    const { flow } = flowOver(chain)
    const baselineTimers = vi.getTimerCount()
    const tap = flow.register!().catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    flow.cancelRegister()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(flow.optimistic().registered).toBe(true)

    // When: the slot moves on
    flow.newSlot(8)
    await vi.advanceTimersByTimeAsync(0)

    // Then: the flag is down for the old game, the reader stopped, no timer of
    // it is left, and no further read runs
    expect(flow.optimistic().registered).toBe(false)
    expect(vi.getTimerCount()).toBe(baselineTimers)
    const readsAtStop = vi.mocked(chain.player).mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(vi.mocked(chain.player).mock.calls.length).toBe(readsAtStop)
    await tap
  }, 30_000)

  it("the post-loop reader stops on the chain's confirmation and leaves no timer behind", async () => {
    // Given: broadcast, the tap stops, reads keep failing
    let reads = 0
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        options?.onBroadcast?.()
        return { ok: false, error: "Tracking stopped", landingUnknown: true }
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads === 1) return { registered: false }
        throw new Error("the host's chain connection dropped")
      }),
    })
    const { flow } = flowOver(chain)
    const baselineTimers = vi.getTimerCount()
    const tap = flow.register!().catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    flow.cancelRegister()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(flow.optimistic().registered).toBe(true)

    // When: the chain's own row says registered (watchPlayer's confirm)
    flow.confirmRegistered()
    await vi.advanceTimersByTimeAsync(0)

    // Then: the reader stopped, the flag is down for good, no timer left, and
    // no further read runs
    expect(flow.optimistic().registered).toBe(false)
    expect(vi.getTimerCount()).toBe(baselineTimers)
    const readsAtStop = vi.mocked(chain.player).mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(vi.mocked(chain.player).mock.calls.length).toBe(readsAtStop)
    await tap
  }, 30_000)

  it("clears the flag on a confirmed closed window whose Players read answered not-in (row 5, regression guard)", async () => {
    // Given: no wire yet — the window is shut and the player is not in, so the
    // loop's first window check ends it closed with an answered read
    const chain = fakeChain({
      game: vi.fn(async () => ({ index: 7, state: { type: "Shuffle" as const }, registration_ends: NOW - 1 })),
      player: vi.fn(async () => ({ registered: false })),
    })
    const { flow, ends } = flowOver(chain, { nowSeconds: () => NOW })
    flow.setSlot(7, { index: 7, registrationEnds: NOW - 1, gamePlayTime: NOW + 900 })

    // When
    const tap = flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(ends).toContainEqual(["game-signup", "closed"])
    expect(flow.phase()).toBe("closed")
    expect(flow.optimistic().registered).toBe(false)
    await tap
  })

  it("ends landed for an AlreadyRegistered in any message form after the broadcast (row 4, regression guard)", async () => {
    // Given: the broadcast goes out and the dispatch refuses with the pallet's
    // own word, wrapped in the SDK's message
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        options?.onBroadcast?.()
        return { ok: false, error: "game registration failed at sign: AlreadyRegistered" }
      }),
      player: vi.fn(async () => ({ registered: true })),
    })
    const { flow, ends } = flowOver(chain)

    // When
    await flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(ends).toContainEqual(["game-signup", "landed"])
    expect(flow.optimistic().registered).toBe(true)
  })

  it("clears the flag and files refused for a permanent refusal after the broadcast (row 7, regression guard)", async () => {
    // Given: the broadcast goes out and the pallet refuses for good
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        options?.onBroadcast?.()
        return { ok: false, error: "NoInvites" }
      }),
      player: vi.fn(async () => ({ registered: false })),
    })
    const { flow, ends, failures } = flowOver(chain)

    // When
    const tap = flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(ends).toContainEqual(["game-signup", "failed"])
    expect(failures).toContain("signup-failed:refused")
    expect(flow.optimistic().registered).toBe(false)
    await tap
  })

  it("takes the retry reason from the failed landing re-read, not from the dispatch error (row 3)", async () => {
    // Given: the pre-route read answers not-in, the sign-up goes on the wire,
    // the dispatch fails as a tracking loss, and the landing re-read fails with
    // a host-chain error — the retry's reason must name the re-read's failure
    let reads = 0
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        options?.onBroadcast?.()
        return { ok: false, error: "Tracking stopped", landingUnknown: true }
      }),
      player: vi.fn(async (): Promise<{ registered: boolean }> => {
        reads += 1
        if (reads === 1) return { registered: false }
        throw new Error("CannotGetCurrentBlock: the host's chain connection dropped")
      }),
    })
    const { flow, attrs } = flowOver(chain)

    // When
    const tap = flow.register!().catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.register).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(12_000) // the landing wait, the re-read fails

    // Then: the retry reason is the re-read's own failure ("host-chain"),
    // not the dispatch error's ("tracking-lost")
    expect(attrs["signup.retry_reason"]).toBe("host-chain")
    flow.cancelRegister()
    await vi.advanceTimersByTimeAsync(60_000)
    await tap
  }, 30_000)
})

describe("the prize draw's log", () => {
  async function drawLog(draws: SignUpDraws) {
    const chain = fakeChain({
      register: vi.fn(async (_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions): Promise<DispatchResult> => {
        options?.onDraws?.(draws)
        options?.onBroadcast?.()
        return { ok: true }
      }),
    })
    const lines: Array<{ level?: string; message: string }> = []
    const { flow } = flowOver(chain, {
      log: (tag, message, _data, level) => {
        if (tag === "signup" && (message.startsWith("draws skipped") || message.startsWith("entered "))) {
          lines.push({ level, message })
        }
      },
    })
    await flow.register!()
    await vi.advanceTimersByTimeAsync(0)
    return lines
  }

  it("logs a game with no draw as info, though the SDK gives its reason", async () => {
    const lines = await drawLog({ entered: 0, scheduled: 0, skipped: "the game has no prize draw", waitedMs: 0, retries: 0 })

    expect(lines).toEqual([{ level: "info", message: "draws skipped: the game has no prize draw" }])
  })

  it("logs a draw the sign-up could not enter as an error", async () => {
    const lines = await drawLog({ entered: 0, scheduled: 1, skipped: "draw #0 is Drawing", kind: "closed", waitedMs: 0, retries: 0 })

    expect(lines).toEqual([{ level: "error", message: "draws skipped: draw #0 is Drawing" }])
  })
})

describe("a sign-up is held back", () => {
  it("ends the tap for an account that cannot pay the deposit, signing nothing", async () => {
    // Given
    const chain = fakeChain({ seat: vi.fn(async (account, facts) => gameSeat({ free: 10n })(account, facts)) })
    const { flow } = flowOver(chain)

    // When / Then
    await expect(flow.register!()).rejects.toBeInstanceOf(SeatUnfundedError)
    expect(chain.register).not.toHaveBeenCalled()
  })

  it("waits for the game reminder the surface asks for", async () => {
    // Given
    const chain = fakeChain()
    const reminders = vi.fn(async () => "alarm-required" as const)
    const { flow } = flowOver(chain, { reminders })

    // When
    await flow.register!()

    // Then
    expect(reminders).toHaveBeenCalledWith(WINDOW)
    expect(flow.phase()).toBe("alarm-required")
    expect(chain.register).not.toHaveBeenCalled()
  })

  it("files no second sign-up over one another surface has on its way for this game", async () => {
    // Given
    const chain = fakeChain()
    const { flow } = flowOver(chain, { registrationRecord: { surface: "app", write: async () => {} } })
    flow.setRegistration({ gameIndex: 7, phase: "registering", surface: "chat", at: Date.now(), attempt: 1 })

    // When
    await flow.register!()

    // Then
    expect(chain.register).not.toHaveBeenCalled()
  })

  it("goes over its own surface's record, a run of it the page left", async () => {
    // Given
    const chain = fakeChain()
    const { flow } = flowOver(chain, { registrationRecord: { surface: "app", write: async () => {} } })
    flow.setRegistration({ gameIndex: 7, phase: "registering", surface: "app", at: Date.now(), attempt: 1 })

    // When
    await flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(chain.register).toHaveBeenCalledTimes(1)
  })

  it("goes over another surface's record for another game, or one that ended", async () => {
    // Given
    const chain = fakeChain()
    const { flow } = flowOver(chain, { registrationRecord: { surface: "app", write: async () => {} } })
    flow.setRegistration({ gameIndex: 6, phase: "registering", surface: "chat", at: Date.now(), attempt: 1 })

    // When
    await flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(chain.register).toHaveBeenCalledTimes(1)
  })

  it("ends closed once registration has closed by the chain's clock", async () => {
    // Given
    const chain = fakeChain({
      game: vi.fn(async () => ({ index: 7, state: { type: "Shuffle" }, registration_ends: NOW - 1 })),
    })
    const { flow } = flowOver(chain)

    // When
    await flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(chain.register).not.toHaveBeenCalled()
    expect(flow.phase()).toBe("closed")
  })
})

describe("the free seat's bind", () => {
  /** a lite person with no binding yet: the free route, not ready */
  function litePerson(bind: SignUpFlowChain["bind"]) {
    const keys = { holds: vi.fn(async () => true), prove: vi.fn(async () => ({ proof: "p" }) as never) }
    const chain = fakeChain({
      holdsLiteKey: vi.fn(async () => true),
      seat: vi.fn(async (account, facts) => gameSeat({ free: 0n, blockers: ["AliasNotBound"] })(account, facts)),
      bind: vi.fn(bind),
    })
    const { flow } = flowOver(chain, { capabilities: capabilities({ personhood: keys }) })
    return { chain, flow, keys }
  }

  it("binds a lite person in the background through the SDK, with the person's keys", async () => {
    // Given
    const { chain, flow, keys } = litePerson(async () => ({ kind: "bound" }))
    expect((await flow.readSeat()).seat).toEqual({ path: "free", ready: false })

    // When
    flow.requestBind()
    await vi.advanceTimersByTimeAsync(0)

    // Then: the SDK's bind proves with the person's own keys, and the seat is ready
    const [handed] = vi.mocked(chain.bind).mock.calls[0]!
    expect(handed.account.address).toBe(PLAYER)
    await handed.personhood!.prove({} as never, {} as never, new Uint8Array(1))
    expect(keys.prove).toHaveBeenCalledTimes(1)
    expect((await flow.readSeat()).seat).toEqual({ path: "free", ready: true })
  })

  it("falls back to the deposit route once the bind is refused for good", async () => {
    // Given: the person's free seat is pinned to another account
    const { flow } = litePerson(async () => ({
      kind: "refused",
      permanent: true,
      refusal: "pinned-elsewhere",
      code: "AnotherAccountInvited",
      account: "5Other",
      detail: "lite bind refused",
    }))

    // When
    flow.requestBind()
    await vi.advanceTimersByTimeAsync(0)

    // Then: seated like anyone who is not a lite person, here without the funds
    expect((await flow.readSeat()).seat.path).toBe("unfunded")
  })

  it("keeps waiting on the same lite lookup across a forward wall-clock jump", async () => {
    const lookup = deferred<boolean>()
    const holdsLiteKey = vi.fn(() => lookup.promise)
    const chain = fakeChain({ holdsLiteKey })
    const keys = { holds: vi.fn(async () => true), prove: vi.fn() }
    const { flow } = flowOver(chain, { capabilities: capabilities({ personhood: keys }) })

    const first = flow.readSeat()
    const firstResult = expect(first).rejects.toThrow("lite key lookup timed out")
    await vi.advanceTimersByTimeAsync(10_001)
    await firstResult

    vi.setSystemTime(Date.now() + 60_000)
    const second = flow.readSeat()
    await vi.advanceTimersByTimeAsync(0)
    expect(holdsLiteKey).toHaveBeenCalledTimes(1)

    lookup.resolve(true)
    await expect(second).resolves.toMatchObject({ seat: { path: "free" } })
  })
})

describe("the seat", () => {
  it("is the route the facts decide, ready once the name is linked", async () => {
    // Given
    const nameGate = createNameGate({ link: async () => "linked", retryDelay: () => 5_000 })
    const { flow } = flowOver(fakeChain(), { nameGate })

    // When
    const before = await flow.readSeat()
    flow.requestName()
    await vi.advanceTimersByTimeAsync(0)
    const after = await flow.readSeat()

    // Then
    expect(before.seat).toEqual({ path: "deposit", ready: false })
    expect(after.seat).toEqual({ path: "deposit", ready: true })
  })

  it("a new game takes the last game's optimism away", async () => {
    // Given
    const { flow } = flowOver(fakeChain())
    await flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // When
    flow.newSlot(8)

    // Then
    expect(flow.optimistic().registered).toBe(false)
  })
})

describe("a sign-up holds together", () => {
  /** a sign-up that goes on the wire and never hears back, on a page the test hides and shows */
  function wiredForever(player: SignUpFlowChain["player"] = vi.fn(async () => ({ registered: false }))) {
    let watcher: ((hidden: boolean) => void) | undefined
    const chain = fakeChain({
      register: vi.fn((_capabilities: GameRegistrationCapabilities, _id: Uint8Array, options?: RegisterOptions) => {
        options?.onDraws?.({ entered: 0, scheduled: 0, waitedMs: 0, retries: 0 })
        options?.onBroadcast?.()
        return new Promise<DispatchResult>(() => {})
      }),
      player,
    })
    const page = {
      hidden: () => false,
      watch: (onChange: (hidden: boolean) => void) => {
        watcher = onChange
        return () => (watcher = undefined)
      },
    }
    const hide = () => watcher?.(true)
    const show = () => watcher?.(false)
    const shown = () => {
      hide()
      show()
    }
    return { chain, page, hide, show, shown }
  }

  it("expires and re-reads on return after the phone slept past the deadline", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0)
    const player = vi.fn(async () => ({ registered: false }))
    const { chain, page, hide, show } = wiredForever(player)
    const { flow, attrs } = flowOver(chain, { page })
    await flow.register!()
    const readsBeforeReturn = player.mock.calls.length

    hide()
    vi.setSystemTime(Date.now() + 50_000)
    show()
    await vi.advanceTimersByTimeAsync(0)

    expect(player).toHaveBeenCalledTimes(readsBeforeReturn + 1)
    expect(attrs["signup.hidden_ms"]).toBe("50000")
    expect(attrs["signup.on_return"]).toBe("expired")
    flow.cancelRegister()
  })

  it("settles an attempt once when the page comes back after its deadline", async () => {
    // Given: the deadline passed, and the attempt waits two blocks before it re-reads
    const { chain, page, shown } = wiredForever()
    const { flow, ends, failures } = flowOver(chain, { page })
    await flow.register!()
    await vi.advanceTimersByTimeAsync(45_001)

    // When: the page is shown again while it waits
    shown()
    await vi.advanceTimersByTimeAsync(20_000)

    // Then: one end and one failure for the attempt
    expect(ends.filter(([name]) => name === "game-signup")).toHaveLength(1)
    expect(failures.filter((failure) => failure.startsWith("signup-failed"))).toHaveLength(1)
  })

  it("keeps the player in when the page's return found the sign-up landed while the attempt waited", async () => {
    // Given: past the deadline, waiting two blocks to re-read
    let registered = false
    const { chain, page, shown } = wiredForever(vi.fn(async () => ({ registered })))
    const { flow, ends } = flowOver(chain, { page })
    await flow.register!()
    await vi.advanceTimersByTimeAsync(45_001)

    // When: the page comes back and the chain has the player; then a read says otherwise
    registered = true
    shown()
    await vi.advanceTimersByTimeAsync(0)
    registered = false
    await vi.advanceTimersByTimeAsync(20_000)

    // Then
    expect(ends).toContainEqual(["game-signup", "landed"])
    expect(flow.optimistic().registered).toBe(true)
  })

  it("tells its listeners the sign-up is over when a reminder holds it", async () => {
    // Given
    const { flow } = flowOver(fakeChain(), { reminders: async () => "alarm-required" as const })
    const heard: boolean[] = []
    flow.onChange(() => heard.push(flow.signingUp()))

    // When
    await flow.register!()

    // Then
    expect(flow.signingUp()).toBe(false)
    expect(heard.at(-1)).toBe(false)
  })

  it("reads the player again after a read that threw at once", async () => {
    // Given: the first read throws before it returns a promise, the next finds the player
    let reads = 0
    const player = vi.fn((): Promise<{ registered: boolean }> => {
      reads += 1
      if (reads === 1) throw new Error("not an address")
      return Promise.resolve({ registered: true })
    })
    const { flow } = flowOver(fakeChain({ player }))

    // When
    void flow.register!().catch(() => {})
    await vi.advanceTimersByTimeAsync(60_000)

    // Then
    expect(reads).toBeGreaterThan(1)
    expect(flow.optimistic().registered).toBe(true)
  })

  it("binds again on the ladder after a bind that threw", async () => {
    // Given: a lite person whose bind throws (the host's prover is gone)
    const bind = vi.fn(async (): Promise<never> => {
      throw new Error("the prover is gone")
    })
    const chain = fakeChain({ holdsLiteKey: vi.fn(async () => true), bind })
    const keys = { holds: vi.fn(async () => true), prove: vi.fn() }
    const { flow } = flowOver(chain, { capabilities: capabilities({ personhood: keys }) })

    // When
    flow.requestBind()
    await vi.advanceTimersByTimeAsync(0)
    flow.requestBind()
    await vi.advanceTimersByTimeAsync(0)

    // Then: not again at once, but after the ladder's first wait
    expect(bind).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(GAME_REGISTRATION_RETRY_MS[0]!)
    flow.requestBind()
    await vi.advanceTimersByTimeAsync(0)
    expect(bind).toHaveBeenCalledTimes(2)
  })

  it("logs a bind failure as an error only once it keeps failing", async () => {
    // Given: a lite person whose bind is refused, for now, every time
    const bind = vi.fn(async () => ({
      kind: "refused" as const,
      permanent: false,
      refusal: "transient",
      code: "Stale",
      detail: "lite bind failed: Stale",
    }))
    const chain = fakeChain({ holdsLiteKey: vi.fn(async () => true), bind: bind as never })
    const keys = { holds: vi.fn(async () => true), prove: vi.fn() }
    const levels: Array<string | undefined> = []
    const { flow } = flowOver(chain, {
      capabilities: capabilities({ personhood: keys }),
      log: (tag, message, _data, level) => {
        if (tag === "bind" && message.startsWith("bind failed")) levels.push(level)
      },
    })

    // When: three attempts in a row fail
    const ladderTop = Math.max(...GAME_REGISTRATION_RETRY_MS)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      flow.requestBind()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(ladderTop)
    }

    // Then: the retries are warnings, and the third failure in a row is the error
    expect(bind).toHaveBeenCalledTimes(3)
    expect(levels).toEqual(["warn", "warn", "error"])
  })
})

describe("the game registration record", () => {
  /** a store that keeps what the flow wrote, in order */
  function recorded() {
    const writes: (GameRegistration | null)[] = []
    const registrationRecord = { surface: "app" as const, write: async (record: GameRegistration | null) => void writes.push(record) }
    const phases = () => writes.map((record) => (record ? `${record.phase}${record.reason ? `:${record.reason}` : ""}` : "cleared"))
    return { writes, registrationRecord, phases }
  }

  it("writes registering, sent and registered through a sign-up that lands, one attempt for the tap", async () => {
    // Given
    const { writes, registrationRecord, phases } = recorded()
    const { flow } = flowOver(fakeChain(), { registrationRecord })

    // When
    await flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(phases()).toEqual(["registering", "sent", "registered"])
    expect(writes.every((record) => record?.gameIndex === 7 && record.surface === "app")).toBe(true)
    expect(new Set(writes.map((record) => record?.attempt)).size).toBe(1)
  })

  it("ends registered for a player the chain already has, filing nothing", async () => {
    // Given
    const { registrationRecord, phases } = recorded()
    const chain = fakeChain({ player: vi.fn(async () => ({ registered: true })) })
    const { flow } = flowOver(chain, { registrationRecord })

    // When
    await flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then: the chain's word counts as on the wire, as the app's sign-up always has
    expect(chain.register).not.toHaveBeenCalled()
    expect(phases()).toEqual(["registering", "sent", "registered"])
  })

  it("writes failed once registration has closed", async () => {
    // Given
    const { registrationRecord, phases } = recorded()
    const chain = fakeChain({
      game: vi.fn(async () => ({ index: 7, state: { type: "Shuffle" }, registration_ends: NOW - 1 })),
    })
    const { flow } = flowOver(chain, { registrationRecord })

    // When
    await flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(phases()).toEqual(["registering", "failed:window-closed"])
  })

  it("writes failed when the tap ends on an account that cannot pay", async () => {
    // Given
    const { registrationRecord, phases } = recorded()
    const { flow } = flowOver(fakeChain({ seat: vi.fn(async (account, facts) => gameSeat({ free: 10n })(account, facts)) }), { registrationRecord })

    // When
    await flow.register!().catch(() => {})

    // Then
    expect(phases()).toEqual(["registering", "failed:refused"])
  })

  it("clears its record when the page stops a sign-up that never went out", async () => {
    // Given: the seat read never answers
    const { registrationRecord, phases } = recorded()
    const { flow } = flowOver(fakeChain({ seat: vi.fn(() => new Promise<never>(() => {})) }), { registrationRecord })
    const tap = flow.register!().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)

    // When
    flow.cancelRegister()
    await vi.advanceTimersByTimeAsync(100)

    // Then
    expect(await tap).toEqual(new Error("the sign-up was cancelled"))
    expect(phases()).toEqual(["registering", "cleared"])
  })

  it("writes nothing while a reminder holds the sign-up back", async () => {
    // Given
    const { registrationRecord, writes } = recorded()
    const { flow } = flowOver(fakeChain(), { registrationRecord, reminders: async () => "alarm-required" as const })

    // When
    await flow.register!()

    // Then
    expect(writes).toEqual([])
  })

  it("signs up all the same when the record cannot be written", async () => {
    // Given
    const chain = fakeChain()
    const write = vi.fn(() => {
      throw new Error("no storage")
    })
    const { flow } = flowOver(chain, { registrationRecord: { surface: "app", write } })

    // When
    await flow.register!()
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(chain.register).toHaveBeenCalledTimes(1)
    expect(flow.optimistic().registered).toBe(true)
    expect(write).toHaveBeenCalledTimes(3)
  })
})
