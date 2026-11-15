// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// `next dev --webpack` (what an app=local dev run uses) watches every directory the app's Tailwind @source names.
// An `@source "../../.."` (the repo root) makes Fast Refresh rebuild ~140 times a minute on an idle page, until the
// app chunks time out and the stale-build check never reads the version file. This compiles the real stylesheet the
// way the app's PostCSS setup does and pins what it scans.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { compile } from "@tailwindcss/node"
import { describe, expect, it } from "vitest"

const APP = resolve(__dirname, "..")
const ROOT = resolve(APP, "../..")
const FILE = resolve(APP, "app/globals.css")

async function sources() {
  const { sources } = await compile(readFileSync(FILE, "utf8"), { base: resolve(APP, "app"), onDependency: () => {} })
  return sources.map((s) => ({ dir: resolve(s.base, s.pattern === "**/*" ? "." : s.pattern), negated: s.negated }))
}

describe("the app's Tailwind @source folders", () => {
  it("compiles, and scans the workspace packages and the worker", async () => {
    const dirs = (await sources()).filter((s) => !s.negated).map((s) => s.dir)
    expect(dirs).toContain(resolve(ROOT, "packages"))
    expect(dirs).toContain(resolve(ROOT, "apps/jollity-worker"))
  })
  it("never scans the repo root, apps/, scripts/ or the bots' output", async () => {
    for (const { dir, negated } of await sources()) {
      if (negated) continue
      for (const wide of [ROOT, resolve(ROOT, "apps"), resolve(ROOT, "scripts")]) expect(dir, "watched by next dev --webpack").not.toBe(wide)
    }
  })
})
