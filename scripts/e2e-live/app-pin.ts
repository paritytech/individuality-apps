// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { LoadedApp } from "./build-refresh"

const LOCAL_APP = "local"

const exactCid = (value: string): string => {
  if (!/^baf[a-z2-7]{20,}$/.test(value.trim())) throw new Error(`app_cid="${value.trim()}" is not a CID`)
  if (value !== value.trim()) throw new Error("app_cid must be an exact CID without surrounding whitespace")
  return value
}

export type AppPinSource = "input" | "resolved"

export interface AppPin {
  cid: string
  source: AppPinSource
}

/** Pick the run-wide app CID. An explicit input is validated but never
 * resolved through dotNS, so a series can keep using exactly the same bytes. */
export async function selectAppPin(
  app: string,
  input: string | undefined,
  resolve: (name: string) => Promise<string>,
): Promise<AppPin> {
  if (input) {
    if (app === LOCAL_APP) throw new Error("app_cid cannot be used with app=local")
    return { cid: exactCid(input), source: "input" }
  }
  if (app === LOCAL_APP) return { cid: "", source: "resolved" }
  return { cid: await resolve(app), source: "resolved" }
}

export interface PinnedReleaseDocument {
  product: string
  version: string
  body: Record<string, unknown>
}

/** Only an explicit app_cid suppresses the real release document. The normal
 * just-in-time dotNS pin and the check-stale-build profile keep today's path. */
export function pinnedReleaseDocument(app: LoadedApp, source: string | undefined): PinnedReleaseDocument | null {
  if (source !== "input") return null
  if (!app.cid || !app.product || !app.version) throw new Error("an input-pinned deployed app needs CID, product and version provenance")
  return {
    product: app.product,
    version: app.version,
    body: {
      [app.product]: { version: app.version, time: 0 },
      updated: new Date(0).toISOString(),
    },
  }
}

/** A series pin is immutable for the run. In particular, a PR-preview name's
 * normal proactive refresh must not move a runner to another CID. */
export const mayRefreshApp = (app: LoadedApp): boolean => app.pinSource !== "input"

/** Never expose the mutable dotNS refresh callback to an input-pinned site. */
export function appRefreshLoader<T>(app: LoadedApp, refresh: () => Promise<T>): (() => Promise<T>) | undefined {
  return mayRefreshApp(app) ? refresh : undefined
}

/** Provenance belongs only to the initial build loaded from E2E_APP_CID. */
export function pinSourceForLoad(source: string | undefined, configuredCid: string | null | undefined, cidOverride: string | undefined): "input" | undefined {
  return source === "input" && configuredCid != null && cidOverride === undefined ? "input" : undefined
}

/** A visible update gate means the input-only release interception failed. */
export function pinnedUpdateGateWarning(app: LoadedApp, visible: boolean): string | null {
  return app.pinSource === "input" && visible
    ? "input-pinned app reached the update gate; the pinned release-document interception did not take effect"
    : null
}

/** The release workflow's public document. Keep the cache-busting query. */
export function isVersionDocument(url: string | URL): boolean {
  try {
    return (typeof url === "string" ? new URL(url) : url).pathname.endsWith("/dim2-version.json")
  } catch {
    return false
  }
}
