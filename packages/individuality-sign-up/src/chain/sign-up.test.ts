// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tests the sign-up's chain side (./sign-up.ts) over the SDK's game
 * registration, mocked: what the flow is handed back, finality, and the draw
 * rule Jollity adds (#167). The SDK's own tests cover the seat, the bind and
 * the sign-up themselves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GameRegistrationCapabilities, RegisterForGameOptions } from "@parity/product-sdk-individuality"
import type { PeopleClient } from "@individuality/people-chain"

const sdk = vi.hoisted(() => ({
  readGameSeat: vi.fn(),
  holdsLiteKey: vi.fn(),
  bindGameSeat: vi.fn(),
  registerForGame: vi.fn(),
}))
vi.mock("@parity/product-sdk-individuality", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@parity/product-sdk-individuality")>()),
  fromPapi: () => ({ chain: "papi" }),
  ...sdk,
}))
const { GameRegistrationError, GameSeatBindError } = await import("@parity/product-sdk-individuality")
const { signUpFlowChain } = await import("./sign-up")
const { verifyVrf } = await import("./vrf")

const PLAYER = "5GameAccount"
const ok = <T>(value: T) => ({ ok: true as const, value })
const err = (error: unknown) => ({ ok: false as const, error })

/** a People client whose player has `participant` for a score row, under a threshold of 10 */
function client(participant?: Record<string, unknown> | "fails") {
  const read = (value: unknown) => vi.fn(async () => (value === "fails" ? Promise.reject(new Error("no answer")) : value))
  return {
    client: {},
    api: {
      query: {
        Score: { Participants: { getValue: read(participant) }, PersonhoodThreshold: { getValue: read(10) } },
        Game: {
          Players: { getValue: vi.fn(async () => ({ registered: true })) },
          Game: { getValue: vi.fn(async () => ({ index: 7, state: { type: "Registration" }, registration_ends: 900 })) },
        },
      },
    },
  } as unknown as PeopleClient
}

const signVrf = vi.fn()
const capabilities = (): GameRegistrationCapabilities => ({
  account: { address: PLAYER, publicKey: new Uint8Array(32) },
  signer: {} as GameRegistrationCapabilities["signer"],
  submit: vi.fn(),
  signVrf,
})
/** the options the SDK's `registerForGame` was called with, and the capabilities */
const registered = () => {
  const [, caps, options] = sdk.registerForGame.mock.calls[0]! as [unknown, GameRegistrationCapabilities, RegisterForGameOptions]
  return { caps, options }
}
const DRAWS = { entered: 2, scheduled: 2, waitedMs: 0, retries: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  sdk.registerForGame.mockResolvedValue(ok({ kind: "registered", route: "deposit", draws: DRAWS, report: { steps: {} } }))
})

describe("the seat and the lite key", () => {
  it("reads the SDK's seat for the account, at the network's TLD", async () => {
    sdk.readGameSeat.mockResolvedValue(ok({ path: "free", ready: true }))
    const seat = await signUpFlowChain(client(), { tld: "paseo" }).seat(PLAYER, { litePerson: true, bound: true })
    expect(seat).toEqual({ path: "free", ready: true })
    expect(sdk.readGameSeat).toHaveBeenCalledWith({ chain: "papi" }, { account: PLAYER, tld: "paseo", litePerson: true, bound: true })
  })

  it("throws a seat the SDK could not read", async () => {
    sdk.readGameSeat.mockResolvedValue(err(new Error("no answer")))
    await expect(signUpFlowChain(client(), { tld: "paseo" }).seat(PLAYER, { litePerson: false })).rejects.toThrow("no answer")
  })

  it("asks the SDK whether the host holds the person's lite key", async () => {
    sdk.holdsLiteKey.mockResolvedValue(ok(true))
    expect(await signUpFlowChain(client(), { tld: "paseo" }).holdsLiteKey(capabilities())).toBe(true)
  })
})

describe("the bind", () => {
  it("hands back the SDK's outcome", async () => {
    sdk.bindGameSeat.mockResolvedValue(ok("already-bound"))
    expect(await signUpFlowChain(client(), { tld: "paseo" }).bind(capabilities())).toEqual({ kind: "already-bound" })
  })

  it("hands back a refusal for good, with the account the seat is pinned to", async () => {
    sdk.bindGameSeat.mockResolvedValue(err(new GameSeatBindError("pinned-elsewhere", "AnotherAccountInvited", "5Other")))
    expect(await signUpFlowChain(client(), { tld: "paseo" }).bind(capabilities())).toMatchObject({
      kind: "refused",
      permanent: true,
      refusal: "pinned-elsewhere",
      account: "5Other",
    })
  })

  it("hands back a refusal the next try can pass as one to retry", async () => {
    sdk.bindGameSeat.mockResolvedValue(err(new GameSeatBindError("rejected", "CallBlockOutOfRange")))
    expect(await signUpFlowChain(client(), { tld: "paseo" }).bind(capabilities())).toMatchObject({ kind: "refused", permanent: false })
  })

  it("throws anything else, for the flow to retry", async () => {
    sdk.bindGameSeat.mockResolvedValue(err(new Error("host gone")))
    await expect(signUpFlowChain(client(), { tld: "paseo" }).bind(capabilities())).rejects.toThrow("host gone")
  })
})

describe("the sign-up", () => {
  it("lands at finality, says when it is on the wire, and checks every ticket", async () => {
    const onBroadcast = vi.fn()
    const result = await signUpFlowChain(client({ score: 0, streak: { type: "Attended", value: 0 }, recognition: { type: "Recognized" }, reached_personhood: false }), { tld: "paseo" })
      .register(capabilities(), new Uint8Array(65), { onBroadcast })
    expect(result).toEqual({ ok: true })
    const { caps, options } = registered()
    expect(options).toMatchObject({ tld: "paseo", waitFor: "finalized" })
    expect(caps.verifyVrf).toBe(verifyVrf)
    expect(caps.signVrf).toBe(signVrf)
    options.onStage?.("draws")
    expect(onBroadcast).not.toHaveBeenCalled()
    options.onStage?.("broadcast")
    expect(onBroadcast).toHaveBeenCalledTimes(1)
  })

  it("names what the flow reads as in already, or as a closed window", async () => {
    const chain = signUpFlowChain(client(), { tld: "paseo" })
    sdk.registerForGame.mockResolvedValueOnce(ok({ kind: "already-registered", report: { steps: {} } }))
    expect(await chain.register(capabilities(), new Uint8Array(65))).toEqual({ ok: false, error: "AlreadyRegistered" })
    sdk.registerForGame.mockResolvedValueOnce(ok({ kind: "not-open", report: { steps: {} } }))
    expect(await chain.register(capabilities(), new Uint8Array(65))).toEqual({ ok: false, error: "NoRegistration" })
  })

  it("hands back a failure with its code and words, and whether it may still land", async () => {
    sdk.registerForGame.mockResolvedValue(err(new GameRegistrationError("sign", "Timeout", { retryable: true, landingUnknown: true })))
    const result = await signUpFlowChain(client(), { tld: "paseo" }).register(capabilities(), new Uint8Array(65))
    expect(result).toEqual({ ok: false, error: "game registration failed at sign: Timeout", code: "Timeout", landingUnknown: true })
  })

  it("keeps the player's own refusal in words the flow reads as one", async () => {
    sdk.registerForGame.mockResolvedValue(err(new GameRegistrationError("sign", "SigningRejected", { retryable: false })))
    const result = await signUpFlowChain(client(), { tld: "paseo" }).register(capabilities(), new Uint8Array(65))
    expect(result).toEqual({ ok: false, error: "game registration failed at sign: SigningRejected", code: "SigningRejected" })
  })
})

describe("the draw rule (#167)", () => {
  /** a player this game cannot make a member: a score of 0, five games short */
  const candidate = { score: 0, streak: { type: "Absent", value: 0 }, recognition: { type: "NotRecognized" }, reached_personhood: false }

  it("signs up a player this game cannot make a member without a ticket, and says why", async () => {
    const onDraws = vi.fn()
    await signUpFlowChain(client(candidate), { tld: "paseo" }).register(capabilities(), new Uint8Array(65), { onDraws })
    const { caps, options } = registered()
    expect(caps.signVrf).toBeUndefined()
    options.onDraws?.({ entered: 0, scheduled: 2, skipped: "no VRF signer", kind: "signature", waitedMs: 0, retries: 0 })
    expect(onDraws).toHaveBeenCalledWith(expect.objectContaining({ kind: "not-member-yet", skipped: "this game cannot make the player a member (4 games to go)" }))
  })

  it("keeps the SDK's reason for a draw it could not enter anyway", async () => {
    const onDraws = vi.fn()
    await signUpFlowChain(client(candidate), { tld: "paseo" }).register(capabilities(), new Uint8Array(65), { onDraws })
    registered().options.onDraws?.({ entered: 0, scheduled: 2, skipped: "the game is in Shuffle", kind: "closed", waitedMs: 0, retries: 0 })
    expect(onDraws).toHaveBeenCalledWith(expect.objectContaining({ kind: "closed" }))
  })

  it("keeps the ticket of a player this game makes a member", async () => {
    const lastGame = { score: 9, streak: { type: "Attended", value: 1 }, recognition: { type: "NotRecognized" }, reached_personhood: false }
    await signUpFlowChain(client(lastGame), { tld: "paseo" }).register(capabilities(), new Uint8Array(65))
    expect(registered().caps.signVrf).toBe(signVrf)
  })

  it("leaves the tickets to the SDK when the standing cannot be read", async () => {
    await signUpFlowChain(client("fails"), { tld: "paseo" }).register(capabilities(), new Uint8Array(65))
    expect(registered().caps.signVrf).toBe(signVrf)
  })
})

describe("the flow's reads", () => {
  it("reads the player at the best block and the game at the finalized one", async () => {
    const chain = signUpFlowChain(client(), { tld: "paseo" })
    expect(await chain.player(PLAYER)).toEqual({ registered: true })
    expect(await chain.game()).toEqual({ index: 7, state: { type: "Registration" }, registration_ends: 900 })
  })
})
