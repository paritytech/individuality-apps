// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Info = { platform: string; name: string; version: string } | null
/** `answer`, when set, is how the host answers each call (started at the call) */
const host = vi.hoisted(() => ({ info: null as Info, answer: null as (() => Promise<Info>) | null }))
vi.mock("../host/host-info", () => ({ readHostInfo: () => (host.answer ? host.answer() : Promise.resolve(host.info)) }))

import {
  collectDevice,
  connectionSnapshot,
  connectionTags,
  deviceContext,
  deviceTags,
  inferIosClass,
  normaliseGpu,
  parseUserAgent,
  readGpu,
  watchConnection,
} from "./device"
import type { DeviceProfile } from "./device"

const ANDROID_WV =
  "Mozilla/5.0 (Linux; Android 16; SM-S918B Build/BP4A.251205.006; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.8037.57 Mobile Safari/537.36"
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
const IPAD_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"
const ELECTRON =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PolkadotDesktop/0.8.10 Chrome/134.0.6998.205 Electron/35.7.5 Safari/537.36"
const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36"
const REDUCED = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"

describe("parseUserAgent", () => {
  it("reads an Android WebView", () => {
    expect(parseUserAgent(ANDROID_WV)).toEqual({
      os: "android",
      osVersion: "16",
      engine: "chromium-webview",
      engineVersion: "154.0.8037.57",
      model: "SM-S918B",
    })
  })
  it("reads an iPhone WKWebView, which names no model", () => {
    expect(parseUserAgent(IPHONE)).toEqual({
      os: "ios",
      osVersion: "18.6",
      engine: "webkit",
      engineVersion: "605.1.15",
      model: null,
    })
  })
  it("reads an iPad asking for the desktop site as iOS", () => {
    expect(parseUserAgent(IPAD_DESKTOP, 5)).toMatchObject({ os: "ios", osVersion: "18.6", engine: "webkit", model: null })
    expect(parseUserAgent(IPAD_DESKTOP, 0)).toMatchObject({ os: "macos" })
  })
  it("reads Polkadot Desktop (Electron) as Chromium on macOS", () => {
    expect(parseUserAgent(ELECTRON)).toEqual({
      os: "macos",
      osVersion: "10.15.7",
      engine: "chromium",
      engineVersion: "134.0.6998.205",
      model: null,
    })
  })
  it("reads desktop Chrome", () => {
    expect(parseUserAgent(CHROME_WIN)).toMatchObject({ os: "windows", osVersion: "10.0", engine: "chromium", engineVersion: "130.0.0.0" })
  })
  it("takes an Android model with no Build token, and drops the reduced-UA K", () => {
    expect(parseUserAgent(CHROME_ANDROID)).toMatchObject({ os: "android", engine: "chromium", model: "Pixel 8" })
    expect(parseUserAgent(REDUCED).model).toBeNull()
  })
  it("never throws on junk", () => {
    expect(parseUserAgent("")).toMatchObject({ os: "other", engine: "other", model: null })
    expect(parseUserAgent(undefined as unknown as string)).toMatchObject({ os: "other" })
  })
})

const wv = (android: number, model: string, build: string, chrome = "153.0.0.0") =>
  `Mozilla/5.0 (Linux; Android ${android}; ${model} Build/${build}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${chrome} Mobile Safari/537.36`

describe("parseUserAgent: the Android model, per vendor, as the Polkadot WebView sends it", () => {
  it.each([
    ["Motorola Edge 30 Pro (issue 231)", wv(14, "motorola edge 30 pro", "U1SHS34.1-177-6-4"), "motorola edge 30 pro"],
    ["Pixel 10a", wv(17, "Pixel 10a", "CP3A.260905.009", "153.0.8010.39"), "Pixel 10a"],
    ["Pixel 9 Pro XL", wv(17, "Pixel 9 Pro XL", "CP3A.260905.009", "153.0.8010.39"), "Pixel 9 Pro XL"],
    ["Pixel 7a", wv(16, "Pixel 7a", "BP4A.251205.006", "154.0.8037.57"), "Pixel 7a"],
    ["Samsung A54", wv(15, "SM-A546B", "AP3A.240905.015.A2"), "SM-A546B"],
    ["Fairphone 4", wv(13, "FP4", "TP1A.220624.014"), "FP4"],
    ["OnePlus 9 Pro", wv(14, "LE2123", "UP1A.231005.007"), "LE2123"],
  ])("%s", (_name, ua, model) => {
    expect(parseUserAgent(ua)).toMatchObject({ os: "android", engine: "chromium-webview", model })
  })
})

describe("deviceContext", () => {
  const profile = (over: Partial<DeviceProfile>) => ({ os: "android", model: null, ...over }) as DeviceProfile
  it.each([
    ["Motorola", profile({ os: "android", model: "motorola edge 30 pro" }), { model: "motorola edge 30 pro", family: "motorola edge 30 pro" }],
    ["Pixel 10a", profile({ os: "android", model: "Pixel 10a" }), { model: "Pixel 10a", family: "Pixel 10a" }],
    ["an iPhone, whose model is a screen class", profile({ os: "ios", model: "iphone-6.1in" }), null],
    ["an Android with no model", profile({ os: "android", model: null }), null],
  ])("%s", (_name, input, expected) => {
    expect(deviceContext(input)).toEqual(expected)
  })
})

describe("inferIosClass", () => {
  it("names a class from screen points", () => {
    expect(inferIosClass(393, 852, "iphone")).toBe("iphone-6.1in")
    expect(inferIosClass(852, 393, "iphone")).toBe("iphone-6.1in") // landscape
    expect(inferIosClass(430, 932, "iphone")).toBe("iphone-6.7in")
    expect(inferIosClass(402, 874, "iphone")).toBe("iphone-6.3in")
    expect(inferIosClass(1024, 1366, "ipad")).toBe("ipad")
    expect(inferIosClass(1, 2, "iphone")).toBe("iphone")
  })
})

describe("normaliseGpu", () => {
  it("folds renderer strings into a low-cardinality family", () => {
    expect(normaliseGpu("ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)")).toBe("Adreno 740")
    expect(normaliseGpu("Adreno (TM) 830")).toBe("Adreno 830")
    expect(normaliseGpu("Mali-G715")).toBe("Mali-G715")
    expect(normaliseGpu("ARM, Mali-G78 MC14")).toBe("Mali-G78")
    expect(normaliseGpu("Apple GPU")).toBe("Apple GPU")
    expect(normaliseGpu("ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)")).toBe("Apple M2")
    expect(normaliseGpu("ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)")).toBe("NVIDIA")
    expect(normaliseGpu("Intel(R) UHD Graphics")).toBe("Intel")
    expect(normaliseGpu("SwiftShader")).toBe("software")
    expect(normaliseGpu("Something Exotic 9000")).toBe("other")
    expect(normaliseGpu(null)).toBeNull()
  })
})

function fakeDocument(opts: { renderer?: string | null; noExt?: boolean; throws?: boolean }) {
  const lose = vi.fn()
  const gl = {
    getExtension: (name: string) => {
      if (name === "WEBGL_debug_renderer_info") return opts.noExt ? null : { UNMASKED_RENDERER_WEBGL: 37446 }
      if (name === "WEBGL_lose_context") return { loseContext: lose }
      return null
    },
    getParameter: (p: number) => (p === 37446 ? opts.renderer : null),
  }
  const doc = {
    createElement: () => {
      if (opts.throws) throw new Error("no canvas")
      return { width: 0, height: 0, getContext: () => gl }
    },
  } as unknown as Document
  return { doc, lose }
}

describe("readGpu", () => {
  it("reads the unmasked renderer, then loses the context", () => {
    const { doc, lose } = fakeDocument({ renderer: "ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)" })
    expect(readGpu(doc)).toBe("ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)")
    expect(lose).toHaveBeenCalledTimes(1)
  })
  it("is null without the extension, and never throws", () => {
    expect(readGpu(fakeDocument({ noExt: true }).doc)).toBeNull()
    expect(readGpu(fakeDocument({ throws: true }).doc)).toBeNull()
  })
})

/** the profile for the stubbed page's own user agent */
const collect = () => collectDevice({ userAgent: (navigator as Navigator | undefined)?.userAgent ?? "" })

function stubBrowser(over: {
  ua?: string
  touch?: number
  highEntropy?: (keys: string[]) => Promise<Record<string, unknown>>
  cores?: number
  memory?: number
  connection?: unknown
  renderer?: string | null
  screen?: { width: number; height: number }
} = {}) {
  const { doc, lose } = fakeDocument({ renderer: over.renderer === undefined ? "Mali-G715" : over.renderer })
  vi.stubGlobal("navigator", {
    userAgent: over.ua ?? ANDROID_WV,
    maxTouchPoints: over.touch ?? 5,
    hardwareConcurrency: over.cores ?? 8,
    deviceMemory: over.memory,
    connection: over.connection,
    userAgentData: over.highEntropy ? { getHighEntropyValues: over.highEntropy } : undefined,
  })
  vi.stubGlobal("screen", over.screen ?? { width: 412, height: 915, orientation: { type: "portrait-primary" } })
  vi.stubGlobal("window", { devicePixelRatio: 2.625, innerWidth: 412, innerHeight: 800, __HOST_API_PORT__: {} })
  vi.stubGlobal("document", doc)
  return { lose }
}

beforeEach(() => {
  host.info = null
  host.answer = null
})
afterEach(() => vi.unstubAllGlobals())

describe("collectDevice", () => {
  it("collects the profile from the page", async () => {
    stubBrowser({ memory: 8 })
    const profile = await collect()
    expect(profile).toMatchObject({
      os: "android",
      osVersion: "16",
      engine: "chromium-webview",
      engineVersion: "154.0.8037.57",
      model: "SM-S918B",
      modelSource: "ua",
      cores: 8,
      memory: 8,
      screen: "412x915",
      dpr: 2.625,
      viewport: "412x800",
      orientation: "portrait-primary",
    })
    // the GPU is read when the page is idle (init.ts), never here
    expect(profile).not.toHaveProperty("gpu")
  })
  it("lets client hints override the model and OS version", async () => {
    stubBrowser({
      highEntropy: async () => ({
        model: "Pixel 10 Pro",
        platformVersion: "16.0.0",
        fullVersionList: [{ brand: "Android WebView", version: "155.0.1.2" }],
      }),
    })
    expect(await collect()).toMatchObject({
      model: "Pixel 10 Pro",
      modelSource: "client-hints",
      osVersion: "16",
      engineVersion: "155.0.1.2",
    })
  })
  it("gives up on client hints after a second", async () => {
    vi.useFakeTimers()
    try {
      stubBrowser({ highEntropy: () => new Promise(() => {}) })
      const pending = collect()
      await vi.advanceTimersByTimeAsync(1100)
      expect(await pending).toMatchObject({ model: "SM-S918B", modelSource: "ua" })
    } finally {
      vi.useRealTimers()
    }
  })
  it("survives client hints that throw", async () => {
    stubBrowser({
      highEntropy: async () => {
        throw new Error("denied")
      },
    })
    expect(await collect()).toMatchObject({ model: "SM-S918B" })
  })
  it("infers an iPhone's class from the screen", async () => {
    stubBrowser({ ua: IPHONE, screen: { width: 393, height: 852 }, renderer: "Apple GPU" })
    expect(await collect()).toMatchObject({
      os: "ios",
      model: "iphone-6.1in",
      modelSource: "inferred",
    })
  })
  it("carries the host's name and version when the host reports them", async () => {
    stubBrowser()
    host.info = { platform: "Android", name: "Polkadot Mobile", version: "1.4.2" }
    expect(await collect()).toMatchObject({ hostName: "Polkadot Mobile", hostVersion: "1.4.2" })
  })
  it("never waits forever on a host that does not answer: the profile comes without the host", async () => {
    vi.useFakeTimers()
    try {
      stubBrowser()
      host.answer = () => new Promise(() => {}) // a parked port that never connects
      let profile: Awaited<ReturnType<typeof collect>> | null = null
      void collect().then((value) => (profile = value))
      await vi.advanceTimersByTimeAsync(3100)
      expect(profile).toMatchObject({ os: "android", model: "SM-S918B", hostName: null, hostVersion: null })
    } finally {
      vi.useRealTimers()
    }
  })
  it("asks the client hints and the host at once, not one after the other", async () => {
    vi.useFakeTimers()
    try {
      const later = <T,>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))
      stubBrowser({ highEntropy: () => later({ model: "Pixel 10 Pro" }, 800) })
      host.answer = () => later({ platform: "Android", name: "Polkadot Mobile", version: "1.4.2" }, 800)
      let profile: Awaited<ReturnType<typeof collect>> | null = null
      void collect().then((value) => (profile = value))
      await vi.advanceTimersByTimeAsync(900)
      expect(profile).toMatchObject({ model: "Pixel 10 Pro", hostName: "Polkadot Mobile" })
    } finally {
      vi.useRealTimers()
    }
  })
  it("takes the user agent it is given", async () => {
    stubBrowser()
    expect(await collectDevice({ userAgent: CHROME_WIN })).toMatchObject({ os: "windows" })
  })
  it("never throws with no browser at all", async () => {
    vi.stubGlobal("navigator", undefined)
    vi.stubGlobal("screen", undefined)
    vi.stubGlobal("window", undefined)
    vi.stubGlobal("document", undefined)
    expect(await collect()).toMatchObject({ os: "other" })
  })
})

describe("deviceTags", () => {
  it("makes low-cardinality string tags", async () => {
    stubBrowser({ memory: 8 })
    const tags = deviceTags(await collect())
    expect(tags).toEqual({
      "device.os": "android",
      "device.os_version": "16",
      "device.model": "SM-S918B",
      "device.cores": "8",
      "device.memory": "8",
      "device.engine": "chromium-webview",
      "device.engine_version": "154",
    })
  })
  it("keeps major.minor for iOS and leaves out what is unknown", async () => {
    stubBrowser({ ua: IPHONE, screen: { width: 393, height: 852 }, renderer: "Apple GPU", cores: 6 })
    const tags = deviceTags(await collect())
    expect(tags["device.os_version"]).toBe("18.6")
    // WebKit's user agent is frozen at 605 on every iOS: the OS version is the engine's
    expect(tags).not.toHaveProperty("device.engine_version")
    // the engine FAMILY is still said: a codec map groups WebKit by it and the OS version
    expect(tags["device.engine"]).toBe("webkit")
    expect(tags).not.toHaveProperty("device.memory")
  })
  it("adds the host app when known", async () => {
    stubBrowser()
    host.info = { platform: "Android", name: "Polkadot Mobile", version: "1.4.2" }
    const tags = deviceTags(await collect())
    expect(tags).toMatchObject({ "host.app": "Polkadot Mobile", "host.app_version": "1.4.2" })
  })
})

describe("connection", () => {
  const conn = { type: "cellular", effectiveType: "4g", downlink: 9.5, rtt: 100, saveData: false }
  it("snapshots navigator.connection", () => {
    stubBrowser({ connection: conn })
    expect(connectionSnapshot()).toEqual({
      type: "cellular",
      effectiveType: "4g",
      downlinkMbps: 9.5,
      rttMs: 100,
      saveData: false,
    })
  })
  it("is null where the API does not exist", () => {
    stubBrowser()
    expect(connectionSnapshot()).toBeNull()
  })
  it("says unknown for a missing type", () => {
    stubBrowser({ connection: { effectiveType: "3g", downlink: 1, rtt: 300 } })
    expect(connectionSnapshot()).toMatchObject({ type: "unknown", effectiveType: "3g", saveData: false })
  })
  it("turns a snapshot into net tags", () => {
    stubBrowser({ connection: conn })
    expect(connectionTags(connectionSnapshot())).toEqual({ "net.type": "cellular", "net.effective": "4g" })
    expect(connectionTags(null)).toEqual({})
  })
  it("calls back on change, and stops when told to", () => {
    const listeners: Array<() => void> = []
    const c = {
      ...conn,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.splice(listeners.indexOf(fn), 1),
    }
    stubBrowser({ connection: c })
    const seen: unknown[] = []
    const stop = watchConnection((snap) => seen.push(snap?.effectiveType))
    expect(listeners).toHaveLength(1)
    c.effectiveType = "3g"
    listeners[0]()
    expect(seen).toEqual(["3g"])
    stop()
    expect(listeners).toHaveLength(0)
  })
  it("watches nothing where there is no API", () => {
    stubBrowser()
    expect(watchConnection(() => {})()).toBeUndefined()
  })
})
