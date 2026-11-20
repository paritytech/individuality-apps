// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { readFileSync, readdirSync } from "node:fs"

const script = join(__dirname, "determine-domain.sh")
const PREVIEW = { SUFFIX: ".testnet", STAGING_SUFFIX: "", DEPLOY_ENV: "preview" }
const PASEO = { SUFFIX: ".paseo", STAGING_SUFFIX: "next", DEPLOY_ENV: "paseo-next-v2" }

function spawn(env: Record<string, string>) {
  return spawnSync("bash", [script], { env: { PATH: process.env.PATH ?? "", DOTNS_DOMAIN: "my-game", TARGET: "", ...env }, encoding: "utf8" })
}

function run(env: Record<string, string>) {
  const r = spawn(env)
  expect(r.status, r.stderr).toBe(0)
  return Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=")))
}

describe("determine-domain", () => {
  it("previewnet PR: a sandbox name, compiled as the release name", () => {
    expect(run({ ...PREVIEW, EVENT: "pull_request", PR_NUMBER: "433" })).toEqual({
      label: "my-game-pr433-sandbox00",
      dotns: "my-game-pr433-sandbox00.testnet",
      product: "my-game.testnet",
      staging: "",
    })
  })

  it("paseo PR: a sandbox name, compiled as itself", () => {
    expect(run({ ...PASEO, EVENT: "pull_request", PR_NUMBER: "433" })).toEqual({
      label: "my-game-pr433-sandbox00",
      dotns: "my-game-pr433-sandbox00.paseo",
      product: "my-game-pr433-sandbox00.paseo",
      staging: "",
    })
  })

  it("push main: the release name on previewnet, and the staging name built as the release name on paseo", () => {
    expect(run({ ...PREVIEW, EVENT: "push" })).toEqual({ label: "my-game", dotns: "my-game.testnet", product: "my-game.testnet", staging: "1" })
    expect(run({ ...PASEO, EVENT: "push" })).toEqual({ label: "my-gamenext", dotns: "my-gamenext.paseo", product: "my-game.paseo", staging: "1" })
  })

  it("a release dispatch publishes paseo under the release name itself", () => {
    expect(run({ ...PASEO, EVENT: "workflow_dispatch", TARGET: "release" })).toEqual({
      label: "my-game",
      dotns: "my-game.paseo",
      product: "my-game.paseo",
      staging: "",
    })
  })

  it("a PR never shares the main build's source-hash inputs", () => {
    const pr = run({ ...PREVIEW, EVENT: "pull_request", PR_NUMBER: "1" })
    const main = run({ ...PREVIEW, EVENT: "push" })
    expect(pr.product).toBe(main.product)
    expect(pr.dotns).not.toBe(main.dotns)
    const wf = readFileSync(join(__dirname, "../../.github/workflows/deploy.yml"), "utf8")
    expect(wf).toContain(`"$PRODUCT" "$DEPLOY_ENV" "$DOTNS"`)
  })

  it("refuses a DOTNS_DOMAIN that is not a bare label", () => {
    for (const DOTNS_DOMAIN of ["", "my-game.paseo", "My-Game", "-game"]) {
      const r = spawn({ ...PASEO, EVENT: "push", DOTNS_DOMAIN })
      expect(r.status, DOTNS_DOMAIN).not.toBe(0)
      expect(r.stdout, DOTNS_DOMAIN).toBe("")
    }
  })

  it("the deploy and release machinery take every name from DOTNS_DOMAIN_JOLLITY", () => {
    const root = join(__dirname, "../..")
    const files = [".github/workflows/deploy.yml", ".github/workflows/release.yml", "scripts/sync-manifest.mts", ...readdirSync(__dirname).filter((f) => !f.endsWith(".test.ts")).map((f) => `scripts/ci/${f}`)]
    for (const file of files) expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(/dim2/i)
  })

  it("exits non-zero on missing input instead of printing empty outputs", () => {
    const r = spawnSync("bash", [script], { env: { PATH: process.env.PATH ?? "", EVENT: "push" }, encoding: "utf8" })
    expect(r.status).not.toBe(0)
  })
})
