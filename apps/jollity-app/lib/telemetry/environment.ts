// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Where this page is served from, in Sentry's words. Pure: no Sentry, no
 * window. The callers read `location` and `navigator` and pass them in.
 *
 * THE ENVIRONMENT IS THE SERVED HOST NAME. A build may be served under
 * another name than the one it was built for (for example, a release that
 * promotes a staging build's CID without rebuilding), so the baked product
 * cannot tell the two apart.
 *
 * AN ORIGIN WE CANNOT NAME IS NEVER FILED AS THE BAKED PRODUCT: a production
 * build opened from http://localhost would otherwise land in the production
 * numbers (issue 230). An unrecognised name served over anything
 * but https or polkadot:// (http://localhost, a LAN address, file:) is a
 * developer's copy: environment `local`, source `local`. Any other
 * unrecognised host is `unknown`, source `host-unknown`.
 * (The product name the host says it served us as is only learned later, in
 * game-source, which telemetry must not import, so it cannot refine "unknown".)
 */
import { parseUserAgent, type DeviceOs } from "./device"

export type HostKind = "android" | "ios" | "desktop" | "browser"

export interface Served {
  hostname: string
  protocol: string
}

/** the dotNS suffixes a served name ends in */
const DOTNS_SUFFIXES = [".paseo", ".testnet", ".dot"] as const

export type EnvSource = "host" | "host-unknown" | "local"

/** the schemes a real host serves the product over; anything else is a developer's copy */
const HOSTED_SCHEMES = new Set(["https:", "polkadot:"])

export function environmentFor(
  served: Served,
): { environment: string; source: EnvSource } {
  let name = served.hostname.toLowerCase()
  // manifest products serve from their `app.` subname
  if (name.startsWith("app.")) name = name.slice(4)
  // the web gateway mirrors
  if (name.endsWith(".li")) name = name.slice(0, -3)
  // the web gateway serves an executable as `<name>.app.<tld>.li`
  for (const suffix of DOTNS_SUFFIXES) if (name.endsWith(`.app${suffix}`)) name = name.slice(0, -(suffix.length + 4)) + suffix
  const known = DOTNS_SUFFIXES.some((suffix) => name.endsWith(suffix) && name.length > suffix.length)
  if (known) return { environment: name, source: "host" }
  if (!HOSTED_SCHEMES.has(served.protocol)) return { environment: "local", source: "local" }
  return { environment: "unknown", source: "host-unknown" }
}

/** `scheme://host`. Not `location.origin`, which reads "null" for polkadot:// */
export function pageOrigin(served: Served): string {
  return `${served.protocol}//${served.hostname}`
}

/** The host from the user agent's OS (parseUserAgent holds the one iPad rule). */
export function detectHostKind(device: { userAgent: string; inContainer: boolean; maxTouchPoints: number }): HostKind {
  if (!device.inContainer) return "browser"
  const { os } = parseUserAgent(device.userAgent, device.maxTouchPoints)
  return os === "android" || os === "ios" ? os : "desktop"
}

/** The DSN's host, the one domain the Remote grant must add. Null for an
 *  empty or malformed DSN: such a build adds no domain and sends nothing. */
export function ingestHost(dsn: string | undefined): string | null {
  if (!dsn) return null
  try {
    const url = new URL(dsn)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (!url.username || !url.hostname) return null
    return url.hostname
  } catch {
    return null
  }
}

/**
 * WHICH SENTRY PROJECT A PAGE WRITES TO. Test traffic can go to its own
 * project, so it never spends production's quota or spike protection: a page
 * uses the TEST DSN (NEXT_PUBLIC_SENTRY_DSN_TEST) only when it is a
 * developer's copy, environment `local`: next dev, a local truapi-host
 * session, or an end-to-end test driver that serves even a production bundle
 * from http://localhost. A HOSTED origin (any https or polkadot:// name, a
 * preview deploy included) always keeps the production DSN, whatever the test
 * tag says: a stale NEXT_PUBLIC_SENTRY_TAG in a deploy's shell must never send
 * real players to the test project. A build without a usable test DSN uses
 * the production DSN everywhere.
 */
export function pickDsn(choice: { prod: string; test: string; environment: string }): string {
  if (choice.environment === "local" && ingestHost(choice.test) !== null) return choice.test
  return choice.prod
}

/** What the boot log line records, so every exported log shows what the host served. */
export function describePage(
  page: Served & { userAgent: string; inContainer: boolean; maxTouchPoints: number },
): {
  origin: string
  host: HostKind
  environment: string
  envSource: EnvSource
  os: DeviceOs
  osVersion: string
  model: string | null
} {
  const { environment, source } = environmentFor(page)
  const { os, osVersion, model } = parseUserAgent(page.userAgent, page.maxTouchPoints)
  return {
    origin: pageOrigin(page),
    host: detectHostKind(page),
    environment,
    envSource: source,
    os,
    osVersion,
    model,
  }
}
