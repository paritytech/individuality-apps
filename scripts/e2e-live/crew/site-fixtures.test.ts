// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { loadCrewCatalogue } from "./catalogue"
import { validatePublicRunRecord, validatePublicSuiteRecord, type PublicRunRecord, type PublicSuiteRecord } from "./run-record"
import { generateCrewSite } from "./site"

const here = new URL(".", import.meta.url)
const portraitDir = new URL("./portraits/", here)
const catalogue = loadCrewCatalogue()
const json = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, here), "utf8")) as T

const files = (root: string, at = root): string[] => readdirSync(at).flatMap((name) => {
  const path = join(at, name)
  return statSync(path).isDirectory() ? files(root, path) : [relative(root, path)]
}).sort()

describe("generated crew-site fixture tree", () => {
  it("contains only public JSON, HTML, CSS, JS, WebP portraits, and .nojekyll", () => {
    const run = json<PublicRunRecord>("nightly-pass")
    const identity = catalogue.identities.find(({ key }) => key === run.identity?.key)!
    const digest = createHash("sha256").update(readFileSync(new URL(identity.portrait, portraitDir))).digest("hex")
    run.identity = { ...run.identity!, portraitFile: identity.portrait, portraitSha256: digest, portraitPath: `assets/portraits/by-sha256/${digest}.webp` }
    const suite = json<PublicSuiteRecord>("suite-completed")
    const stateDir = mkdtempSync(join(tmpdir(), "crew-site-fixtures-state-"))
    mkdirSync(join(stateDir, "data", "runs"), { recursive: true })
    mkdirSync(join(stateDir, "data", "suites"), { recursive: true })
    writeFileSync(join(stateDir, "data", "runs", `${run.key}.json`), JSON.stringify(validatePublicRunRecord(run)))
    writeFileSync(join(stateDir, "data", "suites", `${suite.key}.json`), JSON.stringify(validatePublicSuiteRecord(suite)))
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-fixtures-output-"))
    const written = generateCrewSite({ stateDir, outputDir, catalogue, portraitDir, now: new Date("2026-10-18T07:30:00.000Z") })
    expect(written).toEqual(files(outputDir))
    expect(written).toContain("index.html")
    expect(written).toContain("assets/site.css")
    expect(written).toContain("assets/status.js")
    expect(readFileSync(join(outputDir, "assets/status.js"))).toEqual(readFileSync(new URL("./status.js", here)))
    expect(written).toContain(".nojekyll")
    expect(written.filter((path) => path.startsWith("identities/") && path.endsWith("/index.html"))).toHaveLength(30)
    expect(written.every((path) => /(?:\.html|\.css|\.js|\.json|\.webp|\.nojekyll)$/.test(path))).toBe(true)
    expect(written.some((path) => /\.(?:mp4|webm|mov|avi|mkv|mp3|wav)$/i.test(path))).toBe(false)
  })

  it("keeps a historical portrait when the current file with that name has changed", () => {
    const run = json<PublicRunRecord>("nightly-pass")
    const current = catalogue.identities.find(({ key }) => key === run.identity?.key)!
    const historical = catalogue.identities.find(({ key }) => key !== current.key)!
    const historicalBytes = readFileSync(new URL(historical.portrait, portraitDir))
    const historicalDigest = createHash("sha256").update(historicalBytes).digest("hex")
    run.identity = { ...run.identity!, portraitFile: current.portrait, portraitSha256: historicalDigest, portraitPath: `assets/portraits/by-sha256/${historicalDigest}.webp` }
    const suite = json<PublicSuiteRecord>("suite-completed")
    const stateDir = mkdtempSync(join(tmpdir(), "crew-site-history-state-"))
    mkdirSync(join(stateDir, "data", "runs"), { recursive: true })
    mkdirSync(join(stateDir, "data", "suites"), { recursive: true })
    mkdirSync(join(stateDir, "assets", "portraits", "by-sha256"), { recursive: true })
    writeFileSync(join(stateDir, "data", "runs", `${run.key}.json`), JSON.stringify(validatePublicRunRecord(run)))
    writeFileSync(join(stateDir, "data", "suites", `${suite.key}.json`), JSON.stringify(validatePublicSuiteRecord(suite)))
    writeFileSync(join(stateDir, run.identity.portraitPath), historicalBytes)
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-history-output-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir, now: new Date("2026-10-18T07:30:00.000Z") })
    const currentDigest = createHash("sha256").update(readFileSync(new URL(current.portrait, portraitDir))).digest("hex")
    expect(readFileSync(join(outputDir, run.identity.portraitPath))).toEqual(historicalBytes)
    expect(existsSync(join(outputDir, "assets", "portraits", "by-sha256", `${currentDigest}.webp`))).toBe(true)
  })

  it("fails closed rather than replacing a corrupt content-addressed portrait", () => {
    const run = json<PublicRunRecord>("nightly-pass")
    const identity = catalogue.identities.find(({ key }) => key === run.identity?.key)!
    const bytes = readFileSync(new URL(identity.portrait, portraitDir))
    const portraitSha256 = createHash("sha256").update(bytes).digest("hex")
    run.identity = { ...run.identity!, portraitFile: identity.portrait, portraitSha256, portraitPath: `assets/portraits/by-sha256/${portraitSha256}.webp` }
    const suite = json<PublicSuiteRecord>("suite-completed")
    const stateDir = mkdtempSync(join(tmpdir(), "crew-site-corrupt-state-"))
    mkdirSync(join(stateDir, "data", "runs"), { recursive: true })
    mkdirSync(join(stateDir, "data", "suites"), { recursive: true })
    mkdirSync(join(stateDir, "assets", "portraits", "by-sha256"), { recursive: true })
    writeFileSync(join(stateDir, "data", "runs", `${run.key}.json`), JSON.stringify(validatePublicRunRecord(run)))
    writeFileSync(join(stateDir, "data", "suites", `${suite.key}.json`), JSON.stringify(validatePublicSuiteRecord(suite)))
    writeFileSync(join(stateDir, run.identity.portraitPath), "not the portrait")
    expect(() => generateCrewSite({ stateDir, outputDir: mkdtempSync(join(tmpdir(), "crew-site-corrupt-output-")), catalogue, portraitDir, now: new Date("2026-10-18T07:30:00.000Z") })).toThrow(/digest does not match/)
  })
})
