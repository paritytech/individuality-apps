// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { loadCrewCatalogue } from "./catalogue"
import { validatePublicRunRecord, validatePublicSuiteRecord, type PublicRunRecord, type PublicSuiteRecord } from "./run-record"
import { generateCrewSite, readCrewSiteState, selectLatestSuite } from "./site"
import { replaceGeneratedSite } from "./site-cli.mts"

const here = new URL(".", import.meta.url)
const portraits = new URL("./portraits/", here)
const catalogue = loadCrewCatalogue()

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, here), "utf8")) as T

function records(): { run: PublicRunRecord; suite: PublicSuiteRecord } {
  const run = fixture<PublicRunRecord>("nightly-pass")
  const identity = catalogue.identities.find(({ key }) => key === run.identity?.key)!
  const bytes = readFileSync(new URL(identity.portrait, portraits))
  const portraitSha256 = createHash("sha256").update(bytes).digest("hex")
  run.identity = {
    ...run.identity!,
    portraitFile: identity.portrait,
    portraitSha256,
    portraitPath: `assets/portraits/by-sha256/${portraitSha256}.webp`,
  }
  return { run: validatePublicRunRecord(run), suite: validatePublicSuiteRecord(fixture("suite-completed")) }
}

function stateWith(run: PublicRunRecord, suite: PublicSuiteRecord): string {
  const stateDir = mkdtempSync(join(tmpdir(), "crew-site-state-"))
  mkdirSync(join(stateDir, "data", "runs"), { recursive: true })
  mkdirSync(join(stateDir, "data", "suites"), { recursive: true })
  writeFileSync(join(stateDir, "data", "runs", `${run.key}.json`), `${JSON.stringify(run, null, 2)}\n`)
  writeFileSync(join(stateDir, "data", "suites", `${suite.key}.json`), `${JSON.stringify(suite, null, 2)}\n`)
  return stateDir
}

describe("PreviewNet Crew site", () => {
  it("selects the newest published suite for the headline regardless of trigger", () => {
    const { suite } = records()
    const manual = { ...suite, key: "manual-suite", suiteId: "manual-suite", runId: suite.runId + 2, classification: "manual" as const, startedAt: "2026-10-19T01:00:00.000Z" }
    const older = { ...suite, key: "older-nightly", suiteId: "nightly-older", runId: suite.runId - 1, startedAt: "2026-10-17T01:00:00.000Z" }
    expect(selectLatestSuite([manual, older, suite])?.key).toBe(manual.key)
  })

  it("shows a newer manual suite in the home banner instead of an older nightly", () => {
    const { run, suite } = records()
    const manual = validatePublicSuiteRecord({
      ...suite,
      key: "manual-suite",
      suiteId: "manual-suite",
      runId: suite.runId + 2,
      classification: "manual",
      startedAt: "2026-10-19T01:00:00.000Z",
      finishedAt: "2026-10-19T01:30:00.000Z",
    })
    const stateDir = stateWith(run, suite)
    writeFileSync(join(stateDir, "data", "suites", `${manual.key}.json`), JSON.stringify(manual))
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-latest-manual-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-20T10:00:00.000Z") })
    const home = readFileSync(join(outputDir, "index.html"), "utf8")
    expect(home).toContain("Latest suite · Manual")
    expect(home).toContain(`href="suites/${manual.key}/"`)
    expect(home).toContain("data-suite-classification=\"manual\"")
    expect(home).toContain("<h1 data-suite-label role=\"status\" aria-live=\"polite\">Passed</h1>")
    expect(home).not.toContain("Tonight's crew run isn't published yet")
  })

  it("presents the latest execution as a plain test game when no suite summary exists", () => {
    const { run, suite } = records()
    const stateDir = stateWith(run, suite)
    const peer = validatePublicRunRecord({ ...run, key: `${run.key}-peer`, bot: 2 })
    writeFileSync(join(stateDir, "data", "runs", `${peer.key}.json`), JSON.stringify(peer))
    unlinkSync(join(stateDir, "data", "suites", `${suite.key}.json`))
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-no-suites-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-20T10:00:00.000Z") })
    const home = readFileSync(join(outputDir, "index.html"), "utf8")
    expect(home).toContain("Latest test game · 18 Oct 2026, 19:33 CEST")
    expect(home).toContain(`<h1 role="status" aria-live="polite">2 bots played game ${run.game}</h1>`)
    expect(home).toContain(run.scenario!.title)
    expect(home).toContain('<span class="status status-passed"><span>Game</span> passed</span>')
    expect(home).toContain(`href="runs/${run.key}/"`)
    expect(home).toContain("Watch the game")
    expect(home).not.toContain("No runs published yet")
    expect(home).not.toContain("No suite result published")
    expect(home).not.toContain("Infrastructure")
  })

  it("uses singular bot copy for a one-bot fallback game", () => {
    const { run, suite } = records()
    const stateDir = stateWith(run, suite)
    unlinkSync(join(stateDir, "data", "suites", `${suite.key}.json`))
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-one-bot-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-20T10:00:00.000Z") })
    const home = readFileSync(join(outputDir, "index.html"), "utf8")
    expect(home).toContain(`<h1 role="status" aria-live="polite">1 bot played game ${run.game}</h1>`)
    expect(home).not.toContain("1 bots played")
  })

  it("does not claim a bot count when the latest run has no bot", () => {
    const { run, suite } = records()
    const harnessRun = validatePublicRunRecord({ ...run, bot: null })
    const stateDir = stateWith(harnessRun, suite)
    unlinkSync(join(stateDir, "data", "suites", `${suite.key}.json`))
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-no-bot-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-20T10:00:00.000Z") })
    const home = readFileSync(join(outputDir, "index.html"), "utf8")
    expect(home).toContain(`<h1 role="status" aria-live="polite">Game ${run.game}</h1>`)
    expect(home).not.toMatch(/\d+ bots? played/)
  })

  it("omits an unknown game status from the fallback hero", () => {
    const { run, suite } = records()
    const unknown = validatePublicRunRecord({ ...run, game: null, result: "missing", productResult: "missing", infrastructure: "missing", failures: ["No published result."] })
    const peer = validatePublicRunRecord({ ...unknown, key: `${unknown.key}-peer`, bot: 2 })
    const stateDir = stateWith(unknown, suite)
    writeFileSync(join(stateDir, "data", "runs", `${peer.key}.json`), JSON.stringify(peer))
    unlinkSync(join(stateDir, "data", "suites", `${suite.key}.json`))
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-unknown-game-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-20T10:00:00.000Z") })
    const home = readFileSync(join(outputDir, "index.html"), "utf8")
    const hero = home.match(/<section class="hero hero-missing">[\s\S]*?<\/section>/)?.[0]
    expect(hero).toContain('<h1 role="status" aria-live="polite">2 bots played a test game</h1>')
    expect(hero).not.toContain('class="status ')
    expect(hero).not.toMatch(/<h1[^>]*>[^<]*missing/i)
    expect(home).not.toContain('<span class="status status-missing">')
  })

  it("keeps legacy regression identifiers out of public copy without rewriting evidence", () => {
    const { run, suite } = records()
    const title = "Game259 Clean Video Control"
    const criteria = catalogue.scenarios.find(({ profile }) => profile === "game259-clean-video-control")!.criteria
    const legacy = validatePublicRunRecord({
      ...run,
      game: 921,
      result: "failed",
      productResult: "failed",
      scenario: {
        ...run.scenario!,
        profile: "game259-clean-video-control",
        title,
        expected: `Evidence for ${title} must show clean video.`,
        criteria,
        phases: {
          ...run.scenario!.phases,
          preparing: `Captain Baseline is preparing ${title}.`,
        },
      },
      diagnostics: criteria.map((criterion, index) => ({
        criterion,
        status: index === 0 ? "met" : index === 1 ? "not-met" : "pending",
        detail: index === 0 ? "Observed 1 matching log line among 80 captured lines." : index === 1 ? "Observed 0 matching log lines among 80 captured lines." : "This criterion is pending and was not evaluated.",
      })),
      timeline: [{ ...run.timeline[0]!, text: `Captain Baseline is preparing ${title}.` }],
    })
    const stateDir = stateWith(legacy, suite)
    unlinkSync(join(stateDir, "data", "suites", `${suite.key}.json`))
    const source = readFileSync(join(stateDir, "data", "runs", `${legacy.key}.json`), "utf8")
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-legacy-title-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-20T10:00:00.000Z") })
    const home = readFileSync(join(outputDir, "index.html"), "utf8")
    const detail = readFileSync(join(outputDir, "runs", legacy.key, "index.html"), "utf8")
    expect(home).toContain("Clean Video Control")
    expect(detail).toContain("Clean Video Control")
    expect(detail).toContain("Game 921")
    expect(detail).toContain("<h2>Acceptance criteria</h2>")
    expect(detail).not.toContain("<strong>Expected:</strong>")
    expect(detail.match(/<tr class="criterion-/g)).toHaveLength(criteria.length)
    expect(detail).toContain("criterion-status-met\">Met")
    expect(detail).toContain("criterion-status-not-met\">Not met")
    expect(detail).toContain("criterion-status-pending\">Pending")
    expect(detail.match(/Open job log/g)).toHaveLength(criteria.length)
    expect(detail).toContain(`https://github.com/${run.repository}/actions/runs/${run.runId}/job/${run.source.jobId}`)
    expect(home).not.toContain("Game259")
    expect(detail).not.toContain("Game259")
    expect(readFileSync(join(stateDir, "data", "runs", `${legacy.key}.json`), "utf8")).toBe(source)
  })

  it("uses plain empty-state copy only when no run or suite exists", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "crew-site-empty-state-"))
    mkdirSync(join(stateDir, "data", "runs"), { recursive: true })
    mkdirSync(join(stateDir, "data", "suites"), { recursive: true })
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-empty-output-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-20T10:00:00.000Z") })
    const home = readFileSync(join(outputDir, "index.html"), "utf8")
    expect(home).toContain("<h1 role=\"status\" aria-live=\"polite\">No runs published yet</h1>")
    expect(home).toContain("Published test runs will appear here.")
    expect(home).not.toContain("trusted")
  })

  it("validates every JSON record read from state", () => {
    const { run, suite } = records()
    const stateDir = stateWith(run, suite)
    const state = readCrewSiteState(stateDir)
    expect(state.runs).toEqual([run])
    expect(state.suites).toEqual([suite])
    writeFileSync(join(stateDir, "data", "runs", `${run.key}.json`), JSON.stringify({ ...run, unexpectedField: true }))
    expect(() => readCrewSiteState(stateDir)).toThrow(/unknown field unexpectedField/)
  })

  it("renders escaped, accessible pages and all 30 identities", () => {
    const { run, suite } = records()
    run.failures = ["<script>alert('no')</script>"]
    const stateDir = stateWith(validatePublicRunRecord(run), suite)
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-output-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-18T07:30:00.000Z") })

    const home = readFileSync(join(outputDir, "index.html"), "utf8")
    const identity = readFileSync(join(outputDir, "identities", run.identity!.key, "index.html"), "utf8")
    const runPage = readFileSync(join(outputDir, "runs", run.key, "index.html"), "utf8")
    const suitePage = readFileSync(join(outputDir, "suites", suite.key, "index.html"), "utf8")
    expect((home.match(/class="identity-card /g) ?? [])).toHaveLength(30)
    expect(home).toContain("PreviewNet Crew")
    expect(home).toMatch(/Game<\/span> passed/)
    expect(home).toMatch(/Recording<\/span> Recorded/)
    expect(home).toContain("data-suite-date=\"2026-10-18\"")
    expect(home).toContain("<dt>Passed</dt><dd>1</dd>")
    expect(home).toContain("<dt>Coverage</dt><dd>1/1 complete</dd>")
    expect(home).toContain("<dt>Latest nightly scenario</dt><dd>Healthy Baseline</dd>")
    expect(home).toContain("<dt>Latest nightly result</dt><dd>passed</dd>")
    expect(home).toContain("<dt>Last nightly success</dt>")
    expect(identity).toContain(catalogue.identities.find(({ key }) => key === run.identity!.key)!.speciality)
    expect(identity).toContain("Last nightly success")
    expect(identity).toContain("filter-nightly")
    expect(runPage).toContain("Observed timeline")
    expect(runPage).toContain("Organization members only")
    expect(runPage).toContain("Video available")
    expect(runPage).toContain("role=\"status\" aria-live=\"polite\"")
    expect(runPage).toContain("Watch receiver recording")
    expect(runPage).toContain("&lt;script&gt;alert(&#39;no&#39;)&lt;/script&gt;")
    expect(runPage).not.toContain("<script>alert")
    expect(suitePage).toContain("Coverage")
    expect(suitePage).toContain("wave-all")
    expect(suitePage).toContain(`../runs/${run.key}/`)
  })

  it("links every exact-run player POV from game pages and compact home game entries", () => {
    const { run, suite } = records()
    const peer = validatePublicRunRecord({ ...run, key: `${run.key}-peer`, bot: 2 })
    const unavailablePeer = validatePublicRunRecord({
      ...run,
      key: `${run.key}-missing`,
      bot: 3,
      recording: { state: "missing", artifactUrl: null, visibility: "organization", uploadedAt: null, expiresAt: null },
    })
    const otherExecution = validatePublicRunRecord({
      ...run,
      key: `${run.key}-other`,
      executionKey: "wave-other",
      wave: "wave-other",
      recording: { state: "missing", artifactUrl: null, visibility: "organization", uploadedAt: null, expiresAt: null },
    })
    const stateDir = stateWith(run, suite)
    for (const record of [peer, unavailablePeer, otherExecution]) writeFileSync(join(stateDir, "data", "runs", `${record.key}.json`), JSON.stringify(record))
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-game-povs-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-18T07:30:00.000Z") })
    const detail = readFileSync(join(outputDir, "runs", run.key, "index.html"), "utf8")
    expect(detail).toContain("Player videos from this game")
    expect(detail).toContain(`../../runs/${run.key}/`)
    expect(detail).toContain(`../../runs/${peer.key}/`)
    expect(detail).toContain(`../../runs/${unavailablePeer.key}/`)
    expect(detail).not.toContain(`../../runs/${otherExecution.key}/`)
    const home = readFileSync(join(outputDir, "index.html"), "utf8")
    expect(home).toContain("<h2>Recent games</h2>")
    expect(home).toContain("2 player videos · wave-all")
    expect(home).toContain("0 player videos · wave-other")
  })

  it("declares public release recordings as MP4 sources for WebKit", () => {
    const { run, suite } = records()
    const artifactUrl = "https://github.com/paritytech/jollity-tests/releases/download/crew-run-1/video.mp4"
    const published = validatePublicRunRecord({
      ...run,
      recording: { ...run.recording, artifactUrl, artifactUrls: [artifactUrl], visibility: "public" },
    })
    const stateDir = stateWith(published, suite)
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-public-video-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-18T07:30:00.000Z") })
    const html = readFileSync(join(outputDir, "runs", run.key, "index.html"), "utf8")
    expect(html).toContain(`<source src="${artifactUrl}" type="video/mp4">`)
    expect(html).not.toMatch(/<video[^>]+\ssrc=/)
  })

  it("produces byte-identical trees for identical inputs", () => {
    const { run, suite } = records()
    const stateDir = stateWith(run, suite)
    const one = mkdtempSync(join(tmpdir(), "crew-site-one-"))
    const two = mkdtempSync(join(tmpdir(), "crew-site-two-"))
    const options = { stateDir, catalogue, portraitDir: portraits, now: new Date("2026-10-18T07:30:00.000Z") }
    const first = generateCrewSite({ ...options, outputDir: one })
    const second = generateCrewSite({ ...options, outputDir: two })
    expect(first).toEqual(second)
    for (const path of first) expect(readFileSync(join(one, path))).toEqual(readFileSync(join(two, path)))
  }, 15_000)

  it("renders missing and expired recordings as distinct terminal states", () => {
    const { run, suite } = records()
    for (const [state, expected] of [["missing", "Recording unavailable"], ["expired", "Video expired"]] as const) {
      const changed = validatePublicRunRecord({
        ...run,
        recording: state === "missing"
          ? { state, artifactUrl: null, visibility: "organization", uploadedAt: null, expiresAt: null }
          : { state, artifactUrl: run.recording.artifactUrl, visibility: "organization", uploadedAt: run.recording.uploadedAt, expiresAt: run.recording.expiresAt },
      })
      const stateDir = stateWith(changed, suite)
      const outputDir = mkdtempSync(join(tmpdir(), `crew-site-${state}-`))
      generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-11-02T08:00:00.000Z") })
      const html = readFileSync(join(outputDir, "runs", run.key, "index.html"), "utf8")
      expect(html).toContain(expected)
      if (state === "expired") expect(html).not.toContain("data-recording-link")
    }
  })

  it("bakes recording expiry into HTML at the exact boundary without mutating durable JSON", () => {
    const { run, suite } = records()
    const expiresAt = run.recording.expiresAt!
    const stateDir = stateWith(run, suite)
    const sourcePath = join(stateDir, "data", "runs", `${run.key}.json`)
    const source = readFileSync(sourcePath, "utf8")
    for (const [milliseconds, expected, hasLink] of [[-1, "Video available", true], [0, "Video expired", false]] as const) {
      const outputDir = mkdtempSync(join(tmpdir(), "crew-site-expiry-boundary-"))
      generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date(Date.parse(expiresAt) + milliseconds) })
      const html = readFileSync(join(outputDir, "runs", run.key, "index.html"), "utf8")
      expect(html).toContain(expected)
      expect(html.includes("data-recording-link")).toBe(hasLink)
      expect(readFileSync(sourcePath, "utf8")).toBe(source)
      expect(JSON.parse(readFileSync(join(outputDir, "data", "runs", `${run.key}.json`), "utf8")).recording.state).toBe(milliseconds < 0 ? "available" : "expired")
    }
  })

  it("shows every product, infrastructure, and coverage total on home and suite pages", () => {
    const { run, suite } = records()
    const mixed = validatePublicSuiteRecord({
      ...suite,
      totals: { passed: 1, failed: 2, inconclusive: 3, missing: 4, skipped: 5 },
      infrastructureTotals: { complete: 6, partial: 7, missing: 8, superseded: 9 },
      coverage: { planned: 31, observed: 27, complete: false, missing: ["null-nancy", "packet-jack", "the-rejoiner", "captain-baseline"] },
    })
    const stateDir = stateWith(run, mixed)
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-mixed-totals-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-18T07:30:00.000Z") })
    for (const html of [readFileSync(join(outputDir, "index.html"), "utf8"), readFileSync(join(outputDir, "suites", mixed.key, "index.html"), "utf8")]) {
      for (const [label, count] of [["Passed", 1], ["Failed", 2], ["Inconclusive", 3], ["No game result", 4], ["Skipped", 5], ["Recording complete", 6], ["Recording partial", 7], ["Recording missing", 8], ["Recording superseded", 9]] as const) {
        expect(html).toContain(`<dt>${label}</dt><dd>${count}</dd>`)
      }
      expect(html).toContain("<dt>Coverage</dt><dd>27/31 incomplete</dd>")
    }
  })

  it("keeps manual and branch runs in identity history without replacing the nightly headline", () => {
    const { run, suite } = records()
    const manual = validatePublicRunRecord({ ...run, key: `${run.key}-manual`, runId: run.runId + 1, classification: "manual", executionKey: "manual", finishedAt: "2026-10-19T06:00:00.000Z", productResult: "failed", result: "failed" })
    const branch = validatePublicRunRecord({ ...run, key: `${run.key}-branch`, runId: run.runId + 2, classification: "branch", executionKey: "branch", finishedAt: "2026-10-19T06:01:00.000Z", productResult: "failed", result: "failed" })
    const partial = validatePublicRunRecord({ ...run, key: `${run.key}-partial`, runId: run.runId + 3, finishedAt: "2026-10-19T06:02:00.000Z", infrastructure: "partial", productResult: "failed", result: "failed" })
    const stateDir = stateWith(run, suite)
    writeFileSync(join(stateDir, "data", "runs", `${manual.key}.json`), JSON.stringify(manual))
    writeFileSync(join(stateDir, "data", "runs", `${branch.key}.json`), JSON.stringify(branch))
    writeFileSync(join(stateDir, "data", "runs", `${partial.key}.json`), JSON.stringify(partial))
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-history-groups-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-19T07:30:00.000Z") })
    const home = readFileSync(join(outputDir, "index.html"), "utf8")
    const identity = readFileSync(join(outputDir, "identities", run.identity!.key, "index.html"), "utf8")
    expect(home).toContain(`href="suites/${suite.key}/"`)
    expect(home).toContain("data-suite-result=\"Passed\"")
    expect(home).toContain("<dt>Latest nightly result</dt><dd>passed</dd>")
    expect(home).toContain("<dt>Last nightly success</dt>")
    expect(home).toContain('<span class="status status-partial"><span>Recording</span> Partly recorded</span>')
    expect(identity).toContain(`runs/${manual.key}/`)
    expect(identity).toContain(`runs/${branch.key}/`)
    expect(identity).toContain("<dt>Latest nightly result</dt><dd>passed</dd>")
    expect(identity).toContain("<dt>Last nightly success</dt>")
    expect(identity).toContain("<h3>Manual</h3>")
    expect(identity).toContain("<h3>Branch</h3>")
  })

  it("renders a started suite as in progress only until the next freshness deadline", () => {
    const { run } = records()
    const suite = validatePublicSuiteRecord(fixture("suite-started"))
    const stateDir = stateWith(run, suite)
    for (const [now, expected] of [["2026-10-19T06:59:59.999Z", "In progress"], ["2026-10-19T07:00:00.000Z", "Tonight's crew run isn't published yet"]] as const) {
      const outputDir = mkdtempSync(join(tmpdir(), "crew-site-started-"))
      generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date(now) })
      const home = readFileSync(join(outputDir, "index.html"), "utf8")
      expect(home).toContain("data-suite-state=\"started\"")
      expect(home).toContain(`<h1 data-suite-label role="status" aria-live="polite">${expected.replaceAll("'", "&#39;")}</h1>`)
    }
  })

  it("fails closed when a suite names a child run that is absent", () => {
    const { run, suite } = records()
    const broken = validatePublicSuiteRecord({ ...suite, observedRunKeys: [...suite.observedRunKeys, "run-absent"] })
    const stateDir = stateWith(run, broken)
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-missing-child-"))
    expect(() => generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-18T07:30:00.000Z") })).toThrow(/suite.*run-absent|run-absent.*suite/i)
  })

  it("keeps a catastrophic pre-plan nightly visible as missing infrastructure", () => {
    const { run } = records()
    const suite = validatePublicSuiteRecord(fixture("suite-catastrophic"))
    const stateDir = stateWith(run, suite)
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-catastrophic-"))
    generateCrewSite({ stateDir, outputDir, catalogue, portraitDir: portraits, now: new Date("2026-10-19T07:30:00.000Z") })
    const home = readFileSync(join(outputDir, "index.html"), "utf8")
    const detail = readFileSync(join(outputDir, "suites", suite.key, "index.html"), "utf8")
    expect(home).not.toContain('<span class="status status-missing">')
    expect(home).toContain("<dt>Recording missing</dt><dd>1</dd>")
    expect(detail).toContain("The nightly workflow stopped before planning or bot startup.")
    expect(detail).toContain("The run plan is unavailable.")
    expect(detail).toContain("Organization members only")
  })

  it("runs the CLI into a separate render tree, preserves canonical state, and removes stale generated pages", () => {
    const { run, suite } = records()
    const stateDir = stateWith(run, suite)
    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-cli-output-"))
    mkdirSync(join(outputDir, "runs", "obsolete"), { recursive: true })
    writeFileSync(join(outputDir, "runs", "obsolete", "index.html"), "stale")
    const canonicalBefore = readFileSync(join(stateDir, "data", "runs", `${run.key}.json`))
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/e2e-live/crew/site-cli.mts", "--state", stateDir, "--out", outputDir, "--now", "2026-10-18T07:30:00.000Z"], {
      cwd: new URL("../../..", here),
      encoding: "utf8",
      env: { ...process.env, CREW_SITE_TEST_CLOCK: "1" },
    })
    expect(child.stderr).toBe("")
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toMatchObject({ outputDir, generatedAt: "2026-10-18T07:30:00.000Z" })
    expect(existsSync(join(outputDir, "index.html"))).toBe(true)
    expect(existsSync(join(outputDir, "runs", "obsolete"))).toBe(false)
    expect(readFileSync(join(stateDir, "data", "runs", `${run.key}.json`))).toEqual(canonicalBefore)
    expect(validatePublicRunRecord(JSON.parse(readFileSync(join(stateDir, "data", "runs", `${run.key}.json`), "utf8")))).toEqual(run)
    const previousHome = readFileSync(join(outputDir, "index.html"), "utf8")
    writeFileSync(join(stateDir, "data", "runs", `${run.key}.json`), JSON.stringify({ ...run, unexpectedField: true }))
    const rejected = spawnSync(process.execPath, ["--import", "tsx", "scripts/e2e-live/crew/site-cli.mts", "--state", stateDir, "--out", outputDir, "--now", "2026-10-19T07:30:00.000Z"], {
      cwd: new URL("../../..", here),
      encoding: "utf8",
      env: { ...process.env, CREW_SITE_TEST_CLOCK: "1" },
    })
    expect(rejected.status).not.toBe(0)
    expect(readFileSync(join(outputDir, "index.html"), "utf8")).toBe(previousHome)
  })

  it("runs the CLI when the requested output parent does not exist yet", () => {
    const { run, suite } = records()
    const stateDir = stateWith(run, suite)
    const outputDir = join(mkdtempSync(join(tmpdir(), "crew-site-cli-fresh-parent-")), "new", "site")
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/e2e-live/crew/site-cli.mts", "--state", stateDir, "--out", outputDir, "--now", "2026-10-18T07:30:00.000Z"], {
      cwd: new URL("../../..", here), encoding: "utf8", env: { ...process.env, CREW_SITE_TEST_CLOCK: "1" },
    })
    expect(child.status, child.stderr).toBe(0)
    expect(existsSync(join(outputDir, "index.html"))).toBe(true)
  })

  it("refuses to render the site over the canonical history tree", () => {
    const { run, suite } = records()
    const stateDir = stateWith(run, suite)
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/e2e-live/crew/site-cli.mts", "--state", stateDir], {
      cwd: new URL("../../..", here), encoding: "utf8",
    })
    expect(child.status).not.toBe(0)
    expect(child.stderr).toMatch(/--out|separate/i)
  })

  it("refuses a symlink alias of the canonical history tree as output", () => {
    const { run, suite } = records()
    const stateDir = stateWith(run, suite)
    const alias = join(mkdtempSync(join(tmpdir(), "crew-site-alias-")), "history-alias")
    const stageDir = mkdtempSync(join(tmpdir(), "crew-site-alias-stage-"))
    symlinkSync(stateDir, alias, "dir")
    expect(() => replaceGeneratedSite(stateDir, alias, stageDir)).toThrow(/separate|canonical history/i)
  })

  it("refuses nested history and output trees in either direction", () => {
    const { run, suite } = records()
    const stateDir = stateWith(run, suite)
    const nestedOutput = join(stateDir, "rendered-site")
    const firstStage = mkdtempSync(join(tmpdir(), "crew-site-nested-stage-"))
    expect(() => replaceGeneratedSite(stateDir, nestedOutput, firstStage)).toThrow(/separate|contain/i)

    const outputDir = mkdtempSync(join(tmpdir(), "crew-site-containing-output-"))
    const nestedState = join(outputDir, "canonical-history")
    mkdirSync(nestedState)
    const secondStage = mkdtempSync(join(tmpdir(), "crew-site-containing-stage-"))
    expect(() => replaceGeneratedSite(nestedState, outputDir, secondStage)).toThrow(/separate|contain/i)
  })

  it("retains the backup if an atomic replacement cannot restore the old site", () => {
    const parent = mkdtempSync(join(tmpdir(), "crew-site-rollback-"))
    const stateDir = join(parent, "history")
    const outputDir = join(parent, "site")
    const stageDir = join(parent, ".crew-site-stage-test")
    mkdirSync(outputDir, { recursive: true })
    mkdirSync(stageDir, { recursive: true })
    writeFileSync(join(outputDir, "index.html"), "old site")
    writeFileSync(join(stageDir, "index.html"), "new site")
    let calls = 0
    const failInstallAndRestore = (from: Parameters<typeof renameSync>[0], to: Parameters<typeof renameSync>[1]): void => {
      calls += 1
      if (calls === 2 || calls === 3) throw new Error(`rename ${calls} failed`)
      renameSync(from, to)
    }
    expect(() => replaceGeneratedSite(stateDir, outputDir, stageDir, failInstallAndRestore)).toThrow(/backup retained/)
    const backup = readdirSync(parent).find((entry) => entry.startsWith(".crew-site-backup-"))
    expect(backup).toBeDefined()
    expect(readFileSync(join(parent, backup!, "index.html"), "utf8")).toBe("old site")
    expect(existsSync(stageDir)).toBe(false)
  })

  it("updates stale-nightly and video-expiry copy at exact local boundaries without fetching", () => {
    const script = readFileSync(new URL("./status.js", here), "utf8")
    const headline = { dataset: { suiteDate: "2026-10-17", suiteState: "completed", suiteResult: "Passed", suiteClassification: "nightly" }, textContent: "Passed" }
    const link = { href: "artifact", removed: false, remove() { this.removed = true }, removeAttribute(name: string) { if (name === "href") this.removed = true } }
    const label = { textContent: "Video available" }
    const recording = {
      dataset: { recordingExpiresAt: "2026-10-18T07:00:00.000Z" },
      querySelector(selector: string) { return selector === "[data-recording-link]" ? link : label },
    }
    let fetches = 0
    class FakeDate extends Date {
      constructor(value?: string | number | Date) { super(value === undefined ? "2026-10-18T06:59:59.999Z" : value instanceof Date ? value.getTime() : value) }
      static override now(): number { return Date.parse("2026-10-18T06:59:59.999Z") }
    }
    const timers: Array<{ callback: () => void; delay: number }> = []
    const context = {
      window: {} as Record<string, unknown>,
      document: {
        querySelector: (selector: string) => selector === "[data-suite-status]" ? headline : null,
        querySelectorAll: (selector: string) => selector === "[data-recording-expires-at]" ? [recording] : [],
      },
      Date: FakeDate,
      Intl,
      fetch: () => { fetches += 1 },
      setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length },
      clearTimeout: () => {},
    }
    runInNewContext(script, context)
    expect(timers[0]?.delay).toBe(1)
    const refresh = context.window.__previewNetCrewRefresh as (now: Date) => void
    refresh(new Date("2026-10-18T06:59:59.999Z"))
    expect(headline.textContent).toBe("Passed")
    expect(label.textContent).toBe("Video available")
    refresh(new Date("2026-10-18T07:00:00.000Z"))
    expect(headline.textContent).toBe("Tonight's crew run isn't published yet")
    expect(label.textContent).toBe("Video expired")
    expect(link.removed).toBe(true)
    headline.dataset.suiteDate = "2026-10-18"
    headline.dataset.suiteState = "started"
    refresh(new Date("2026-10-18T08:00:00.000Z"))
    expect(headline.textContent).toBe("In progress")
    refresh(new Date("2026-10-19T07:00:00.000Z"))
    expect(headline.textContent).toBe("Tonight's crew run isn't published yet")
    expect(fetches).toBe(0)
  })

  it("marks an older-than-yesterday nightly stale before 09:00 local time", () => {
    const script = readFileSync(new URL("./status.js", here), "utf8")
    const headline = { dataset: { suiteDate: "2026-10-16", suiteState: "completed", suiteResult: "Passed", suiteClassification: "nightly" }, textContent: "Passed" }
    const context = {
      window: {} as Record<string, unknown>,
      document: { querySelector: () => headline, querySelectorAll: () => [] },
      Date,
      Intl,
      setTimeout: () => 1,
      clearTimeout: () => {},
    }
    runInNewContext(script, context)
    const refresh = context.window.__previewNetCrewRefresh as (now: Date) => void
    refresh(new Date("2026-10-18T06:30:00.000Z"))
    expect(headline.textContent).toBe("Tonight's crew run isn't published yet")
    headline.dataset.suiteDate = "2026-10-17"
    refresh(new Date("2026-10-18T06:30:00.000Z"))
    expect(headline.textContent).toBe("Passed")
    headline.dataset.suiteClassification = "manual"
    headline.dataset.suiteDate = "2026-10-01"
    refresh(new Date("2026-10-18T10:30:00.000Z"))
    expect(headline.textContent).toBe("Passed")
  })

  it("schedules the 09:00 freshness transition exactly in CET as well as CEST", () => {
    const script = readFileSync(new URL("./status.js", here), "utf8")
    const delays: number[] = []
    class FakeDate extends Date {
      constructor(value?: string | number | Date) { super(value === undefined ? "2026-12-18T07:59:59.999Z" : value instanceof Date ? value.getTime() : value) }
      static override now(): number { return Date.parse("2026-12-18T07:59:59.999Z") }
    }
    runInNewContext(script, {
      window: {},
      document: {
        querySelector: () => ({ dataset: { suiteDate: "2026-12-17", suiteState: "completed", suiteResult: "Passed", suiteClassification: "nightly" }, textContent: "Passed" }),
        querySelectorAll: () => [],
      },
      Date: FakeDate,
      Intl,
      setTimeout: (_callback: () => void, delay: number) => { delays.push(delay); return delays.length },
      clearTimeout: () => {},
    })
    expect(delays[0]).toBe(1)
  })
})

describe("the injected-fault section on a run page", () => {
  // Lane S4: each persona's intended fault next to what was measured, so it can be read
  // without watching videos. The section renders from the record's own shaping field.
  const withShaping = (shaping: unknown): string => {
    const { run, suite } = records()
    const stateDir = stateWith(validatePublicRunRecord({ ...run, shaping }), suite)
    const out = mkdtempSync(join(tmpdir(), "crew-site-out-"))
    generateCrewSite({ stateDir, outputDir: out, catalogue, portraitDir: portraits, now: new Date("2026-10-28T12:00:00Z") })
    return readFileSync(join(out, "runs", run.key, "index.html"), "utf8")
  }

  it("shows the intended fault, the measurement and the verdict together", () => {
    const html = withShaping({ intended: "2 Mbit, 150ms ±40ms, 2% loss", measured: "rtt p50 196ms vs the run's wifi reference 23ms", verdict: "impact seen", note: null })
    expect(html).toContain("Injected fault and what was measured")
    expect(html).toContain("2 Mbit, 150ms")
    expect(html).toContain("rtt p50 196ms")
    expect(html).toContain("impact seen")
  })

  it("shows the reader's caveat under the verdict, never a bare verdict", () => {
    const html = withShaping({ intended: "CPU ×4", measured: "0 long task(s)", verdict: "cannot tell", note: "CPU ×4 cannot be judged on the game span" })
    expect(html).toContain("CPU ×4 cannot be judged on the game span")
  })

  it("renders nothing at all for a record written before the report existed", () => {
    expect(withShaping(undefined)).not.toContain("Injected fault and what was measured")
  })

  it("refuses a verdict outside the reader's vocabulary", () => {
    expect(() => withShaping({ intended: "x", measured: "y", verdict: "probably fine", note: null })).toThrow(/verdict/)
  })
})
