// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The bound on a host call that can never settle.
 *
 * Inside the WebView `fetch` is the host bridge and it ignores `signal`, so a
 * bridge that has gone away leaves the promise pending for ever. The mesh
 * awaits these, with no clock of its own, so anything unbounded here stops a
 * game from opening at all rather than falling back to STUN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CONNECTION_STAGE_DURATION, HOST_FULL_CYCLE, ROUND_GAP } from "@jollity/game-chain/game"
import { boundedForTests, meshOpenMinS, stampSecondsOf } from "./ice"
import { cleanReason } from "../journeys/turn-outcome"

// One mock for the whole file: repeatedly registering and removing this static
// ice.ts dependency can expose the real host bridge under a loaded worker.
const turnProofMock = vi.hoisted(() => vi.fn())
vi.mock("../host/turn-proof", () => ({ turnProofBody: turnProofMock }))

const hostStorageMock = vi.hoisted(() => ({
  readStoredJSON: vi.fn<(_key: string) => Promise<unknown>>(async () => null),
  writeStoredJSON: vi.fn<(_key: string, _value: unknown) => Promise<void>>(async () => {}),
}))
vi.mock("../host/storage", () => hostStorageMock)

const recordDistributionMock = vi.hoisted(() => vi.fn())
vi.mock("../telemetry/metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telemetry/metrics")>()),
  recordDistribution: recordDistributionMock,
}))

const devLogMock = vi.hoisted(() => vi.fn())
vi.mock("../debug/log-store", () => ({ devLog: devLogMock }))

const hostRetryRecordMock = vi.hoisted(() => vi.fn())
vi.mock("../telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telemetry")>()),
  hostRetryRecord: hostRetryRecordMock,
}))

// Each test loads its own ice module, and a retry or late fetch of one test left
// on a real timer would fire in a later test and call that test's fetch spy. The
// timers a test starts are cleared when it ends, so a stale module goes quiet.
const realTimeouts = new Set<ReturnType<typeof setTimeout>>()
const realSetTimeout = globalThis.setTimeout
beforeEach(() => {
  realTimeouts.clear()
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    const id = realSetTimeout(...args)
    realTimeouts.add(id)
    return id
  }) as typeof setTimeout)
})

afterEach(() => {
  vi.mocked(globalThis.setTimeout).mockRestore()
  for (const id of realTimeouts) clearTimeout(id)
  realTimeouts.clear()
  turnProofMock.mockReset()
  hostStorageMock.readStoredJSON.mockReset().mockResolvedValue(null)
  hostStorageMock.writeStoredJSON.mockReset().mockResolvedValue(undefined)
  recordDistributionMock.mockReset()
  devLogMock.mockReset()
  hostRetryRecordMock.mockReset()
})

describe("bounded", () => {
  it("rejects a promise that never settles", async () => {
    vi.useFakeTimers()
    const forever = new Promise<string>(() => {})
    const raced = boundedForTests(forever, "turn/proof")
    const assertion = expect(raced).rejects.toThrow(/turn\/proof: no answer/)
    await vi.advanceTimersByTimeAsync(6_000)
    await assertion
    vi.useRealTimers()
  })

  it("passes a value through untouched when it arrives in time", async () => {
    await expect(boundedForTests(Promise.resolve("credentials"), "turn/proof")).resolves.toBe(
      "credentials",
    )
  })

  it("keeps the original failure rather than replacing it with the timeout", async () => {
    await expect(
      boundedForTests(Promise.reject(new Error("issuer said 403")), "turn/proof"),
    ).rejects.toThrow("issuer said 403")
  })
})

it("stamps from the issuer's skew first, then the chain gap, then chain seconds, then the device clock", () => {
  expect(
    stampSecondsOf(
      {
        serverSkewMs: 2_000,
        skewBaseMs: () => 1_700_000_000_000,
        gapMs: () => 75_000,
        deviceNowMs: () => 1_700_000_075_000,
        chainSeconds: () => 1_699_999_999,
      },
      false,
    ),
  ).toEqual({ seconds: 1_700_000_002, fromGap: false })

  expect(
    stampSecondsOf(
      {
        serverSkewMs: null,
        skewBaseMs: () => 1_700_000_000_000,
        gapMs: () => 75_000,
        deviceNowMs: () => 1_700_000_075_000,
        chainSeconds: () => 1_699_999_999,
      },
      false,
    ),
  ).toEqual({ seconds: 1_700_000_000, fromGap: true })

  expect(
    stampSecondsOf(
      {
        serverSkewMs: null,
        skewBaseMs: () => 1_700_000_000_000,
        gapMs: () => 75_000,
        deviceNowMs: () => 1_700_000_075_000,
        chainSeconds: () => 1_699_999_999,
      },
      true,
    ),
  ).toEqual({ seconds: 1_699_999_999, fromGap: false })

  expect(
    stampSecondsOf(
      {
        serverSkewMs: null,
        skewBaseMs: () => 1_700_000_000_000,
        gapMs: () => null,
        deviceNowMs: () => 1_700_000_075_000,
        chainSeconds: () => null,
      },
      false,
    ),
  ).toEqual({ seconds: 1_700_000_075, fromGap: false })
})

describe("TURN without a personhood proof fails", () => {
  it("asks no issuer for credentials", async () => {
    // Given
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    turnProofMock.mockImplementation(async () => ({ reason: "not inside a host", code: "no-host" }))
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const ice = await import("./ice")

    // When
    const servers = await ice.fetchIceServers()

    // Then
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(servers.every((server) => String(server.urls).startsWith("stun:"))).toBe(true)
    expect(ice.lastIceOutcome()).toMatchObject({ turnReceived: false })
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("asks a second STUN provider on another port, for networks that drop Google's 19302", async () => {
    // Given
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    turnProofMock.mockImplementation(async () => ({ reason: "not inside a host", code: "no-host" }))
    vi.stubGlobal("fetch", vi.fn())
    const ice = await import("./ice")

    // When
    const urls = (await ice.fetchIceServers()).flatMap((server) => server.urls)

    // Then
    expect(urls).toContain("stun:stun.l.google.com:19302")
    expect(urls).toContain("stun:stun.cloudflare.com:3478")
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("puts a later client receipt in the same native console stream as the earlier STUN-only failure", async () => {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    const consoleLines: string[] = []
    vi.spyOn(console, "warn").mockImplementation((message) => consoleLines.push(String(message)))
    vi.spyOn(console, "log").mockImplementation((message) => consoleLines.push(String(message)))
    turnProofMock.mockResolvedValueOnce({ reason: "host channel interrupted", code: "no-host" })
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 201,
      json: async () => ({ servers: ["turn:private.example:3478"], username: "private-user", password: "private-password", ttl: 1800 }),
    })))
    const ice = await import("./ice")

    expect(await ice.fetchIceServers()).toHaveLength(1)
    turnProofMock.mockResolvedValue({ body: { productId: "p", collection: "c", proof: "0x", ringIndex: 0, ringRevision: 0, timestamp: 1 } })
    expect(await ice.retryIceServersAfterHostReconnect()).toHaveLength(2)

    const failed = consoleLines.findIndex((line) => line.includes("failed to fetch credentials"))
    const recovered = consoleLines.findIndex((line) => line.includes("client response received and parsed"))
    expect(failed).toBeGreaterThanOrEqual(0)
    expect(recovered).toBeGreaterThan(failed)
    expect(consoleLines[recovered]).toContain("turn_servers=1")
    expect(consoleLines.join("\n")).not.toContain("private.example")
    expect(consoleLines.join("\n")).not.toContain("private-user")
    expect(consoleLines.join("\n")).not.toContain("private-password")
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
})

describe("the TURN steps as events", () => {
  const BODY = { productId: "p", collection: "c", proof: "0x", ringIndex: 0, ringRevision: 0, timestamp: 1 }

  it("reports the proof and the issue, then a cache hit", async () => {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    turnProofMock.mockImplementation(async () => ({ body: BODY }))
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 201,
        json: async () => ({ servers: ["turn:relay.example:3478"], username: "u", password: "p", ttl: 1800 }),
      })),
    )
    const ice = await import("./ice")
    const events: import("./ice").IceEvent[] = []
    const stop = ice.observeIce((event) => events.push(event))
    await ice.fetchIceServers()
    await ice.fetchIceServers()
    stop()
    await ice.fetchIceServers()
    expect(events.map((event) => event.kind)).toEqual(["proof", "issue", "cached"])
    expect(events[0]).toMatchObject({ kind: "proof", ok: true })
    expect(events[1]).toMatchObject({ kind: "issue", ok: true })
    expect(devLogMock.mock.calls.map(([, message]) => message)).toContainEqual(
      expect.stringMatching(/^\[jollity-rtc\] TURN: client response received and parsed lifecycle=initial request_started_at_ms=\d+ received_at_ms=\d+ completed_at_ms=\d+ expires_at_ms=\d+ cache_expires_at_ms=\d+ ttl_s=1800 turn_servers=1$/),
    )
    const proof = events[0] as { startedAt: number; endedAt: number }
    expect(proof.endedAt).toBeGreaterThanOrEqual(proof.startedAt)
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("labels an expired refetch as renewal and records real credential and cache expiry", async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    turnProofMock.mockImplementation(async () => ({ body: BODY }))
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250))
        return {
          status: 201,
          json: async () => ({ servers: ["turn:relay.example:3478"], username: "u", password: "p", ttl: 6 }),
        }
      }),
    )
    const ice = await import("./ice")

    const first = ice.fetchIceServers()
    await vi.advanceTimersByTimeAsync(250)
    await first
    await vi.advanceTimersByTimeAsync(1_001)
    const renewed = ice.fetchIceServers()
    await vi.advanceTimersByTimeAsync(250)
    await renewed

    const lifecycle = devLogMock.mock.calls
      .map(([, message]) => message as string)
      .filter((message) => message.includes("TURN:") && message.includes("request_started_at_ms="))
    expect(lifecycle).toHaveLength(2)
    expect(lifecycle[0]).toContain("lifecycle=initial ")
    expect(lifecycle[1]).toContain("lifecycle=renewal ")
    for (const message of lifecycle) {
      const values = Object.fromEntries(
        [...message.matchAll(/(request_started_at_ms|received_at_ms|completed_at_ms|expires_at_ms|cache_expires_at_ms)=(\d+)/g)]
          .map((match) => [match[1], Number(match[2])]),
      )
      expect(values.received_at_ms).toBeGreaterThan(values.request_started_at_ms)
      expect(values.completed_at_ms).toBeGreaterThanOrEqual(values.received_at_ms)
      expect(values.expires_at_ms - values.received_at_ms).toBe(6_000)
      expect(values.cache_expires_at_ms - values.received_at_ms).toBe(1_000)
    }

    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("reports a proof the host could not give, and no issue", async () => {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    turnProofMock.mockImplementation(async () => ({ reason: "not inside a host", code: "no-host" }))
    vi.stubGlobal("fetch", vi.fn())
    const ice = await import("./ice")
    const events: import("./ice").IceEvent[] = []
    ice.observeIce((event) => events.push(event))
    await ice.fetchIceServers()
    expect(events).toEqual([expect.objectContaining({ kind: "proof", ok: false })])
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  describe("the event trail under 4 minutes left works", () => {
    async function underFourMinutes() {
      vi.resetModules()
      vi.useFakeTimers()
      vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
      turnProofMock.mockImplementation(async () => ({ body: BODY }))
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          status: 201,
          json: async () => ({ servers: ["turn:relay.example:3478"], username: "u", password: "p", ttl: 1800 }),
        })),
      )
      const ice = await import("./ice")
      await ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(27 * 60_000)
      const events: import("./ice").IceEvent[] = []
      ice.observeIce((event) => events.push(event))
      return { ice, events }
    }

    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    })

    it("reports the renewal a mesh waited for, and no cache hit", async () => {
      // Given
      const { ice, events } = await underFourMinutes()

      // When
      await ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(1_000)

      // Then
      expect(events.map((event) => event.kind)).toEqual(["proof", "issue"])
      expect(devLogMock.mock.calls.map(([, message]) => message)).toContainEqual(
        expect.stringMatching(/^\[jollity-rtc\] TURN: client response received and parsed lifecycle=renewal request_started_at_ms=\d+ received_at_ms=\d+ completed_at_ms=\d+ expires_at_ms=\d+ cache_expires_at_ms=\d+ ttl_s=1800 turn_servers=1$/),
      )
    })

    it("reports a cache hit for a warm-up, ahead of the renewal it starts", async () => {
      // Given
      const { ice, events } = await underFourMinutes()

      // When
      await ice.fetchIceServers(undefined, "warmup")
      await vi.advanceTimersByTimeAsync(1_000)

      // Then
      expect(events.map((event) => event.kind)).toEqual(["cached", "proof", "issue"])
    })
  })
})

describe("TURN credentials across reloads and network changes (#724)", () => {
  const BODY = { productId: "p", collection: "c", proof: "0x", ringIndex: 0, ringRevision: 0, timestamp: 1 }
  const stored = new Map<string, unknown>()
  const durable = new Map<string, unknown>()
  let durableReadMs = 0
  let durableReadError = false
  const PLAYER_A = new Uint8Array(32).fill(0xaa)
  const PLAYER_B = new Uint8Array(32).fill(0xbb)
  const issued = (username: string) => ({
    status: 201,
    json: async () => ({
      servers: ["turn:relay.example:3478"],
      username,
      password: "p",
      ttl: 1800,
    }),
  })

  const load = async (
    fetchSpy: ReturnType<typeof vi.fn>,
    proof: () => Promise<unknown> = async () => ({ body: BODY }),
    player: Uint8Array = PLAYER_A,
  ) => {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    turnProofMock.mockImplementation(proof)
    hostStorageMock.readStoredJSON.mockImplementation(async (key: string) => {
      if (durableReadMs < 0) await new Promise(() => {})
      if (durableReadMs > 0)
        await new Promise((resolve) => setTimeout(resolve, durableReadMs))
      if (durableReadError) throw new Error("host store unavailable")
      return durable.get(key) ?? null
    })
    hostStorageMock.writeStoredJSON.mockImplementation(async (key: string, value: unknown) => {
      durable.set(key, structuredClone(value))
    })
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        const value = stored.get(key)
        return value === undefined ? null : JSON.stringify(value)
      },
      setItem: (key: string, value: string) => void stored.set(key, JSON.parse(value)),
      removeItem: (key: string) => void stored.delete(key),
    })
    vi.stubGlobal("fetch", fetchSpy)
    const ice = await import("./ice")
    ice.setTurnPlayerAccount(player)
    return ice
  }

  afterEach(() => {
    vi.useRealTimers()
    stored.clear()
    durable.clear()
    durableReadMs = 0
    durableReadError = false
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("tells a STUN-only room about credentials a slow durable read adopts", async () => {
    // Learn the durable key and the stored shape from one ordinary run.
    const seed = await load(vi.fn(async () => issued("seed")))
    await seed.fetchIceServers()
    await Promise.resolve()
    const [key, pass] = [...durable.entries()][0]!
    durable.clear()
    // A fresh page: the in-page browser cache is gone too, so the only copy
    // is the durable one whose read is slow.
    stored.clear()

    // The same pass, but its read outlives the wait, so the room opens on
    // STUN only and its single lateIceServers call has already gone by.
    durableReadMs = 9_000
    durable.set(key, pass)
    // The issue is slow too, so the room does not wait for it either.
    const fetchSpy = vi.fn(() => new Promise<never>(() => {}))
    const ice = await load(fetchSpy)
    const opened = { setIceServers: vi.fn() }
    const stop = ice.observeTurnServers((servers) => opened.setIceServers(servers))
    try {
      const servers = await ice.fetchIceServers()
      expect(servers.every((server) => String(server.urls).startsWith("stun:"))).toBe(true)
      expect(opened.setIceServers).not.toHaveBeenCalled()

      // The pass lands afterwards. The room must hear about it, or its links
      // stay on STUN for the rest of the page.
      await new Promise((resolve) => setTimeout(resolve, 20))
      await vi.waitFor(() => expect(opened.setIceServers).toHaveBeenCalled(), { timeout: 8_000, interval: 100 })
      expect(opened.setIceServers).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ username: "seed" })]),
      )
    } finally {
      stop()
    }
  }, 20_000)

  it("reuses unexpired credentials after the page reloads", async () => {
    const firstFetch = vi.fn(async () => issued("before-reload"))
    const first = await load(firstFetch)
    await first.fetchIceServers()
    await Promise.resolve()
    expect(firstFetch).toHaveBeenCalledTimes(1)
    expect(stored.size).toBe(1)

    const afterReloadFetch = vi.fn()
    const afterReload = await load(afterReloadFetch)
    const servers = await afterReload.fetchIceServers()
    expect(afterReloadFetch).not.toHaveBeenCalled()
    expect(servers).toContainEqual(expect.objectContaining({ username: "before-reload" }))
    expect(afterReload.lastTurnOutcome()).toMatchObject({ received: "cached" })
  })

  it("labels a refetch after an expired persisted credential as renewal", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const first = await load(vi.fn(async () => issued("expired-before-reload")))
    await first.fetchIceServers()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(30 * 60_000)

    devLogMock.mockClear()
    const afterReload = await load(vi.fn(async () => issued("renewed-after-reload")))
    await afterReload.fetchIceServers()

    expect(devLogMock.mock.calls.map(([, message]) => message)).toContainEqual(
      expect.stringMatching(/^\[jollity-rtc\] TURN: client response received and parsed lifecycle=renewal request_started_at_ms=/),
    )
  })

  it("waits for delayed durable-cache history before classifying a concurrent issue", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const first = await load(vi.fn(async () => issued("durable-history")))
    await first.fetchIceServers()
    await Promise.resolve()

    stored.clear()
    durableReadMs = 250
    devLogMock.mockClear()
    const afterReloadFetch = vi.fn(async () => issued("concurrent-renewal"))
    const afterReload = await load(afterReloadFetch)
    const fetching = afterReload.fetchIceServers()
    await vi.advanceTimersByTimeAsync(250)
    await fetching

    expect(afterReloadFetch).toHaveBeenCalledTimes(1)
    expect(devLogMock.mock.calls.map(([, message]) => message)).toContainEqual(
      expect.stringMatching(/^\[jollity-rtc\] TURN: client response received and parsed lifecycle=renewal request_started_at_ms=/),
    )
  })

  it("reuses a durable host pass after the WebView storage is lost, without another ring proof (#911)", async () => {
    // Given: the first page issued TURN and mirrored it outside the WebView.
    const firstFetch = vi.fn(async () => issued("before-host-drop"))
    const first = await load(firstFetch)
    await first.fetchIceServers()
    await Promise.resolve()
    expect(durable.size).toBe(1)

    // The host replaces the page after its channel drops during a later proof.
    stored.clear()
    turnProofMock.mockClear()
    const afterDropFetch = vi.fn()
    const afterDrop = await load(afterDropFetch, () => new Promise(() => {}))

    // When
    const servers = await afterDrop.fetchIceServers()

    // Then: rejoin takes the retained relay immediately and never asks the
    // broken host channel to create another ring proof.
    expect(servers).toContainEqual(
      expect.objectContaining({ username: "before-host-drop" }),
    )
    expect(turnProofMock).not.toHaveBeenCalled()
    expect(afterDropFetch).not.toHaveBeenCalled()
    expect(afterDrop.lastTurnOutcome()).toMatchObject({ received: "cached" })
  })

  it("records one numeric durable-cache hit wait per page and key", async () => {
    const first = await load(vi.fn(async () => issued("durable-hit")))
    await first.fetchIceServers()
    await Promise.resolve()

    stored.clear()
    recordDistributionMock.mockClear()
    const afterReload = await load(vi.fn(), () => new Promise(() => {}))
    await afterReload.fetchIceServers()
    await afterReload.fetchIceServers()

    expect(recordDistributionMock).toHaveBeenCalledTimes(1)
    expect(recordDistributionMock).toHaveBeenCalledWith(
      "turn.durable_wait_ms",
      expect.any(Number),
      "millisecond",
      { "turn.durable_result": "hit" },
    )
  })

  it("records one durable-cache miss per page and key", async () => {
    const ice = await load(
      vi.fn(),
      async () => ({ reason: "not inside a host", code: "no-host" }),
    )

    await ice.fetchIceServers()
    await ice.fetchIceServers()

    expect(recordDistributionMock).toHaveBeenCalledTimes(1)
    expect(recordDistributionMock).toHaveBeenCalledWith(
      "turn.durable_wait_ms",
      expect.any(Number),
      "millisecond",
      { "turn.durable_result": "miss" },
    )
    expect(ice.lastIceOutcome()).toMatchObject({ durable_timed_out: false })
  })

  it("records one durable-cache error per page and key", async () => {
    durableReadError = true
    const ice = await load(
      vi.fn(),
      async () => ({ reason: "not inside a host", code: "no-host" }),
    )

    await ice.fetchIceServers()
    await ice.fetchIceServers()

    expect(recordDistributionMock).toHaveBeenCalledTimes(1)
    expect(recordDistributionMock).toHaveBeenCalledWith(
      "turn.durable_wait_ms",
      expect.any(Number),
      "millisecond",
      { "turn.durable_result": "error" },
    )
  })

  it("records one durable-cache timeout and exposes it on the ICE outcome", async () => {
    vi.useFakeTimers()
    durableReadMs = -1
    const ice = await load(
      vi.fn(),
      async () => ({ reason: "not inside a host", code: "no-host" }),
    )

    const first = ice.fetchIceServers()
    await vi.advanceTimersByTimeAsync(1_500)
    await first
    await ice.fetchIceServers()

    expect(recordDistributionMock).toHaveBeenCalledTimes(1)
    expect(recordDistributionMock).toHaveBeenCalledWith(
      "turn.durable_wait_ms",
      1_500,
      "millisecond",
      { "turn.durable_result": "timeout" },
    )
    expect(ice.lastIceOutcome()).toMatchObject({ durable_timed_out: true })
  })

  it("records the unbound-account case once per page", async () => {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    turnProofMock.mockImplementation(async () => ({
      reason: "not inside a host",
      code: "no-host",
    }))
    vi.stubGlobal("fetch", vi.fn())
    const ice = await import("./ice")

    await ice.fetchIceServers()
    await ice.fetchIceServers()

    expect(recordDistributionMock).toHaveBeenCalledTimes(1)
    expect(recordDistributionMock).toHaveBeenCalledWith(
      "turn.durable_wait_ms",
      0,
      "millisecond",
      { "turn.durable_result": "none" },
    )
    expect(ice.lastIceOutcome()).toMatchObject({ durable_timed_out: false })
  })

  it("isolates a durable pass by player account", async () => {
    const first = await load(vi.fn(async () => issued("player-a")))
    await first.fetchIceServers()
    await Promise.resolve()
    const [playerAKey] = [...durable.keys()]

    stored.clear()
    const playerBFetch = vi.fn(async () => issued("player-b"))
    const second = await load(playerBFetch, undefined, PLAYER_B)
    const servers = await second.fetchIceServers()

    expect(playerBFetch).toHaveBeenCalledTimes(1)
    expect(servers).toContainEqual(expect.objectContaining({ username: "player-b" }))
    expect(servers).not.toContainEqual(expect.objectContaining({ username: "player-a" }))
    expect([...durable.keys()]).toHaveLength(2)
    expect([...durable.keys()][1]).not.toBe(playerAKey)
  })

  it("starts the proof immediately and opens STUN by eight seconds while a slow proof is asked for again", async () => {
    vi.useFakeTimers()
    durableReadMs = -1
    const fetchSpy = vi.fn()
    const proofStartedAt: number[] = []
    const ice = await load(fetchSpy, async () => {
      proofStartedAt.push(Date.now())
      await new Promise((resolve) => setTimeout(resolve, 7_000))
      return { body: BODY }
    })
    let opened: RTCIceServer[] | undefined

    void ice.fetchIceServers().then((servers) => {
      opened = servers
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(proofStartedAt).toEqual([Date.now()])
    await vi.advanceTimersByTimeAsync(8_000)

    expect(opened?.every((server) => String(server.urls).startsWith("stun:"))).toBe(
      true,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("keeps the complete first-open wait bounded to eight seconds with a stuck store", async () => {
    vi.useFakeTimers()
    durableReadMs = -1
    const fetchSpy = vi.fn(() => new Promise(() => {}))
    const ice = await load(fetchSpy)
    let opened: RTCIceServer[] | undefined

    void ice.fetchIceServers().then((servers) => {
      opened = servers
    })
    await vi.advanceTimersByTimeAsync(7_999)
    expect(opened).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)

    expect(opened?.every((server) => String(server.urls).startsWith("stun:"))).toBe(
      true,
    )
    expect(turnProofMock).toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalled()
  })

  it("does not pay the durable timeout again after the first read is stuck", async () => {
    vi.useFakeTimers()
    durableReadMs = -1
    const ice = await load(
      vi.fn(),
      async () => ({ reason: "not inside a host", code: "no-host" }),
    )

    const first = ice.fetchIceServers()
    await vi.advanceTimersByTimeAsync(1_499)
    let firstSettled = false
    void first.then(() => {
      firstSettled = true
    })
    expect(firstSettled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await first

    let secondSettled = false
    void ice.fetchIceServers().then(() => {
      secondSettled = true
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(secondSettled).toBe(true)
    expect(hostStorageMock.readStoredJSON).toHaveBeenCalledTimes(1)
  })

  it("still adopts a valid durable pass that lands after the one allowed wait", async () => {
    vi.useFakeTimers()
    const first = await load(vi.fn(async () => issued("late-durable")))
    await first.fetchIceServers()
    await Promise.resolve()

    stored.clear()
    durableReadMs = 2_000
    turnProofMock.mockClear()
    const afterDrop = await load(
      vi.fn(),
      async () => ({ reason: "host channel dropped", code: "proof-refused" }),
    )
    const firstRejoin = afterDrop.fetchIceServers()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(
      (await firstRejoin).every((server) => String(server.urls).startsWith("stun:")),
    ).toBe(true)

    await vi.advanceTimersByTimeAsync(500)
    const recovered = await afterDrop.fetchIceServers()

    expect(recovered).toContainEqual(
      expect.objectContaining({ username: "late-durable" }),
    )
    expect(turnProofMock).toHaveBeenCalledTimes(1)
  })

  it("discards expired persisted credentials on reload", async () => {
    const first = await load(vi.fn(async () => issued("expired")))
    await first.fetchIceServers()
    const [key, value] = [...stored.entries()][0]!
    stored.set(key, { ...(value as object), expiresAtWallMs: Date.now() - 1 })
    durable.set(key, {
      ...(durable.get(key) as object),
      expiresAtWallMs: Date.now() - 1,
    })

    const afterReloadFetch = vi.fn(async () => issued("replacement"))
    const afterReload = await load(afterReloadFetch)
    const servers = await afterReload.fetchIceServers()

    expect(afterReloadFetch).toHaveBeenCalledTimes(1)
    expect(servers).toContainEqual(expect.objectContaining({ username: "replacement" }))
    expect(servers).not.toContainEqual(expect.objectContaining({ username: "expired" }))
  })

  it("hands out no relay from a malformed stored pass and fetches a fresh one", async () => {
    // Given
    const first = await load(vi.fn(async () => issued("before-reload")))
    await first.fetchIceServers()
    const [key] = [...durable.keys()]
    const malformed = { turn: "nope", expiresAtWallMs: Date.now() + 600_000 }
    stored.set(key!, malformed)
    durable.set(key!, malformed)
    const afterReloadFetch = vi.fn(async () => issued("replacement"))
    const afterReload = await load(afterReloadFetch)

    // When
    const servers = await afterReload.fetchIceServers()

    // Then
    expect(afterReloadFetch).toHaveBeenCalledTimes(1)
    expect(servers.filter((server) => !String(server.urls).startsWith("stun:"))).toEqual([
      expect.objectContaining({ username: "replacement" }),
    ])
  })

  it("reuses valid credentials on a network change without spending another host proof", async () => {
    const fetchSpy = vi.fn(async () => issued("wifi"))
    const ice = await load(fetchSpy)
    const outcomes: import("./ice").TurnOutcome[] = []
    ice.observeTurnOutcome((outcome) => outcomes.push(outcome))

    await ice.fetchIceServers()
    const changed = await ice.retryIceServers()

    expect(changed).toContainEqual(expect.objectContaining({ username: "wifi" }))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(outcomes).toEqual([{ received: "true", ttlLeftS: 1800 }])
    expect(await ice.fetchIceServers()).toContainEqual(
      expect.objectContaining({ username: "wifi" }),
    )
  })

  it("does not let a network change turn valid credentials into a host failure", async () => {
    const fetchSpy = vi.fn(async () => issued("still-valid"))
    const ice = await load(fetchSpy)
    await ice.fetchIceServers()

    const changed = await ice.retryIceServers()

    expect(changed).toContainEqual(expect.objectContaining({ username: "still-valid" }))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(ice.lastTurnOutcome()).toMatchObject({ received: "true" })
  })

  it("shares a successful retry after a dropped host channel with a mesh opening", async () => {
    let proofCalls = 0
    const fetchSpy = vi.fn(async () => issued("after-reconnect"))
    const ice = await load(fetchSpy, async () => {
      proofCalls++
      if (proofCalls === 1)
        throw new Error("TrUAPI host connection interrupted")
      return { body: BODY }
    })

    expect(
      (await ice.fetchIceServers()).every((server) =>
        String(server.urls).startsWith("stun:"),
      ),
    ).toBe(true)

    const retry = ice.retryIceServersAfterHostReconnect()
    const meshOpen = ice.fetchIceServers()
    expect(hostRetryRecordMock).toHaveBeenCalledOnce()
    expect(hostRetryRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      operation: "turn.ice-servers",
      attempt: 2,
      reason: "turn",
      error: "host-reconnect",
    }))

    await expect(meshOpen).resolves.toContainEqual(
      expect.objectContaining({ username: "after-reconnect" }),
    )
    await expect(retry).resolves.toContainEqual(
      expect.objectContaining({ username: "after-reconnect" }),
    )
    expect(turnProofMock).toHaveBeenCalledTimes(2)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("gives TURN from a host reconnect retry to the already-open STUN-only mesh", async () => {
    let proofCalls = 0
    const fetchSpy = vi.fn(async () => issued("after-reconnect"))
    const ice = await load(fetchSpy, async () => {
      proofCalls++
      if (proofCalls === 1)
        throw new Error("TrUAPI host connection interrupted")
      return { body: BODY }
    })
    const opened = { setIceServers: vi.fn() }

    expect(
      (await ice.fetchIceServers()).every((server) =>
        String(server.urls).startsWith("stun:"),
      ),
    ).toBe(true)
    const stop = ice.observeTurnServers((servers) => opened.setIceServers(servers))

    await ice.retryIceServersAfterHostReconnect()

    expect(opened.setIceServers).toHaveBeenCalledOnce()
    expect(opened.setIceServers).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ username: "after-reconnect" }),
      ]),
    )
    stop()
  })

  describe("when the app comes back to the foreground", () => {
    // each test loads its own ice module; take its foreground listener and any waiting retry down with it
    afterEach(async () => {
      vi.useRealTimers()
      const ice = await import("./ice")
      ice.resetForegroundRetryForTests()
    })

    const INTERRUPTED = "could not list peopl.paseo keys: The host channel was interrupted (the app likely resumed)"

    // the real publisher, driven by a fake page lifecycle, so a hide with no
    // show is genuinely just a hide
    async function lifecycle() {
      const foreground = await import("../telemetry/foreground")
      let hidden = false
      let onHidden = () => {}
      let onShown = () => {}
      let now = 0
      foreground.watchForegroundReturns({
        pageHidden: () => hidden,
        watchPageHidden: (hide, show) => {
          onHidden = hide
          onShown = show
          return () => {}
        },
        setInterval: () => 0,
        clearInterval: () => {},
        emit: () => {},
        logInterval: () => {},
        logOpen: () => {},
        returnSource: () => null,
        wallNow: () => now,
        monoNow: () => now,
      })
      return {
        hide: () => {
          hidden = true
          onHidden()
        },
        show: () => {
          now += 5_000
          hidden = false
          onShown()
        },
      }
    }

    it("fetches TURN again for a STUN-only mesh whose first fetch hit an interrupted host call", async () => {
      let proofCalls = 0
      const fetchSpy = vi.fn(async () => issued("after-resume"))
      const ice = await load(fetchSpy, async () => {
        proofCalls++
        if (proofCalls === 1) throw new Error(INTERRUPTED)
        return { body: BODY }
      })
      const opened = { setIceServers: vi.fn() }
      const page = await lifecycle()
      ice.retryIceServersOnForegroundReturn()
      expect((await ice.fetchIceServers()).every((server) => String(server.urls).startsWith("stun:"))).toBe(true)
      const stop = ice.observeTurnServers((servers) => opened.setIceServers(servers))

      page.hide()
      page.show()
      await vi.waitFor(() => expect(opened.setIceServers).toHaveBeenCalledOnce())

      expect(opened.setIceServers).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ username: "after-resume" })]),
      )
      expect(hostRetryRecordMock).toHaveBeenCalledOnce()
      expect(hostRetryRecordMock).toHaveBeenCalledWith(expect.objectContaining({
        operation: "turn.ice-servers",
        attempt: 1,
        reason: "turn",
        error: "foreground-return",
      }))
      stop()
    })

    it("does not fetch when valid credentials are in hand", async () => {
      const fetchSpy = vi.fn(async () => issued("held"))
      const ice = await load(fetchSpy)
      const page = await lifecycle()
      ice.retryIceServersOnForegroundReturn()
      const stop = ice.observeTurnServers(() => {})
      await ice.fetchIceServers()
      fetchSpy.mockClear()
      turnProofMock.mockClear()

      page.hide()
      page.show()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(turnProofMock).not.toHaveBeenCalled()
      expect(hostRetryRecordMock).not.toHaveBeenCalled()
      stop()
    })

    it("logs no TURN rerun on a host reconnect with valid credentials in hand", async () => {
      // Given
      const fetchSpy = vi.fn(async () => issued("held"))
      const ice = await load(fetchSpy)
      await ice.fetchIceServers()
      fetchSpy.mockClear()

      // When
      await ice.retryIceServersAfterHostReconnect()

      // Then
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(hostRetryRecordMock).not.toHaveBeenCalled()
    })

    it("logs no TURN rerun on a host reconnect that joins a mesh fetch still in flight", async () => {
      // Given
      let releaseProof: (value: unknown) => void = () => {}
      const fetchSpy = vi.fn(async () => issued("joined"))
      const ice = await load(fetchSpy, () => new Promise((resolve) => (releaseProof = resolve)))
      const mesh = ice.fetchIceServers()
      await new Promise((resolve) => setTimeout(resolve, 0))

      // When
      const reconnect = ice.retryIceServersAfterHostReconnect()
      releaseProof({ body: BODY })
      await Promise.all([mesh, reconnect])

      // Then
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(hostRetryRecordMock).not.toHaveBeenCalled()
    })

    it("waits for an interrupted proof still pending at the return, then fetches once afresh", async () => {
      vi.useFakeTimers()
      let proofCalls = 0
      let interrupt: (error: Error) => void = () => {}
      const fetchSpy = vi.fn(async () => issued("after-race"))
      const ice = await load(fetchSpy, () => {
        proofCalls++
        if (proofCalls === 1) return new Promise((_, reject) => (interrupt = reject))
        return Promise.resolve({ body: BODY })
      })
      const opened = { setIceServers: vi.fn() }
      const stop = ice.observeTurnServers((servers) => opened.setIceServers(servers))
      const page = await lifecycle()
      ice.retryIceServersOnForegroundReturn()
      void ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(1_000)

      page.hide()
      page.show() // the host has not rejected the call yet
      await vi.advanceTimersByTimeAsync(100)
      expect(proofCalls).toBe(1)
      interrupt(new Error(INTERRUPTED))
      await vi.advanceTimersByTimeAsync(100)

      expect(proofCalls).toBe(2)
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(opened.setIceServers).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ username: "after-race" })]),
      )
      stop()
    })

    it("does not fetch when no mesh is open", async () => {
      const fetchSpy = vi.fn(async () => issued("no-mesh"))
      const ice = await load(fetchSpy, async () => {
        throw new Error(INTERRUPTED)
      })
      const page = await lifecycle()
      ice.retryIceServersOnForegroundReturn()
      await ice.fetchIceServers()
      turnProofMock.mockClear()

      page.hide()
      page.show()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(turnProofMock).not.toHaveBeenCalled()
    })

    it("does not fetch for a mesh that already has TURN", async () => {
      const ice = await load(vi.fn(async () => issued("relayed")))
      const page = await lifecycle()
      ice.retryIceServersOnForegroundReturn()
      const stop = ice.observeTurnServers(() => {})
      await ice.fetchIceServers() // credentials in hand, as a relayed mesh has
      turnProofMock.mockClear()

      page.hide()
      page.show()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(turnProofMock).not.toHaveBeenCalled()
      stop()
    })

    it("retries at most once a minute", async () => {
      vi.useFakeTimers()
      const fetchSpy = vi.fn(async () => {
        throw new Error("issuer unreachable")
      })
      const ice = await load(fetchSpy, async () => ({ body: BODY }))
      const stop = ice.observeTurnServers(() => {})
      const page = await lifecycle()
      ice.retryIceServersOnForegroundReturn()

      page.hide()
      page.show()
      await vi.advanceTimersByTimeAsync(20_000)
      page.hide()
      page.show()
      await vi.advanceTimersByTimeAsync(1_000)

      expect(turnProofMock).toHaveBeenCalledTimes(1)
      stop()
    })

    it("does nothing while the page is only hidden", async () => {
      const fetchSpy = vi.fn(async () => issued("hidden-only"))
      const ice = await load(fetchSpy, async () => {
        throw new Error(INTERRUPTED)
      })
      const page = await lifecycle()
      ice.retryIceServersOnForegroundReturn()
      const stop = ice.observeTurnServers(() => {})
      await ice.fetchIceServers()
      turnProofMock.mockClear()

      page.hide()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(turnProofMock).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      stop()
    })
  })
})

describe("the TURN outcome of each fetch (#259)", () => {
  const BODY = { productId: "p", collection: "c", proof: "0x", ringIndex: 0, ringRevision: 0, timestamp: 1 }
  type Outcome = import("./ice").TurnOutcome

  async function load(fetchImpl: () => Promise<unknown>, proof: unknown = BODY) {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    turnProofMock.mockImplementation(async () => (proof === null ? { reason: "not inside a host", code: "no-host" } : typeof proof === "object" && proof !== null && "reason" in proof ? proof : { body: proof }))
    const fetchSpy = vi.fn(fetchImpl)
    vi.stubGlobal("fetch", fetchSpy)
    const ice = await import("./ice")
    const outcomes: Outcome[] = []
    ice.observeTurnOutcome((outcome) => outcomes.push(outcome))
    return { ice, outcomes, fetchSpy }
  }
  const issued = () => ({
    status: 201,
    json: async () => ({ servers: ["turn:relay.example:3478"], username: "u", password: "p", ttl: 1800 }),
  })
  const refused = (status: number, body: string) => () => Promise.resolve({ status, text: async () => body })
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
  const cleanup = () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.doUnmock("@jollity/protocol")
  }

  it("says issued with the seconds left, then cached with what is left of them", async () => {
    const { ice, outcomes } = await load(async () => issued())
    await ice.fetchIceServers()
    await settled()
    await ice.fetchIceServers()
    await settled()
    expect(outcomes).toEqual([
      { received: "true", ttlLeftS: 1800 },
      { received: "cached", ttlLeftS: 1800, source: "cache-hit" },
    ])
    cleanup()
  })

  it("names the stage, the HTTP status and the server's reason for a refusal, and still falls back to STUN", async () => {
    const { ice, outcomes } = await load(refused(400, JSON.stringify({ error: "proof rejected: ring revision too old" })))
    const servers = await ice.fetchIceServers()
    await settled()
    expect(servers.every((server) => String(server.urls).startsWith("stun:"))).toBe(true)
    expect(outcomes).toEqual([{ received: "false", stage: "issue", status: 400, reason: "proof rejected: ring revision too old", cause: "bad-request" }])
    // the thrown message, which the health ladder and the log already read, is untouched
    expect(ice.lastIceOutcome()?.issuerErrors[0]).toContain("turn/issue-with-proof 400")
    cleanup()
  })

  it("reads a plain-text reason too, and says so when the server gave none", async () => {
    const plain = await load(refused(409, "upstream unavailable"))
    await plain.ice.fetchIceServers()
    await settled()
    expect(plain.outcomes[0]).toMatchObject({ status: 409, reason: "upstream unavailable" })
    cleanup()
    const silent = await load(() => Promise.resolve({ status: 404 }))
    await silent.ice.fetchIceServers()
    await settled()
    expect(silent.outcomes[0]).toMatchObject({ stage: "issue", status: 404, reason: "no reason given", cause: "no-route" })
    cleanup()
  })

  it("hands on the server's text raw, capped, for the trace to clean", async () => {
    const { ice, outcomes } = await load(refused(401, `bad credential ${"x".repeat(3000)}`))
    await ice.fetchIceServers()
    await settled()
    await settled()
    const outcome = outcomes[0] as { reason: string }
    expect(outcome.reason.startsWith("bad credential xxx")).toBe(true)
    expect(outcome.reason.length).toBe(1000)
  })

  it("does not hold the mesh's STUN-only list for a body that never arrives", async () => {
    const { ice, outcomes } = await load(() => Promise.resolve({ status: 403, text: () => new Promise<string>(() => {}) }))
    const servers = await ice.fetchIceServers() // resolves at once
    expect(servers.length).toBeGreaterThan(0)
    expect(outcomes).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 1_100)) // the bounded read gives up
    expect(outcomes).toEqual([{ received: "false", stage: "issue", status: 403, reason: "no reason given", cause: "proof-rejected" }])
  })

  it("names the proof stage when the host could not give one", async () => {
    const { ice, outcomes, fetchSpy } = await load(async () => issued(), null)
    await ice.fetchIceServers()
    await settled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(outcomes).toEqual([{ received: "false", stage: "proof", reason: "no proof: not inside a host", cause: "no-host" }])
    cleanup()
  })

  it("carries the host's own refusal into the proof failure (game 216: 'the host refused' hid host bug #76)", async () => {
    const refusal = { code: "proof-refused", reason: "refused (people-lite): Domain <- V1 <- Unknown: CannotGetCurrentBlock { reason: Rpc(SubscriptionDropped) }" }
    const { ice, outcomes } = await load(async () => issued(), refusal)
    await ice.fetchIceServers()
    await settled()
    expect(outcomes).toEqual([{ received: "false", stage: "proof-chain", reason: `no proof: ${refusal.reason}`, cause: "proof-refused" }])
    // the failure event caps the reason at 120 characters: the host's words must survive that
    expect(cleanReason((outcomes[0] as { reason: string }).reason)).toContain("CannotGetCurrentBlock { reason: Rpc(SubscriptionDropped) }")
    cleanup()
  })

  it("keeps a host link interruption at the proof stage, so it is no chain evidence", async () => {
    const refusal = { code: "proof-refused", reason: "refused (people-lite): The host channel was interrupted (the app likely resumed). <- TrUAPI host connection interrupted" }
    const { ice, outcomes } = await load(async () => issued(), refusal)
    await ice.fetchIceServers()
    await settled()
    expect(outcomes).toEqual([{ received: "false", stage: "proof", reason: `no proof: ${refusal.reason}`, cause: "proof-refused" }])
    expect(ice.lastTurnChainHealthOutcome()).toBeNull()
    cleanup()
  })

  it("says the same to every caller that shared one fetch, and fetches once", async () => {
    const { ice, outcomes, fetchSpy } = await load(refused(400, JSON.stringify({ error: "nope" })))
    await Promise.all([ice.fetchIceServers(), ice.fetchIceServers()])
    await settled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(outcomes).toHaveLength(2)
    expect(outcomes[1]).toEqual(outcomes[0])
    cleanup()
  })

  it("names a missing issuer as the config stage", async () => {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    vi.doMock("@jollity/protocol", async (original) => ({ ...(await original<typeof import("@jollity/protocol")>()), deviceUniquenessBackendUrl: () => "" }))
    const ice = await import("./ice")
    const outcomes: Outcome[] = []
    ice.observeTurnOutcome((outcome) => outcomes.push(outcome))
    await ice.fetchIceServers()
    await settled()
    expect(outcomes).toEqual([{ received: "false", stage: "config", reason: "no TURN issuer configured" }])
    cleanup()
  })
})

describe("TURN stays reliable through a clock, a timeout and a refusal (#225)", () => {
  const BODY = { productId: "p", collection: "c", proof: "0x", ringIndex: 0, ringRevision: 0, timestamp: 1 }
  const PHONE_FAST_MS = 75_000
  type Outcome = import("./ice").TurnOutcome
  const T0 = Date.now()
  let randomSpy: ReturnType<typeof vi.spyOn> | undefined
  /** the issuer's clock: the phone's runs PHONE_FAST_MS ahead of it */
  const serverMs = () => Date.now() - PHONE_FAST_MS
  const dateHeader = () => ({ get: (name: string) => (name.toLowerCase() === "date" ? new Date(serverMs()).toUTCString() : null) })
  const issued = (extra: object = {}) => ({
    status: 201,
    headers: dateHeader(),
    json: async () => ({ servers: ["turn:relay.example:3478"], username: "u", password: "p", ttl: 1800, ...extra }),
  })
  const refusal = (status: number, text: string) => ({ status, headers: dateHeader(), text: async () => JSON.stringify({ error: text }) })
  const WINDOW = "timestamp outside the accepted window"
  /** the backend's rule: a proof stamped more than 60 s from server time is a 400 */
  const strictIssuer = (log: number[] = []) => async (_url: unknown, init: { body: string }) => {
    const stamp = (JSON.parse(init.body) as { timestamp: number }).timestamp
    log.push(stamp - serverMs() / 1000) // how far ahead of the issuer's clock the stamp was
    return Math.abs(stamp - serverMs() / 1000) > 60 ? refusal(400, WINDOW) : issued()
  }
  const stampedBody = async (_id: string, stamp?: number) => ({ body: { ...BODY, timestamp: stamp ?? Math.floor(Date.now() / 1000) } })

  async function load(fetchImpl: (url: unknown, init: { body: string }) => Promise<unknown>, proof: (id: string, stamp?: number) => Promise<unknown> = stampedBody) {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(T0 + PHONE_FAST_MS) // the phone is 75 s fast
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5) // no jitter
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    const proofSpy = vi.fn(proof)
    turnProofMock.mockImplementation(proofSpy)
    const fetchSpy = vi.fn(fetchImpl)
    vi.stubGlobal("fetch", fetchSpy)
    const ice = await import("./ice")
    const clock = await import("../chain-clock")
    const outcomes: Outcome[] = []
    const healthOutcomes: Outcome[] = []
    ice.observeTurnOutcome((outcome) => outcomes.push(outcome))
    ice.observeTurnChainHealthOutcome((outcome) => healthOutcomes.push(outcome))
    return { ice, clock, outcomes, healthOutcomes, fetchSpy, proofSpy }
  }
  const settle = () => vi.advanceTimersByTimeAsync(1_500)
  const relays = (servers: RTCIceServer[]) => servers.filter((server) => !String(server.urls).startsWith("stun:"))
  afterEach(() => {
    vi.useRealTimers()
    randomSpy?.mockRestore()
    vi.doUnmock("../device-clock")
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  describe("a phone 75 s fast", () => {
    it("still gets credentials when the chain clock is known, stamped with the corrected time", async () => {
      const stamps: number[] = []
      const { ice, clock, fetchSpy } = await load(strictIssuer(stamps))
      clock.setChainOffset(-75)
      const servers = await ice.fetchIceServers()
      expect(relays(servers)).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(Math.abs(stamps[0])).toBeLessThan(2)
    })

    describe("with no readable Date header and the game clock on the device (peer offset 0, #1375)", () => {
      const noHeader = { get: () => null }
      /** the strict issuer, its Date header unreadable (cross-origin) */
      const headerlessIssuer = (log: number[]) => async (url: unknown, init: { body: string }) => {
        const answer = (await strictIssuer(log)(url, init)) as object
        return { ...answer, headers: noHeader }
      }
      async function onDeviceClock(stamps: number[]) {
        const loaded = await load(headerlessIssuer(stamps))
        const { deviceNowMs } = await import("../device-clock")
        // what the doorway publishes since #1375: offset 0, the game clock is the device clock
        loaded.clock.setChainOffset(0)
        loaded.clock.setChainNow(() => deviceNowMs())
        return loaded
      }

      it("stamps from the chain gap, so the issuer takes the first proof (#1397)", async () => {
        const stamps: number[] = []
        const { ice, clock, fetchSpy } = await onDeviceClock(stamps)
        clock.setChainGapMs(PHONE_FAST_MS) // device minus block: the phone is 75 s ahead of the chain
        const servers = await ice.fetchIceServers()
        expect(relays(servers)).toHaveLength(1)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        expect(Math.abs(stamps[0])).toBeLessThan(2)
      })

      it("without a chain gap yet, stamps on the game clock as before", async () => {
        const stamps: number[] = []
        const { ice } = await onDeviceClock(stamps)
        const run = ice.fetchIceServers()
        await vi.advanceTimersByTimeAsync(20_000)
        expect(relays(await run)).toEqual([])
        expect(stamps).toHaveLength(3)
        for (const stamp of stamps) expect(stamp).toBeGreaterThan(70) // the device clock, 75 s ahead
      })
    })

    it("a phone with the right clock and a gap minutes too large retries once on the game clock", async () => {
      const stamps: number[] = []
      // this phone's clock is right: the issuer's time is its own, and no Date header is readable
      const { ice, clock, fetchSpy } = await load(async (_url, init) => {
        const stamp = (JSON.parse(init.body) as { timestamp: number }).timestamp
        stamps.push(stamp - Date.now() / 1000)
        const answer = Math.abs(stamp - Date.now() / 1000) > 60 ? refusal(400, WINDOW) : issued()
        return { ...answer, headers: { get: () => null } }
      })
      const { deviceNowMs } = await import("../device-clock")
      clock.setChainOffset(0)
      clock.setChainNow(() => deviceNowMs())
      clock.setChainGapMs(240_000) // a lagging block view: the gap is 4 minutes, the phone is right
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(5_000) // the one backoff
      expect(relays(await run)).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(stamps[0]).toBeLessThan(-200)
      expect(Math.abs(stamps[1])).toBeLessThan(2)
    })

    it("a known chain gap does not override the issuer's Date header", async () => {
      const stamps: number[] = []
      const { ice, clock, fetchSpy } = await load(strictIssuer(stamps))
      clock.setChainOffset(0)
      clock.setChainGapMs(PHONE_FAST_MS + 120_000) // a wrong gap: alone it would stamp 120 s behind
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(relays(await run)).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(stamps[0]).toBeLessThan(-60)
      expect(Math.abs(stamps[1])).toBeLessThan(2) // the 400's Date header wins over the gap
    })

    it("without the chain clock, restamps from the 400's Date header and retries once", async () => {
      const stamps: number[] = []
      const { ice, fetchSpy, proofSpy } = await load(strictIssuer(stamps))
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(5_000) // the one backoff
      const servers = await run
      expect(relays(servers)).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(proofSpy).toHaveBeenCalledTimes(2) // the proof covers the stamp, so a new stamp is a new proof
      expect(stamps[0]).toBeGreaterThan(60)
      expect(Math.abs(stamps[1])).toBeLessThan(2)
    })

    it("a timestamp 400 that keeps coming ends after the ordinary tries, and is named", async () => {
      const { ice, outcomes, fetchSpy } = await load(async () => refusal(400, WINDOW))
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(relays(await run)).toEqual([])
      await settle()
      expect(fetchSpy).toHaveBeenCalledTimes(3)
      expect(outcomes).toEqual([{ received: "false", stage: "issue", status: 400, reason: WINDOW, cause: "timestamp-window" }])
    })

    it("learns the issuer's clock from ANY answer, so the next fetch is stamped right", async () => {
      const stamps: number[] = []
      const { ice, fetchSpy } = await load(async (_url, init) => {
        stamps.push((JSON.parse(init.body) as { timestamp: number }).timestamp - serverMs() / 1000)
        return refusal(502, "bad gateway")
      })
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(20_000)
      await run
      expect(fetchSpy).toHaveBeenCalledTimes(3)
      expect(stamps[0]).toBeGreaterThan(70) // the first stamp had nothing to go on: 75 s ahead of the issuer
      await vi.advanceTimersByTimeAsync(35_000) // the old proof is now too old to reuse
      const next = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(20_000)
      await next
      expect(Math.abs(stamps[3])).toBeLessThan(2) // the first post of the second fetch
    })

    it("stamps on the chain's clock, so a device clock that lost time in a visible freeze is not behind (#331)", async () => {
      const stamps: number[] = []
      const { ice, clock } = await load(async (_url, init) => {
        stamps.push((JSON.parse(init.body) as { timestamp: number }).timestamp - serverMs() / 1000)
        return refusal(502, "bad gateway")
      })
      // the doorway's chain clock: here the true time, which the issuer keeps
      clock.setChainNow(() => serverMs())
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(20_000)
      await run
      // a visible freeze: the wall moved 90 s and performance.now() did not,
      // so the step-free device clock took it for a step and is 90 s behind
      vi.setSystemTime(Date.now() + 90_000)
      await vi.advanceTimersByTimeAsync(35_000)
      const next = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(20_000)
      await next
      expect(Math.abs(stamps[3])).toBeLessThan(2) // the first post of the second fetch
    })
  })

  describe("a proof that times out", () => {
    it("tries a stuck host once more, and no more", async () => {
      // Given
      const { ice, outcomes, healthOutcomes, proofSpy, fetchSpy } = await load(
        async () => issued(),
        () => new Promise(() => {}),
      )

      // When
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(8_000)
      const servers = await run
      await vi.advanceTimersByTimeAsync(60_000)

      // Then
      expect(relays(servers)).toEqual([])
      expect(proofSpy).toHaveBeenCalledTimes(2)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(outcomes).toEqual([expect.objectContaining({ received: "false", cause: "timeout" })])
      expect(healthOutcomes).toEqual([expect.objectContaining({ received: "false", stage: "proof", cause: "timeout" })])
    })

    it("hands a mesh that opened on STUN the pass a second proof brings", async () => {
      // Given
      let proofs = 0
      const { ice, proofSpy } = await load(
        async () => issued(),
        (id, stamp) => (++proofs === 1 ? new Promise(() => {}) : new Promise((resolve) => setTimeout(() => resolve(stampedBody(id, stamp)), 3_000))),
      )

      // When
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(8_000)
      const opened = await run
      const late = ice.lateIceServers()
      await vi.advanceTimersByTimeAsync(2_000)

      // Then
      expect(relays(opened)).toEqual([])
      expect(relays((await late)!)).toHaveLength(1)
      expect(proofSpy).toHaveBeenCalledTimes(2)
    })

    it("counts issuer tries apart from the proof retry", async () => {
      // Given
      let posts = 0
      let proofs = 0
      const { ice, fetchSpy } = await load(
        async () => (++posts <= 2 ? refusal(503, "no ring roots yet") : issued()),
        (id, stamp) => (++proofs === 1 ? new Promise(() => {}) : stampedBody(id, stamp)),
      )

      // When
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(8_000)
      await run
      const late = ice.lateIceServers()
      await vi.advanceTimersByTimeAsync(10_000)

      // Then
      expect(fetchSpy).toHaveBeenCalledTimes(3)
      expect(relays((await late)!)).toHaveLength(1)
    })

    it("does not ask again after a proof the host refused", async () => {
      // Given
      const { ice, proofSpy } = await load(
        async () => issued(),
        async () => ({ reason: "refused (people-lite): Denied", code: "proof-refused" }),
      )

      // When
      await ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(60_000)

      // Then
      expect(proofSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe("a proof refused because the host chain was lost (#486)", () => {
    const CHAIN_LOST = "Domain <- V1 <- Unknown: CannotGetCurrentBlock { reason: Rpc(SubscriptionDropped) }"

    it("does not loop against the stuck host", async () => {
      const { ice, outcomes, proofSpy, fetchSpy } = await load(
        async () => issued(),
        async () => ({ reason: CHAIN_LOST, code: "proof-refused" }),
      )

      expect(relays(await ice.fetchIceServers())).toEqual([])
      await Promise.resolve()
      expect(outcomes).toEqual([
        {
          received: "false",
          stage: "proof-chain",
          reason: `no proof: ${CHAIN_LOST}`,
          cause: "proof-refused",
        },
      ])

      await vi.advanceTimersByTimeAsync(60_000)
      expect(proofSpy).toHaveBeenCalledTimes(1)
      expect(fetchSpy).not.toHaveBeenCalled()
      await expect(ice.lateIceServers()).resolves.toBeNull()
    })

    it("tries again only when the network changes", async () => {
      let proofCalls = 0
      const { ice, outcomes, proofSpy, fetchSpy } = await load(
        async () => issued(),
        async (id, stamp) =>
          ++proofCalls === 1 ? { reason: CHAIN_LOST, code: "proof-refused" } : stampedBody(id, stamp),
      )
      expect(relays(await ice.fetchIceServers())).toEqual([])
      await Promise.resolve()

      expect(relays(await ice.retryIceServers())).toEqual([])
      expect(relays((await ice.lateIceServers())!)).toHaveLength(1)
      expect(proofSpy).toHaveBeenCalledTimes(2)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(outcomes).toEqual([
        {
          received: "false",
          stage: "proof-chain",
          reason: `no proof: ${CHAIN_LOST}`,
          cause: "proof-refused",
        },
        { received: "true", ttlLeftS: 1800, source: "network-change" },
      ])
    })

    it("does not replay an old outcome into a later route mount", async () => {
      const { ice } = await load(async () => issued(), async () => ({ reason: CHAIN_LOST, code: "proof-refused" }))
      await ice.fetchIceServers()
      expect(ice.lastTurnChainHealthOutcome(ice.TURN_OUTCOME_REPLAY_MAX_MS)).not.toBeNull()
      await vi.advanceTimersByTimeAsync(ice.TURN_OUTCOME_REPLAY_MAX_MS + 1)
      expect(ice.lastTurnChainHealthOutcome(ice.TURN_OUTCOME_REPLAY_MAX_MS)).toBeNull()
    })
  })

  describe("a fetch that fails", () => {
    it("retries a network error and a 5xx, then succeeds", async () => {
      let calls = 0
      const { ice } = await load(async () => {
        calls += 1
        if (calls === 1) throw new Error("network down")
        return calls === 2 ? refusal(503, "no ring roots") : issued()
      })
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(relays(await run)).toHaveLength(1)
      expect(calls).toBe(3)
    })

    it("does not retry a refusal that retrying cannot change", async () => {
      for (const status of [403, 429]) {
        const { ice, fetchSpy } = await load(async () => refusal(status, "no"))
        await ice.fetchIceServers()
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      }
    })

    it.each([
      [400, "ring revision unknown", "bad-request"],
      [403, "proof did not verify", "proof-rejected"],
      [429, "redemption limit reached", "redemption-limit"],
      [503, "no ring roots yet", "no-ring-roots"],
    ])("gives a %i its own reason, with the server's text", async (status, text, cause) => {
      const { ice, outcomes } = await load(async () => refusal(status, text))
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(20_000)
      await run
      await settle()
      expect(outcomes).toEqual([{ received: "false", stage: "issue", status, reason: text, cause }])
    })

    it("hands out no relay for a 201 that holds no credentials", async () => {
      // Given
      const { ice } = await load(async () => ({ status: 201, headers: dateHeader(), json: async () => ({ servers: ["turn:relay.example:3478"], ttl: 1800 }) }))

      // When
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(20_000)
      const servers = await run

      // Then
      expect(servers.length).toBeGreaterThan(0)
      expect(relays(servers)).toEqual([])
    })

    it("names a request that never answered as the issue timing out", async () => {
      const { ice, outcomes } = await load(() => new Promise(() => {}))
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(40_000)
      await run
      await settle()
      expect(outcomes).toEqual([expect.objectContaining({ stage: "issue", cause: "timeout" })])
    })
  })

  describe("proving", () => {
    it("is done once for the retries of a fetch that failed after it", async () => {
      let calls = 0
      const bodies: string[] = []
      const { ice, proofSpy } = await load(async (_url, init) => {
        bodies.push(init.body)
        return ++calls < 3 ? refusal(503, "no ring roots") : issued()
      })
      const run = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(relays(await run)).toHaveLength(1)
      expect(calls).toBe(3)
      expect(proofSpy).toHaveBeenCalledTimes(1)
      expect(new Set(bodies).size).toBe(1)
    })

    it("reports a throw before the host is asked as proof-failed, not a server error", async () => {
      // Given
      const { ice, outcomes, fetchSpy } = await load(
        async () => issued(),
        async () => {
          throw new Error("no product account")
        },
      )

      // When
      const servers = await ice.fetchIceServers()
      await Promise.resolve()

      // Then
      expect(relays(servers)).toEqual([])
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(outcomes).toEqual([expect.objectContaining({ received: "false", stage: "proof", cause: "proof-failed" })])
    })
  })

  describe("the first start", () => {
    it("waits about 8 s at most, goes STUN only, and the fetch carries on and is cached", async () => {
      let calls = 0
      const { ice, outcomes, fetchSpy } = await load(
        () => new Promise((resolve) => setTimeout(() => resolve(++calls < 3 ? refusal(503, "no ring roots") : issued()), 4_000)),
      )
      let servers: RTCIceServer[] | undefined
      void ice.fetchIceServers().then((list) => (servers = list))
      await vi.advanceTimersByTimeAsync(7_900)
      expect(servers).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(relays(servers!)).toEqual([])
      await settle()
      expect(outcomes).toEqual([expect.objectContaining({ received: "false", cause: "timeout" })])
      await vi.advanceTimersByTimeAsync(20_000) // the fetch finishes in the background
      expect(relays(await ice.fetchIceServers())).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(3) // no new fetch for the next mesh
    })

    it("reports a warm-up that succeeds after its eight-second handover budget", async () => {
      let calls = 0
      const { ice, outcomes } = await load(
        () => new Promise((resolve) => setTimeout(() => resolve(++calls < 3 ? refusal(503, "no ring roots") : issued()), 4_000)),
      )
      const warm = ice.warmIceServers()
      await vi.advanceTimersByTimeAsync(8_100)
      await warm
      await settle()
      expect(outcomes).toEqual([
        expect.objectContaining({ received: "false", source: "warmup", cause: "timeout" }),
      ])

      await vi.advanceTimersByTimeAsync(20_000)
      await settle()
      expect(outcomes).toEqual([
        expect.objectContaining({ received: "false", source: "warmup", cause: "timeout" }),
        { received: "true", ttlLeftS: 1800, source: "warmup" },
      ])
    })

    it("does not double-report an outlived warm-up joined by a network change", async () => {
      let calls = 0
      const { ice, outcomes } = await load(
        () => new Promise((resolve) => setTimeout(() => resolve(++calls < 3 ? refusal(503, "no ring roots") : issued()), 4_000)),
      )
      const warm = ice.warmIceServers()
      await vi.advanceTimersByTimeAsync(8_100)
      await warm
      expect(relays(await ice.retryIceServers())).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(20_000)
      await settle()
      expect(outcomes).toEqual([
        expect.objectContaining({ received: "false", source: "warmup", cause: "timeout" }),
        { received: "true", ttlLeftS: 1800, source: "warmup" },
      ])
    })
  })

  describe("a mesh that started on STUN only", () => {
    it("is handed the fetch that outlived the first start, with no new fetch", async () => {
      let calls = 0
      const { ice, fetchSpy } = await load(
        () => new Promise((resolve) => setTimeout(() => resolve(++calls < 3 ? refusal(503, "no ring roots") : issued()), 4_000)),
      )
      const first = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(8_100)
      expect(relays(await first)).toEqual([]) // the mesh opens on STUN only
      let late: RTCIceServer[] | null | undefined
      void ice.lateIceServers().then((servers) => (late = servers))
      await vi.advanceTimersByTimeAsync(20_000) // the fetch finishes in the background
      expect(relays(late!)).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it("lets a network change join the outlived fetch without losing its completed result", async () => {
      let calls = 0
      const { ice, outcomes, fetchSpy } = await load(
        () => new Promise((resolve) => setTimeout(() => resolve(++calls < 3 ? refusal(503, "no ring roots") : issued()), 4_000)),
      )
      const first = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(8_100)
      expect(relays(await first)).toEqual([])

      expect(relays(await ice.retryIceServers())).toEqual([])
      await vi.advanceTimersByTimeAsync(20_000)
      await settle()

      expect(fetchSpy).toHaveBeenCalledTimes(3)
      expect(outcomes).toEqual([
        expect.objectContaining({ received: "false", cause: "timeout" }),
        { received: "true", ttlLeftS: 1800, source: "network-change" },
      ])
      expect(relays((await ice.lateIceServers())!)).toHaveLength(1)
    })

    it("is handed nothing when no fetch outlived the first start and nothing is cached", async () => {
      const { ice } = await load(async () => refusal(403, "not a person"))
      await ice.fetchIceServers()
      expect(await ice.lateIceServers()).toBeNull()
    })

    it("does not hand out credentials from a settled fetch after they expired", async () => {
      let calls = 0
      const { ice } = await load(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve(++calls < 3 ? refusal(503, "no ring roots") : issued({ ttl: 6 })),
              4_000,
            ),
          ),
      )
      const first = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(8_100)
      expect(relays(await first)).toEqual([])
      await vi.advanceTimersByTimeAsync(8_000)
      expect(await ice.lateIceServers()).toBeNull()
    })
  })

  describe("credentials already in hand", () => {
    const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * 60_000)

    it("are reused while they have 10 minutes or more left, with no fetch", async () => {
      const { ice, fetchSpy } = await load(async () => issued())
      await ice.fetchIceServers()
      await minutes(15) // 15 minutes of the 30 left
      expect(relays(await ice.fetchIceServers())).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it("are kept when the refresh fails: never an empty list while they are still valid", async () => {
      let fail = false
      const { ice, outcomes } = await load(async () => (fail ? refusal(403, "no") : issued()))
      await ice.fetchIceServers()
      await minutes(25) // 5 minutes left: refresh is due
      fail = true
      const servers = await ice.fetchIceServers()
      await minutes(1)
      expect(relays(servers)).toHaveLength(1)
      expect(outcomes.at(-1)).toMatchObject({ received: "cached" })
      expect(relays(await ice.fetchIceServers())).toHaveLength(1) // still there on the next mesh
    })

    it("are not refreshed again for a minute after a refresh failed", async () => {
      let fail = false
      const { ice, fetchSpy } = await load(async () => (fail ? refusal(403, "no") : issued()))
      await ice.fetchIceServers()
      await minutes(25)
      fail = true
      await ice.fetchIceServers() // starts a refresh, which fails
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      await ice.fetchIceServers() // the next turn's mesh: no storm
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(60_000)
      await ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it("refresh early, in the background, once under 10 minutes are left", async () => {
      let calls = 0
      const { ice } = await load(async () => {
        calls += 1
        return issued({ username: `u${calls}` })
      })
      await ice.fetchIceServers()
      await minutes(25)
      const servers = await ice.fetchIceServers() // answers at once from the old ones
      expect((relays(servers)[0] as RTCIceServer).username).toBe("u1")
      await minutes(1)
      expect(calls).toBe(2)
      await minutes(10) // well inside the new credentials' life
      expect((relays(await ice.fetchIceServers())[0] as RTCIceServer).username).toBe("u2")
      expect(calls).toBe(2)
    })

    it("are renewed at the mesh open when they would not outlive a game of two rounds of six seats", () => {
      // Given
      const game = CONNECTION_STAGE_DURATION + 2 * 6 * HOST_FULL_CYCLE + ROUND_GAP

      // Then
      expect(meshOpenMinS({ rounds: 2, maxGroupSize: 6 })).toBeGreaterThan(game)
      expect(meshOpenMinS({ rounds: 2, maxGroupSize: 6 })).toBeGreaterThanOrEqual(240)
    })

    it("need to outlive the game the chain scheduled, whatever its rounds and seats (#1348)", () => {
      // Given
      const game = CONNECTION_STAGE_DURATION + 3 * 4 * HOST_FULL_CYCLE + 2 * ROUND_GAP

      // Then
      expect(meshOpenMinS({ rounds: 3, maxGroupSize: 4 })).toBeGreaterThan(game)
      expect(meshOpenMinS({ rounds: 4, maxGroupSize: 8 })).toBeGreaterThan(meshOpenMinS({ rounds: 2, maxGroupSize: 6 }))
    })

    it("are renewed at the mesh open for the longer game the session named", async () => {
      // Given: five minutes left outlive two rounds of six, not four rounds of eight
      const meshOpenAfter25Minutes = async (shape?: { rounds: number; maxGroupSize: number }) => {
        let calls = 0
        const { ice } = await load(async () => {
          calls += 1
          return issued({ username: `u${calls}` })
        })
        ice.setTurnGameShape(shape)
        await ice.fetchIceServers()
        await minutes(25)
        const servers = await ice.fetchIceServers()
        await settle()
        return (relays(servers)[0] as RTCIceServer).username
      }

      // Then
      expect(5 * 60 + 5).toBeGreaterThan(meshOpenMinS({ rounds: 2, maxGroupSize: 6 }))
      expect(5 * 60 + 5).toBeLessThan(meshOpenMinS({ rounds: 4, maxGroupSize: 8 }))
      expect(await meshOpenAfter25Minutes()).toBe("u1")
      expect(await meshOpenAfter25Minutes({ rounds: 4, maxGroupSize: 8 })).toBe("u2")
    })

    it("are renewed before the links are built when the mesh opens with under 4 minutes left", async () => {
      // Given
      let calls = 0
      const { ice, outcomes } = await load(async () => {
        calls += 1
        return issued({ username: `u${calls}` })
      })
      await ice.fetchIceServers()
      await minutes(27)

      // When
      const servers = await ice.fetchIceServers()
      await settle()

      // Then
      expect((relays(servers)[0] as RTCIceServer).username).toBe("u2")
      expect(calls).toBe(2)
      expect(outcomes.at(-1)).toEqual({ received: "true", ttlLeftS: 1800 })
    })

    it("keep the old ones when the renewal at the mesh open fails", async () => {
      // Given
      let fail = false
      const { ice, outcomes, fetchSpy } = await load(async () => (fail ? refusal(403, "no") : issued()))
      await ice.fetchIceServers()
      await minutes(27)
      fail = true

      // When
      const servers = await ice.fetchIceServers()
      await settle()

      // Then
      expect(relays(servers)).toHaveLength(1)
      expect(outcomes.at(-1)).toMatchObject({ received: "cached" })

      // When
      await ice.fetchIceServers()
      await settle()

      // Then
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it("keep the old ones when the renewal at the mesh open outlives the first start", async () => {
      // Given
      let hang = false
      const { ice, outcomes } = await load(() => (hang ? new Promise(() => {}) : Promise.resolve(issued())))
      await ice.fetchIceServers()
      await minutes(27)
      hang = true

      // When
      const opening = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(8_000)

      // Then
      expect(relays(await opening)).toHaveLength(1)
      await settle()
      expect(outcomes.at(-1)).toMatchObject({ received: "cached" })
    })

    it("are not handed to a mesh past their expiry when the renewal at the open hangs", async () => {
      // Given
      let hang = false
      const { ice, outcomes } = await load(() => (hang ? new Promise(() => {}) : Promise.resolve(issued())))
      await ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(1800_000 - 10_000)
      hang = true

      // When
      const opening = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(8_000)

      // Then
      expect(relays(await opening)).toEqual([])
      await settle()
      expect(outcomes.at(-1)).toMatchObject({ received: "false", cause: "timeout" })
    })

    it("hand the renewal to a mesh that opened past their expiry once it lands", async () => {
      // Given
      let renewing = 0
      const { ice } = await load(() => {
        if (renewing === 0) return Promise.resolve(issued())
        const answer = ++renewing === 2 ? refusal(503, "no ring roots") : issued({ username: "late" })
        return new Promise((resolve) => setTimeout(() => resolve(answer), 4_000))
      })
      await ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(1800_000 - 10_000)
      renewing = 1

      // When
      const opening = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(8_000)

      // Then
      expect(relays(await opening)).toEqual([])

      // When
      const late = ice.lateIceServers()
      await vi.advanceTimersByTimeAsync(2_000)

      // Then
      expect((relays((await late)!)[0] as RTCIceServer).username).toBe("late")
    })

    it("are not handed to a mesh past their expiry when the renewal at the open is refused", async () => {
      // Given
      let fail = false
      const { ice, outcomes } = await load(() =>
        fail ? new Promise((resolve) => setTimeout(() => resolve(refusal(403, "no")), 4_000)) : Promise.resolve(issued()),
      )
      await ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(1800_000 - 8_000)
      fail = true

      // When
      const opening = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(4_000)

      // Then
      expect(relays(await opening)).toEqual([])
      await settle()
      expect(outcomes.at(-1)).toMatchObject({ received: "false", cause: "proof-rejected" })
    })

    it("tell the restart card when the renewal at the mesh open loses the host chain", async () => {
      // Given
      const CHAIN_LOST = "Domain <- V1 <- Unknown: CannotGetCurrentBlock { reason: Rpc(SubscriptionDropped) }"
      let proofCalls = 0
      const { ice, outcomes, healthOutcomes } = await load(
        async () => issued(),
        async (id, stamp) => (++proofCalls === 1 ? stampedBody(id, stamp) : { reason: CHAIN_LOST, code: "proof-refused" }),
      )
      await ice.fetchIceServers()
      await minutes(27)

      // When
      const servers = await ice.fetchIceServers()
      await settle()

      // Then
      expect(relays(servers)).toHaveLength(1)
      expect(outcomes.at(-1)).toMatchObject({ received: "cached" })
      expect(ice.lastTurnChainHealthOutcome()).toMatchObject({ stage: "proof-chain", cause: "proof-refused" })
      expect(healthOutcomes.filter((outcome) => outcome.received === "false")).toEqual([
        expect.objectContaining({ received: "false", stage: "proof-chain", reason: `no proof: ${CHAIN_LOST}`, cause: "proof-refused" }),
      ])
    })

    it("keep a proof the host cannot give off the restart card", async () => {
      // Given
      let proofCalls = 0
      const { ice } = await load(
        async () => issued(),
        async (id, stamp) => (++proofCalls === 1 ? stampedBody(id, stamp) : { reason: "no dim2 key for either personhood ring", code: "no-ring-key" }),
      )
      const initial = await ice.fetchIceServers()
      expect(relays(initial)).toHaveLength(1)
      expect(proofCalls).toBe(1)
      await minutes(27)

      // When
      const servers = await ice.fetchIceServers()
      await settle()

      // Then
      expect(relays(servers)).toHaveLength(1)
      expect(proofCalls).toBe(2)
      expect(ice.lastTurnChainHealthOutcome()).toEqual({ received: "true", ttlLeftS: 1800 })
    })

    it("tell the restart card when the renewal at the mesh open outlives the wait and then fails", async () => {
      // Given
      let fail = false
      const { ice, outcomes, healthOutcomes } = await load(() =>
        fail ? new Promise((resolve) => setTimeout(() => resolve(refusal(503, "no ring roots")), 4_000)) : Promise.resolve(issued()),
      )
      await ice.fetchIceServers()
      await minutes(27)
      fail = true

      // When
      const opening = ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(8_000)

      // Then
      expect(relays(await opening)).toHaveLength(1)

      // When
      await vi.advanceTimersByTimeAsync(10_000)

      // Then
      expect(outcomes.at(-1)).toMatchObject({ received: "cached" })
      expect(ice.lastTurnChainHealthOutcome()).toMatchObject({ received: "false", stage: "issue", cause: "no-ring-roots" })
      expect(healthOutcomes.filter((outcome) => outcome.received === "false")).toEqual([
        expect.objectContaining({ received: "false", stage: "issue", status: 503, cause: "no-ring-roots" }),
      ])
    })

    it("do not hold a mesh under 4 minutes inside the minute after a failed refresh", async () => {
      // Given
      let fail = false
      const { ice, fetchSpy } = await load(async () => (fail ? refusal(403, "no") : issued()))
      await ice.fetchIceServers()
      await vi.advanceTimersByTimeAsync(26.5 * 60_000)
      fail = true

      // When
      await ice.fetchIceServers(undefined, "warmup")
      await settle() // finish the background refusal before this test's mock is removed

      // Then
      expect(fetchSpy).toHaveBeenCalledTimes(2)

      // When
      let opened = false
      const opening = ice.fetchIceServers().then((servers) => {
        opened = true
        return servers
      })
      await vi.advanceTimersByTimeAsync(0)

      // Then
      expect(opened).toBe(true)
      expect(relays(await opening)).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it("still refresh a warm-up under 4 minutes in the background", async () => {
      // Given
      let deviceMs = T0 + PHONE_FAST_MS
      vi.doMock("../device-clock", async (original) => ({
        ...(await original<typeof import("../device-clock")>()),
        deviceNowMs: () => deviceMs,
      }))
      let calls = 0
      const { ice } = await load(async () => {
        calls += 1
        return issued({ username: `u${calls}` })
      })
      const initial = await ice.fetchIceServers()
      expect((relays(initial)[0] as RTCIceServer).username).toBe("u1")
      expect(calls).toBe(1)
      // Age only the cache clock. Advancing the fake-timer queue can overlap
      // the refresh below and fire its retry clock, inventing a third fetch.
      deviceMs += 27 * 60_000
      vi.useRealTimers()
      const refreshed = new Promise<RTCIceServer[]>((resolve) => {
        const stop = ice.observeTurnServers((servers) => {
          stop()
          resolve(servers)
        })
      })

      // When
      const servers = await ice.fetchIceServers(undefined, "warmup")

      // Then
      expect((relays(servers)[0] as RTCIceServer).username).toBe("u1")
      expect((relays(await refreshed)[0] as RTCIceServer).username).toBe("u2")
      expect(calls).toBe(2)
    })

    it("are let go only once they have expired, and a failed fetch then really is STUN only", async () => {
      let fail = false
      const { ice } = await load(async () => (fail ? refusal(403, "no") : issued()))
      await ice.fetchIceServers()
      await minutes(31)
      fail = true
      expect(relays(await ice.fetchIceServers())).toEqual([])
    })
  })
})
