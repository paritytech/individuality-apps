// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { localEnv } from "../../../packages/jollity-protocol/src/local-network.fixture"
import { chatRelease } from "./build-config.mjs"

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../jollity-app/package.json"), "utf8"))

describe("chat build release", () => {
  it("uses the same package-version fallback as the app build", () => {
    expect(chatRelease({})).toBe(`jollity@${version}`)
    expect(chatRelease({ NEXT_PUBLIC_APP_VERSION: "source-hash" })).toBe("jollity@source-hash")
  })
})

describe("chat env files", () => {
  function fromFile(values, overrides = {}) {
    const fixture = mkdtempSync(join(tmpdir(), "jollity-chat-env-"))
    try {
      writeFileSync(join(fixture, ".env.production.local"), Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"))
      const shell = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NEXT_PUBLIC_") && !name.startsWith("__NEXT")))
      return spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { loadChatEnvironment } from ${JSON.stringify(new URL("./build-config.mjs", import.meta.url).href)};
        loadChatEnvironment(process.argv[1]);
        console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("NEXT_PUBLIC_")))));
      `, fixture], { env: { ...shell, NODE_ENV: "production", ...overrides }, encoding: "utf8" })
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }
  it("reads local settings from the app production env file and lets the shell win", () => {
    const result = fromFile(localEnv, { NEXT_PUBLIC_PEOPLE_WS: "ws://localhost:9999" })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ...localEnv, NEXT_PUBLIC_PEOPLE_WS: "ws://localhost:9999" })
  })
  it("validates settings read only from the app env file", () => {
    const values = { ...localEnv }
    delete values.NEXT_PUBLIC_ASSET_HUB_GENESIS
    const result = fromFile(values)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("NEXT_PUBLIC_ASSET_HUB_GENESIS")
  })
})

describe("hosted worker environment", () => {
  it.each(["paseo", "previewnet"])("keeps %s shell settings and ignores app env files", (network) => {
    const fixture = mkdtempSync(join(tmpdir(), "jollity-hosted-env-"))
    try {
      writeFileSync(join(fixture, ".env.production.local"), "NEXT_PUBLIC_NETWORK_NAME=local\nNEXT_PUBLIC_PEOPLE_WS=ws://file-only\nNEXT_PUBLIC_PRIZE_UNIT=FILE\n")
      const shell = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NEXT_PUBLIC_") && !name.startsWith("__NEXT")))
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { loadChatEnvironment } from ${JSON.stringify(new URL("./build-config.mjs", import.meta.url).href)};
        loadChatEnvironment(process.argv[1]);
        console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("NEXT_PUBLIC_")))));
      `, fixture], { env: { ...shell, NODE_ENV: "production", NEXT_PUBLIC_NETWORK_NAME: network }, encoding: "utf8" })
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ NEXT_PUBLIC_NETWORK_NAME: network })
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
  it.each(["paseo", "previewnet"])("does not select %s from an env file when the shell has no network", (network) => {
    const fixture = mkdtempSync(join(tmpdir(), "jollity-unset-env-"))
    try {
      writeFileSync(join(fixture, ".env.production.local"), `NEXT_PUBLIC_NETWORK_NAME=${network}\nNEXT_PUBLIC_PRIZE_UNIT=FILE\n`)
      const shell = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NEXT_PUBLIC_") && !name.startsWith("__NEXT")))
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { loadChatEnvironment } from ${JSON.stringify(new URL("./build-config.mjs", import.meta.url).href)};
        loadChatEnvironment(process.argv[1]);
        console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("NEXT_PUBLIC_")))));
      `, fixture], { env: { ...shell, NODE_ENV: "production" }, encoding: "utf8" })
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({})
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
