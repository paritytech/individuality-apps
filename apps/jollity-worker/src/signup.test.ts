// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tests the sign-up from the chat over a fake engine and a fake host: which
 * route it takes, when it binds first, what the card is asked, and what each
 * outcome leaves on the card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { COMMUNICATION_KEY_KEY, GAME_REGISTRATION_KEY, REGISTRATION_WATCH_MS, toHex } from "@individuality/shared-records"
import { cardCopy } from "./card"
import { deriveSeat, GameRegistrationError, type GameSeat, type LiteSignUpBlocker, type PersonhoodRing } from "@parity/product-sdk-individuality"
import type { DispatchResult } from "@individuality/people-chain"
import { BIND_TIMEOUT_MS, communicationKeyFrom, communicationKeyRecord, type BindResult, type RegisterOptions, type RegisterResult } from "@individuality/sign-up"
import {
  createSignup,
  LANDING_WAIT_MS,
  reportInterruptedSignup,
  signingRefused,
  submitSignUp,
  type Signup,
  type SignupDependencies,
  type SignupEngine,
} from "./signup"
import { configureTelemetry, resetTelemetry, setChatUser } from "./telemetry"
import type { WorkerHost } from "./host"
import { decodeTelemetryEnvelope, telemetryRecords, type TelemetryRecord } from "./testing/telemetry-envelope"

const ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
/** the people-lite ring the SDK asks the host about */
const LITE_RING: PersonhoodRing = { key: "lite", owner: "peopl.paseo", ring: { chainId: "0x01", junctions: [] } }
/** the host holds this person's lite key */
const KEY = "the lite key"
const SIGNER = { publicKey: new Uint8Array(32) } as never
const ENTROPY = new Uint8Array(32).fill(9)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** what the chain says about the account: its seat blockers and its balance, against a deposit route of 20 */
const facts = (blockers: string[], free = 0n) => ({ blockers, free })

/** A sign-up the pool refused, as the shared sign-up hands it back from the SDK. */
const poolRefusal = (code: string): RegisterResult => ({ ok: false, error: new GameRegistrationError("sign", code, { retryable: true }).message, code })

/** The SDK's seat over `spec`, its route decided by the SDK's own `deriveSeat`. */
function seatOf(spec: ReturnType<typeof facts>, litePerson = false): GameSeat {
  const blockers = spec.blockers.map((tag) => ({ tag })) as unknown as LiteSignUpBlocker[]
  return {
    ...deriveSeat({ blockers, free: spec.free, required: 20n, litePerson }),
    registered: spec.blockers.includes("AlreadyRegistered"),
    open: true,
    required: 20n,
    requirement: { blockers } as unknown as GameSeat["requirement"],
    funds: { free: spec.free, deposit: 10n, estimatedFee: 5n, decimals: 10, symbol: "PAS" } as GameSeat["funds"],
  }
}

/** The shared sign-up's chain side over `spec`: a lite person is whoever the host's keys say. */
function fakeEngine(spec: ReturnType<typeof facts>, register?: (options: RegisterOptions) => Promise<DispatchResult>) {
  return {
    seat: vi.fn(async (_address: string, { litePerson }: { litePerson: boolean }) => seatOf(spec, litePerson)),
    holdsLiteKey: vi.fn(async (capabilities: { personhood?: { holds(ring: PersonhoodRing): Promise<boolean> } }) =>
      capabilities.personhood ? capabilities.personhood.holds(LITE_RING) : false,
    ),
    bind: vi.fn<SignupEngine["bind"]>(async () => ({ kind: "bound" })),
    register: vi.fn(async (_capabilities: unknown, _id: Uint8Array, options?: RegisterOptions) =>
      register ? register(options!) : { ok: true as const },
    ),
  } satisfies SignupEngine
}

function fakeHost(overrides: { signer?: unknown; liteKey?: () => Promise<string | null> } = {}) {
  const store = new Map<string, unknown>()
  const liteKey = vi.fn(overrides.liteKey ?? (async () => null))
  const personhood = { holds: vi.fn(async () => (await liteKey()) !== null), prove: vi.fn() }
  return {
    store,
    /** whether the host holds the person's lite key */
    liteKey,
    personhood,
    storage: {
      readJSON: vi.fn(async (key: string) => store.get(key) ?? null),
      writeJSON: vi.fn(async (key: string, value: unknown) => void store.set(key, value)),
    },
    accounts: {
      signer: vi.fn().mockResolvedValue("signer" in overrides ? overrides.signer : SIGNER),
      signVrf: vi.fn(() => async () => ({ preOutput: new Uint8Array(32), proof: new Uint8Array(64) })),
      personhood: vi.fn(() => personhood),
    },
    entropy: vi.fn().mockResolvedValue(ENTROPY),
  } as unknown as WorkerHost & {
    store: Map<string, unknown>
    liteKey: typeof liteKey
    personhood: typeof personhood
    accounts: { [K in keyof WorkerHost["accounts"]]: ReturnType<typeof vi.fn> }
  }
}

/** The values the sign-up wrote to its key in host storage, in order. */
const marks = (host: ReturnType<typeof fakeHost>) =>
  vi.mocked(host.storage.writeJSON).mock.calls.filter(([key]) => key === GAME_REGISTRATION_KEY).map(([, value]) => value)

/** The step of every busy state the sign-up goes through from here on, in order. */
function busySteps(signup: Signup): string[] {
  const steps: string[] = []
  signup.subscribe(() => {
    const state = signup.state()
    if (state.kind === "busy") steps.push(state.step)
  })
  return steps
}

function signupWith(
  engine: SignupEngine,
  host = fakeHost(),
  remindersInPlace: SignupDependencies["remindersInPlace"] = async (): Promise<string | null> => null,
  reportInterrupted = async (): Promise<boolean> => true,
  extra: Partial<SignupDependencies> = {},
) {
  const openApp = vi.fn().mockResolvedValue(undefined)
  const linkName = vi.fn()
  const signup = createSignup({
    host,
    connect: async () => ({ engine, address: ADDRESS }),
    account: { name: "dim2.paseo", index: 1 },
    remindersInPlace,
    reportInterrupted,
    openApp,
    linkName,
    ...extra,
  })
  return { signup, openApp, host, linkName }
}

describe("sign-up from the chat works", () => {
  it("signs a returning player up on the returning route, with the draw tickets the host signs", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]))
    const { signup, host } = signupWith(engine)

    // When
    await signup.register(7)

    // Then: the SDK takes the returning route from the seat it reads; the
    // chat hands it the signer and the host's draw ticket
    expect(engine.register).toHaveBeenCalledWith(
      expect.objectContaining({ signer: SIGNER, signVrf: expect.any(Function), account: expect.objectContaining({ address: ADDRESS }) }),
      communicationKeyFrom(ENTROPY, 7).publicKey,
      expect.anything(),
    )
    expect(host.accounts.signVrf).toHaveBeenCalledWith("dim2.paseo", 1)
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
  })

  it("hands the SDK the host's personhood keys, for a member's draw proofs and the lite proof, and submits through the chat's watch", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]))
    const { signup, host } = signupWith(engine)

    // When
    await signup.register(7)
    const capabilities = engine.register.mock.calls[0]![0] as { personhood?: unknown; submit?: unknown }

    // Then
    expect(capabilities.personhood).toBe(host.personhood)
    expect(capabilities.submit).toBe(submitSignUp)
  })

  it("links the player's name once their sign-up from the chat lands", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]))
    const { signup, linkName } = signupWith(engine)

    // When
    await signup.register(7)

    // Then
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(linkName).toHaveBeenCalledTimes(1)
  })

  it("links the name even when the sign-up went without its tickets", async () => {
    // Given: the account holds the player's later tickets too, so the link is wanted either way
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async (options) => {
      options.onDraws!({ entered: 0, skipped: "draw #0 is not taking entries yet", kind: "not-open", scheduled: 1, waitedMs: 0, retries: 0 })
      options.onBroadcast!()
      return { ok: true }
    })
    const { signup, linkName } = signupWith(engine)

    // When
    await signup.register(7)

    // Then
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(linkName).toHaveBeenCalledTimes(1)
  })

  it("links no name when the sign-up fails, or was another's already", async () => {
    // Given
    const failing = fakeEngine(facts(["AlreadyPlaying"]), async () => poolRefusal("NoRegistration"))
    const taken = fakeEngine(facts(["AlreadyPlaying"]), async () => ({ ok: false, error: "AlreadyRegistered" }))
    const first = signupWith(failing)
    const second = signupWith(taken)

    // When
    await first.signup.register(7)
    await second.signup.register(7)

    // Then
    expect(first.signup.state().kind).toBe("failed")
    expect(second.signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(first.linkName).not.toHaveBeenCalled()
    expect(second.linkName).not.toHaveBeenCalled()
  })

  it("waits on the name link before it asks the host for anything, then signs up", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]))
    let linked!: (name: "linked" | "not-linked") => void
    const nameInPlace = vi.fn(() => new Promise<"linked" | "not-linked">((resolve) => (linked = resolve)))
    const { signup, host } = signupWith(engine, fakeHost(), undefined, undefined, { nameInPlace })
    const steps = busySteps(signup)

    // When
    const signingUp = signup.register(7)
    await flush()

    // Then
    expect(steps).toEqual(["reminders", "name"])
    expect(host.accounts.signer).not.toHaveBeenCalled()
    linked("linked")
    await signingUp
    expect(steps).toEqual(["reminders", "name", "signer", "route", "draws"])
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
  })

  it("signs nothing up, and leaves a notice to try again, when the name is not linked in time", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]))
    const { signup, host } = signupWith(engine, fakeHost(), undefined, undefined, { nameInPlace: async () => "not-linked" })

    // When
    await signup.register(7)

    // Then
    expect(host.accounts.signer).not.toHaveBeenCalled()
    expect(engine.register).not.toHaveBeenCalled()
    expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.SIGN_UP_FAILED })
  })

  it("signs nothing up, and says the username is not registered, when nobody owns it on chain (#1115)", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]))
    const { signup, host } = signupWith(engine, fakeHost(), undefined, undefined, {
      nameInPlace: async () => "not-linked",
      nameUnowned: () => true,
    })

    // When
    await signup.register(7)

    // Then
    expect(host.accounts.signer).not.toHaveBeenCalled()
    expect(engine.register).not.toHaveBeenCalled()
    expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.NAME_UNOWNED, needs: "username" })
  })

  it("signs nothing up and leaves the notice of the gate while the reminders are not in place", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]))
    const { signup, host } = signupWith(engine, fakeHost(), async () => "Turn on alarms or notifications for Polkadot to register.")

    // When
    await signup.register(7)

    // Then
    expect(host.accounts.signer).not.toHaveBeenCalled()
    expect(engine.register).not.toHaveBeenCalled()
    expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: "Turn on alarms or notifications for Polkadot to register." })
  })

  it("takes the deposit route for an account the chain does not know that can pay", async () => {
    // Given
    const engine = fakeEngine(facts([], 20n))
    const { signup } = signupWith(engine)

    // When
    await signup.register(7)

    // Then
    expect(engine.register).toHaveBeenCalledWith(expect.objectContaining({ signer: SIGNER }), expect.any(Uint8Array), expect.anything())
  })

  it("takes the free route with the lite proof for a lite person whose binding is there", async () => {
    // Given
    const engine = fakeEngine(facts([]), async (options) => {
      options.onDraws!({ entered: 1, scheduled: 1, waitedMs: 0, retries: 0 })
      return { ok: true }
    })
    const host = fakeHost({ liteKey: async () => KEY })
    const { signup } = signupWith(engine, host)
    const steps = busySteps(signup)

    // When
    await signup.register(7)

    // Then
    expect(steps).toEqual(["reminders", "signer", "route", "draws", "sign"])
    expect(engine.bind).not.toHaveBeenCalled()
    // the SDK proves the free route's origin with the person's keys when the ring moved
    expect(engine.register).toHaveBeenCalledWith(
      expect.objectContaining({ signer: SIGNER, personhood: host.personhood }),
      expect.any(Uint8Array),
      expect.anything(),
    )
  })

  it("binds the lite alias first when the free route has no binding yet, and never takes the ring back", async () => {
    // Given
    const engine = fakeEngine(facts(["AliasNotBound"]), async (options) => {
      options.onDraws!({ entered: 1, scheduled: 1, waitedMs: 0, retries: 0 })
      return { ok: true }
    })
    const { signup } = signupWith(engine, fakeHost({ liteKey: async () => KEY }))
    const steps = busySteps(signup)

    // When
    await signup.register(7)

    // Then
    expect(steps).toEqual(["reminders", "signer", "route", "bind", "draws", "sign"])
    expect(engine.bind).toHaveBeenCalledWith(expect.objectContaining({ account: expect.objectContaining({ address: ADDRESS }) }), {
      signal: expect.any(AbortSignal),
    })
    expect(engine.bind.mock.invocationCallOrder[0]).toBeLessThan(engine.register.mock.invocationCallOrder[0]!)
    expect(engine.register).toHaveBeenCalledWith(expect.objectContaining({ signer: SIGNER }), expect.any(Uint8Array), expect.anything())
  })

  it("takes the deposit route when the bind is refused for good, and stops counting the person", async () => {
    // Given
    const engine = fakeEngine(facts(["AliasNotBound"], 20n))
    engine.bind.mockResolvedValue({
      kind: "refused",
      permanent: true,
      refusal: "pinned-elsewhere",
      code: "AnotherAccountInvited",
      account: "5Other",
      detail: "lite bind refused: the person's free seat is on 5Other",
    })
    const host = fakeHost({ liteKey: async () => KEY })
    const { signup } = signupWith(engine, host)

    // When
    await signup.register(7)
    await signup.register(8)

    // Then
    expect(engine.register).toHaveBeenCalledWith(expect.objectContaining({ signer: SIGNER }), expect.any(Uint8Array), expect.anything())
    expect(engine.bind).toHaveBeenCalledTimes(1)
    expect(host.liteKey).toHaveBeenCalledTimes(1)
  })

  it("never asks about the draw: a sign-up that cannot carry its ticket goes out without it", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async (options) => {
      expect(options).not.toHaveProperty("confirmWithoutDraws")
      options.onDraws!({ entered: 0, skipped: "draw #0 is not taking entries yet (gave up waiting)", kind: "not-open", scheduled: 1, waitedMs: 20_000, retries: 9 })
      options.onBroadcast!()
      return { ok: true }
    })
    const { signup } = signupWith(engine)

    // When
    await signup.register(7)

    // Then
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
  })

  it("shows the player registered the moment the sign-up is on the wire", async () => {
    // Given
    let finalize: (result: DispatchResult) => void = () => {}
    const engine = fakeEngine(facts(["AlreadyPlaying"]), (options) => {
      options.onBroadcast!()
      return new Promise((resolve) => (finalize = resolve))
    })
    const { signup } = signupWith(engine)

    // When
    const signingUp = signup.register(7)
    await flush()

    // Then
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    finalize({ ok: true })
    await signingUp
  })

  it("takes an account the chain already holds as registered", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async () => ({ ok: false, error: "AlreadyRegistered" }))
    const { signup } = signupWith(engine)

    // When
    await signup.register(7)

    // Then
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
  })

  it("files nothing for an account the seat read already shows registered", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying", "AlreadyRegistered"]))
    const { signup, openApp } = signupWith(engine)

    // When
    await signup.register(7)

    // Then
    expect(engine.register).not.toHaveBeenCalled()
    expect(openApp).not.toHaveBeenCalled()
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
  })

  it("opens the app for an account that cannot pay, and for a host that hands over no signer", async () => {
    // Given
    const unfunded = fakeEngine(facts([], 0n))
    const unsigned = fakeEngine(facts(["AlreadyPlaying"]))
    const broke = signupWith(unfunded)
    const signerless = signupWith(unsigned, fakeHost({ signer: null }))

    // When
    await broke.signup.register(7)
    await signerless.signup.register(7)

    // Then
    expect(broke.openApp).toHaveBeenCalledTimes(1)
    expect(unfunded.register).not.toHaveBeenCalled()
    expect(signerless.openApp).toHaveBeenCalledTimes(1)
    expect(unsigned.seat).not.toHaveBeenCalled()
    expect([broke.signup.state(), signerless.signup.state()]).toEqual([
      { kind: "idle", handedOff: 7 },
      { kind: "idle", handedOff: 7 },
    ])
  })

  it("starts no second sign-up while one is on its way", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]), () => new Promise(() => {}))
    const { signup } = signupWith(engine)

    // When
    void signup.register(7)
    void signup.register(7)
    await flush()

    // Then
    expect(engine.seat).toHaveBeenCalledTimes(1)
  })

  it("keeps the game's communication key in this product's storage before the sign-up goes out, and sends its public half", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]))
    const { signup, host } = signupWith(engine)
    const key = communicationKeyFrom(ENTROPY, 7)

    // When
    await signup.register(7)

    // Then
    const kept = vi.mocked(host.storage.writeJSON).mock.calls.find(([k]) => k === COMMUNICATION_KEY_KEY)?.[1]
    expect(kept).toMatchObject({ gameIndex: 7, publicKey: toHex(key.publicKey), secret: toHex(key.secret) })
    expect(engine.register).toHaveBeenCalledWith(expect.anything(), key.publicKey, expect.anything())
  })
  it("sends the key the app already kept for the game instead of deriving another", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]))
    const host = fakeHost()
    const appKey = communicationKeyFrom(new Uint8Array(32).fill(3), 7)
    await host.storage.writeJSON(COMMUNICATION_KEY_KEY, communicationKeyRecord(7, appKey))
    vi.mocked(host.storage.writeJSON).mockClear()
    const { signup } = signupWith(engine, host)

    // When
    await signup.register(7)

    // Then
    expect(engine.register).toHaveBeenCalledWith(expect.anything(), appKey.publicKey, expect.anything())
    expect(vi.mocked(host.storage.writeJSON).mock.calls.some(([k]) => k === COMMUNICATION_KEY_KEY)).toBe(false)
  })
})

describe("sign-up from the chat fails", () => {
  // The names of the Game pallet's own errors (the Game error enum of the
  // individuality descriptors), which is what engine.register reports. The
  // SDK's seat blocker tags never come back as a dispatch error.
  it.each(["NoRegistration", "NoGame", "GameOngoing"])("leaves the closing notice when the pallet refuses with %s", async (error) => {
    // Given
    const late = signupWith(fakeEngine(facts(["AlreadyPlaying"]), async () => poolRefusal(error)))

    // When
    await late.signup.register(7)

    // Then
    expect(late.signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.REGISTRATION_CLOSED_NOTICE })
  })

  it("leaves the closing notice when registration closed, and the plain one for any other refusal", async () => {
    // Given
    const late = signupWith(fakeEngine(facts(["AlreadyPlaying"]), async () => ({ ok: false, error: "NoRegistration" })))
    const refused = signupWith(fakeEngine(facts(["AlreadyPlaying"]), async () => ({ ok: false, error: "GameFull" })))

    // When
    await late.signup.register(7)
    await refused.signup.register(7)

    // Then
    expect(late.signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.REGISTRATION_CLOSED_NOTICE })
    expect(refused.signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.SIGN_UP_FAILED })
  })

  it.each([
    ["signer", (host: ReturnType<typeof fakeHost>) => host.accounts.signer.mockReturnValueOnce(new Promise(() => {}))],
    ["entropy", (host: ReturnType<typeof fakeHost>) => vi.mocked(host.entropy).mockReturnValueOnce(new Promise(() => {}))],
    ["lite key", (host: ReturnType<typeof fakeHost>) => host.liteKey.mockReturnValueOnce(new Promise(() => {}))],
  ] as const)("ends failed when the %s request never answers", async (_step, hang) => {
    // Given
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const engine = fakeEngine(facts(["AlreadyPlaying"]))
      const host = fakeHost()
      hang(host)
      const { signup } = signupWith(engine, host)

      // When
      const signingUp = signup.register(7)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await signingUp

      // Then
      expect(engine.register).not.toHaveBeenCalled()
      expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.SIGN_UP_FAILED })
    } finally {
      vi.useRealTimers()
    }
  })

  it("ends failed, rather than taking another route, when the lite ring read never answers", async () => {
    // Given
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const engine = fakeEngine(facts([], 20n))
      engine.holdsLiteKey.mockReturnValueOnce(new Promise(() => {}))
      const { signup } = signupWith(engine, fakeHost({ liteKey: async () => KEY }))

      // When
      const signingUp = signup.register(7)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await signingUp

      // Then
      expect(engine.register).not.toHaveBeenCalled()
      expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.SIGN_UP_FAILED })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    [["AlreadyPlaying", "AlreadyRegistered"], "sent"],
    [["AlreadyPlaying"], "unsettled"],
  ] as const)("a broadcast whose watch never settles reads the chain again: %j ends %s", async (after, kind) => {
    // Given
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const engine = fakeEngine(facts(["AlreadyPlaying"]), (options) => {
        options.onBroadcast!()
        return new Promise(() => {})
      })
      engine.seat.mockResolvedValueOnce(seatOf(facts(["AlreadyPlaying"]))).mockResolvedValue(seatOf(facts([...after])))
      const { signup } = signupWith(engine)

      // When
      const signingUp = signup.register(7)
      await vi.advanceTimersByTimeAsync(1_000)
      const onTheWire = signup.state()
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await signingUp

      // Then
      expect(onTheWire).toEqual({ kind: "sent", gameIndex: 7 })
      expect(signup.state()).toEqual(kind === "sent" ? { kind: "sent", gameIndex: 7 } : { kind: "idle", unsettled: 7 })
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaves a broadcast whose watch and re-read never settle to the poll, rather than failing it", async () => {
    // Given
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const engine = fakeEngine(facts(["AlreadyPlaying"]), (options) => {
        options.onBroadcast!()
        return new Promise(() => {})
      })
      engine.seat.mockResolvedValueOnce(seatOf(facts(["AlreadyPlaying"]))).mockReturnValue(new Promise(() => {}))
      const { signup } = signupWith(engine)

      // When
      const signingUp = signup.register(7)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await signingUp

      // Then
      expect(signup.state()).toEqual({ kind: "idle", unsettled: 7 })
    } finally {
      vi.useRealTimers()
    }
  })

  it("ends sent, and links the name, when the watch never settles but the re-read finds the player registered", async () => {
    // Given
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const engine = fakeEngine(facts(["AlreadyPlaying"]), (options) => {
        options.onBroadcast!()
        return new Promise(() => {})
      })
      engine.seat.mockResolvedValueOnce(seatOf(facts(["AlreadyPlaying"]))).mockResolvedValue(seatOf(facts(["AlreadyPlaying", "AlreadyRegistered"])))
      const { signup, linkName } = signupWith(engine)

      // When
      const signingUp = signup.register(7)
      await vi.advanceTimersByTimeAsync(REGISTRATION_WATCH_MS)
      await signingUp

      // Then
      expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
      expect(linkName).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaves a notice and sends nothing when the bind fails for the moment", async () => {
    // Given
    const engine = fakeEngine(facts(["AliasNotBound"]))
    engine.bind.mockRejectedValue(new Error("the pool dropped the transaction"))
    const { signup } = signupWith(engine, fakeHost({ liteKey: async () => KEY }))

    // When
    await signup.register(7)

    // Then
    expect(engine.register).not.toHaveBeenCalled()
    expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.SIGN_UP_FAILED })
  })

  it("aborts a bind that runs past its deadline, so it sends nothing more and the next tap cannot put a second one in flight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      // Given: a bind whose watch never settles
      const engine = fakeEngine(facts(["AliasNotBound"]))
      let signal: AbortSignal | undefined
      engine.bind.mockImplementation((_capabilities: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal
        return new Promise<BindResult>(() => {})
      })
      const { signup } = signupWith(engine, fakeHost({ liteKey: async () => KEY }))

      // When
      const signingUp = signup.register(7)
      await vi.advanceTimersByTimeAsync(BIND_TIMEOUT_MS)
      await signingUp

      // Then
      expect(signal?.aborted).toBe(true)
      expect(engine.register).not.toHaveBeenCalled()
      expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.SIGN_UP_FAILED })
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaves a notice rather than take a lite person for nobody when the host cannot list the keys", async () => {
    // Given
    const engine = fakeEngine(facts([], 20n))
    const host = fakeHost({
      liteKey: async () => {
        throw new Error("The host could not list the keys of peopl.paseo.")
      },
    })
    const { signup } = signupWith(engine, host)

    // When
    await signup.register(7)

    // Then
    expect(engine.register).not.toHaveBeenCalled()
    expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.SIGN_UP_FAILED })
  })
})

describe("sign-up from the chat is shared with the app", () => {
  it("marks the sign-up registering from the tap, sent from the broadcast, and registered once the chain holds it", async () => {
    // Given
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 })
    try {
      let finalize: (result: DispatchResult) => void = () => {}
      let broadcast: () => void = () => {}
      const engine = fakeEngine(facts(["AlreadyPlaying"]), (options) => {
        broadcast = options.onBroadcast!
        return new Promise((resolve) => (finalize = resolve))
      })
      const { signup, host } = signupWith(engine)

      // When
      const signingUp = signup.register(7)
      await flush()

      // Then
      expect(host.store.get(GAME_REGISTRATION_KEY)).toEqual({ gameIndex: 7, phase: "registering", surface: "chat", at: 1_700_000_000_000, attempt: 1_700_000_000_000 })

      // When
      vi.setSystemTime(1_700_000_010_000)
      broadcast()
      await flush()

      // Then
      expect(host.store.get(GAME_REGISTRATION_KEY)).toEqual({ gameIndex: 7, phase: "sent", surface: "chat", at: 1_700_000_010_000, attempt: 1_700_000_000_000 })

      // When
      vi.setSystemTime(1_700_000_060_000)
      finalize({ ok: true })
      await signingUp
      await flush()

      // Then
      expect(host.store.get(GAME_REGISTRATION_KEY)).toEqual({ gameIndex: 7, phase: "registered", surface: "chat", at: 1_700_000_060_000, attempt: 1_700_000_000_000 })
    } finally {
      vi.useRealTimers()
    }
  })

  it("lands the end of a refused sign-up after a slow mark of the tap", async () => {
    // Given
    const host = fakeHost()
    let releaseTap: () => void = () => {}
    vi.mocked(host.storage.writeJSON).mockImplementationOnce(
      (key: string, value: unknown) =>
        new Promise<void>((resolve) => {
          releaseTap = () => {
            host.store.set(key, value)
            resolve()
          }
        }),
    )
    const { signup } = signupWith(fakeEngine(facts(["AlreadyPlaying"]), async () => ({ ok: false, error: "GameFull" })), host)

    // When
    await signup.register(7)
    await flush()
    releaseTap()
    await flush()

    // Then
    expect(signup.state()).toMatchObject({ kind: "failed" })
    expect(host.store.get(GAME_REGISTRATION_KEY)).toMatchObject({ phase: "failed", gameIndex: 7, reason: "register" })
  })

  it("marks a sign-up that fails, and clears the mark of one that goes to the app or is left unsettled", async () => {
    // Given
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const refused = signupWith(fakeEngine(facts(["AlreadyPlaying"]), async () => ({ ok: false, error: "GameFull" })))
      const broke = signupWith(fakeEngine(facts([], 0n)))
      const unsettled = signupWith(
        fakeEngine(facts(["AlreadyPlaying"]), (options) => {
          options.onBroadcast!()
          return new Promise(() => {})
        }),
      )

      // When
      await refused.signup.register(7)
      await broke.signup.register(7)
      const watching = unsettled.signup.register(7)
      await vi.advanceTimersByTimeAsync(REGISTRATION_WATCH_MS)
      await watching
      await vi.advanceTimersByTimeAsync(0)

      // Then
      expect(marks(refused.host)).toEqual([expect.objectContaining({ phase: "registering" }), expect.objectContaining({ phase: "failed", reason: "register" })])
      expect(marks(broke.host)).toEqual([expect.objectContaining({ phase: "registering" }), null])
      expect(marks(unsettled.host)).toEqual([expect.objectContaining({ phase: "registering" }), expect.objectContaining({ phase: "sent" }), null])
    } finally {
      vi.useRealTimers()
    }
  })

  it("writes nothing for a tap dropped while a sign-up is on its way", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]), () => new Promise(() => {}))
    const { signup, host } = signupWith(engine)

    // When
    void signup.register(7)
    await flush()
    void signup.register(7)
    await flush()

    // Then
    expect(marks(host)).toEqual([{ gameIndex: 7, phase: "registering", surface: "chat", at: expect.any(Number), attempt: expect.any(Number) }])
  })

  it("keeps the sign-up going when host storage refuses the mark", async () => {
    // Given
    const engine = fakeEngine(facts(["AlreadyPlaying"]))
    const { signup, host } = signupWith(engine)
    vi.mocked(host.storage.writeJSON).mockRejectedValue(new Error("no storage"))

    // When
    await signup.register(7)

    // Then
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
  })
})

describe("sign-up from the chat is recorded", () => {
  const sent: TelemetryRecord[] = []
  beforeEach(() => {
    sent.length = 0
    configureTelemetry({
      dsn: "https://k@o1.ingest.de.sentry.io/1",
      product: "dim2.paseo",
      fetchImpl: async (_url, init) => {
        sent.push(...decodeTelemetryEnvelope(init.body))
      },
    })
  })
  afterEach(() => resetTelemetry())
  const journeys = () => telemetryRecords(sent, "journey.game-signup", "transaction")
  const failures = () => sent.filter((record) => ["event", "metric"].includes(record.kind) && record.tags["failure.kind"] === "signup-failed")

  it("sends one sent journey with the route, bind, draws and timing", async () => {
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async (options) => {
      options.onDraws!({ entered: 2, scheduled: 2, waitedMs: 0, retries: 0 })
      options.onBroadcast!()
      return { ok: true }
    })
    const { signup } = signupWith(engine)
    await signup.register(7)
    await flush()
    expect(failures()).toEqual([])
    expect(journeys()).toHaveLength(1)
    expect(journeys()[0]!.tags).toMatchObject({
      surface: "chat",
      "journey.outcome": "sent",
      "journey.sad": "false",
      "signup.attempt": "1",
      "signup.route": expect.any(String),
      "signup.bind": "none",
      "signup.draws_entered": "2",
      "signup.draws_skipped": "none",
      "signup.tap_to_broadcast_ms": expect.stringMatching(/^\d+$/),
    })
  })

  it("records the bind result", async () => {
    const { signup } = signupWith(fakeEngine(facts(["AliasNotBound"]), async () => ({ ok: true })), fakeHost({ liteKey: async () => KEY }))
    await signup.register(7)
    await flush()
    expect(journeys()[0]!.tags["signup.bind"]).toBe("bound")
  })

  it("records the hand-off to the app with its why, sad but with no failure event", async () => {
    const broke = signupWith(fakeEngine(facts([], 0n)))
    const signerless = signupWith(fakeEngine(facts(["AlreadyPlaying"])), fakeHost({ signer: null }))
    await broke.signup.register(7)
    await signerless.signup.register(7)
    await flush()
    expect(journeys().map((j) => j.tags)).toEqual([
      expect.objectContaining({ "journey.outcome": "handoff", "signup.handoff_reason": "unfunded", "journey.expected": "true", "journey.sad": "true", "journey.sad_reason": "handoff-unfunded" }),
      expect.objectContaining({ "journey.outcome": "handoff", "signup.handoff_reason": "no-signer", "journey.sad_reason": "handoff-no-signer" }),
    ])
    expect(failures()).toEqual([])
  })

  it("records the draw on the journey, and one draw-skipped event, for a sign-up that went without its ticket", async () => {
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async (options) => {
      options.onDraws!({ entered: 0, skipped: "draw #0 is not taking entries yet (gave up waiting)", kind: "not-open", scheduled: 1, waitedMs: 20_000, retries: 9 })
      options.onBroadcast!()
      return { ok: true }
    })
    await signupWith(engine).signup.register(7)
    await flush()
    expect(journeys()[0]!.tags).toMatchObject({
      "signup.draw.outcome": "skipped",
      "signup.draw.kind": "not-open",
      "signup.draw.scheduled": "1",
      "signup.draw.waited_ms": "20000",
      "signup.draw.retries": "9",
    })
    const skipped = telemetryRecords(sent, "failure", "metric").filter((e) => e.tags["failure.kind"] === "draw-skipped")
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({
      value: 1,
      tags: { "failure.reason": "not-open", "journey.expected": "true" },
    })
    expect(telemetryRecords(sent, "draw-skipped: not-open", "log")).toContainEqual(
      expect.objectContaining({ contexts: { detail: expect.objectContaining({ skipped: expect.stringContaining("gave up waiting") }) } }),
    )
  })

  it("sends no draw-skipped event for a sign-up that never reached the wire", async () => {
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async (options) => {
      options.onDraws!({ entered: 0, skipped: "draw #0 is Drawing", kind: "closed", scheduled: 1, waitedMs: 0, retries: 0 })
      return { ok: false, error: "GameFull" }
    })
    await signupWith(engine).signup.register(7)
    await flush()
    expect(sent.filter((record) => record.tags["failure.kind"] === "draw-skipped")).toEqual([])
  })

  it("records an entered draw and sends no draw-skipped event", async () => {
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async (options) => {
      options.onDraws!({ entered: 2, scheduled: 2, waitedMs: 0, retries: 0 })
      options.onBroadcast!()
      return { ok: true }
    })
    await signupWith(engine).signup.register(7)
    await flush()
    expect(journeys()[0]!.tags).toMatchObject({ "signup.draw.outcome": "entered", "signup.draw.scheduled": "2", "signup.draw.retries": "0" })
    expect(journeys()[0]!.tags["signup.draw.kind"]).toBeUndefined()
    expect(sent.filter((record) => record.tags["failure.kind"] === "draw-skipped")).toEqual([])
  })

  it("calls a game without a draw no-draw, and sends no draw-skipped event", async () => {
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async (options) => {
      options.onDraws!({ entered: 0, skipped: "the game has no prize draw", scheduled: 0, waitedMs: 0, retries: 0 })
      options.onBroadcast!()
      return { ok: true }
    })
    await signupWith(engine).signup.register(7)
    await flush()
    expect(journeys()[0]!.tags["signup.draw.outcome"]).toBe("no-draw")
    expect(sent.filter((record) => record.tags["failure.kind"] === "draw-skipped")).toEqual([])
  })

  it("sends a signup-failed event with the reason and the error text on a refusal", async () => {
    await signupWith(fakeEngine(facts(["AlreadyPlaying"]), async () => ({ ok: false, error: "GameFull" }))).signup.register(7)
    await flush()
    expect(failures()).toHaveLength(1)
    expect(failures()[0]).toMatchObject({ kind: "event", name: "signup-failed: register", contexts: { failure: { error: "GameFull" } } })
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "failed", "signup.stage": "register" })
  })

  it("includes the host error cause chain in a thrown sign-up failure", async () => {
    const engine = fakeEngine(facts(["AlreadyPlaying"]))
    engine.seat.mockRejectedValue(
      new Error("ring VRF proof request failed", {
        cause: new TypeError("SigningRejected: host proof service unavailable", { cause: new Error("native bridge refused") }),
      }),
    )

    await signupWith(engine).signup.register(7)
    await flush()

    expect(failures()[0]).toMatchObject({
      kind: "event",
      contexts: {
        failure: {
          error: "Error: ring VRF proof request failed <- TypeError: SigningRejected: host proof service unavailable <- Error: native bridge refused",
        },
      },
    })
    expect(journeys()[0]!.tags).toMatchObject({ "signup.stage": "route", "journey.expected": "false" })
  })

  it("files a failure after the draws under the register stage", async () => {
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async (options) => {
      options.onDraws!({ entered: 2, scheduled: 2, waitedMs: 0, retries: 0 })
      throw new Error("timeout")
    })
    await signupWith(engine).signup.register(7)
    await flush()
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "failed", "signup.stage": "register" })
  })

  it("files a failed seat read after a refused bind under the route stage", async () => {
    const engine = fakeEngine(facts(["AliasNotBound"], 20n))
    engine.seat.mockResolvedValueOnce(seatOf(facts(["AliasNotBound"], 20n), true)).mockRejectedValueOnce(new Error("timeout"))
    engine.bind.mockResolvedValue({
      kind: "refused",
      permanent: true,
      refusal: "pinned-elsewhere",
      code: "AnotherAccountInvited",
      account: "5Other",
      detail: "lite bind refused: the person's free seat is on 5Other",
    })
    await signupWith(engine, fakeHost({ liteKey: async () => KEY })).signup.register(7)
    await flush()
    expect(engine.bind).toHaveBeenCalled()
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "failed", "signup.stage": "route" })
  })

  it("files a thrown signing refusal as the expected signing-refused", async () => {
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async () => {
      throw new Error("Transaction signing was rejected.")
    })
    await signupWith(engine).signup.register(7)
    await flush()
    expect(failures()[0]).toMatchObject({ kind: "metric", name: "failure", value: 1, tags: { "failure.reason": "signing-refused" } })
    expect(telemetryRecords(sent, "signup-failed: signing-refused", "log")).toContainEqual(expect.objectContaining({ level: "info" }))
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "failed", "journey.expected": "true" })
  })

  it("records a reminder block as blocked, not as a failed sign-up", async () => {
    await signupWith(fakeEngine(facts([])), fakeHost(), async () => "Turn on alarms").signup.register(7)
    await flush()
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "blocked", "journey.sad_reason": "reminders-blocked" })
    expect(failures()).toEqual([])
  })

  it("keeps the reminder gate's real reason on a blocked sign-up", async () => {
    const remindersInPlace: SignupDependencies["remindersInPlace"] = async (blocked) => {
      blocked("no-game-to-join")
      return cardCopy.SIGN_UP_FAILED
    }

    await signupWith(fakeEngine(facts([])), fakeHost(), remindersInPlace).signup.register(7)
    await flush()

    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "blocked", "journey.sad_reason": "no-game-to-join" })
    expect(failures()).toEqual([])
  })

  it("counts a tap while a sign-up is on its way, and numbers the attempts", async () => {
    let finalize: (result: DispatchResult) => void = () => {}
    let calls = 0
    const engine = fakeEngine(facts(["AlreadyPlaying"]), () =>
      calls++ === 0 ? new Promise((resolve) => (finalize = resolve)) : Promise.resolve({ ok: false, error: "GameFull" }),
    )
    const { signup } = signupWith(engine)
    const first = signup.register(7)
    await vi.waitFor(() => expect(engine.register).toHaveBeenCalled())
    void signup.register(7)
    await flush()
    finalize({ ok: false, error: "GameFull" })
    await first
    await signup.register(7)
    await flush()
    expect(telemetryRecords(sent, "chat.signup.tap_dropped", "metric")).toEqual([expect.objectContaining({ value: 1 })])
    expect(journeys().map((j) => j.tags["signup.attempt"])).toEqual(["1", "2"])
  })

  it.each(["Transaction signing was rejected.", "SigningRejected", "HostRejected: no", "the host rejected the request"])(
    "reads %s as a signing the player refused, as it always has",
    (text) => {
      expect(signingRefused(text)).toBe(true)
    },
  )

  it("does not read a host that ran out of time as a refusal", () => {
    expect(signingRefused("timeout")).toBe(false)
  })
})

describe("a sign-up that fails after the broadcast reads the chain before it is filed failed (#825)", () => {
  const sent: TelemetryRecord[] = []
  beforeEach(() => {
    sent.length = 0
    configureTelemetry({
      dsn: "https://k@o1.ingest.de.sentry.io/1",
      product: "dim2.paseo",
      fetchImpl: async (_url, init) => {
        sent.push(...decodeTelemetryEnvelope(init.body))
      },
    })
  })
  afterEach(() => resetTelemetry())
  const journeys = () => telemetryRecords(sent, "journey.game-signup", "transaction")

  async function run(register: (options: RegisterOptions) => Promise<RegisterResult>, after: ReturnType<typeof facts> | null, seatReads?: "fail" | "not-in") {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const engine = fakeEngine(facts(["AlreadyPlaying"]), register)
      engine.seat.mockResolvedValueOnce(seatOf(facts(["AlreadyPlaying"])))
      if (after) engine.seat.mockResolvedValue(seatOf(after))
      else if (seatReads === "not-in") engine.seat.mockResolvedValue(seatOf(facts(["AlreadyPlaying"])))
      else engine.seat.mockRejectedValue(new Error("read failed"))
      const { signup, linkName, host } = signupWith(engine)
      const signingUp = signup.register(7)
      await vi.advanceTimersByTimeAsync(60_000)
      await signingUp
      return { signup, engine, linkName, host }
    } finally {
      vi.useRealTimers()
    }
  }

  it("ends sent, not failed, when a post-broadcast failure classifies permanent as registered in a wrapped message form (row 4)", async () => {
    // Given: the broadcast goes out and the pool refuses with AlreadyRegistered
    // wrapped in the SDK's own message — classifyPermanent reads it as
    // "registered", so the chat sign-up has landed, not failed
    const { signup, linkName } = await run(async (options) => {
      options.onBroadcast!()
      return { ok: false, error: "game registration failed at sign: AlreadyRegistered", code: "AlreadyRegistered" }
    }, facts(["AlreadyPlaying"]))
    await flush()
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(linkName).not.toHaveBeenCalled() // maybe another surface's sign-up
    expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([])
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "sent", "signup.landed_by": "already-registered", "signup.broadcast": "true" })
  })

  it("resends once on a Stale nonce when the re-read answers not-in (row 10, guard)", async () => {
    // Given: the broadcast goes out, the pool refuses the nonce as Stale, and
    // the re-read answers not-in — the same nonce did not land, so it resends
    const refused = poolRefusal("Stale")
    const answers: Array<RegisterResult> = [refused, { ok: true }]
    const { signup, engine } = await run(async (options) => {
      options.onBroadcast!()
      return answers.shift()!
    }, facts(["AlreadyPlaying"]))
    await flush()
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(engine.register).toHaveBeenCalledTimes(2)
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "sent", "signup.resend": "Stale" })
  })

  it("leaves a Stale nonce whose re-read fails to the poll, never resending (row 10, guard)", async () => {
    // Given: the broadcast goes out, the pool refuses the nonce as Stale (the
    // same-nonce transaction may have landed), and the re-read fails — a
    // failed read is unknown, so the Stale must not be resent on it
    const refused = poolRefusal("Stale")
    const { signup, engine } = await run(async (options) => {
      options.onBroadcast!()
      return refused
    }, null)
    await flush()
    expect(signup.state()).toEqual({ kind: "idle", unsettled: 7 })
    expect(engine.register).toHaveBeenCalledTimes(1)
    expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([])
  })

  it("resends once on a Future nonce when the re-read fails (row 11)", async () => {
    // Given: the broadcast goes out, the pool refuses the nonce as Future (a
    // transaction of the account is queued ahead), and the re-read fails —
    // a second send clears Future, so it resends once
    const refused = poolRefusal("Future")
    const answers: Array<RegisterResult> = [refused, { ok: true }]
    const { signup, engine } = await run(
      async (options) => {
        options.onBroadcast!()
        return answers.shift()!
      },
      null,
      "fail", // every read after the first seat read fails
    )
    await flush()
    expect(engine.seat.mock.calls.length).toBeGreaterThan(1) // the re-read was made, and failed
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(engine.register).toHaveBeenCalledTimes(2)
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "sent", "signup.resend": "Future" })
    expect(telemetryRecords(sent, "chat.signup.resend", "metric")).toEqual([expect.objectContaining({ value: 1 })])
  })

  it("leaves it to the poll when a Future resend fails before its own broadcast after the first was sent (row 11)", async () => {
    // Given: the first send is broadcast and refused as Future, the reads
    // fail, and the resend fails before it goes out — the first may still land
    const answers: Array<(options: RegisterOptions) => RegisterResult> = [
      (options) => (options.onBroadcast!(), poolRefusal("Future")),
      () => ({ ok: false, error: "host refused" }),
    ]
    const { signup, engine } = await run(async (options) => answers.shift()!(options), null)
    await flush()
    expect(engine.register).toHaveBeenCalledTimes(2)
    expect(signup.state()).toEqual({ kind: "idle", unsettled: 7 })
    expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([])
  })

  it("ends sent, and links the name, when the chain holds the player after a Tracking stopped result", async () => {
    const { signup, linkName } = await run(async (options) => {
      options.onBroadcast!()
      return { ok: false, error: "Tracking stopped" }
    }, facts(["AlreadyPlaying", "AlreadyRegistered"]))
    await flush()
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(linkName).toHaveBeenCalledTimes(1)
    expect(journeys()).toHaveLength(1)
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "sent", "signup.landed_by": "reread", "signup.broadcast": "true" })
  })

  it("ends sent, and links the name, when the engine rejects after the broadcast and the chain holds the player", async () => {
    const { signup, linkName } = await run(async (options) => {
      options.onBroadcast!()
      throw new Error("Tracking stopped")
    }, facts(["AlreadyPlaying", "AlreadyRegistered"]))
    await flush()
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(linkName).toHaveBeenCalledTimes(1)
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "sent", "signup.landed_by": "reread" })
  })

  it("still files failed, and links no name, when the chain does not hold the player", async () => {
    const { signup, linkName } = await run(async (options) => {
      options.onBroadcast!()
      return { ok: false, error: "Tracking stopped" }
    }, facts(["AlreadyPlaying"]))
    await flush()
    expect(signup.state()).toMatchObject({ kind: "failed" })
    expect(linkName).not.toHaveBeenCalled()
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "failed", "signup.stage": "register" })
  })

  it.each([
    ["a watch result", async (options: RegisterOptions): Promise<RegisterResult> => (options.onBroadcast!(), { ok: false, error: "Tracking stopped", landingUnknown: true })],
    ["a rejection", async (options: RegisterOptions): Promise<RegisterResult> => (options.onBroadcast!(), Promise.reject(new Error("the host's chain connection dropped")))],
    ["a non-permanent failure without a landing-unknown flag", async (options: RegisterOptions): Promise<RegisterResult> => (options.onBroadcast!(), { ok: false, error: "Tracking stopped" })],
  ])("leaves a broadcast whose re-read also fails to the poll, never failed, when the failure is %s (#37)", async (_name, register) => {
    const { signup } = await run(register, null)
    await flush()
    expect(signup.state()).toEqual({ kind: "idle", unsettled: 7 })
    expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([])
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "unknown", "signup.stage": "reread-failed" })
  })

  it.each(["NoRegistration", "GameOngoing", "NoGame"])(
    "leaves %s after the broadcast whose re-read fails to the poll, never closed: no window-closed event, the record stays sent (closed-unverified, #95)",
    async (code) => {
      const { signup, engine, host } = await run(async (options) => {
        options.onBroadcast!()
        return { ok: false, error: code, code }
      }, null)
      await flush()
      // the chain's own refusal is no longer final on its own: this tap
      // broadcast, so only an answered Players read may end it
      expect(engine.seat.mock.calls.length).toBeGreaterThan(1) // the re-read was made, and failed
      expect(signup.state()).toEqual({ kind: "idle", unsettled: 7 })
      expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([])
      expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "unknown", "signup.stage": "closed-unverified", "signup.broadcast": "true" })
      // the stored record stays sent and lapses through SENT_TTL_MS
      expect(host.store.get(GAME_REGISTRATION_KEY)).toMatchObject({ phase: "sent", gameIndex: 7 })
    },
  )

  it("keeps no stale registering record when a Future resend meets a closed error before its own broadcast and the re-read fails (closed-unverified, #95 review)", async () => {
    // Given: the first send broadcasts and is refused Future; the nonce re-read
    // fails, so it resends; the resend rewrites the record as registering and
    // returns a closed code without broadcasting; the closed re-read fails too
    const refused = poolRefusal("Future")
    const answers: Array<(options: RegisterOptions) => RegisterResult> = [
      (options) => (options.onBroadcast!(), refused),
      () => ({ ok: false, error: "NoRegistration", code: "NoRegistration" }),
    ]
    const { signup, engine, host } = await run(
      async (options) => answers.shift()!(options),
      null,
      "fail", // every read after the first seat read fails
    )
    await flush()
    expect(engine.register).toHaveBeenCalledTimes(2)
    expect(signup.state()).toEqual({ kind: "idle", unsettled: 7 })
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "unknown", "signup.stage": "closed-unverified", "signup.broadcast": "true" })
    // the first send went out, so the record is sent — not the resend's registering
    expect(host.store.get(GAME_REGISTRATION_KEY)).toMatchObject({ phase: "sent", gameIndex: 7 })
  })

  it.each(["NoRegistration", "GameOngoing", "NoGame"])(
    "files %s after the broadcast as window-closed when the re-read answers not-in (#95)",
    async (code) => {
      const { signup, engine } = await run(
        async (options) => {
          options.onBroadcast!()
          return { ok: false, error: code, code }
        },
        facts(["AlreadyPlaying"]),
        "not-in",
      )
      await flush()
      expect(engine.seat.mock.calls.length).toBeGreaterThan(1) // the re-read was made, and answered not-in
      expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.REGISTRATION_CLOSED_NOTICE })
      expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([
        expect.objectContaining({ name: "signup-failed: window-closed", contexts: { failure: expect.objectContaining({ error: expect.stringContaining(code) }) } }),
      ])
      expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "closed", "signup.broadcast": "true" })
    },
  )

  it.each(["NoRegistration", "GameOngoing", "NoGame"])(
    "ends %s after the broadcast as sent without linking the name when the re-read finds the player registered (#95 review: closed refused this tap's own transaction)",
    async (code) => {
      const { signup, linkName } = await run(
        async (options) => {
          options.onBroadcast!()
          return { ok: false, error: code, code }
        },
        facts(["AlreadyPlaying", "AlreadyRegistered"]),
      )
      await flush()
      expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
      // the registration is another surface's or an earlier attempt's: no
      // name link for tickets this attempt may not own
      expect(linkName).not.toHaveBeenCalled()
      expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([])
      expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "sent", "signup.landed_by": "already-registered", "signup.broadcast": "true" })
    },
  )

  it.each(["NoRegistration", "GameOngoing", "NoGame"])(
    "files %s before the broadcast as window-closed without reading the chain again (#95)",
    async (code) => {
      const { signup, engine } = await run(async () => ({ ok: false, error: code, code }), null)
      await flush()
      expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.REGISTRATION_CLOSED_NOTICE })
      expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([
        expect.objectContaining({ name: "signup-failed: window-closed", contexts: { failure: expect.objectContaining({ error: expect.stringContaining(code) }) } }),
      ])
      expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "closed" })
      // never broadcast: the chain's own refusal is final, no re-read
      expect(engine.seat).toHaveBeenCalledTimes(1)
    },
  )

  it.each(["InvalidPlayDeposit", "CreditCapacityExhausted", "NoInvites"])(
    "files %s after the broadcast as failed even when the re-read fails, without reading the chain again",
    async (code) => {
      const { signup, engine } = await run(async (options) => {
        options.onBroadcast!()
        return { ok: false, error: code, code }
      }, null)
      await flush()
      expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.SIGN_UP_FAILED })
      expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toHaveLength(1)
      expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "failed", "signup.broadcast": "true" })
      expect(engine.seat).toHaveBeenCalledTimes(1)
    },
  )

  it("does not read again for a failure before the broadcast", async () => {
    const { engine } = await run(async () => ({ ok: false, error: "Tracking stopped" }), facts(["AlreadyPlaying", "AlreadyRegistered"]))
    expect(engine.seat).toHaveBeenCalledTimes(1)
  })

  it.each(["Stale", "Future"])("sends the sign-up again when the pool refuses its nonce as %s", async (refusal) => {
    // Given
    const refused = poolRefusal(refusal)
    const answers: Array<(options: RegisterOptions) => RegisterResult> = [
      () => refused,
      (options) => (options.onBroadcast!(), { ok: true }),
    ]

    // When
    const { signup, engine } = await run(async (options) => answers.shift()!(options), facts(["AlreadyPlaying"]))
    await flush()

    // Then
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(engine.register).toHaveBeenCalledTimes(2)
    expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([])
  })

  it("reads the chain, and sends nothing again, when the pool refuses the nonce after the broadcast and the chain holds the player", async () => {
    // Given
    const refused = poolRefusal("Stale")

    // When
    const { signup, engine } = await run(async (options) => {
      options.onBroadcast!()
      return refused
    }, facts(["AlreadyPlaying", "AlreadyRegistered"]))
    await flush()

    // Then
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(engine.register).toHaveBeenCalledTimes(1)
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "sent", "signup.landed_by": "reread" })
  })

  it("sends the sign-up again, and counts the resend, when the pool refuses the nonce after the broadcast and the chain lacks the player", async () => {
    // Given
    const refused = poolRefusal("Stale")
    const answers: Array<RegisterResult> = [refused, { ok: true }]

    // When
    const { signup, engine } = await run(async (options) => {
      options.onBroadcast!()
      return answers.shift()!
    }, facts(["AlreadyPlaying"]))
    await flush()

    // Then
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(engine.register).toHaveBeenCalledTimes(2)
    expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([])
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "sent", "signup.resend": "Stale" })
    expect(telemetryRecords(sent, "chat.signup.resend", "metric")).toEqual([expect.objectContaining({ value: 1 })])
  })

  it("sends nothing again when the pool refuses the nonce and the chain already holds the player", async () => {
    // Given
    const refused = poolRefusal("Stale")

    // When
    const { signup, engine } = await run(async () => refused, facts(["AlreadyPlaying", "AlreadyRegistered"]))
    await flush()

    // Then
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(engine.register).toHaveBeenCalledTimes(1)
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "sent", "signup.landed_by": "reread" })
  })

  it("files the sign-up failed when the pool refuses the nonce before the broadcast and again after it", async () => {
    // Given
    const refused = poolRefusal("Stale")
    const answers: Array<(options: RegisterOptions) => RegisterResult> = [
      () => refused,
      (options) => (options.onBroadcast!(), refused),
      (options) => (options.onBroadcast!(), { ok: true }),
    ]

    // When
    const { signup, engine } = await run(async (options) => answers.shift()!(options), facts(["AlreadyPlaying"]))
    await flush()

    // Then
    expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.SIGN_UP_FAILED })
    expect(engine.register).toHaveBeenCalledTimes(2)
    expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([
      expect.objectContaining({ name: "signup-failed: register", contexts: { failure: expect.objectContaining({ error: expect.stringContaining("Stale") }) } }),
    ])
  })

  it("files the sign-up failed when the pool refuses its nonce a second time", async () => {
    // Given
    const refused = poolRefusal("Stale")

    // When
    const { signup, engine } = await run(async () => refused, facts(["AlreadyPlaying"]))
    await flush()

    // Then
    expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: cardCopy.SIGN_UP_FAILED })
    expect(engine.register).toHaveBeenCalledTimes(2)
    expect(sent.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([
      expect.objectContaining({ name: "signup-failed: register", contexts: { failure: expect.objectContaining({ error: expect.stringContaining("Stale") }) } }),
    ])
  })
  it("reads the chain again for the earlier broadcast when the resend fails before its own broadcast", async () => {
    // Given
    const answers: Array<(options: RegisterOptions) => RegisterResult> = [
      (options) => (options.onBroadcast!(), poolRefusal("Stale")),
      () => ({ ok: false, error: "host refused" }),
    ]

    // When
    const { signup, engine } = await run(async (options) => answers.shift()!(options), facts(["AlreadyPlaying"]))
    await flush()

    // Then
    expect(signup.state()).toMatchObject({ kind: "failed", gameIndex: 7 })
    expect(engine.register).toHaveBeenCalledTimes(2)
    // the first seat read, the nonce refusal's re-read, and one more after
    // the failed resend: the first send may still land, so only an answered
    // not-in files it failed
    expect(engine.seat).toHaveBeenCalledTimes(3)
  })

  it("ends sent, read again, when the resend after a nonce refusal loses its watch and the chain holds the player", async () => {
    // Given
    const answers: Array<(options: RegisterOptions) => RegisterResult> = [
      () => poolRefusal("Stale"),
      (options) => (options.onBroadcast!(), { ok: false, error: "Tracking stopped" }),
    ]
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async (options) => answers.shift()!(options))
    engine.seat
      .mockResolvedValueOnce(seatOf(facts(["AlreadyPlaying"])))
      .mockResolvedValueOnce(seatOf(facts(["AlreadyPlaying"])))
      .mockResolvedValue(seatOf(facts(["AlreadyPlaying", "AlreadyRegistered"])))
    const { signup, linkName } = signupWith(engine)

    // When
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const signingUp = signup.register(7)
      await vi.advanceTimersByTimeAsync(LANDING_WAIT_MS)
      await signingUp
    } finally {
      vi.useRealTimers()
    }
    await flush()

    // Then
    expect(signup.state()).toEqual({ kind: "sent", gameIndex: 7 })
    expect(engine.register).toHaveBeenCalledTimes(2)
    expect(linkName).toHaveBeenCalledTimes(1)
    expect(journeys()[0]!.tags).toMatchObject({ "journey.outcome": "sent", "signup.landed_by": "reread", "signup.resend": "Stale" })
  })
})

describe("a sign-up a stopped worker left behind is reported on the next start (#825)", () => {
  const sent: TelemetryRecord[] = []
  beforeEach(() => {
    sent.length = 0
    configureTelemetry({
      dsn: "https://k@o1.ingest.de.sentry.io/1",
      product: "dim2.paseo",
      fetchImpl: async (_url, init) => {
        sent.push(...decodeTelemetryEnvelope(init.body))
      },
    })
  })
  afterEach(() => resetTelemetry())
  const journeys = () => telemetryRecords(sent, "journey.game-signup", "transaction")

  it("sends one interrupted journey with the phase and the game, and only once per record", async () => {
    const host = fakeHost()
    host.store.set(GAME_REGISTRATION_KEY, { gameIndex: 7, phase: "sent", surface: "chat", at: Date.now() - 90_000, attempt: 123 })
    await reportInterruptedSignup(host)
    await reportInterruptedSignup(host)
    await flush()
    expect(journeys()).toHaveLength(1)
    expect(journeys()[0]!.tags).toMatchObject({
      "journey.outcome": "interrupted",
      "journey.sad": "true",
      "signup.stage": "sent",
      "signup.broadcast": "true",
      "signup.game_index": "7",
    })
  })

  it("ends a sign-up the stopped worker never broadcast, so Humanity stops showing Registering", async () => {
    const host = fakeHost()
    host.store.set(GAME_REGISTRATION_KEY, { gameIndex: 7, phase: "registering", surface: "chat", at: Date.now() - 1_000, attempt: 123 })

    await reportInterruptedSignup(host)

    expect(host.store.get(GAME_REGISTRATION_KEY)).toMatchObject({ gameIndex: 7, phase: "failed", surface: "chat", attempt: 123, reason: "interrupted" })
  })

  it("leaves a broadcast sign-up of a stopped worker to the chain", async () => {
    const host = fakeHost()
    host.store.set(GAME_REGISTRATION_KEY, { gameIndex: 7, phase: "sent", surface: "chat", at: Date.now() - 1_000, attempt: 123 })

    await reportInterruptedSignup(host)

    expect(host.store.get(GAME_REGISTRATION_KEY)).toMatchObject({ phase: "sent" })
  })

  it("carries the player identity when startup resolved it in parallel", async () => {
    const host = fakeHost()
    host.store.set(GAME_REGISTRATION_KEY, { gameIndex: 7, phase: "registering", surface: "chat", at: Date.now() - 1_000, attempt: 123 })
    setChatUser(ADDRESS)

    await reportInterruptedSignup(host)
    await flush()

    expect(journeys()[0]!.user?.id).toBe(ADDRESS)
  })

  it("does not report a sign-up that ended normally when the worker restarts inside the sent record's lifetime", async () => {
    const host = fakeHost()
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async (options) => {
      options.onBroadcast!()
      return { ok: true }
    })
    await signupWith(engine, host).signup.register(7)
    await flush()
    expect(host.store.get(GAME_REGISTRATION_KEY)).toMatchObject({ phase: "registered" })
    sent.length = 0
    await reportInterruptedSignup(host)
    await flush()
    expect(journeys().filter((j) => j.tags["journey.outcome"] === "interrupted")).toEqual([])
  })

  it.each([
    ["a failed result", async (options: RegisterOptions): Promise<DispatchResult> => (options.onBroadcast!(), { ok: false, error: "Tracking stopped" })],
    ["a rejection", async (options: RegisterOptions): Promise<DispatchResult> => (options.onBroadcast!(), Promise.reject(new Error("Tracking stopped")))],
  ])("does not report a sign-up recovered by the re-read after %s", async (_name, register) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const host = fakeHost()
    try {
      const engine = fakeEngine(facts(["AlreadyPlaying"]), register)
      engine.seat.mockResolvedValueOnce(seatOf(facts(["AlreadyPlaying"]))).mockResolvedValue(seatOf(facts(["AlreadyPlaying", "AlreadyRegistered"])))
      const signingUp = signupWith(engine, host).signup.register(7)
      await vi.advanceTimersByTimeAsync(60_000)
      await signingUp
    } finally {
      vi.useRealTimers()
    }
    await flush()
    expect(host.store.get(GAME_REGISTRATION_KEY)).toMatchObject({ phase: "registered" })
    sent.length = 0
    await reportInterruptedSignup(host)
    await flush()
    expect(journeys().filter((j) => j.tags["journey.outcome"] === "interrupted")).toEqual([])
  })

  it("keeps register() pending until the reported marker write is acknowledged", async () => {
    const host = fakeHost()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const write = host.storage.writeJSON as unknown as ReturnType<typeof vi.fn>
    const plain = write.getMockImplementation()! as (key: string, value: unknown) => Promise<void>
    write.mockImplementation(async (key: string, value: unknown) => {
      if (key === "jollity.signup.reported") await gate
      return plain(key, value)
    })
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async (options) => (options.onBroadcast!(), { ok: true }))
    let done = false
    const signingUp = signupWith(engine, host).signup.register(7).then(() => (done = true))
    await flush()
    await flush()
    expect(done).toBe(false)
    expect(host.store.has("jollity.signup.reported")).toBe(false)
    release()
    await signingUp
    expect(host.store.get("jollity.signup.reported")).toEqual(expect.any(Number))
  })

  it("shows the final failed card before a slow marker write is acknowledged", async () => {
    const host = fakeHost()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const write = host.storage.writeJSON as unknown as ReturnType<typeof vi.fn>
    const plain = write.getMockImplementation()! as (key: string, value: unknown) => Promise<void>
    write.mockImplementation(async (key: string, value: unknown) => {
      if (key === "jollity.signup.reported") await gate
      return plain(key, value)
    })
    const { signup } = signupWith(fakeEngine(facts([])), host, async () => "Turn on alarms")
    let done = false
    const signingUp = signup.register(7).then(() => (done = true))

    await flush()
    await flush()

    expect(signup.state()).toEqual({ kind: "failed", gameIndex: 7, notice: "Turn on alarms" })
    expect(done).toBe(false)
    release()
    await signingUp
  })

  it("reports an older interrupted attempt before the new attempt writes its busy record", async () => {
    const host = fakeHost()
    let release: () => void = () => {}
    const interrupted = new Promise<boolean>((resolve) => (release = () => resolve(true)))
    const reportInterrupted = vi.fn(() => interrupted)
    const { signup } = signupWith(fakeEngine(facts(["AlreadyPlaying"])), host, async () => null, reportInterrupted)

    const signingUp = signup.register(7)
    await flush()

    expect(reportInterrupted).toHaveBeenCalledTimes(1)
    expect(signup.state()).toEqual({ kind: "busy", gameIndex: 7, step: "reminders" })
    expect(marks(host)).toEqual([])

    release()
    await signingUp
    expect(marks(host)[0]).toMatchObject({ phase: "registering", gameIndex: 7 })
    await signup.register(8)
    expect(reportInterrupted).toHaveBeenCalledTimes(1)
  })

  it("does not replace an unread record and retries recovery on the next tap", async () => {
    const host = fakeHost()
    host.store.set(GAME_REGISTRATION_KEY, { gameIndex: 6, phase: "registering", surface: "chat", at: Date.now() - 1_000, attempt: 123 })
    const reportInterrupted = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const { signup } = signupWith(fakeEngine(facts(["AlreadyPlaying"])), host, async () => null, reportInterrupted)

    await signup.register(7)

    expect(signup.state()).toEqual({ kind: "idle" })
    expect(marks(host)).toEqual([])
    expect(host.store.get(GAME_REGISTRATION_KEY)).toMatchObject({ gameIndex: 6, attempt: 123 })

    await signup.register(7)

    expect(reportInterrupted).toHaveBeenCalledTimes(2)
    expect(marks(host)[0]).toMatchObject({ phase: "registering", gameIndex: 7 })
  })

  it("marks a blocked journey even when writing its failed record fails", async () => {
    const host = fakeHost()
    const write = host.storage.writeJSON as unknown as ReturnType<typeof vi.fn>
    const plain = write.getMockImplementation()! as (key: string, value: unknown) => Promise<void>
    write.mockImplementation(async (key: string, value: unknown) => {
      if (key === GAME_REGISTRATION_KEY && (value as { phase?: string } | null)?.phase === "failed") throw new Error("write failed")
      return plain(key, value)
    })

    await signupWith(fakeEngine(facts([])), host, async () => "Turn on alarms").signup.register(7)
    await flush()

    expect(host.store.get(GAME_REGISTRATION_KEY)).toMatchObject({ phase: "registering", gameIndex: 7 })
    expect(host.store.get("jollity.signup.reported")).toEqual(expect.any(Number))
    sent.length = 0
    await reportInterruptedSignup(host)
    await flush()
    expect(journeys().filter((j) => j.tags["journey.outcome"] === "interrupted")).toEqual([])
  })

  it("ends and marks a handoff before opening the app", async () => {
    const host = fakeHost({ signer: null })
    const { signup, openApp } = signupWith(fakeEngine(facts(["AlreadyPlaying"])), host)
    let sawEndedJourney = false
    let sawMarker = false
    openApp.mockImplementation(async () => {
      sawEndedJourney = journeys().some((journey) => journey.tags["journey.outcome"] === "handoff")
      sawMarker = typeof host.store.get("jollity.signup.reported") === "number"
    })

    await signup.register(7)
    expect(openApp).toHaveBeenCalledTimes(1)
    expect(sawEndedJourney).toBe(true)
    expect(sawMarker).toBe(true)
  })

  it("opens the app after a bounded wait when a handoff marker stalls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const host = fakeHost({ signer: null })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const write = host.storage.writeJSON as unknown as ReturnType<typeof vi.fn>
    const plain = write.getMockImplementation()! as (key: string, value: unknown) => Promise<void>
    write.mockImplementation(async (key: string, value: unknown) => {
      if (key === "jollity.signup.reported") await gate
      return plain(key, value)
    })
    const { signup, openApp } = signupWith(fakeEngine(facts(["AlreadyPlaying"])), host)
    try {
      const signingUp = signup.register(7)
      await vi.advanceTimersByTimeAsync(5_000)

      expect(signup.state()).toEqual({ kind: "idle", handedOff: 7 })
      expect(openApp).toHaveBeenCalledTimes(1)
      await signingUp
    } finally {
      release()
      await vi.runAllTimersAsync()
      vi.useRealTimers()
    }
  })

  it("does not report this worker's live attempt as interrupted after tap recovery settles", async () => {
    const host = fakeHost()
    let finish: (result: DispatchResult) => void = () => {}
    const engine = fakeEngine(facts(["AlreadyPlaying"]), () => new Promise((resolve) => (finish = resolve)))
    const { signup } = signupWith(engine, host, async () => null, () => reportInterruptedSignup(host))
    const signingUp = signup.register(7)
    await vi.waitFor(() => expect(engine.register).toHaveBeenCalledTimes(1))
    await flush()

    await reportInterruptedSignup(host)
    await flush()

    expect(journeys().filter((journey) => journey.tags["journey.outcome"] === "interrupted")).toEqual([])
    finish({ ok: true })
    await signingUp
    await flush()
    expect(journeys().map((journey) => journey.tags["journey.outcome"])).toEqual(["sent"])
  })

  it("retries an interrupted-record read that failed", async () => {
    const host = fakeHost()
    host.store.set(GAME_REGISTRATION_KEY, { gameIndex: 7, phase: "registering", surface: "chat", at: Date.now() - 1_000, attempt: 123 })
    const read = host.storage.readJSON
    vi.mocked(read).mockRejectedValueOnce(new Error("storage unavailable"))

    expect(await reportInterruptedSignup(host)).toBe(false)
    expect(await reportInterruptedSignup(host)).toBe(true)
    await flush()

    expect(journeys()).toHaveLength(1)
    expect(host.store.get("jollity.signup.reported")).toBe(123)
  })

  it("retries a failed journey marker once after ending the journey", async () => {
    const order: string[] = []
    configureTelemetry({
      dsn: "https://k@o1.ingest.de.sentry.io/1",
      product: "dim2.paseo",
      fetchImpl: async (_url, init) => {
        if (init.body.includes('"transaction":"journey.game-signup"')) order.push("journey")
      },
    })
    const host = fakeHost()
    const write = host.storage.writeJSON as unknown as ReturnType<typeof vi.fn>
    const plain = write.getMockImplementation()! as (key: string, value: unknown) => Promise<void>
    let attempts = 0
    write.mockImplementation(async (key: string, value: unknown) => {
      if (key === "jollity.signup.reported") {
        order.push("marker")
        if (attempts++ === 0) throw new Error("first marker failed")
      }
      return plain(key, value)
    })

    await signupWith(fakeEngine(facts([])), host, async () => "Turn on alarms").signup.register(7)

    expect(order.slice(0, 3)).toEqual(["journey", "marker", "marker"])
    expect(host.store.get("jollity.signup.reported")).toEqual(expect.any(Number))
  })

  it("ends an interrupted journey before storing its marker and retries the marker once", async () => {
    const order: string[] = []
    configureTelemetry({
      dsn: "https://k@o1.ingest.de.sentry.io/1",
      product: "dim2.paseo",
      fetchImpl: async (_url, init) => {
        if (init.body.includes('"transaction":"journey.game-signup"')) order.push("journey")
      },
    })
    const host = fakeHost()
    host.store.set(GAME_REGISTRATION_KEY, { gameIndex: 7, phase: "registering", surface: "chat", at: Date.now() - 1_000, attempt: 123 })
    const write = host.storage.writeJSON as unknown as ReturnType<typeof vi.fn>
    const plain = write.getMockImplementation()! as (key: string, value: unknown) => Promise<void>
    let attempts = 0
    write.mockImplementation(async (key: string, value: unknown) => {
      if (key === "jollity.signup.reported") {
        order.push("marker")
        if (attempts++ === 0) throw new Error("first marker failed")
      }
      return plain(key, value)
    })

    await reportInterruptedSignup(host)

    expect(order).toEqual(["journey", "marker", "marker"])
    expect(host.store.get("jollity.signup.reported")).toBe(123)
  })

  it("does not report a finished attempt whose sent record is still held behind a slow mark", async () => {
    const host = fakeHost()
    let releaseSent: () => void = () => {}
    const write = host.storage.writeJSON as unknown as ReturnType<typeof vi.fn>
    const plain = write.getMockImplementation()! as (key: string, value: unknown) => Promise<void>
    write.mockImplementation(async (key: string, value: unknown) => {
      if (key === GAME_REGISTRATION_KEY && (value as { phase?: string } | null)?.phase === "sent") await new Promise<void>((r) => (releaseSent = r))
      return plain(key, value)
    })
    const engine = fakeEngine(facts(["AlreadyPlaying"]), async (options) => (options.onBroadcast!(), { ok: true }))
    await signupWith(engine, host).signup.register(7)
    await flush()
    // the busy record is on disk, the sent one still waits, the marker has landed
    expect(host.store.get(GAME_REGISTRATION_KEY)).toMatchObject({ phase: "registering" })
    expect(host.store.has("jollity.signup.reported")).toBe(true)
    sent.length = 0
    await reportInterruptedSignup(host)
    await flush()
    expect(journeys().filter((j) => j.tags["journey.outcome"] === "interrupted")).toEqual([])
    releaseSent()
  })

  it("sends nothing for a record that ended, or one the app made: neither is a stopped chat sign-up", async () => {
    for (const record of [
      { gameIndex: 7, phase: "registered", surface: "chat", at: Date.now() - 1_000, attempt: 123 },
      { gameIndex: 7, phase: "failed", surface: "chat", at: Date.now() - 1_000, attempt: 123, reason: "register" },
      { gameIndex: 7, phase: "registering", surface: "app", at: Date.now() - 1_000, attempt: 123 },
      { gameIndex: 7, phase: "sent", surface: "app", at: Date.now() - 1_000, attempt: 123 },
    ]) {
      const host = fakeHost()
      host.store.set(GAME_REGISTRATION_KEY, record)
      await reportInterruptedSignup(host)
      await flush()
      expect(journeys()).toEqual([])
      expect(host.store.has("jollity.signup.reported")).toBe(false)
    }
  })

  it("sends nothing when no record is left", async () => {
    await reportInterruptedSignup(fakeHost())
    await flush()
    expect(journeys()).toEqual([])
  })
})

describe("the chat's submission of a sign-up (the SDK's submit capability)", () => {
  /** a built sign-up whose watch replays `events`, then fails with `error` or completes */
  const tx = (events: Array<{ type: string; ok?: boolean; dispatchError?: unknown }>, end?: { error: unknown } | "complete") =>
    ({
      createSubmitAndWatch: () => ({
        subscribe(observer: { next(event: unknown): void; error(error: unknown): void; complete?(): void }) {
          for (const event of events) observer.next(event)
          if (end === "complete") observer.complete?.()
          else if (end) observer.error(end.error)
          return { unsubscribe: () => {} }
        },
      }),
    }) as never

  it("lands at finality, saying when it is on the wire", async () => {
    const onBroadcast = vi.fn()
    const result = await submitSignUp(tx([{ type: "broadcasted" }, { type: "inBestBlock", ok: true }, { type: "finalized", ok: true }]), SIGNER, {
      waitFor: "finalized",
      onBroadcast,
    })
    expect(result).toEqual({ ok: true })
    expect(onBroadcast).toHaveBeenCalledTimes(1)
  })

  it("names the pallet's refusal", async () => {
    const refused = { type: "Module", value: { type: "Game", value: { type: "NoRegistration" } } }
    expect(await submitSignUp(tx([{ type: "finalized", ok: false, dispatchError: refused }]), SIGNER, { waitFor: "finalized" })).toEqual({
      ok: false,
      code: "NoRegistration",
    })
  })

  it("does not know where a sign-up went whose watch stopped or ended", async () => {
    const stopped = await submitSignUp(tx([{ type: "broadcasted" }], { error: new Error("Tracking stopped") }), SIGNER, { waitFor: "finalized" })
    const ended = await submitSignUp(tx([{ type: "broadcasted" }], "complete"), SIGNER, { waitFor: "finalized" })
    expect(stopped).toMatchObject({ ok: false, landingUnknown: true })
    expect(ended).toMatchObject({ ok: false, code: "Dropped", landingUnknown: true })
  })

  it("takes the player closing the signing sheet for a refusal", async () => {
    const result = await submitSignUp(tx([], { error: new Error("signing was rejected") }), SIGNER, { waitFor: "finalized" })
    expect(result).toMatchObject({ ok: false, refused: true })
  })

  it("sends nothing once aborted before the broadcast", async () => {
    const abort = new AbortController()
    const pending = { createSubmitAndWatch: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }) } as never
    const result = submitSignUp(pending, SIGNER, { waitFor: "finalized", signal: abort.signal })
    abort.abort(new Error("the page left"))
    expect(await result).toEqual({ ok: false, code: "Aborted" })
  })
})
