// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The page's view of lib/release/stale-build.ts, kept up by
 * lib/release/stale-build-watch.ts: while `active` (the page passes it from
 * app open, once the permission gate has finished so the version file's host
 * dialog never competes with the gate's own, until the gate is moot,
 * lib/home-gate buildCheckWanted) it asks until the answer is definite,
 * backing off, paused while the page is hidden. Leaving the page stops it.
 *
 * ASKED AGAIN FOR AN ENTRY (#1102). A "current" from the app open can be
 * minutes old when the player goes into a game, and a release can land in
 * those minutes. A new `asking` key (the game the
 * device is about to go into, lib/home-gate entryRecheck) starts the watch
 * over, so the file is read again, and the answer names the key it was asked
 * for (`askedFor`) so the handover can wait for its own. An attempt that
 * cannot tell keeps the standing answer, as the watch's foreground recheck
 * does. A denied grant is not asked again on a new key: that would raise the
 * host's dialog again, and a denial already fails open.
 *
 * With no version file (the gate is off) every key is answered at once with
 * "unknown", so nothing waits on a check that never runs.
 *
 * The answer is reported as the `build.stale` scope tag ("true", "false" or
 * "unknown"), which every error and every transaction sent after it carries;
 * it moves to the definite answer when that arrives. While it is "unknown",
 * `build.check` says why ("denied" or "failed"). The number of retries
 * it took is the `build.check_retries` count.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { pageHidden, watchPageHidden } from "../page-lifecycle"
import { requestVersionGrant } from "../permissions"
import { recordCount } from "../telemetry/metrics"
import { setScopeTags } from "../telemetry/scope-tags"
import { APP_VERSION, BUILD_TIME, LOG_PRODUCT } from "../debug/flag"
import { checkBuild, type BuildAnswer, type BuildState } from "./stale-build"
import { watchBuild } from "./stale-build-watch"

const VERSION_URL = process.env.NEXT_PUBLIC_VERSION_URL ?? ""
const TAG = { stale: "true", current: "false", unknown: "unknown" } as const

export function useStaleBuild(active: boolean, asking?: number): BuildAnswer {
  const [answer, setAnswer] = useState<BuildAnswer>({ state: "unknown" })
  const standing = useRef<BuildState>("unknown")
  // a refusal keeps the key it was refused on: no new dialog for a new one
  const key = answer.last === "denied" ? answer.askedFor : asking
  // no version file: the gate is off, and every key is answered at once
  const off = useMemo<BuildAnswer | null>(
    () => (VERSION_URL || !active ? null : { state: "unknown", last: "unknown", askedFor: asking }),
    [active, asking],
  )
  useEffect(() => {
    if (!active || !VERSION_URL) return
    return watchBuild({
      check: (signal) =>
        checkBuild({
          url: VERSION_URL,
          product: LOG_PRODUCT,
          version: APP_VERSION,
          time: BUILD_TIME,
          grant: () => requestVersionGrant(VERSION_URL),
          signal,
        }),
      onResult: (next, attempts, reason) => {
        // a recheck that cannot tell is quiet over a definite answer
        if (next !== "unknown" || standing.current === "unknown") {
          standing.current = next
          // an unknown says why: the host refused the grant, or the read failed
          setScopeTags({ "build.stale": TAG[next], "build.check": next === "unknown" ? reason : undefined })
        }
        // the retries it took to get a definite answer, tagged with it
        if (next !== "unknown" && attempts > 1) recordCount("build.check_retries", attempts - 1, { "build.stale": TAG[next] })
        setAnswer({ state: standing.current, last: reason === "denied" ? "denied" : next, askedFor: key })
      },
      isHidden: pageHidden,
      watchHidden: watchPageHidden,
    })
  }, [active, key])
  return off ?? answer
}
