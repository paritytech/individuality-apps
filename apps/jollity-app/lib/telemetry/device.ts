// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE DEVICE AND ITS CONNECTION, in Sentry's words. Framework-free and
 * Sentry-free: init.ts puts the results on the scope.
 *
 * Why: a media or sign-up failure is only readable next to the phone it
 * happened on (Adreno or Mali, 4 GB or 12, 3g or wifi). The user agent gives
 * the OS, WebView and, on Android, the model; Android WebView's client hints
 * give the true model and OS version; WebGL's debug renderer names the GPU;
 * an iPhone names nothing, so its CLASS is inferred from screen points. The
 * host app's own name and version come from lib/host/host-info.ts.
 *
 * Everything here never throws. The WebGL probe (readGpu) is not part of
 * collectDevice: init.ts runs it when the page is idle, off the boot path.
 */
import { hostPortParked } from "../host/container"
import { readHostInfo } from "../host/host-info"
import { withTimeout } from "../with-timeout"

export type DeviceOs = "android" | "ios" | "macos" | "windows" | "linux" | "other"
type DeviceEngine = "chromium-webview" | "chromium" | "webkit" | "other"

export interface ParsedUserAgent {
  os: DeviceOs
  osVersion: string
  engine: DeviceEngine
  engineVersion: string
  model: string | null
}

export interface DeviceProfile extends ParsedUserAgent {
  modelSource: "ua" | "client-hints" | "inferred" | null
  cores: number | null
  /** GB, Chromium only */
  memory: number | null
  screen: string
  dpr: number | null
  viewport: string
  orientation: string | null
  hostName: string | null
  hostVersion: string | null
}

export interface ConnectionSnapshot {
  type: string
  effectiveType: string
  downlinkMbps: number
  rttMs: number
  saveData: boolean
}

const match = (text: string, pattern: RegExp): string | null => pattern.exec(text)?.[1] ?? null

export function parseUserAgent(ua: string, maxTouchPoints = 0): ParsedUserAgent {
  const text = typeof ua === "string" ? ua : ""
  let os: DeviceOs = "other"
  let osVersion = ""
  let model: string | null = null
  if (/Android/i.test(text)) {
    os = "android"
    osVersion = match(text, /Android ([\d.]+)/) ?? ""
    const named = match(text, /Android [\d.]+;\s*([^;)]*?)\s*Build\//) ?? match(text, /Android [\d.]+;\s*([^;)]+)/)
    // "K" is Chrome's reduced user agent; "wv" is the WebView flag
    model = named && named !== "K" && named !== "wv" ? named.trim() : null
  } else if (/iPhone|iPad|iPod/.test(text)) {
    os = "ios"
    osVersion = (match(text, /OS (\d+(?:_\d+)*) like Mac/) ?? "").replace(/_/g, ".")
  } else if (/Macintosh/.test(text)) {
    // an iPad asking for the desktop site: a Mac user agent with a touch screen
    if (maxTouchPoints > 1) {
      os = "ios"
      osVersion = match(text, /Version\/([\d.]+)/) ?? ""
    } else {
      os = "macos"
      osVersion = (match(text, /Mac OS X (\d+(?:[_.]\d+)*)/) ?? "").replace(/_/g, ".")
    }
  } else if (/Windows/.test(text)) {
    os = "windows"
    osVersion = match(text, /Windows NT ([\d.]+)/) ?? ""
  } else if (/Linux|X11|CrOS/.test(text)) {
    os = "linux"
  }
  let engine: DeviceEngine = "other"
  let engineVersion = ""
  const chrome = match(text, /Chrome\/([\d.]+)/)
  if (chrome) {
    engine = /;\s*wv\)/.test(text) ? "chromium-webview" : "chromium"
    engineVersion = chrome
  } else if (/AppleWebKit/.test(text)) {
    engine = "webkit"
    engineVersion = match(text, /AppleWebKit\/([\d.]+)/) ?? ""
  }
  return { os, osVersion, engine, engineVersion, model }
}

/** Screen points (short x long edge) to an iPhone size class. Display Zoom
 *  reports a smaller screen, so a zoomed phone reads one class down. */
const IPHONE_CLASS: Record<string, string> = {
  "440x956": "6.9in",
  "430x932": "6.7in",
  "428x926": "6.7in",
  "402x874": "6.3in",
  "393x852": "6.1in",
  "390x844": "6.1in",
  "414x896": "6.1in",
  "375x812": "5.8in",
  "414x736": "5.5in",
  "375x667": "4.7in",
}

export function inferIosClass(width: number, height: number, kind: "iphone" | "ipad"): string {
  if (kind === "ipad") return "ipad"
  const size = IPHONE_CLASS[`${Math.min(width, height)}x${Math.max(width, height)}`]
  return size ? `iphone-${size}` : "iphone"
}

/** A renderer string folded into a family small enough to tag. */
export function normaliseGpu(raw: string | null | undefined): string | null {
  if (!raw) return null
  const adreno = match(raw, /Adreno\s*(?:\(TM\))?\s*(\d+)/i)
  if (adreno) return `Adreno ${adreno}`
  const mali = match(raw, /((?:Mali|Immortalis)-[A-Z]\d+)/)
  if (mali) return mali
  if (/Apple GPU/i.test(raw)) return "Apple GPU"
  const apple = match(raw, /(Apple M\d+)/)
  if (apple) return apple
  if (/PowerVR/i.test(raw)) return "PowerVR"
  if (/SwiftShader|llvmpipe|Software/i.test(raw)) return "software"
  if (/NVIDIA/i.test(raw)) return "NVIDIA"
  if (/Intel/i.test(raw)) return "Intel"
  if (/AMD|Radeon/i.test(raw)) return "AMD"
  return "other"
}

/** The unmasked GPU renderer: one tiny canvas, read once, context lost at once. */
export function readGpu(doc: Document | undefined = typeof document === "undefined" ? undefined : document): string | null {
  try {
    if (!doc) return null
    const canvas = doc.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    const gl = (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null
    if (!gl) return null
    try {
      const info = gl.getExtension("WEBGL_debug_renderer_info")
      const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null
      return typeof renderer === "string" && renderer ? renderer : null
    } finally {
      gl.getExtension("WEBGL_lose_context")?.loseContext()
    }
  } catch {
    return null
  }
}

const CLIENT_HINTS_TIMEOUT_MS = 1000
/** the whole async part (client hints and the host's report, side by side):
 *  getTruApi() has no deadline of its own, and a parked port that never
 *  connects would leave the profile unresolved for the session */
const COLLECT_TIMEOUT_MS = 3000

interface UserAgentData {
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>
}

async function clientHints(): Promise<{ model?: string; osVersion?: string; engineVersion?: string }> {
  try {
    const data = (navigator as unknown as { userAgentData?: UserAgentData }).userAgentData
    if (!data?.getHighEntropyValues) return {}
    const values = await withTimeout(data.getHighEntropyValues(["model", "platformVersion", "fullVersionList"]), CLIENT_HINTS_TIMEOUT_MS)
    if (!values) return {}
    const out: { model?: string; osVersion?: string; engineVersion?: string } = {}
    if (typeof values.model === "string" && values.model) out.model = values.model
    if (typeof values.platformVersion === "string" && values.platformVersion) {
      out.osVersion = values.platformVersion.replace(/(\.0)+$/, "")
    }
    const list = values.fullVersionList
    if (Array.isArray(list)) {
      const brand = list.find((b) => b && /Android WebView|Chromium/.test(String((b as { brand?: unknown }).brand)))
      const version = (brand as { version?: unknown } | undefined)?.version
      if (typeof version === "string" && version) out.engineVersion = version
    }
    return out
  } catch {
    return {}
  }
}

const dimensions = (w: unknown, h: unknown) => (typeof w === "number" && typeof h === "number" ? `${w}x${h}` : "")

export async function collectDevice({ userAgent: ua }: { userAgent: string }): Promise<DeviceProfile> {
  const nav = typeof navigator === "undefined" ? undefined : navigator
  const scr = typeof screen === "undefined" ? undefined : screen
  const win = typeof window === "undefined" ? undefined : window
  let parsed: ParsedUserAgent
  try {
    parsed = parseUserAgent(ua, nav?.maxTouchPoints ?? 0)
  } catch {
    parsed = parseUserAgent("")
  }
  let model = parsed.model
  let modelSource: DeviceProfile["modelSource"] = model ? "ua" : null
  let { osVersion, engineVersion } = parsed
  const askHost = hostPortParked()
  const asked = await withTimeout(Promise.all([clientHints(), askHost ? readHostInfo() : Promise.resolve(null)]), COLLECT_TIMEOUT_MS)
  const [hints, info] = asked ?? [{}, null]
  if (hints.model) {
    model = hints.model
    modelSource = "client-hints"
  }
  if (hints.osVersion) osVersion = hints.osVersion
  if (hints.engineVersion) engineVersion = hints.engineVersion
  if (parsed.os === "ios") {
    const kind = /iPad|Macintosh/.test(ua) ? "ipad" : "iphone"
    model = inferIosClass(Number(scr?.width), Number(scr?.height), kind)
    modelSource = "inferred"
  }
  const hostName = info?.name || null
  const hostVersion = info?.version || null
  const memory = (nav as unknown as { deviceMemory?: unknown } | undefined)?.deviceMemory
  return {
    ...parsed,
    osVersion,
    engineVersion,
    model,
    modelSource,
    cores: typeof nav?.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null,
    memory: typeof memory === "number" ? memory : null,
    screen: dimensions(scr?.width, scr?.height),
    dpr: typeof win?.devicePixelRatio === "number" ? win.devicePixelRatio : null,
    viewport: dimensions(win?.innerWidth, win?.innerHeight),
    orientation: scr?.orientation?.type ?? null,
    hostName,
    hostVersion,
  }
}

/** The device context we send Sentry ourselves (issue 231), Android only.
 *  Left to itself, Sentry parses the request's User-Agent, and its parser cut a
 *  Motorola's model to "rola edge 30 pro Build/U1SHS34.1-177-6-4; wv". It fills
 *  only what we leave out, so family repeats the model (the parser garbles that
 *  too). Its brand is right, and on iOS our model is a screen-size class, not a
 *  model, so there we send nothing. */
export function deviceContext(profile: DeviceProfile): { model: string; family: string } | null {
  if (profile.os !== "android" || !profile.model) return null
  return { model: profile.model, family: profile.model }
}

/** The tags every event carries. Strings; a field that is not known is left out. */
export function deviceTags(profile: DeviceProfile): Record<string, string> {
  const tags: Record<string, string> = { "device.os": profile.os }
  const parts = profile.osVersion.split(".")
  const osVersion = profile.os === "android" ? parts[0] : parts.slice(0, 2).join(".")
  if (osVersion) tags["device.os_version"] = osVersion
  if (profile.model) tags["device.model"] = profile.model
  if (profile.cores !== null) tags["device.cores"] = String(profile.cores)
  if (profile.memory !== null) tags["device.memory"] = String(profile.memory)
  // the engine family always, so a codec map can group by it; on iOS the OS
  // version stands in for the engine version
  tags["device.engine"] = profile.engine
  // iOS: WebKit's user agent says 605 on every device; the OS version is the engine's
  const engineMajor = profile.os === "ios" ? "" : profile.engineVersion.split(".")[0]
  if (engineMajor) tags["device.engine_version"] = engineMajor
  if (profile.hostName) tags["host.app"] = profile.hostName
  if (profile.hostVersion) tags["host.app_version"] = profile.hostVersion
  return tags
}

// -- the network connection (navigator.connection: Android / Chromium only) ---

interface ConnectionLike {
  type?: unknown
  effectiveType?: unknown
  downlink?: unknown
  rtt?: unknown
  saveData?: unknown
  addEventListener?: (name: string, listener: () => void) => void
  removeEventListener?: (name: string, listener: () => void) => void
}

const connectionOf = (): ConnectionLike | null => {
  try {
    if (typeof navigator === "undefined") return null
    return (navigator as unknown as { connection?: ConnectionLike }).connection ?? null
  } catch {
    return null
  }
}

export function connectionSnapshot(): ConnectionSnapshot | null {
  try {
    const c = connectionOf()
    if (!c) return null
    return {
      type: typeof c.type === "string" && c.type ? c.type : "unknown",
      effectiveType: typeof c.effectiveType === "string" && c.effectiveType ? c.effectiveType : "unknown",
      downlinkMbps: typeof c.downlink === "number" ? c.downlink : 0,
      rttMs: typeof c.rtt === "number" ? c.rtt : 0,
      saveData: c.saveData === true,
    }
  } catch {
    return null
  }
}

export function connectionTags(snapshot: ConnectionSnapshot | null): Record<string, string> {
  return snapshot ? { "net.type": snapshot.type, "net.effective": snapshot.effectiveType } : {}
}

/** The journey attributes: the tags, plus the round-trip and downlink. */
export function connectionAttrs(snapshot: ConnectionSnapshot | null = connectionSnapshot()): Record<string, string> {
  if (!snapshot) return {}
  return {
    ...connectionTags(snapshot),
    // strings on purpose: a raw number on a span attribute lands as NULL in Sentry's string column (verified)
    "net.rtt": String(snapshot.rttMs),
    "net.downlink": String(snapshot.downlinkMbps),
  }
}

/** Calls back on every connection change; returns the stop function. */
export function watchConnection(onChange: (snapshot: ConnectionSnapshot | null) => void): () => void {
  try {
    const c = connectionOf()
    if (!c?.addEventListener || !c.removeEventListener) return () => {}
    const listener = () => {
      try {
        onChange(connectionSnapshot())
      } catch {
        /* telemetry never breaks the app */
      }
    }
    c.addEventListener("change", listener)
    return () => c.removeEventListener?.("change", listener)
  } catch {
    return () => {}
  }
}
