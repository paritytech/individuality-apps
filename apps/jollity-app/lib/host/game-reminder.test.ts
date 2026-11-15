// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => ({
  api: null as unknown,
  store: new Map<string, unknown>(),
  readFails: false,
  readHangs: false,
  reads: 0,
}))
vi.mock("@parity/product-sdk-host", () => ({
  getTruApi: async () => sdk.api,
  getHostLocalStorage: async () => ({
    readJSON: async (key: string) => {
      sdk.reads++
      if (sdk.readFails) throw new Error("busy")
      if (sdk.readHangs) return new Promise(() => {})
      return sdk.store.get(key) ?? null
    },
    writeJSON: async (key: string, value: unknown) => void sdk.store.set(key, value),
  }),
}))

import { holdGameReminder, reminderForSignup } from "./game-reminder"

const KEY = "jollity.wg.host-reminder"
const GAME = 1_700_000_000

afterEach(() => {
  vi.useRealTimers()
  sdk.store.clear()
  sdk.readFails = false
  sdk.readHangs = false
  sdk.reads = 0
})

const answering = (remindNextGame: (request: { startsAt: bigint }) => unknown) => ({
  game: { remindNextGame, cancelNextGame: vi.fn() },
})
const held = () => Promise.resolve({ isOk: () => true })

describe("the game reminder of the app works", () => {
  it("passes the answer of the host through and records the start it sent", async () => {
    // Given
    sdk.api = answering(held)

    // When
    const outcome = await holdGameReminder(GAME, 1_700_000_000_000)

    // Then
    expect(outcome).toBe("held")
    expect(sdk.store.get(KEY)).toMatchObject({ gamePlayTime: GAME, startsAt: 1_700_000_000_000, outcome: "held" })
  })

  it("reports the answer of a real ask to onAsked, and none for a reused record", async () => {
    // Given
    sdk.api = answering(held)
    const onAsked = vi.fn()

    // When
    await holdGameReminder(GAME, 1_700_000_000_000, onAsked)
    await holdGameReminder(GAME, 1_700_000_000_000, onAsked)

    // Then
    expect(onAsked).toHaveBeenCalledTimes(1)
    expect(onAsked).toHaveBeenCalledWith("held", undefined)
  })

  it("passes the reason of an answer other than held to onAsked", async () => {
    // Given
    sdk.api = answering(() => Promise.resolve({ isOk: () => false, error: { tag: "HostFailure", value: { reason: "notifications are off" } } }))
    const onAsked = vi.fn()

    // When
    const outcome = await holdGameReminder(GAME, 1_700_000_000_000, onAsked)

    // Then
    expect(outcome).toBe("failed")
    expect(onAsked).toHaveBeenCalledWith("failed", "HostFailure: notifications are off")
  })

  it.each(["held", "asking"] as const)("asks nothing for a game the record shows %s, so the host hears one start", async (outcome) => {
    // Given
    const remind = vi.fn(held)
    sdk.api = answering(remind)
    sdk.store.set(KEY, { gamePlayTime: GAME, startsAt: 1_700_000_000_000, outcome, at: Date.now() })

    // When
    const answer = await holdGameReminder(GAME, 1_700_000_003_000)

    // Then
    expect(answer).toBe(outcome)
    expect(remind).not.toHaveBeenCalled()
  })

  it("asks over an ask the record has shown for longer than a host call may take, with the start it holds", async () => {
    // Given
    const remind = vi.fn(held)
    sdk.api = answering(remind)
    sdk.store.set(KEY, { gamePlayTime: GAME, startsAt: 1_700_000_000_000, outcome: "asking", at: Date.now() - 60_000 })

    // When
    const answer = await holdGameReminder(GAME, 1_700_000_003_000)

    // Then
    expect(answer).toBe("held")
    expect(remind).toHaveBeenCalledWith({ startsAt: 1_700_000_000_000n })
  })

  it("sends the start the record holds for the game, not its own reading", async () => {
    // Given
    const remind = vi.fn(held)
    sdk.api = answering(remind)
    sdk.store.set(KEY, { gamePlayTime: GAME, startsAt: 1_700_000_000_000, outcome: "dropped", at: 1 })

    // When
    await holdGameReminder(GAME, 1_700_000_003_000)

    // Then
    expect(remind).toHaveBeenCalledWith({ startsAt: 1_700_000_000_000n })
  })

  it("asks with its own reading for a game the record does not hold", async () => {
    // Given
    const remind = vi.fn(held)
    sdk.api = answering(remind)
    sdk.store.set(KEY, { gamePlayTime: GAME - 86_400, startsAt: 1_699_913_600_000, outcome: "held", at: 1 })

    // When
    await holdGameReminder(GAME, 1_700_000_003_000)

    // Then
    expect(remind).toHaveBeenCalledWith({ startsAt: 1_700_000_003_000n })
  })

  it("records a late answer once the host gives it", async () => {
    // Given
    vi.useFakeTimers()
    let answer: (value: { isOk: () => boolean }) => void = () => {}
    sdk.api = answering(() => new Promise((resolve) => (answer = resolve)))

    // When
    const pending = holdGameReminder(GAME, 1_700_000_000_000)
    await vi.advanceTimersByTimeAsync(10_100)
    const outcome = await pending
    answer({ isOk: () => true })
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(outcome).toBe("failed")
    expect(sdk.store.get(KEY)).toMatchObject({ gamePlayTime: GAME, outcome: "held" })
  })
})

describe("the game reminder of the app fails", () => {
  it("records what the host answered when it does not hold the reminder", async () => {
    // Given
    sdk.api = answering(() => Promise.resolve({ isOk: () => false, error: { tag: "Unsupported" } }))

    // When
    const outcome = await holdGameReminder(GAME, 1_700_000_000_000)

    // Then
    expect(outcome).toBe("unsupported")
    expect(sdk.store.get(KEY)).toMatchObject({ gamePlayTime: GAME, outcome: "unsupported" })
  })

  it("asks nothing when it cannot read the record", async () => {
    // Given
    const remind = vi.fn(held)
    sdk.api = answering(remind)
    sdk.readFails = true

    // When
    const outcome = await holdGameReminder(GAME, 1_700_000_000_000)

    // Then
    expect(outcome).toBe("unrecorded")
    expect(remind).not.toHaveBeenCalled()
  })

  it("is null with no host", async () => {
    // Given
    sdk.api = null

    // When
    const outcome = await holdGameReminder(GAME, 1)

    // Then
    expect(outcome).toBeNull()
  })

  it("answers failed when the host never hands over its client", async () => {
    // Given
    vi.useFakeTimers()
    sdk.api = new Promise(() => {})

    // When
    const pending = holdGameReminder(GAME, 1)
    await vi.advanceTimersByTimeAsync(10_100)

    // Then
    expect(await pending).toBe("failed")
  })
})

describe("the reminder gate of a sign-up from the app works", () => {
  it("asks once more when the host does not hold the reminder, and takes the second answer", async () => {
    // Given
    const remind = vi.fn()
      .mockResolvedValueOnce({ isOk: () => false, error: { tag: "HostFailure", value: { reason: "the player is still deciding" } } })
      .mockResolvedValueOnce({ isOk: () => true })
    sdk.api = answering(remind)
    const onAsked = vi.fn()

    // When
    const outcome = await reminderForSignup(GAME, 1_700_000_000_000, onAsked)

    // Then
    expect(outcome).toBe("held")
    expect(remind).toHaveBeenCalledTimes(2)
    expect(onAsked.mock.calls).toEqual([
      ["failed", "HostFailure: the player is still deciding"],
      ["held", undefined],
    ])
  })

  it("gives the answer of the second ask when the host refuses both", async () => {
    // Given
    const remind = vi.fn(() => Promise.resolve({ isOk: () => false, error: { tag: "Denied" } }))
    sdk.api = answering(remind)

    // When
    const outcome = await reminderForSignup(GAME, 1_700_000_000_000)

    // Then
    expect(outcome).toBe("denied")
    expect(remind).toHaveBeenCalledTimes(2)
  })

  it.each(["unsupported", "starts-in-past"] as const)("asks once when the host answers %s, which no second ask changes", async (outcome) => {
    // Given
    const error = outcome === "unsupported" ? { tag: "Unsupported" } : { tag: "Domain", value: { tag: "V1", value: "StartsInPast" } }
    const remind = vi.fn(() => Promise.resolve({ isOk: () => false, error }))
    sdk.api = answering(remind)
    const onAsked = vi.fn()

    // When
    const answer = await reminderForSignup(GAME, 1_700_000_000_000, onAsked)

    // Then
    expect(answer).toBe(outcome)
    expect(remind).toHaveBeenCalledTimes(1)
    expect(onAsked).toHaveBeenCalledWith(outcome, outcome === "unsupported" ? "Unsupported" : "Domain.V1: StartsInPast")
  })

  it("waits for the answer to an ask the chat has under way, and takes it", async () => {
    // Given
    vi.useFakeTimers()
    const remind = vi.fn(held)
    sdk.api = answering(remind)
    sdk.store.set(KEY, { gamePlayTime: GAME, startsAt: 1_700_000_000_000, outcome: "asking", at: Date.now() })

    // When
    const pending = reminderForSignup(GAME, 1_700_000_000_000)
    await vi.advanceTimersByTimeAsync(20_000)
    sdk.store.set(KEY, { gamePlayTime: GAME, startsAt: 1_700_000_000_000, outcome: "held", at: Date.now() })
    await vi.advanceTimersByTimeAsync(2_000)

    // Then
    expect(await pending).toBe("held")
    expect(remind).not.toHaveBeenCalled()
  })

  it("gives the host as long as the chat does while it asks the player", async () => {
    // Given
    vi.useFakeTimers()
    const remind = vi.fn()
      .mockResolvedValueOnce({ isOk: () => false, error: { tag: "HostFailure", value: { reason: "the player is still deciding" } } })
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ isOk: () => true }), 30_000)))
    sdk.api = answering(remind)

    // When
    const pending = reminderForSignup(GAME, 1_700_000_000_000)
    await vi.advanceTimersByTimeAsync(31_000)

    // Then
    expect(await pending).toBe("held")
    expect(remind).toHaveBeenCalledTimes(2)
  })

  it("stops waiting once a host call would have answered, even on a claim dated ahead of the clock, and asks over it once", async () => {
    // Given
    vi.useFakeTimers()
    const remind = vi.fn(held)
    sdk.api = answering(remind)
    sdk.store.set(KEY, { gamePlayTime: GAME, startsAt: 1_700_000_000_000, outcome: "asking", at: Date.now() + 3_600_000 })

    // When
    const pending = reminderForSignup(GAME, 1_700_000_000_000)
    await vi.advanceTimersByTimeAsync(46_000)

    // Then
    expect(remind).toHaveBeenCalledTimes(1)
    expect(await pending).toBe("held")
  })

  it("reads the record no more once its wait gives up, while its own ask is still out", async () => {
    // Given
    vi.useFakeTimers()
    sdk.api = answering(() => new Promise(() => {}))
    sdk.store.set(KEY, { gamePlayTime: GAME, startsAt: 1_700_000_000_000, outcome: "asking", at: Date.now() + 3_600_000 })
    void reminderForSignup(GAME, 1_700_000_000_000)
    await vi.advanceTimersByTimeAsync(46_000)
    const readsWhenTheWaitGaveUp = sdk.reads

    // When
    await vi.advanceTimersByTimeAsync(30_000)

    // Then
    expect(sdk.reads).toBe(readsWhenTheWaitGaveUp)
  })

  it("answers within one wait and two asks when host storage never answers", async () => {
    // Given
    vi.useFakeTimers()
    sdk.api = answering(vi.fn(held))
    sdk.readHangs = true
    let answered = false

    // When
    void reminderForSignup(GAME, 1_700_000_000_000).then(() => (answered = true))
    await vi.advanceTimersByTimeAsync(3 * 45_000 + 1_000)

    // Then
    expect(answered).toBe(true)
  })
})
