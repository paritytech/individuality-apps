// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => ({
  inside: false,
  storage: null as null | {
    readString: ReturnType<typeof vi.fn>
    writeString: ReturnType<typeof vi.fn>
  },
  requestPermission: vi.fn<(arg: unknown) => Promise<unknown>>(async () => ({ ok: true, value: true })),
  requestDevicePermission: vi.fn<(arg: unknown) => Promise<unknown>>(async () => ({ ok: true, value: true })),
  requestResourceAllocation: vi.fn<(arg: unknown) => Promise<unknown>>(async () => ({ ok: true, value: ["Allocated"] })),
  connectionListeners: new Set<(status: "connecting" | "connected" | "disconnected") => void>(),
}))

vi.mock("@parity/product-sdk-host", () => ({
  isInsideContainerSync: () => host.inside,
  getHostLocalStorage: async () => host.storage, // null falls back to browser localStorage
  requestPermission: (arg: unknown) => host.requestPermission(arg),
  requestDevicePermission: (arg: unknown) => host.requestDevicePermission(arg),
  requestResourceAllocation: (arg: unknown) => host.requestResourceAllocation(arg),
  subscribeConnectionStatus: (listener: (status: "connecting" | "connected" | "disconnected") => void) => {
    host.connectionListeners.add(listener)
    return () => host.connectionListeners.delete(listener)
  },
}))
vi.mock("@jollity/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@jollity/protocol")>()),
  deviceUniquenessBackendUrl: () => "https://issuer.example",
  productAccount: () => "dim2.testnet",
}))
vi.mock("./webrtc/ice", () => ({ fetchIceServers: vi.fn(async () => []) }))
vi.mock("./debug/log-store", () => ({ devLog: () => {} }))

const DSN = "https://key@o1.ingest.de.sentry.io/42"
const FLAG = "jollity.telemetry.remote:dim2.testnet"
const store = new Map<string, string>()

beforeEach(() => {
  host.inside = true
  host.storage = null
  host.requestPermission.mockClear()
  host.requestPermission.mockImplementation(async () => ({ ok: true, value: true }))
  host.requestResourceAllocation.mockReset().mockResolvedValue({ ok: true, value: ["Allocated"] })
  host.connectionListeners.clear()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  store.clear()
})

async function load(dsn: string | undefined = DSN) {
  vi.resetModules()
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", dsn ?? "")
  return import("./permissions")
}

describe("the Remote grant for the game", () => {
  it("never carries Sentry's host, and the flag stays v2", async () => {
    const permissions = await load()
    expect(permissions.REMOTE_DOMAINS).toEqual([
      "turn.cloudflare.com",
      "stun.cloudflare.com",
      "issuer.example",
    ])
    await permissions.markPermissionsGranted()
    expect([...store.keys()]).toEqual(["jollity.permissions.v2:dim2.testnet"])
  })
})

describe("resume recovery boundaries", () => {
  it("retries a consent read once after the host reconnects", async () => {
    host.requestPermission
      .mockResolvedValueOnce({ ok: false, error: new Error("TrUAPI host connection interrupted") })
      .mockResolvedValueOnce({ ok: true, value: true })
    const permissions = await load()

    const pending = permissions.requestPermissionItem("webrtc")
    await vi.waitFor(() => expect(host.connectionListeners.size).toBe(1))
    for (const listener of host.connectionListeners) listener("connected")

    await expect(pending).resolves.toEqual({ ok: true })
    expect(host.requestPermission).toHaveBeenCalledTimes(2)
  })

  it("never retries the statements resource allocation", async () => {
    host.requestResourceAllocation.mockRejectedValue(new Error("TrUAPI host connection interrupted"))
    const permissions = await load()

    await expect(permissions.requestPermissionItem("statements")).resolves.toMatchObject({
      ok: false,
      reason: "host-error",
      step: "allocation",
    })
    expect(host.requestResourceAllocation).toHaveBeenCalledOnce()
    expect(host.connectionListeners.size).toBe(0)
  })
})

describe("the remembered permission pass", () => {
  const grantedCamera = () =>
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [{ kind: "videoinput", label: "Front camera" }]),
      },
      permissions: { query: vi.fn(async () => ({ state: "granted" })) },
    })

  const CAMERA_ANSWER = "jollity.camera.v1:dim2.testnet"
  const refusedCamera = () =>
    vi.stubGlobal("navigator", {
      mediaDevices: { enumerateDevices: vi.fn(async () => [{ kind: "videoinput", label: "" }]) },
      permissions: { query: vi.fn(async () => ({ state: "denied" })) },
    })

  it.each([
    ["off", '"off"'],
    ["on", '"on"'],
  ] as const)("stores the camera answer %s as JSON, the only form the worker can read", async (answer, stored) => {
    // Given
    const permissions = await load()

    // When
    await permissions.markCameraAnswer(answer)

    // Then
    expect(store.get(CAMERA_ANSWER)).toBe(stored)
  })

  it("clears a stored off when the app opens with the pass remembered and the camera granted", async () => {
    // Given
    grantedCamera()
    store.set("jollity.permissions.v2:dim2.testnet", "1")
    store.set(CAMERA_ANSWER, '"off"')
    const permissions = await load()

    // When
    const granted = await permissions.allPermissionsGranted()

    // Then
    expect(granted).toBe(true)
    await vi.waitFor(() => expect(store.get(CAMERA_ANSWER)).toBe('"on"'))
  })

  it("clears a stored off when a player who never finished a pass allowed the camera in Settings", async () => {
    // Given
    grantedCamera()
    store.set(CAMERA_ANSWER, '"off"')
    const permissions = await load()

    // When
    const granted = await permissions.allPermissionsGranted()

    // Then
    expect(granted).toBe(false)
    await vi.waitFor(() => expect(store.get(CAMERA_ANSWER)).toBe('"on"'))
  })

  it("keeps a stored off while the camera stays refused", async () => {
    vi.useFakeTimers()
    try {
      // Given
      refusedCamera()
      store.set("jollity.permissions.v2:dim2.testnet", "1")
      store.set(CAMERA_ANSWER, '"off"')
      const permissions = await load()

      // When
      const check = permissions.allPermissionsGranted()
      await vi.advanceTimersByTimeAsync(1_100)

      // Then
      await expect(check).resolves.toBe(false)
      expect(store.get(CAMERA_ANSWER)).toBe('"off"')
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a stored off on the ambiguous prompt state of Android before any pass", async () => {
    // Given
    vi.stubGlobal("navigator", {
      mediaDevices: { enumerateDevices: vi.fn(async () => []) },
      permissions: { query: vi.fn(async () => ({ state: "prompt" })) },
    })
    store.set(CAMERA_ANSWER, '"off"')
    const permissions = await load()

    // When
    const granted = await permissions.allPermissionsGranted()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Then
    expect(granted).toBe(false)
    expect(store.get(CAMERA_ANSWER)).toBe('"off"')
  })

  it("keeps a stored off on the ambiguous prompt state when the pass is remembered", async () => {
    // Given
    vi.stubGlobal("navigator", {
      mediaDevices: { enumerateDevices: vi.fn(async () => [{ kind: "videoinput", label: "" }]) },
      permissions: { query: vi.fn(async () => ({ state: "prompt" })) },
    })
    store.set("jollity.permissions.v2:dim2.testnet", "1")
    store.set(CAMERA_ANSWER, '"off"')
    const permissions = await load()

    // When
    const granted = await permissions.allPermissionsGranted()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Then
    expect(granted).toBe(true)
    expect(store.get(CAMERA_ANSWER)).toBe('"off"')
  })

  it.each([
    [{ ok: true }, "on"],
    [{ ok: false, reason: "denied" }, "off"],
    [{ ok: false, reason: "blocked" }, "off"],
    [{ ok: false, reason: "timeout" }, undefined],
    [{ ok: false, reason: "host-error" }, undefined],
    [{ ok: false, reason: "no-camera" }, undefined],
    [{ ok: false, reason: "busy" }, undefined],
  ] as const)("takes %o as the camera answer %s", async (result, answer) => {
    // Given
    const permissions = await load()

    // When
    const taken = permissions.cameraAnswerOf(result)

    // Then
    expect(taken).toBe(answer)
  })

  const cameraThatThrows = (failure: Error) =>
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw failure
        }),
      },
      permissions: { query: vi.fn(async () => ({ state: "prompt" })) },
    })

  it.each([
    ["TypeError", new TypeError("mediaDevices")],
    ["SecurityError", new DOMException("insecure context", "SecurityError")],
  ])("stores no camera answer when the webview fails with a %s", async (_name, failure) => {
    // Given
    cameraThatThrows(failure)
    const permissions = await load()

    // When
    const result = await permissions.requestPermissionItem("camera")

    // Then
    expect(result).toMatchObject({ ok: false, reason: "host-error" })
    expect(permissions.cameraAnswerOf(result)).toBeUndefined()
  })

  it("stores no camera answer when the webview has no mediaDevices", async () => {
    // Given
    vi.stubGlobal("navigator", {})
    const permissions = await load()

    // When
    const result = await permissions.requestPermissionItem("camera")

    // Then
    expect(result).toMatchObject({ ok: false, reason: "host-error" })
    expect(permissions.cameraAnswerOf(result)).toBeUndefined()
  })

  it("takes a refusal of the webview as the camera answer off", async () => {
    // Given
    cameraThatThrows(new DOMException("refused", "NotAllowedError"))
    const permissions = await load()

    // When
    const result = await permissions.requestPermissionItem("camera")

    // Then
    expect(result).toEqual({ ok: false, reason: "denied" })
    expect(permissions.cameraAnswerOf(result)).toBe("off")
  })

  it("does not let a hung host-storage read block a player whose camera and host grants prove the prior setup", async () => {
    vi.useFakeTimers()
    try {
      grantedCamera()
      host.storage = {
        readString: vi.fn(() => new Promise<string | null>(() => {})),
        writeString: vi.fn(async () => undefined),
      }
      const permissions = await load()

      const check = permissions.allPermissionsGranted()
      await vi.advanceTimersByTimeAsync(3_100)

      await expect(check).resolves.toBe(true)
      expect(host.requestPermission.mock.calls.map(([arg]) => (arg as { tag: string }).tag)).toEqual([
        "Remote",
        "WebRtc",
        "StatementSubmit",
      ])
      expect(host.requestResourceAllocation).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not bypass first-run host setup when only the camera is already granted", async () => {
    vi.useFakeTimers()
    try {
      grantedCamera()
      host.storage = {
        readString: vi.fn(() => new Promise<string | null>(() => {})),
        writeString: vi.fn(async () => undefined),
      }
      host.requestPermission.mockImplementation(async (arg) => ({
        ok: true,
        value: (arg as { tag: string }).tag !== "WebRtc",
      }))
      const permissions = await load()

      const check = permissions.allPermissionsGranted()
      await vi.advanceTimersByTimeAsync(3_100)

      await expect(check).resolves.toBe(false)
      expect(host.requestPermission.mock.calls.map(([arg]) => (arg as { tag: string }).tag)).toEqual([
        "Remote",
        "WebRtc",
      ])
      expect(host.requestResourceAllocation).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("still gates when the remembered flag is genuinely absent", async () => {
    grantedCamera()
    host.storage = {
      readString: vi.fn(async () => null),
      writeString: vi.fn(async () => undefined),
    }
    const permissions = await load()

    await expect(permissions.allPermissionsGranted()).resolves.toBe(false)
  })

  it("keeps trusting Android's prompt state after a real stored pass", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { enumerateDevices: vi.fn(async () => []) },
      permissions: { query: vi.fn(async () => ({ state: "prompt" })) },
    })
    host.storage = {
      readString: vi.fn(async () => "1"),
      writeString: vi.fn(async () => undefined),
    }
    const permissions = await load()

    await expect(permissions.allPermissionsGranted()).resolves.toBe(true)
  })

  it("does not treat Android's ambiguous prompt state as proof when storage is unavailable", async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal("navigator", {
        mediaDevices: { enumerateDevices: vi.fn(async () => []) },
        permissions: { query: vi.fn(async () => ({ state: "prompt" })) },
      })
      host.storage = {
        readString: vi.fn(() => new Promise<string | null>(() => {})),
        writeString: vi.fn(async () => undefined),
      }
      const permissions = await load()

      const check = permissions.allPermissionsGranted()
      await vi.advanceTimersByTimeAsync(3_100)

      await expect(check).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("the telemetry grant", () => {
  it("asks for the ingest host alone, storing no grant", async () => {
    const permissions = await load()
    await expect(permissions.requestTelemetryGrant()).resolves.toBe(true)
    expect(host.requestPermission).toHaveBeenCalledWith({
      tag: "Remote",
      value: { domains: ["o1.ingest.de.sentry.io"] },
    })
    // a host grant may be one-use: a stored "1" would open the signal on a
    // later open with nothing left to cover the requests
    expect(store.has(FLAG)).toBe(false)
  })

  it("asks for the test DSN's host when the build carries the test DSN alone", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN_TEST", "https://test@o2.ingest.de.sentry.io/43")
    const permissions = await load("")
    await expect(permissions.requestTelemetryGrant()).resolves.toBe(true)
    expect(host.requestPermission).toHaveBeenCalledWith({
      tag: "Remote",
      value: { domains: ["o2.ingest.de.sentry.io"] },
    })
  })

  it.each([
    ["a host error", async () => ({ ok: false, error: "nope" })],
    ["a throw", async () => { throw new Error("bridge gone") }],
  ])("returns false when %s, and does not throw", async (_name, impl) => {
    host.requestPermission.mockImplementation(impl)
    const permissions = await load()
    await expect(permissions.requestTelemetryGrant()).resolves.toBe(false)
    expect(store.has(FLAG)).toBe(false)
  })

  it("stores no refusal: a No is the host's to keep, and the next open asks again", async () => {
    host.requestPermission.mockImplementation(async () => ({ ok: true, value: false }))
    const permissions = await load()
    await expect(permissions.requestTelemetryGrant()).resolves.toBe(false)
    // the bare boolean is also what a failed prompt callback flattens to
    // (truapi permissions.rs): storing it would end telemetry for good
    expect(store.has(FLAG)).toBe(false)
    // a fresh app open asks the host, which answers a persisted Deny silently
    const reopened = await load()
    await reopened.syncTelemetryGrant()
    expect(host.requestPermission).toHaveBeenCalledTimes(2)
  })

  it("ignores a refusal an older build stored, and asks the host", async () => {
    store.set(FLAG, "0")
    const permissions = await load()
    await expect(permissions.requestTelemetryGrant()).resolves.toBe(true)
    expect(host.requestPermission).toHaveBeenCalledTimes(1)
  })

  it("does not store a host error and does not ask twice in one page", async () => {
    host.requestPermission.mockImplementation(async () => ({ ok: false, error: "nope" }))
    const permissions = await load()
    await permissions.requestTelemetryGrant()
    await permissions.requestTelemetryGrant()
    expect(store.has(FLAG)).toBe(false)
    expect(host.requestPermission).toHaveBeenCalledTimes(1)
  })

  it("leaves the signal closed on a timeout", async () => {
    vi.useFakeTimers()
    try {
      host.requestPermission.mockImplementation(() => new Promise(() => {}))
      const permissions = await load()
      const pending = permissions.requestTelemetryGrant()
      await vi.advanceTimersByTimeAsync(121_000)
      await expect(pending).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("asks once when called twice at the same time", async () => {
    const permissions = await load()
    await Promise.all([permissions.requestTelemetryGrant(), permissions.requestTelemetryGrant()])
    expect(host.requestPermission).toHaveBeenCalledTimes(1)
  })

  it("makes no request without a DSN", async () => {
    const permissions = await load("")
    await expect(permissions.requestTelemetryGrant()).resolves.toBe(false)
    await permissions.syncTelemetryGrant()
    expect(host.requestPermission).not.toHaveBeenCalled()
  })

  it("makes no request for a malformed DSN", async () => {
    const permissions = await load("sentry please")
    await expect(permissions.requestTelemetryGrant()).resolves.toBe(false)
    expect(host.requestPermission).not.toHaveBeenCalled()
  })
})

describe("the open-time telemetry authorisation", () => {
  it("asks once per page session: the pass's answer covers the open sync", async () => {
    const permissions = await load()
    await permissions.requestTelemetryGrant()
    await permissions.syncTelemetryGrant()
    expect(host.requestPermission).toHaveBeenCalledTimes(1)
  })

  it("asks again on a later open and stores neither answer", async () => {
    const permissions = await load()
    await permissions.syncTelemetryGrant()
    host.requestPermission.mockImplementation(async () => ({ ok: true, value: false }))
    const reopened = await load()
    await reopened.syncTelemetryGrant()
    expect(host.requestPermission).toHaveBeenCalledTimes(2)
    expect(store.has(FLAG)).toBe(false)
  })
})

describe("the game's network step", () => {
  it("asks for the game's domains only; telemetry's grant is the pass's own ask", async () => {
    const permissions = await load()
    await expect(permissions.requestPermissionItem("network")).resolves.toEqual({ ok: true })
    const domains = host.requestPermission.mock.calls.map(
      ([arg]) => (arg as { value: { domains: string[] } }).value.domains,
    )
    expect(domains).toEqual([["turn.cloudflare.com", "stun.cloudflare.com", "issuer.example"]])
  })

  it("does not ask for telemetry when the game's own grant fails", async () => {
    host.requestPermission.mockImplementation(async () => ({ ok: true, value: false }))
    const permissions = await load()
    await expect(permissions.requestPermissionItem("network")).resolves.toMatchObject({ ok: false })
    expect(host.requestPermission).toHaveBeenCalledTimes(1)
  })

  it("hands over the TURN issue in flight", async () => {
    const permissions = await load()
    expect(permissions.turnIssueInFlight()).toBeNull()
    await permissions.requestPermissionItem("network")
    expect(permissions.turnIssueInFlight()).toBeInstanceOf(Promise)
  })

  it("fetches the credentials as a warm-up, never as a mesh open", async () => {
    // Given
    const permissions = await load()
    const { fetchIceServers } = await import("./webrtc/ice")

    // When
    await permissions.requestPermissionItem("network")

    // Then
    expect(fetchIceServers).toHaveBeenLastCalledWith(undefined, "warmup")
  })
})

describe("the signing-decline classifier", () => {
  it.each([
    "Rejected",
    "createTransaction failed: Rejected",
    "createTransaction failed: Rejected <- CallError",
    "HostRejectedError: Host rejected the request",
    "Transaction signing was rejected.",
    "createTransaction failed: user rejected the confirmation",
    "UnableToSign",
  ])("recognises the host's exact signing rejection: %s", async (detail) => {
    const permissions = await load()
    expect(permissions.isSigningDeclined(detail)).toBe(true)
  })

  it.each([
    "HostRejectedError: Host rejected the request",
    "createTransaction failed: Rejected",
    "Transaction signing was rejected.",
  ])("agrees with the probe on %s", async (detail) => {
    const permissions = await load()
    const { runChainHealthProbe } = await import("./chain-health")
    const probed = await runChainHealthProbe(async () => {
      throw new Error(detail)
    })
    expect(permissions.isSigningDeclined(detail)).toBe(true)
    expect(probed.outcome).toBe("declined")
  })

  it.each(["transaction rejected: Invalid.Payment", "pool: transaction rejected", "HostDisconnectedError: host went away", "operation timed out", "cannot get the current block"])(
    "does not mistake %s for a signing decline",
    async (detail) => {
      const permissions = await load()
      expect(permissions.isSigningDeclined(detail)).toBe(false)
    },
  )
})

describe("the version file's grant", () => {
  it("asks for the bare hostname when the URL has a port", async () => {
    const permissions = await load()
    await expect(permissions.requestVersionGrant("http://localhost:22605/version.json")).resolves.toBe(true)
    expect(host.requestPermission).toHaveBeenCalledWith({
      tag: "Remote",
      value: { domains: ["localhost"] },
    })
  })

  it("leaves the production gist URL's domain unchanged", async () => {
    const permissions = await load()
    await permissions.requestVersionGrant("https://gist.githubusercontent.com/x/y/raw/version.json")
    expect(host.requestPermission).toHaveBeenCalledWith({
      tag: "Remote",
      value: { domains: ["gist.githubusercontent.com"] },
    })
  })
})
