// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { botSet, guardConsole, isSs58, PlayerPrivacy, playerLabel } from "./player-privacy"

// dev-keyring accounts (public test keys): Alice plays the person, Bob and Charlie are bots
const PERSON = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
const BOT = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"
const RUN_BOT = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y"
const PROFILES = { profiles: [{ identity: { previewnet: "botbase.12" } }] }
const PERSONAS = { personas: [{ base: "personabot" }] }
const ENV = {
  GITHUB_ACTIONS: "true",
  E2E_IDENTITIES: JSON.stringify({ "poolbot.03": BOT }),
  E2E_RUN_BOT_ACCOUNTS: JSON.stringify([RUN_BOT]),
}
const guard = () => {
  const lines: string[] = []
  return { lines, privacy: new PlayerPrivacy(botSet(PROFILES, PERSONAS, ENV), ENV, (line) => void lines.push(line)) }
}

describe("other players in public logs", () => {
  it("knows a valid SS58 account", () => {
    expect(isSs58(PERSON)).toBe(true)
    expect(isSs58(PERSON.slice(0, -1) + "Z")).toBe(false)
  })
  it("masks a planted non-bot account and its short form the moment it is seen", () => {
    const { lines, privacy } = guard()
    privacy.see(PERSON)
    expect(lines).toEqual([`::add-mask::${PERSON}\n`, `::add-mask::${PERSON.slice(0, 8)}\n`])
  })
  it("masks a planted non-bot username, and never a bot's", () => {
    const { lines, privacy } = guard()
    privacy.seeIn(`co-players: somehuman.42, botbase.12, botbase.77, personabot.05, poolbot.03, ${BOT} and ${RUN_BOT}`)
    expect(lines).toEqual(["::add-mask::somehuman.42\n"])
  })
  it("prints nothing outside GitHub Actions, but still labels", () => {
    const lines: string[] = []
    const privacy = new PlayerPrivacy(botSet(PROFILES, PERSONAS, {}), {}, (line) => void lines.push(line))
    privacy.see(PERSON)
    expect(lines).toEqual([])
    expect(privacy.redact(PERSON)).toBe(playerLabel(PERSON))
  })
  it("masks what a guarded console prints before it is printed", () => {
    const { lines, privacy } = guard()
    const printed: string[] = []
    const target = { log: (...a: unknown[]) => void printed.push(a.join(" ")), info: () => undefined, warn: () => undefined, error: () => undefined }
    guardConsole(privacy, target)
    target.log("round 1", { who: PERSON })
    expect(lines[0]).toBe(`::add-mask::${PERSON}\n`)
    expect(printed).toHaveLength(1)
  })
})

describe("other players in uploaded files", () => {
  it("replaces a non-bot account, its short form and a username with one stable label, and leaves the bots", () => {
    const { privacy } = guard()
    const text = `| ${PERSON} | 3 |\nround 1 ${PERSON.slice(0, 8)} (human)=NotPerson\nseen somehuman.42\nbot ${BOT} ${RUN_BOT.slice(0, 8)} botbase.12`
    privacy.seeIn(text)
    const out = privacy.redact(text)
    expect(out).not.toContain(PERSON.slice(0, 8))
    expect(out).not.toContain("somehuman.42")
    expect(out).toContain(`| ${playerLabel(PERSON)} | 3 |`)
    expect(out).toContain(`round 1 ${playerLabel(PERSON)} (human)`)
    expect(out).toContain(playerLabel("somehuman.42"))
    expect(out).toContain(`bot ${BOT} ${RUN_BOT.slice(0, 8)} botbase.12`)
    expect(privacy.seen).toBe(2)
  })
  it("does not touch a short form inside a longer token", () => {
    const { privacy } = guard()
    privacy.see(PERSON)
    expect(privacy.redact(`cid-${PERSON.slice(0, 8)}xyz`)).toBe(`cid-${PERSON.slice(0, 8)}xyz`)
  })

  const root = mkdtempSync(join(tmpdir(), "redact-players-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  it("redact-players.mts rewrites a planted person in every text file and masks it", () => {
    mkdirSync(join(root, "bot-1"), { recursive: true })
    writeFileSync(join(root, "bot-1/result-1.json"), JSON.stringify({ username: "poolbot.03", groups: [{ with: [PERSON, BOT] }] }))
    writeFileSync(join(root, "bot-1/summary.md"), `- seen by poolbot.03: ${PERSON.slice(0, 8)} and plantedhuman.07\n`)
    writeFileSync(join(root, "bot-1/video-1.webm"), PERSON)
    const run = spawnSync(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "redact-players.mts"), root], { encoding: "utf8", env: { ...process.env, ...ENV } })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(`::add-mask::${PERSON}`)
    expect(run.stdout).toContain("::add-mask::plantedhuman.07")
    expect(run.stdout).toMatch(/2 other player\(s\), 2 file\(s\) rewritten/)
    const result = readFileSync(join(root, "bot-1/result-1.json"), "utf8")
    const summary = readFileSync(join(root, "bot-1/summary.md"), "utf8")
    expect(result).not.toContain(PERSON)
    expect(result).toContain(BOT)
    expect(result).toContain("poolbot.03")
    expect(summary).toBe(`- seen by poolbot.03: ${playerLabel(PERSON)} and ${playerLabel("plantedhuman.07")}\n`)
    // media is not text: left alone (recordings are covered by the publication review instead)
    expect(readFileSync(join(root, "bot-1/video-1.webm"), "utf8")).toBe(PERSON)
  })
})
