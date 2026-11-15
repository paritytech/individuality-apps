// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Debug logging — the master switch, read at build time.
 *
 * ON by default, production builds included (it is NOT gated on `NODE_ENV`).
 * Everything that records what happened on a player's device rides on it:
 *  - the on-device debug log, kept in host storage, and the hidden debug sheet
 *    (5 taps at the top of the screen, or Cmd/Ctrl+D) that shows, copies and
 *    exports it;
 *  - with a Sentry DSN, the breadcrumbs on every event and the end-of-game
 *    logs (lib/telemetry/game-log.ts), which are built from the same lines.
 * So a deployment that sets a DSN and wants game logs needs it on.
 *
 * `NEXT_PUBLIC_DEBUG_LOGS=0` turns all of it off: devLog becomes a no-op and,
 * being a build-time constant, every `if (DEBUG_LOGS)` branch and the debug UI
 * fold away. Sentry's events, spans and metrics still go when a DSN is set.
 * What the log holds is listed in docs/telemetry.md.
 */
export const DEBUG_LOGS = process.env.NEXT_PUBLIC_DEBUG_LOGS !== "0"

/** Build stamp carried on every stored entry, so a log line is attributable to
 *  a build on its own. Baked from package.json in next.config.ts. */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"

const BUILD_COMMIT_PREFIX = "jollity-build-commit:"

/** The exact commit a build came from (NEXT_PUBLIC_BUILD_COMMIT, set by a
 * release build), as an explicit marker so an exported log names its build. */
export const BUILD_COMMIT = process.env.NEXT_PUBLIC_BUILD_COMMIT ?? `${BUILD_COMMIT_PREFIX}dev`

/** Human-readable provenance label for the debug sheet. */
export function buildCommitShort(buildCommit = BUILD_COMMIT): string {
  if (!buildCommit.startsWith(BUILD_COMMIT_PREFIX)) return "unknown"

  const value = buildCommit.slice(BUILD_COMMIT_PREFIX.length)
  return value ? value.slice(0, 12) : "unknown"
}

/** The built commit's time, unix seconds (NEXT_PUBLIC_BUILD_TIME, set by a
 *  release build): the build's place in order, which APP_VERSION's hash has
 *  not. Undefined when unset, as on a dev build. */
export const BUILD_TIME: number | undefined = (() => {
  const time = Number(process.env.NEXT_PUBLIC_BUILD_TIME)
  return process.env.NEXT_PUBLIC_BUILD_TIME && Number.isFinite(time) ? time : undefined
})()

/** A label for which deployment these logs came from, in the export meta and
 *  Sentry's `product` tag: NEXT_PUBLIC_PRODUCT_DOTNS, else the same default
 *  as lib/game-source.ts. A label only; the account the app plays as does not
 *  come from it. */
export const LOG_PRODUCT = process.env.NEXT_PUBLIC_PRODUCT_DOTNS ?? "dim2.testnet"
