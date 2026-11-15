// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import nextEnv from "@next/env"
import { resolveLocalNetwork } from "../../../packages/jollity-protocol/src/local-network.mjs"

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../jollity-app/package.json"), "utf8"))

/** Match next.config.ts: CI's source hash wins, local builds use the app package version. */
export function chatRelease(env = process.env) {
  return `jollity@${env.NEXT_PUBLIC_APP_VERSION || version}`
}

/** Apply the app production env files only when they select local. Hosted builds stay shell-only. */
export function loadChatEnvironment(appDir = resolve(import.meta.dirname, "../../jollity-app")) {
  const selected = process.env.NEXT_PUBLIC_NETWORK_NAME
  if (selected !== undefined && selected !== "local") return
  const shell = { ...process.env }
  let useLocal = false
  try {
    nextEnv.loadEnvConfig(appDir, false)
    if (process.env.NEXT_PUBLIC_NETWORK_NAME === "local") {
      resolveLocalNetwork(process.env)
      useLocal = true
    }
  } finally {
    if (!useLocal) {
      for (const name of Object.keys(process.env)) if (!(name in shell)) delete process.env[name]
      Object.assign(process.env, shell)
    }
  }
}
