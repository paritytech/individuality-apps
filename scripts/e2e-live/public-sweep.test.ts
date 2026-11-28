// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { buildAllowlist, buildPrivateTerms, buildUserMap, scanText, ss58PublicKey, subRuns } from "./public-sweep-rules"

// Every forbidden value below is assembled at run time, so this file passes its own sweep.
const join2 = (...parts: string[]) => parts.join("")
const ALLOW = buildAllowlist({ profiles: [{ identity: { previewnet: "botbase.12" } }, { identity: "solobot.3" }] }, { personas: [{ base: "personabot" }] })
// a synthetic map: two invented people and two bots, with valid SS58 addresses (Alice and Bob of the dev keyring)
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"
const USERS = buildUserMap({ [ALICE]: "realperson.07", [BOB]: "botbase.44", "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy": "otherhuman.०६" })

describe("the sweep's matching", () => {
  it("splits a token into every run of its parts", () => {
    expect(subRuns("a-b.c")).toEqual(["a", "a-b", "a-b.c", "b", "b.c", "c"])
  })
  it("reads the public key of an SS58 address", () => {
    expect(ss58PublicKey(ALICE)).toBe("d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d")
    expect(ss58PublicKey("not-an-address")).toBeNull()
  })
  it("allows the bots' own identities and their bases, and nothing else", () => {
    expect(ALLOW.names.has("botbase.12")).toBe(true)
    expect(ALLOW.bases.has("personabot")).toBe(true)
    expect(scanText("f", "player botbase.44 and personabot.9", ALLOW, USERS)).toEqual([])
  })
  it("finds a real username, even inside a longer token or with non-Latin digits", () => {
    const hits = scanText("f", `x ${join2("realperson", ".07")}-copy\ny ${join2("otherhuman", ".०६")}`, ALLOW, USERS)
    expect(hits.map((h) => [h.line, h.category])).toEqual([[1, "player username"], [2, "player username"]])
  })
  it("finds a real player's account as SS58 or as its hex public key, never a bot's", () => {
    const hex = ss58PublicKey(ALICE)!
    const hits = scanText("f", `${ALICE}\n0x${hex}\n${BOB}`, ALLOW, USERS)
    expect(hits.map((h) => [h.line, h.category])).toEqual([[1, "player account"], [2, "player account"]])
  })
  it("finds a term from the private terms file inside a longer token", () => {
    const terms = buildPrivateTerms({ terms: [{ term: join2("secret", "box"), category: "private host" }] })
    const hits = scanText("f", `ssh ${join2("Secret", "Box")}-07:/srv`, ALLOW, undefined, terms)
    expect(hits.map((h) => h.category)).toEqual(["private host"])
    expect(scanText("f", "ssh otherbox", ALLOW, undefined, terms)).toEqual([])
  })
  it("skips the player check without a map, and still runs the rest", () => {
    expect(scanText("f", join2("realperson", ".07"), ALLOW)).toEqual([])
    expect(scanText("f", join2("/ho", "me/someone/x"), ALLOW).map((h) => h.category)).toEqual(["home path"])
  })
  it("finds home paths, private addresses, board ids and DSNs, and never prints the value", () => {
    const text = [
      join2("/Us", "ers/someone/repo"),
      join2("~/Git", "Hub/thing"),
      join2("10", ".1.2.3"),
      join2("M-2026", "1101-1200-abc"),
      join2("https://", "0123456789abcdef0123", "@o", "123456", ".ingest.example.io/1"),
    ].join("\n")
    const hits = scanText("f", text, ALLOW)
    expect(hits.map((h) => h.category)).toEqual(["home path", "home path", "private address", "board message id", "sentry dsn", "sentry org id"])
    for (const hit of hits) expect(text).not.toContain(hit.tag)
  })
})

describe("the CLI on a planted copy", () => {
  const root = mkdtempSync(join(tmpdir(), "public-sweep-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const repo = resolve(import.meta.dirname, "../..")
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "public-sweep.mts"), "--root", root, ...args], { encoding: "utf8" })

  it("is clean on a copy, then finds one planted name and one planted path", () => {
    mkdirSync(join(root, "scripts/e2e-live"), { recursive: true })
    for (const file of ["profiles.json", "persona-bootstrap.json", "result.ts"]) cpSync(join(repo, "scripts/e2e-live", file), join(root, "scripts/e2e-live", file))
    const map = join(root, "map.json")
    writeFileSync(map, JSON.stringify({ [ALICE]: "realperson.07" }))
    const clean = run("--usernames", map, "scripts/e2e-live")
    expect(clean.stdout).toContain("OK no hits")
    expect(clean.status).toBe(0)

    const target = join(root, "scripts/e2e-live/result.ts")
    writeFileSync(target, readFileSync(target, "utf8") + `\nconst who = "${join2("realperson", ".07")}" // ${join2("/ho", "me/someone")}\n`)
    const dirty = run("--usernames", map, "scripts/e2e-live")
    expect(dirty.status).toBe(1)
    expect(dirty.stdout).toMatch(/scripts\/e2e-live\/result\.ts:\d+: player username/)
    expect(dirty.stdout).toMatch(/scripts\/e2e-live\/result\.ts:\d+: home path/)
    expect(dirty.stdout).not.toContain(join2("realperson", ".07"))
  })
})
