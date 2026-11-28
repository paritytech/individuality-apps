// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

export function main(argv = process.argv.slice(2), activeRunsJson = process.env.ACTIVE_NIGHTLY_RUNS ?? "[]"): void {
  if (argv.length !== 1 || argv[0] !== "manual") throw new Error("usage: nightly-window-cli.mts manual")
  const activeRuns: unknown = JSON.parse(activeRunsJson)
  if (!Array.isArray(activeRuns)) throw new Error("active nightly runs must be a JSON array")
  if (activeRuns.length > 0) throw new Error("a complete PreviewNet crew suite is queued or in progress")
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) {
    console.error(`nightly window admission failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
