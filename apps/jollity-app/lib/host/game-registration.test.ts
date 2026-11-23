// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { GAME_REGISTRATION_KEY, type GameRegistration } from "@individuality/shared-records"

const host = vi.hoisted(() => ({
  read: vi.fn(),
  own: { readJSON: vi.fn(), readString: vi.fn(), writeJSON: vi.fn() },
  store: new Map<string, unknown>(),
  notifications: null as { push: () => unknown; cancel: (id: number) => Promise<void> } | null,
}))
const recordCount = vi.hoisted(() => vi.fn())
const stored = vi.hoisted(() => ({
  json: async (key: string) => host.store.get(key) ?? null,
  string: async (key: string) => (host.store.has(key) ? JSON.stringify(host.store.get(key)) : null),
}))

vi.mock("@parity/product-sdk-host", () => ({
  asProductId: (value: string) => value,
  getTruApi: async () => ({ localStorage: { read: host.read } }),
  getHostLocalStorage: async () => host.own,
  getNotificationManager: async () => host.notifications,
  formatHostError: (error: unknown) => String(error),
}))
vi.mock("@jollity/protocol", () => ({ network: () => ({ dotnsTLD: "paseo" }) }))
vi.mock("../debug/log-store", () => ({ devLog: () => {} }))
vi.mock("../telemetry", () => ({ recordCount }))
vi.mock("./storage", () => ({
  hostStorage: async () => host.own,
  readStoredJSON: stored.json,
  readStoredString: stored.string,
}))

import { WORKER_NOTIFICATIONS_KEY } from "../debug/worker-evidence"
import { humanityProduct, readGameRegistration, recordSignUp, writeGameRegistration } from "./game-registration"

const record = (at: number, surface: GameRegistration["surface"]): GameRegistration => ({
  gameIndex: 7,
  phase: "registering",
  surface,
  at,
  attempt: at,
})
const toHex = (value: unknown) =>
  `0x${Array.from(new TextEncoder().encode(JSON.stringify(value)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
const ok = (value: unknown) => ({ match: (onOk: (value: unknown) => unknown) => onOk(value) })
const refused = (error: unknown) => ({
  match: (_onOk: unknown, onError: (reason: unknown) => unknown) => onError(error),
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe("the game registration, from both products' storage", () => {
  it("keeps Humanity's record when it is the newer one", async () => {
    const now = Date.now()
    host.own.readJSON.mockResolvedValue(record(now - 2_000, "app"))
    host.read.mockResolvedValue(ok({ value: toHex(record(now - 1_000, "humanity")) }))

    expect(await readGameRegistration()).toEqual(record(now - 1_000, "humanity"))
    expect(host.read).toHaveBeenCalledWith({ product: "peopl.paseo", key: GAME_REGISTRATION_KEY })
    expect(humanityProduct()).toBe("peopl.paseo")
  })

  it("keeps this product's record when Humanity's storage refuses the read", async () => {
    const now = Date.now()
    host.own.readJSON.mockResolvedValue(record(now, "chat"))
    host.read.mockResolvedValue(refused("AccessNotGranted"))

    expect(await readGameRegistration()).toEqual(record(now, "chat"))
  })

  it("keeps Humanity's record when this product's storage fails", async () => {
    const now = Date.now()
    host.own.readJSON.mockRejectedValue(new Error("no storage"))
    host.read.mockResolvedValue(ok({ value: toHex(record(now, "humanity")) }))

    expect(await readGameRegistration()).toEqual(record(now, "humanity"))
  })

  it("reads a staging or preview Humanity under the label the build names", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUMANITY_STORAGE_LABEL", "peoplnext")
    try {
      expect(humanityProduct()).toBe("peoplnext.paseo")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("never lets Humanity's failed sign-up hide the chat's that is still going", async () => {
    const now = Date.now()
    host.own.readJSON.mockResolvedValue(record(now - 2_000, "chat"))
    host.read.mockResolvedValue(ok({ value: toHex({ ...record(now - 1_000, "humanity"), phase: "failed" }) }))

    expect(await readGameRegistration()).toEqual(record(now - 2_000, "chat"))
  })

  it("writes only to this product's storage", async () => {
    await writeGameRegistration(record(1, "app"))

    expect(host.own.writeJSON).toHaveBeenCalledWith(GAME_REGISTRATION_KEY, record(1, "app"))
    expect(host.read).not.toHaveBeenCalled()
  })
})

describe("the app's sign-up cancels the opening push the chat worker booked", () => {
  const GAME_DATE = 1_700_000_000
  const runningGame = async () => ({ index: 290, game_date: GAME_DATE })
  const signUp = (phase: GameRegistration["phase"]): GameRegistration => ({
    gameIndex: 290,
    phase,
    surface: "app",
    at: Date.now(),
    attempt: 1,
  })
  const cancel = vi.fn<(id: number) => Promise<void>>(async () => {})

  beforeEach(() => {
    host.store.clear()
    host.own.readJSON.mockImplementation(stored.json)
    host.own.readString.mockImplementation(stored.string)
    host.own.writeJSON.mockImplementation(async (key: string, value: unknown) => void host.store.set(key, value))
    host.notifications = { push: vi.fn(), cancel }
    host.store.set(WORKER_NOTIFICATIONS_KEY, {
      gamePlayTime: GAME_DATE,
      registered: false,
      ids: [41],
      moments: { [`opens:${GAME_DATE}`]: { id: 41, at: Date.now() + 600_000 } },
      stale: [],
      complete: true,
    })
  })

  it.each(["sent", "registered"] as const)("cancels it when the record reaches %s", async (phase) => {
    // Given
    const record = signUp(phase)

    // When
    await recordSignUp(record, runningGame)

    // Then
    expect(host.own.writeJSON).toHaveBeenCalledWith(GAME_REGISTRATION_KEY, record)
    expect(cancel).toHaveBeenCalledWith(41)
  })

  it("leaves it booked while the sign-up is still at the signer", async () => {
    // Given
    const record = signUp("registering")

    // When
    await recordSignUp(record, runningGame)

    // Then
    expect(host.own.writeJSON).toHaveBeenCalledWith(GAME_REGISTRATION_KEY, record)
    expect(cancel).not.toHaveBeenCalled()
  })

  const counted = async (outcome: string) => {
    await vi.dynamicImportSettled()
    expect(recordCount).toHaveBeenCalledWith("signup.opening_push", 1, { outcome })
  }

  it("counts the opening push it cancelled", async () => {
    // When
    await recordSignUp(signUp("sent"), runningGame)

    // Then
    await counted("cancelled")
  })

  type Setup = { record?: GameRegistration; readGame?: () => Promise<undefined> }
  const cases: [string, () => Setup, string][] = [
    ["the record names another game", () => ({ record: { ...signUp("sent"), gameIndex: 289 } }), "none"],
    ["no game is running", () => ({ readGame: async () => undefined }), "none"],
    [
      "the worker has not got the id of the push yet",
      () => {
        host.store.set(WORKER_NOTIFICATIONS_KEY, { moments: { [`opens:${GAME_DATE}`]: { id: null, at: Date.now(), pushing: true } } })
        return {}
      },
      "none",
    ],
    [
      "the page runs outside a host",
      () => {
        host.notifications = null
        return {}
      },
      "none",
    ],
    [
      "the booked pushes cannot be read",
      () => {
        host.own.readJSON.mockRejectedValue(new Error("busy"))
        return {}
      },
      "unreadable",
    ],
  ]

  it.each(cases)("cancels nothing when %s", async (_case, given, outcome) => {
    // Given
    const setup = given()
    const record = setup.record ?? signUp("sent")

    // When
    await recordSignUp(record, setup.readGame ?? runningGame)

    // Then
    expect(host.own.writeJSON).toHaveBeenCalledWith(GAME_REGISTRATION_KEY, record)
    expect(cancel).not.toHaveBeenCalled()
    await counted(outcome)
  })

  it("never fails the sign-up when the host refuses the cancel", async () => {
    // Given
    cancel.mockRejectedValueOnce(new Error("refused"))

    // When
    await recordSignUp(signUp("registered"), runningGame)

    // Then
    expect(cancel).toHaveBeenCalledWith(41)
    await counted("failed")
  })

  it("drops the cancelled push from the booking of the chat worker", async () => {
    // When
    await recordSignUp(signUp("sent"), runningGame)

    // Then
    expect(host.store.get(WORKER_NOTIFICATIONS_KEY)).toEqual({
      gamePlayTime: GAME_DATE,
      registered: false,
      ids: [],
      moments: {},
      stale: [],
      complete: true,
    })
  })

  it("cancels it once for a sign-up that reaches sent and then registered", async () => {
    // Given
    await recordSignUp(signUp("sent"), runningGame)
    await vi.dynamicImportSettled()
    recordCount.mockClear()

    // When
    await recordSignUp(signUp("registered"), runningGame)

    // Then
    expect(cancel).toHaveBeenCalledTimes(1)
    await counted("none")
  })

  it("keeps the booking a poll of the worker wrote during the cancel", async () => {
    // Given
    const rebooked = { gamePlayTime: GAME_DATE, registered: true, ids: [42], moments: { [`start-5m:${GAME_DATE}`]: { id: 42, at: Date.now() + 60_000 } } }
    cancel.mockImplementationOnce(async () => void host.store.set(WORKER_NOTIFICATIONS_KEY, rebooked))

    // When
    await recordSignUp(signUp("sent"), runningGame)

    // Then
    expect(host.store.get(WORKER_NOTIFICATIONS_KEY)).toEqual(rebooked)
    await counted("cancelled")
  })

  it("leaves no booking behind when the booking is gone after the cancel", async () => {
    // Given
    cancel.mockImplementationOnce(async () => void host.store.delete(WORKER_NOTIFICATIONS_KEY))

    // When
    await recordSignUp(signUp("sent"), runningGame)

    // Then
    expect(host.store.has(WORKER_NOTIFICATIONS_KEY)).toBe(false)
    await counted("cancelled")
  })

  it("counts the cancel failed when the booking cannot be read back after the cancel", async () => {
    // Given
    cancel.mockImplementationOnce(async () => void host.own.readJSON.mockRejectedValue(new Error("busy")))

    // When
    await recordSignUp(signUp("sent"), runningGame)

    // Then
    expect(cancel).toHaveBeenCalledWith(41)
    await counted("failed")
  })

  it("counts the cancel failed when the booking cannot be written back", async () => {
    // Given
    host.own.writeJSON.mockImplementation(async (key: string, value: unknown) => {
      if (key === WORKER_NOTIFICATIONS_KEY) throw new Error("refused")
      host.store.set(key, value)
    })

    // When
    await recordSignUp(signUp("sent"), runningGame)

    // Then
    expect(cancel).toHaveBeenCalledWith(41)
    await counted("failed")
  })

  it("gives up on a game read that never answers", async () => {
    // Given
    vi.useFakeTimers()
    try {
      // When
      const done = recordSignUp(signUp("sent"), () => new Promise(() => {}))
      await vi.advanceTimersByTimeAsync(8_000)
      await done

      // Then
      expect(cancel).not.toHaveBeenCalled()
      await counted("none")
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives up on a host that never answers the cancel", async () => {
    // Given
    vi.useFakeTimers()
    try {
      cancel.mockReturnValueOnce(new Promise<void>(() => {}))

      // When
      const done = recordSignUp(signUp("sent"), runningGame)
      await vi.advanceTimersByTimeAsync(8_000)
      await done

      // Then
      expect(cancel).toHaveBeenCalledWith(41)
      await counted("failed")
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives up on a booking write that never answers", async () => {
    // Given
    vi.useFakeTimers()
    try {
      host.own.writeJSON.mockImplementation(async (key: string, value: unknown) => {
        if (key === WORKER_NOTIFICATIONS_KEY) return new Promise<void>(() => {})
        host.store.set(key, value)
      })

      // When
      const done = recordSignUp(signUp("sent"), runningGame)
      await vi.advanceTimersByTimeAsync(8_000)
      await done

      // Then
      expect(cancel).toHaveBeenCalledWith(41)
      await counted("failed")
    } finally {
      vi.useRealTimers()
    }
  })
})
