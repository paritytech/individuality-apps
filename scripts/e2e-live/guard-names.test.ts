// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// A guard that names a signal the app never emits can only fail (or, worse, be read as a pass someday): every
// non-pending metric and event guard of every profile must be a name the app's own source emits.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfiles } from "./profile"

const LIB = resolve(__dirname, "../../apps/jollity-app/lib")
// the shared flows the app runs with its own telemetry (the sign-up's metrics are recorded there)
const PACKAGES = resolve(__dirname, "../../packages")
const SHARED = readdirSync(PACKAGES).filter((name) => name.startsWith("individuality-")).map((name) => join(PACKAGES, name, "src"))
const BOT_INJECTION = resolve(__dirname, "browser-profile.ts")
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [readFileSync(p, "utf8")] : []
  })
const app = [...sources(LIB), ...SHARED.flatMap(sources), readFileSync(BOT_INJECTION, "utf8")].join("\n")

describe("guard names are the app's own", () => {
  const guards = loadProfiles().flatMap((p) => p.expect.flatMap((g) => (!g.pending && (g.kind === "metric" || g.kind === "event") ? [[`${p.name}: ${g.kind} ${g.name}`, g.kind, g.name] as const] : [])))
  it.each(guards)("%s", (_label, kind, name) => {
    // a metric is recorded under a quoted name (some in tables, like rtc-quality's); an event is a journey or step
    // name (telemetry/journeys.ts lists the steps): both must appear as a quoted string in the app
    expect(app, `no "${name}" ${kind === "metric" ? "metric" : "journey or step"} in lib/ or the shared packages`).toContain(`"${name}"`)
  })
})

// A store-rejection guard names a reason the statement store gives: the app's own engine must handle it by that name.
const ENGINE = resolve(__dirname, "../../packages/jollity-statement-core/src")
const engine = sources(ENGINE).join("\n")
describe("store-rejection reasons are the store's own", () => {
  const guards = loadProfiles().flatMap((p) => p.expect.flatMap((g) => (!g.pending && g.kind === "store-rejection" ? [[`${p.name}: ${g.reason}`, g.reason] as const] : [])))
  it.each(guards)("%s", (_label, reason) => {
    expect(engine, `no "${reason}" in packages/jollity-statement-core: the app does not know this refusal`).toContain(reason)
  })
})

// A devlog guard counts the app's own log lines: its match must be text the app logs (the mesh's [jollity-rtc] lines and the like).
describe("devlog matches are the app's own lines", () => {
  const guards = loadProfiles().flatMap((p) => p.expect.flatMap((g) => (!g.pending && g.kind === "devlog" ? [[`${p.name}: ${g.match}`, g.match] as const] : [])))
  it.each(guards)("%s", (_label, match) => {
    expect(app, `no "${match}" in lib/ or the bot's injected fault source: the app never logs it`).toContain(match)
  })
})
