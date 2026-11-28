// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { loadCrewCatalogue } from "./catalogue"
import { applyPublicationBundle, type ApplyPublicationOptions } from "./publish"
import { validatePublicationBundle, validatePublicRunRecord, validatePublicSuiteRecord, type PublicationBundle, type PublicRunRecord, type PublicSuiteRecord } from "./run-record"

const here = new URL(".", import.meta.url)
const portraits = new URL("./portraits/", here)
const catalogue = loadCrewCatalogue()
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, here), "utf8")) as T

const snapshotRun = (over: Partial<PublicRunRecord> = {}): PublicRunRecord => {
  const run = fixture<PublicRunRecord>("nightly-pass")
  const identity = catalogue.identities.find(({ key }) => key === run.identity?.key)!
  const bytes = readFileSync(new URL(identity.portrait, portraits))
  const portraitSha256 = createHash("sha256").update(bytes).digest("hex")
  return validatePublicRunRecord({
    ...run,
    identity: { ...run.identity!, portraitFile: identity.portrait, portraitSha256, portraitPath: `assets/portraits/by-sha256/${portraitSha256}.webp` },
    ...over,
  })
}

const snapshotSuite = (over: Partial<PublicSuiteRecord> = {}): PublicSuiteRecord => validatePublicSuiteRecord({
  ...fixture<PublicSuiteRecord>("suite-completed"),
  ...over,
})

const startedSuite = (over: Partial<PublicSuiteRecord> = {}): PublicSuiteRecord => validatePublicSuiteRecord({
  ...fixture<PublicSuiteRecord>("suite-started"),
  ...over,
})

const bundle = (runs: PublicRunRecord[], suites: PublicSuiteRecord[] = []): PublicationBundle => validatePublicationBundle({ version: 1, runs, suites })

const options = (stateDir: string, publication: PublicationBundle, over: Partial<ApplyPublicationOptions> = {}): ApplyPublicationOptions => ({
  stateDir,
  bundle: publication,
  catalogue,
  portraitDir: portraits,
  portraitSourceDir: stateDir,
  now: new Date("2026-10-18T07:30:00.000Z"),
  ...over,
})

const tree = (root: string): Record<string, string> => {
  const walk = (directory: string): string[] => existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])
    : []
  return Object.fromEntries(walk(root).sort().map((path) => [path.slice(root.length + 1), createHash("sha256").update(readFileSync(path)).digest("hex")]))
}

describe("Crew history publication", () => {
  it("publishes the first validated bundle with durable JSON, portrait, and complete site", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-first-"))
    const run = snapshotRun()
    const suite = snapshotSuite({ observedRunKeys: [run.key] })
    const result = applyPublicationBundle(options(stateDir, bundle([run], [suite])))

    expect(result).toMatchObject({ changed: true, runs: 1, suites: 1 })
    expect(JSON.parse(readFileSync(join(stateDir, "data", "runs", `${run.key}.json`), "utf8"))).toEqual(run)
    expect(JSON.parse(readFileSync(join(stateDir, "data", "suites", `${suite.key}.json`), "utf8"))).toEqual(suite)
    expect(existsSync(join(stateDir, run.identity!.portraitPath))).toBe(true)
    expect(readFileSync(join(stateDir, "index.html"), "utf8")).toContain("PreviewNet Crew")
    expect(readFileSync(join(stateDir, "runs", run.key, "index.html"), "utf8")).toContain(run.identity!.displayName)
  })

  it("replays exactly without changing bytes and never deletes unrelated history", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-replay-"))
    const first = snapshotRun()
    applyPublicationBundle(options(stateDir, bundle([first])))
    const second = snapshotRun({ key: `${first.key}-attempt-2`, attempt: 2, artifactAttempt: 2, source: { ...first.source, artifactId: first.source.artifactId! + 1 } })
    applyPublicationBundle(options(stateDir, bundle([second])))
    const before = tree(stateDir)
    const result = applyPublicationBundle(options(stateDir, bundle([first])))
    expect(result.changed).toBe(false)
    expect(tree(stateDir)).toEqual(before)
    expect(existsSync(join(stateDir, "data", "runs", `${second.key}.json`))).toBe(true)
  })

  it("lets the latest observation replace the same logical run key", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-latest-run-"))
    const initial = snapshotRun({ failures: ["Evidence was incomplete."], result: "inconclusive", productResult: "inconclusive", infrastructure: "partial" })
    applyPublicationBundle(options(stateDir, bundle([initial])))
    const latest = validatePublicRunRecord({ ...initial, failures: [], result: "passed", productResult: "passed", infrastructure: "complete", timeline: [...initial.timeline, { at: initial.finishedAt, state: "passed", source: "outcome", action: null, text: "Evidence completed." }] })
    expect(applyPublicationBundle(options(stateDir, bundle([latest]))).changed).toBe(true)
    expect(JSON.parse(readFileSync(join(stateDir, "data", "runs", `${initial.key}.json`), "utf8"))).toEqual(latest)
    expect(applyPublicationBundle(options(stateDir, bundle([latest]))).changed).toBe(false)
  })

  it("keeps all suite attempts while the highest attempt supplies the current observation", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-suite-"))
    const first = snapshotRun()
    const suite = snapshotSuite({ observedRunKeys: [first.key] })
    applyPublicationBundle(options(stateDir, bundle([first], [suite])))
    const retry = snapshotRun({ key: `${first.key}-retry`, attempt: 2, artifactAttempt: 2, source: { ...first.source, artifactId: first.source.artifactId! + 1 } })
    const updated = snapshotSuite({ attempts: [2], latestAttempt: 2, observedRunKeys: [retry.key] })
    applyPublicationBundle(options(stateDir, bundle([retry], [updated])))
    const stored = JSON.parse(readFileSync(join(stateDir, "data", "suites", `${suite.key}.json`), "utf8")) as PublicSuiteRecord
    expect(stored.attempts).toEqual([1, 2])
    expect(stored.observedRunKeys).toEqual([retry.key])
    const beforeReplay = tree(stateDir)
    expect(applyPublicationBundle(options(stateDir, bundle([retry], [updated]))).changed).toBe(false)
    expect(tree(stateDir)).toEqual(beforeReplay)
  })

  it("lets the latest same-attempt suite observation replace an earlier state", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-suite-same-attempt-"))
    const started = startedSuite()
    applyPublicationBundle(options(stateDir, bundle([], [started])))
    const run = snapshotRun()
    const completed = snapshotSuite()
    applyPublicationBundle(options(stateDir, bundle([run], [completed])))
    const corrected = snapshotSuite({ result: "failed", productResult: "failed", failures: ["One product check failed."], totals: { passed: 0, failed: 1, inconclusive: 0, missing: 0, skipped: 0 } })
    applyPublicationBundle(options(stateDir, bundle([], [corrected])))
    expect(JSON.parse(readFileSync(join(stateDir, "data", "suites", `${started.key}.json`), "utf8"))).toEqual(corrected)
  })

  it("does not let a late same-attempt started observation erase a completion", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-suite-late-started-"))
    const run = snapshotRun()
    const completed = snapshotSuite()
    applyPublicationBundle(options(stateDir, bundle([run], [completed])))
    const before = tree(stateDir)
    expect(applyPublicationBundle(options(stateDir, bundle([], [startedSuite()]))).changed).toBe(false)
    expect(tree(stateDir)).toEqual(before)
  })

  it("ignores an older suite observation once a newer attempt is present", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-suite-order-"))
    const first = snapshotRun()
    const retry = snapshotRun({ key: `${first.key}-retry`, attempt: 2, artifactAttempt: 2, source: { ...first.source, artifactId: first.source.artifactId! + 1 } })
    const older = snapshotSuite({ observedRunKeys: [first.key] })
    const newer = snapshotSuite({ attempts: [1, 2], latestAttempt: 2, observedRunKeys: [retry.key] })
    applyPublicationBundle(options(stateDir, bundle([first, retry], [newer])))
    const before = tree(stateDir)
    expect(applyPublicationBundle(options(stateDir, bundle([], [older]))).changed).toBe(false)
    expect(tree(stateDir)).toEqual(before)
    const stored = JSON.parse(readFileSync(join(stateDir, "data", "suites", `${older.key}.json`), "utf8")) as PublicSuiteRecord
    expect(stored.latestAttempt).toBe(2)
    expect(stored.observedRunKeys).toEqual([retry.key])
    expect(stored.coverage.observed).toBe(1)
  })

  it("rejects a malformed bundle before changing any state", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-malformed-"))
    const first = snapshotRun()
    applyPublicationBundle(options(stateDir, bundle([first])))
    const before = tree(stateDir)
    const malformed = { version: 1, runs: [{ ...first, unexpected: true }], suites: [] } as unknown as PublicationBundle
    expect(() => applyPublicationBundle(options(stateDir, malformed))).toThrow(/unknown field unexpected/)
    expect(tree(stateDir)).toEqual(before)
  })

  it("rejects case-folded record-key collisions before writing files", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-casefold-"))
    const first = snapshotRun()
    const collision = snapshotRun({ key: first.key.toUpperCase(), attempt: 2, artifactAttempt: 2, source: { ...first.source, artifactId: first.source.artifactId! + 1 } })
    expect(() => applyPublicationBundle(options(stateDir, bundle([first, collision])))).toThrow(/case-fold|collision/i)
    expect(existsSync(join(stateDir, "data", "runs"))).toBe(false)
  })

  it("rolls back all writes when site generation or portrait validation fails", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-rollback-"))
    const first = snapshotRun()
    applyPublicationBundle(options(stateDir, bundle([first])))
    const before = tree(stateDir)
    const next = snapshotRun({ key: `${first.key}-bad-portrait`, attempt: 2, artifactAttempt: 2, source: { ...first.source, artifactId: first.source.artifactId! + 1 }, identity: { ...first.identity!, portraitSha256: "0".repeat(64), portraitPath: `assets/portraits/by-sha256/${"0".repeat(64)}.webp` } })
    expect(() => applyPublicationBundle(options(stateDir, bundle([next])))).toThrow(/portrait digest/i)
    expect(tree(stateDir)).toEqual(before)
  })

  it("rolls back an actual mid-replacement rename failure", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-mid-replace-"))
    const first = snapshotRun()
    applyPublicationBundle(options(stateDir, bundle([first])))
    const before = tree(stateDir)
    const second = snapshotRun({ key: `${first.key}-second`, attempt: 2, artifactAttempt: 2, source: { ...first.source, artifactId: first.source.artifactId! + 1 } })
    const renameFile: typeof renameSync = (oldPath, newPath) => {
      if (resolve(String(newPath)) === resolve(stateDir, "data", "runs") && String(oldPath).includes("stage")) throw new Error("simulated install failure")
      renameSync(oldPath, newPath)
    }
    expect(() => applyPublicationBundle(options(stateDir, bundle([second]), { renameFile }))).toThrow(/simulated install failure/)
    expect(tree(stateDir)).toEqual(before)
  })

  it("retains the recovery workspace if restoring the previous state also fails", () => {
    const parent = mkdtempSync(join(tmpdir(), "crew-publish-retained-recovery-"))
    const stateDir = join(parent, "state")
    const first = snapshotRun()
    applyPublicationBundle(options(stateDir, bundle([first])))
    const second = snapshotRun({ key: `${first.key}-second`, attempt: 2, artifactAttempt: 2, source: { ...first.source, artifactId: first.source.artifactId! + 1 } })
    let installationFailed = false
    const renameFile: typeof renameSync = (oldPath, newPath) => {
      if (!installationFailed && resolve(String(newPath)) === resolve(stateDir, "data", "runs") && String(oldPath).includes("stage")) {
        installationFailed = true
        throw new Error("simulated install failure")
      }
      if (installationFailed && String(oldPath).includes("backup/data/runs")) throw new Error("simulated restore failure")
      renameSync(oldPath, newPath)
    }
    expect(() => applyPublicationBundle(options(stateDir, bundle([second]), { renameFile }))).toThrow(/recovery workspace retained at/)
    const retained = readdirSync(parent).filter((name) => name.startsWith(".state.crew-publish-"))
    expect(retained).toHaveLength(1)
    expect(existsSync(join(parent, retained[0]!, "backup", "data", "runs", `${first.key}.json`))).toBe(true)
    // The next single writer restores the missing old tree before reading it.
    expect(() => applyPublicationBundle(options(stateDir, bundle([second])))).not.toThrow()
    expect(existsSync(join(stateDir, "data", "runs", `${first.key}.json`))).toBe(true)
    expect(existsSync(join(stateDir, "data", "runs", `${second.key}.json`))).toBe(true)
    expect(readdirSync(parent).filter((name) => name.startsWith(".state.crew-publish-"))).toEqual([])
  })

  it("renders expiry without mutating the canonical stored run record", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-expiry-"))
    const first = snapshotRun()
    applyPublicationBundle(options(stateDir, bundle([first])))
    const second = snapshotRun({ key: `${first.key}-second`, attempt: 2, artifactAttempt: 2, source: { ...first.source, artifactId: first.source.artifactId! + 1 } })
    applyPublicationBundle(options(stateDir, bundle([second]), { now: new Date("2026-11-02T07:30:00.000Z") }))
    const stored = JSON.parse(readFileSync(join(stateDir, "data", "runs", `${first.key}.json`), "utf8")) as PublicRunRecord
    expect(stored.recording.state).toBe("available")
    expect(readFileSync(join(stateDir, "runs", first.key, "index.html"), "utf8")).toContain("Video expired")
  })

  it("retains both historical portraits when a filename later resolves to new bytes", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-portrait-history-"))
    const first = snapshotRun()
    applyPublicationBundle(options(stateDir, bundle([first])))
    const oldPage = readFileSync(join(stateDir, "runs", first.key, "index.html"), "utf8")
    const source = mkdtempSync(join(tmpdir(), "crew-publish-portrait-source-"))
    const replacement = catalogue.identities.find(({ portrait }) => portrait !== first.identity!.portraitFile)!
    const changedBytes = readFileSync(new URL(replacement.portrait, portraits))
    const changedSha = createHash("sha256").update(changedBytes).digest("hex")
    const changedPath = `assets/portraits/by-sha256/${changedSha}.webp`
    mkdirSync(join(source, "assets", "portraits", "by-sha256"), { recursive: true })
    writeFileSync(join(source, changedPath), changedBytes)
    const second = snapshotRun({ key: `${first.key}-portrait-v2`, attempt: 2, artifactAttempt: 2, source: { ...first.source, artifactId: first.source.artifactId! + 1 }, identity: { ...first.identity!, portraitSha256: changedSha, portraitPath: changedPath } })
    applyPublicationBundle(options(stateDir, bundle([second]), { portraitSourceDir: source }))
    expect(existsSync(join(stateDir, first.identity!.portraitPath))).toBe(true)
    expect(existsSync(join(stateDir, changedPath))).toBe(true)
    expect(readFileSync(join(stateDir, "runs", first.key, "index.html"), "utf8")).toBe(oldPage)
  })

  it("repairs a missing retained portrait when the incoming bundle supplies it", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-portrait-repair-"))
    const run = snapshotRun()
    applyPublicationBundle(options(stateDir, bundle([run])))
    rmSync(join(stateDir, run.identity!.portraitPath))
    const repaired = applyPublicationBundle(options(stateDir, bundle([run])))
    expect(repaired.changed).toBe(true)
    expect(existsSync(join(stateDir, run.identity!.portraitPath))).toBe(true)
  })

  it("publishes a validated bundle through the deterministic CLI harness", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-cli-success-state-"))
    const input = mkdtempSync(join(tmpdir(), "crew-publish-cli-success-input-"))
    const run = snapshotRun()
    const suite = snapshotSuite({ observedRunKeys: [run.key] })
    writeFileSync(join(input, "publication-bundle.json"), `${JSON.stringify(bundle([run], [suite]), null, 2)}\n`)

    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/e2e-live/crew/publish-cli.mts", "--state", stateDir, "--bundle", join(input, "publication-bundle.json"), "--now", "2026-10-18T07:30:00.000Z"], {
      cwd: join(__dirname, "../../.."), encoding: "utf8", env: { ...process.env, CREW_PUBLISH_TEST_CLOCK: "1" },
    })

    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toMatchObject({ changed: true, runs: 1, suites: 1 })
    expect(JSON.parse(readFileSync(join(stateDir, "data", "runs", `${run.key}.json`), "utf8"))).toEqual(run)
    expect(JSON.parse(readFileSync(join(stateDir, "data", "suites", `${suite.key}.json`), "utf8"))).toEqual(suite)
    expect(readFileSync(join(stateDir, "index.html"), "utf8")).toContain("PreviewNet Crew")
  })

  it("keeps the CLI test clock unavailable in production", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-publish-cli-state-"))
    const input = mkdtempSync(join(tmpdir(), "crew-publish-cli-input-"))
    writeFileSync(join(input, "publication-bundle.json"), `${JSON.stringify(bundle([snapshotRun()]), null, 2)}\n`)
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/e2e-live/crew/publish-cli.mts", "--state", stateDir, "--bundle", join(input, "publication-bundle.json"), "--now", "2026-10-18T07:30:00.000Z"], {
      cwd: join(__dirname, "../../.."), encoding: "utf8", env: { ...process.env, CREW_PUBLISH_TEST_CLOCK: "" },
    })
    expect(child.status).not.toBe(0)
    expect(child.stderr).toMatch(/--now is available only/i)
  })
})
