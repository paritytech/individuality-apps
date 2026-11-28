// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE STALE-BUILD CHECK (profile check-stale-build, #539): what it takes for the run to PROVE the update screen, as a
// pure function over what the journey read (vitest pins it in stale-build-check.test.ts).
//
// The app shows the update screen only when it (1) was granted the version file's Remote grant by the host, (2) read the
// document and (3) judged its own build older than the release in it. A host that refuses the grant makes the app answer
// "unknown" and show the home as usual. So a screen alone could never prove the grant, and a missing screen is exactly the
// blocker #539 asks to record: the failure says WHICH step stopped (no fixture read: the grant was refused or never asked,
// a read with no screen: the app judged it current/unknown) and quotes the host/app lines naming the refusal.
//
// The fixture log is boot.mts's: one line per request the local version server answered (see fixtureLogLine).
import type { Check } from "./chain-checks"

/** One line of <out>/fixture.log: the version server answered a request for `path` (the app's cache-buster stripped). */
export const fixtureLogLine = (path: string, atIso: string): string => `${atIso} GET ${path}`

/** The boot log line for the fixture: the app's product comes from the network (the profile pins none), never from the profile env. */
export function fixtureDescription(env: Record<string, string>, productId: string): string {
  return `${env.NEXT_PUBLIC_VERSION_URL} (build time ${env.NEXT_PUBLIC_BUILD_TIME}, product ${env.NEXT_PUBLIC_PRODUCT_DOTNS ?? `${productId}, the network's own`})`
}

/** The number of requests the fixture log shows for `path`. A missing log (null) is no evidence either way. */
export function fixtureHits(log: string | null, path: string): number | null {
  if (log === null) return null
  return log.split("\n").filter((line) => line.endsWith(` GET ${path}`)).length
}

const REFUSAL = /version permission|permission[^\n]{0,40}not granted|\[permissions\][^\n]*(?:denied|refused|not granted)|build\.check[^\n]*denied/i
const HOST_VERSION = /truapi[-_ ]?host[^\n]{0,40}?v?\d+\.\d+\.\d+[^\s]*/i

/** The first lines of `log` that name the grant's refusal, trimmed: the exact refusal a blocker note has to quote. */
export function refusalLines(log: string, max = 3): string[] {
  return log.split("\n").filter((line) => REFUSAL.test(line)).slice(0, max).map((line) => line.trim().slice(0, 240))
}

/** The truapi-host version the slot log names, when it names one. */
export function hostVersionOf(slotLog: string): string | null {
  return slotLog.match(HOST_VERSION)?.[0].trim() ?? null
}

export interface StaleBuildFacts {
  /** the update screen became visible within the wait */
  shown: boolean
  /** Register buttons on the page */
  registerButtons: number
  /** the home's own text, for the detail */
  homeText: string
  /** requests the fixture served for the version file (null: no fixture log was written) */
  fixtureHits: number | null
  browserLog: string
  slotLog: string
}

/** The checks of one stale-build player. Pass takes ALL of: the update screen shown, no Register, and the version file
 *  actually read from the fixture (so the screen came from this run's fixture, never from anything else). */
export function staleBuildVerdict(n: number, f: StaleBuildFacts): Check[] {
  const refused = refusalLines(`${f.browserLog}\n${f.slotLog}`)
  const host = hostVersionOf(f.slotLog)
  const why = (): string => {
    const parts: string[] = []
    if (f.fixtureHits === 0) parts.push("the fixture was never read: the host refused (or the app never asked for) the version file's Remote grant")
    else if (f.fixtureHits === null) parts.push("no fixture log: the fixture server did not run")
    else parts.push(`the fixture was read ${f.fixtureHits} time(s) but the app did not judge its build stale`)
    parts.push(refused.length ? `refusal: ${refused.map((l) => JSON.stringify(l)).join(" | ")}` : "no refusal line in the browser or slot log")
    parts.push(`truapi-host ${host ?? "version not in the slot log"}`)
    return parts.join("; ")
  }
  const served = f.fixtureHits !== null && f.fixtureHits > 0
  return [
    {
      name: `player ${n} stale build shows the update screen`,
      status: f.shown && served ? "pass" : "fail",
      detail: f.shown && served
        ? `"${f.homeText.slice(0, 80)}" after ${f.fixtureHits} fixture read(s)`
        : f.shown
          ? `the update screen showed but the fixture served no version file (${f.fixtureHits === null ? "no fixture log" : "0 reads"}): not this run's proof`
          : `no update screen within 60 s; the home says "${f.homeText.slice(0, 120)}"; ${why()}`,
    },
    {
      name: `player ${n} stale build offers no Register`,
      status: f.registerButtons === 0 ? "pass" : "fail",
      detail: f.registerButtons === 0 ? "no Register button" : `${f.registerButtons} Register button(s) on a stale build`,
    },
  ]
}
