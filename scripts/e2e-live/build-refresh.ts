// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export const BUILD_REFRESH_PATH = "/__e2e/refresh-build"
const PR_PREVIEW_APP = /^dim2-pr\d+-sandbox00\.[a-z0-9.-]+$/
const PREVIEW_REFRESH_INTERVAL_MS = 30_000
const PREVIEW_REFRESH_HANDOVER_GUARD_MS = 30_000

export type BuildRefreshTrigger = "update-message" | "pr-preview"

export const isPrPreviewApp = (app: string): boolean => PR_PREVIEW_APP.test(app)

/** A preview refresh is opportunistic: never start another name resolution
 * too frequently, and stop early enough that a slow CAR fetch cannot steal
 * the handover. The post-run proof check, not this request, is authoritative. */
export const previewRefreshDue = (nowMs: number, lastAttemptMs: number, handoverMs: number): boolean =>
  nowMs - lastAttemptMs >= PREVIEW_REFRESH_INTERVAL_MS && nowMs <= handoverMs - PREVIEW_REFRESH_HANDOVER_GUARD_MS

/** The app's explicit update message is authoritative. It is never suppressed
 * by preview cadence or by the handover guard: while the message is visible,
 * the harness keeps resolving/reloading instead of continuing the journey on
 * the stale document. PR previews have no message, so they use the bounded
 * opportunistic check instead. */
export const buildRefreshTrigger = (input: {
  updateVisible: boolean
  app: string
  nowMs: number
  lastAttemptMs: number
  handoverMs?: number
}): BuildRefreshTrigger | null => {
  if (input.updateVisible) return "update-message"
  if (input.handoverMs === undefined || !isPrPreviewApp(input.app)) return null
  return previewRefreshDue(input.nowMs, input.lastAttemptMs, input.handoverMs) ? "pr-preview" : null
}

/** Whether the caller must stay in the refresh loop. An explicit app message
 * owns the page until it disappears or a reload succeeds; an unchanged
 * proactive preview check gives control straight back to the journey. */
export const buildRefreshHandled = (trigger: BuildRefreshTrigger, reloaded: boolean): boolean => reloaded || trigger === "update-message"

/** What the bot loaded, for result-<n>.json and the gather summary. Kept in
 *  this dependency-free leaf because Playwright loads journey.pw.ts as CJS. */
export interface LoadedApp {
  /** the dotNS name the bots were told to load; "local" = `next dev` of this checkout */
  app: string
  /** the product id the host signs for (compiled into the bundle) */
  product: string | null
  /** the CID of the bundle dotNS pointed at when the bot booted */
  cid: string | null
  /** the build stamp inlined in the bundle (NEXT_PUBLIC_APP_VERSION), null for local */
  version: string | null
  /** Exact Git commit baked into the deployed bundle. */
  commit?: string | null
  /** How the run-wide CID was selected. Present for input-pinned series. */
  pinSource?: "input" | "resolved"
  files: number | null
}

export interface BuildRefreshResult {
  status: "updated" | "unchanged"
  from: LoadedApp
  to: LoadedApp
  seconds: number
}

export interface BuildRefreshEvidence {
  from: Pick<LoadedApp, "cid" | "version">
  to: Pick<LoadedApp, "cid" | "version">
  seconds: number
}

const short = (value: string | null): string => (value ? value.slice(0, 12) : "unknown")

/** One successful transition per build the bot observed. An unchanged resolve
 *  consumes nothing: dotNS may move a few seconds after the version file. */
export function acceptBuildRefresh(result: BuildRefreshResult, completedFrom: Set<string>): BuildRefreshResult | null {
  if (result.status === "unchanged") return null
  const from = result.from.cid
  const to = result.to.cid
  if (!from || !to || from === to) throw new Error(`invalid deployed-build transition ${from ?? "unknown"} -> ${to ?? "unknown"}`)
  if (completedFrom.has(from)) throw new Error(`the bot already reloaded from ${from}; refusing a build-refresh loop`)
  completedFrom.add(from)
  return result
}

export function buildRefreshNote(slot: number, result: BuildRefreshEvidence, subject = "player"): string {
  return `${subject} ${slot} reloaded for a newer build in ${result.seconds.toFixed(1)} s: ${result.from.cid ?? "unknown"} (${short(result.from.version)}) -> ${result.to.cid ?? "unknown"} (${short(result.to.version)})`
}

function isLoadedApp(value: unknown): value is LoadedApp {
  if (!value || typeof value !== "object") return false
  const app = value as Partial<LoadedApp>
  return typeof app.app === "string" && (app.cid === null || typeof app.cid === "string") && (app.version === null || typeof app.version === "string")
}

export async function requestBuildRefresh(port: number, fetchFn: typeof fetch = fetch, timeoutMs = 60_000): Promise<BuildRefreshResult> {
  const response = await fetchFn(`http://127.0.0.1:${port}${BUILD_REFRESH_PATH}`, { method: "POST", signal: AbortSignal.timeout(timeoutMs) })
  const body = (await response.json().catch(() => null)) as { error?: unknown; status?: unknown; from?: unknown; to?: unknown; seconds?: unknown } | null
  if (!response.ok) throw new Error(`refreshing the served build: ${typeof body?.error === "string" ? body.error : `HTTP ${response.status}`}`)
  if (!body || (body.status !== "updated" && body.status !== "unchanged") || !isLoadedApp(body.from) || !isLoadedApp(body.to) || typeof body.seconds !== "number") {
    throw new Error("refreshing the served build: the slot controller returned an invalid response")
  }
  return body as BuildRefreshResult
}
