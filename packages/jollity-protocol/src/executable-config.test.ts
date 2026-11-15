// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { localEnv } from "./local-network.fixture"

const root = resolve(import.meta.dirname, "../../..")
const shell = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NEXT_PUBLIC_") && !name.startsWith("__NEXT")))
const required = Object.keys(localEnv).filter((name) => name !== "NEXT_PUBLIC_NETWORK_NAME")
const malformed: Record<string, string> = {
  NEXT_PUBLIC_PEOPLE_WS: "https://localhost",
  NEXT_PUBLIC_PEOPLE_GENESIS: "0x1234",
  NEXT_PUBLIC_ASSET_HUB_WS: "ws://user:pass@localhost",
  NEXT_PUBLIC_ASSET_HUB_GENESIS: "not-a-hash",
  NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL: "not-a-url",
  NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS: "1,NaN",
}
function config(executable: string, values: Record<string, string>) {
  const args = executable === "app" ? ["--input-type=module", "-e", `
    import loadConfig from "next/dist/server/config.js";
    await loadConfig.default("phase-production-build", process.cwd());
  `] : [resolve(root, "apps/jollity-worker/scripts/build.mjs")]
  return spawnSync(process.execPath, args, {
    cwd: resolve(root, "apps/jollity-app"),
    env: { ...shell, ...values, PRODUCT_DOTNS: "local" }, encoding: "utf8",
  })
}
describe.each(["app", "worker"])("%s config boundary", (executable) => {
  it.each(required)("rejects missing, blank and malformed %s before bundling", (name) => {
    for (const value of [undefined, "", "   ", malformed[name]]) {
      const env: Record<string, string> = { ...localEnv }
      if (value === undefined) delete env[name]
      else env[name] = value
      const result = config(executable, env)
      expect(result.status, result.stderr).not.toBe(0)
      expect(result.stderr).toContain(name)
    }
  }, 30_000)
  if (executable === "app") {
    it("accepts local values and the existing hosted networks", () => {
      for (const env of [localEnv, { NEXT_PUBLIC_NETWORK_NAME: "paseo" }, { NEXT_PUBLIC_NETWORK_NAME: "previewnet" }]) {
        const result = config(executable, env)
        expect(result.status, result.stderr).toBe(0)
      }
    }, 30_000)
  }
})
