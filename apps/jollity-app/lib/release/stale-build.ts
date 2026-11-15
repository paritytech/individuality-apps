// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * IS THIS BUILD OLD? — the doorway that answers it. What the answer blocks is
 * lib/home-gate.ts's business; this module knows only BuildState.
 *
 * A release promotes a bundle onto the product's name, and a player whose app
 * is still showing the previous one keeps playing on it. The deployer's
 * release workflow publishes a version file at NEXT_PUBLIC_VERSION_URL (a URL
 * the deployer controls; it is a remote switch that can mark builds stale):
 * { "<name>": { "version": "<APP_VERSION>", "time": <unix seconds> }, ...,
 * "updated": "<iso>" }, one key per deployed name. APP_VERSION is a source
 * hash and has no ORDER; `time` is the built commit's commit time
 * (NEXT_PUBLIC_BUILD_TIME), which rises along a linear main branch. This
 * module fetches the file and compares.
 *
 * THE RULE, against the entry for THIS product (the released name):
 *  - CURRENT when this build's version is any entry's version (a promotion puts
 *    the SAME bytes under two names, and a pre-release name can run ahead of
 *    the release), or when its time is equal to or later than the release's. A
 *    build NEWER than the release (a version-file write that failed, the
 *    minutes after a deploy) must carry on, which a hash alone could not tell
 *    from an old one.
 *  - STALE only when its time is EARLIER than the release's.
 *  - UNKNOWN when either time is missing or unreadable (a dev build, an entry in
 *    the old string format, no entry for the product yet).
 * The trade-off is deliberate: an old pre-release build that is still newer
 * than the release is not flagged, because only the release's time is the
 * line.
 *
 * IT FAILS OPEN, every way it can fail. No URL (the gate is off), a refused
 * grant, a thrown fetch, a timeout, an abort, a body that is not the file, a
 * missing key, a dev build: all of them are "unknown", and unknown never blocks
 * anyone. A player is only ever locked out by a positive, readable answer.
 */
import { withTimeout } from "../with-timeout"

export type BuildState = "stale" | "current" | "unknown"
/** What one attempt says. "denied" is "unknown" with a reason that is not
 *  worth retrying on a clock: the host refused the version file's grant, and
 *  the refusal is not cached, so asking again would raise its dialog again. */
export type BuildCheck = BuildState | "denied"

/** What the page knows (lib/release/use-stale-build): the standing answer,
 *  what the latest attempt said, and the key it was asked for (the game a
 *  handover waits on, lib/home-gate entryRecheck; undefined for the app
 *  open's own). `last` is undefined until an attempt has answered. */
export interface BuildAnswer {
  state: BuildState
  last?: BuildCheck
  askedFor?: number
}

const TIMEOUT_MS = 4000
/** A CDN-served version file can be cached for minutes; a query that changes
 *  each minute asks the CDN afresh without making every request unique. */
const BUST_MS = 60_000

export interface CheckBuildDeps {
  /** Empty: the gate is off. */
  url: string
  product: string
  version: string
  /** This build's commit time, unix seconds (NEXT_PUBLIC_BUILD_TIME). */
  time?: number
  /** The host's Remote grant for the url's domain (lib/permissions.ts). */
  grant: () => Promise<boolean>
  /** Aborts the fetch (the page left). */
  signal?: AbortSignal
  fetchText?: (url: string, signal: AbortSignal) => Promise<string>
  timeoutMs?: number
  now?: () => number
}

async function fetchTextOver(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { cache: "no-store", signal })
  if (!response.ok) throw new Error(`version file ${response.status}`)
  return response.text()
}

function entryOf(value: unknown): { version: string; time: number } | undefined {
  if (!value || typeof value !== "object") return undefined // the old string format is no entry
  const { version, time } = value as { version?: unknown; time?: unknown }
  if (typeof version !== "string" || !version || typeof time !== "number" || !Number.isFinite(time)) return undefined
  return { version, time }
}

function judge(doc: unknown, product: string, version: string, time: number | undefined): BuildState {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "unknown"
  const entries = Object.entries(doc).filter(([key]) => key !== "updated")
  if (entries.some(([, value]) => entryOf(value)?.version === version)) return "current"
  const release = entryOf((doc as Record<string, unknown>)[product])
  if (!release || time === undefined || !Number.isFinite(time)) return "unknown"
  return time < release.time ? "stale" : "current"
}

/** Never throws, never takes longer than the timeout once the grant is in. */
export async function checkBuild(deps: CheckBuildDeps): Promise<BuildCheck> {
  if (!deps.url || !deps.version || deps.version === "dev") return "unknown"
  const controller = new AbortController()
  const abort = () => controller.abort()
  deps.signal?.addEventListener("abort", abort)
  try {
    const granted = await deps.grant().catch(() => false)
    if (deps.signal?.aborted) return "unknown"
    if (!granted) return "denied"
    const bucket = Math.floor((deps.now ?? Date.now)() / BUST_MS)
    const url = `${deps.url}${deps.url.includes("?") ? "&" : "?"}t=${bucket}`
    const body = await withTimeout((deps.fetchText ?? fetchTextOver)(url, controller.signal), deps.timeoutMs ?? TIMEOUT_MS)
    if (body === null) {
      controller.abort()
      return "unknown"
    }
    return judge(JSON.parse(body), deps.product, deps.version, deps.time)
  } catch {
    return "unknown"
  } finally {
    deps.signal?.removeEventListener("abort", abort)
  }
}
