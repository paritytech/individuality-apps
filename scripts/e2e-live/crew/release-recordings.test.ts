// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { expiredCrewReleaseTags, publishRecordingRelease, recordingAssetName, recordingReleaseTag } from "./release-recordings"
import { validatePublicationBundle, type PublicationBundle } from "./run-record"
import { harnessBundle } from "./workflow-publication"

const fixture = (executionKey = "manual", suiteId: string | null = null): PublicationBundle => {
  const run = JSON.parse(readFileSync(new URL("./fixtures/nightly-pass.json", import.meta.url), "utf8"))
  return validatePublicationBundle({ version: 1, runs: [{ ...run,
    key: `${run.key}-${executionKey}`, executionKey, suiteId, wave: suiteId ? executionKey : null,
    classification: "manual",
  }], suites: [] })
}
const annotations = (receivers = [{ bot: 1, attempt: 1, key: "captain-baseline" }], executionKey = "manual"): string => {
  const root = mkdtempSync(join(tmpdir(), "crew-release-"))
  for (const { bot, attempt, key } of receivers) {
    const directory = join(root, `attempt-${attempt}`, `bot-${bot}`)
    const path = join(directory, "video.annotated.mp4")
    mkdirSync(directory, { recursive: true })
    writeFileSync(path, "mp4")
    writeFileSync(join(directory, "annotation-manifest.json"), JSON.stringify({
      version: 1,
      runId: "39147986065",
      attempt,
      slot: bot,
      receiver: { key },
      sourceArtifact: `e2e-live-39147986065-attempt-${attempt}-${executionKey}-bot${bot}`,
      segments: [{ annotatedFile: "video.annotated.mp4" }],
    }))
  }
  return root
}
describe("public crew recording releases", () => {
  it("maps one POV and multipart POVs to predictable run-scoped names", () => {
    expect(recordingReleaseTag(39147986065, 2)).toBe("crew-run-39147986065-a2")
    expect(recordingAssetName(39147986065, 2, 1, "captain-baseline")).toBe("run-39147986065-a2-bot01-captain-baseline.mp4")
    expect(recordingAssetName(39147986065, 2, 1, "captain-baseline", 2)).toBe("run-39147986065-a2-bot01-captain-baseline-p2.mp4")
    expect(recordingReleaseTag(39147986065, 2, "wave-02")).toBe("crew-run-39147986065-a2-xwave-02")
    expect(recordingAssetName(39147986065, 2, 1, "captain-baseline", undefined, "wave-02")).toBe("run-39147986065-a2-xwave-02-bot01-captain-baseline.mp4")
  })
  it("cleans only strict expired crew prereleases", () => {
    const release = (tag_name: string, published_at: string, prerelease = true) => ({ tag_name, published_at, prerelease })
    expect(expiredCrewReleaseTags([
      release("crew-run-1-a1", "2026-10-04T20:30:00.000Z"),
      release("crew-run-2-a1", "2026-10-04T20:30:00.001Z"),
      release("crew-run-5-a1-xwave-02", "2026-10-04T20:30:00.000Z"),
      release("crew-run-3-a1-not-ours", "2026-01-01T00:00:00.000Z"),
      release("crew-run-4-a1", "2026-01-01T00:00:00.000Z", false),
    ], new Date("2026-10-18T20:30:00.000Z"))).toEqual(["crew-run-1-a1", "crew-run-5-a1-xwave-02"])
  })
  it("dry-runs the same credential-free gh upload path used by Actions and local sync", () => {
    let invoked = false
    const result = publishRecordingRelease({
      bundle: fixture(), annotationsDir: annotations(), dryRun: true,
      now: new Date("2026-10-18T20:30:00.000Z"), gh: () => { invoked = true; return "" },
    })
    expect(invoked).toBe(false)
    expect(result.commands.map((args) => args.slice(0, 3))).toEqual([
      ["release", "create", "crew-run-39147986065-a1"],
      ["release", "upload", "crew-run-39147986065-a1"],
    ])
    expect(result.commands[1]![3]!.split("/").at(-1)).toBe("run-39147986065-a1-bot01-captain-baseline.mp4")
    expect(result.bundle.runs[0]!.recording.artifactUrl).toContain("/crew-run-39147986065-a1/run-39147986065-a1-bot01-captain-baseline.mp4")
    expect(result.bundle.runs[0]!.recording.expiresAt).toBe("2026-11-01T20:30:00.000Z")
  })

  it("accepts safe sibling MP4s when Actions passes a relative annotations directory", () => {
    const root = annotations()
    const result = publishRecordingRelease({
      bundle: fixture(), annotationsDir: relative(process.cwd(), root), dryRun: true,
      now: new Date("2026-10-18T20:30:00.000Z"),
    })
    expect(result.plan?.assets).toHaveLength(1)
    expect(result.plan?.assets[0]!.source).toBe(join(root, "attempt-1", "bot-1", "video.annotated.mp4"))
  })

  it("rejects an annotated MP4 outside its manifest directory", () => {
    const root = annotations()
    const manifestPath = join(root, "attempt-1", "bot-1", "annotation-manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.segments[0].annotatedFile = "../escape.annotated.mp4"
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => publishRecordingRelease({ bundle: fixture(), annotationsDir: root, dryRun: true })).toThrow("unsafe annotated segment")
  })

  it("isolates the same bot and persona in two executions of one suite run", () => {
    const first = publishRecordingRelease({ bundle: fixture("wave-01", "manual-suite-run-39147986065"), annotationsDir: annotations(undefined, "wave-01"), dryRun: true, now: new Date("2026-10-18T20:30:00.000Z") })
    const second = publishRecordingRelease({ bundle: fixture("wave-02", "manual-suite-run-39147986065"), annotationsDir: annotations(undefined, "wave-02"), dryRun: true, now: new Date("2026-10-18T20:30:00.000Z") })
    expect(first.plan?.tag).toBe("crew-run-39147986065-a1-xwave-01")
    expect(second.plan?.tag).toBe("crew-run-39147986065-a1-xwave-02")
    expect(first.plan?.assets[0]!.name).toBe("run-39147986065-a1-xwave-01-bot01-captain-baseline.mp4")
    expect(second.plan?.assets[0]!.name).toBe("run-39147986065-a1-xwave-02-bot01-captain-baseline.mp4")
    expect(first.bundle.runs[0]!.recording.artifactUrl).not.toBe(second.bundle.runs[0]!.recording.artifactUrl)
  })

  it("publishes one execution whose selected bots span source attempts", () => {
    const base = fixture("specialist-01", "scheduled-suite-run-39147986065")
    const first = base.runs[0]!
    const source = validatePublicationBundle({ ...base, runs: [first, {
      ...first,
      key: `${first.key}-retry`,
      attempt: 2,
      artifactAttempt: 2,
      bot: 1,
    }] })
    const result = publishRecordingRelease({ bundle: source, annotationsDir: annotations([{ bot: 1, attempt: 2, key: "captain-baseline" }], "specialist-01"), dryRun: true, now: new Date("2026-10-18T20:30:00.000Z") })
    expect(result.plan?.tag).toBe("crew-run-39147986065-a2-xspecialist-01")
    expect(result.plans.map(({ tag }) => tag)).toEqual([
      "crew-run-39147986065-a2-xspecialist-01",
    ])
    expect(result.bundle.runs.map(({ recording }) => recording.artifactUrl)).toEqual([
      null,
      expect.stringContaining("/crew-run-39147986065-a2-xspecialist-01/"),
    ])
  })

  it("keeps a no-bot harness bundle truthful without creating a release", () => {
    const source = harnessBundle({
      runId: 39147986065, attempt: 2, repository: "paritytech/individuality-apps", ref: "refs/heads/main", commit: "a".repeat(40), actor: "github-actions[bot]",
      workflowPath: ".github/workflows/e2e-live.yml", event: "workflow_dispatch", defaultBranch: "main",
      startedAt: "2026-10-18T20:00:00.000Z", finishedAt: "2026-10-18T20:10:00.000Z",
    }, { network: "previewnet", app: "deployed", bootOnly: true, executionKey: "check-seat-preparing", classification: "harness-check", suiteId: "scheduled-suite-run-39147986065", wave: "checks", publish: true }, "success")
    const result = publishRecordingRelease({ bundle: source, annotationsDir: annotations(undefined, "check-seat-preparing"), dryRun: true })
    expect(result.plan).toBeNull()
    expect(result.plans).toEqual([])
    expect(result.commands).toEqual([])
    expect(result.bundle).toEqual(source)
  })

  it("removes private ZIP links when a public POV could not be produced", () => {
    const base = fixture("game-ready", "manual-suite-run-39147986065")
    const first = base.runs[0]!
    const source = validatePublicationBundle({ ...base, runs: [first, {
      ...first,
      key: `${first.key}-permission-gate`,
      bot: 2,
      identity: { ...first.identity!, key: "shutter-sheila", username: "jollyshutter.63", displayName: "Shutter Sheila" },
    }] })
    const result = publishRecordingRelease({ bundle: source, annotationsDir: annotations(undefined, "game-ready"), dryRun: true })
    expect(result.bundle.runs.find(({ bot }) => bot === 1)?.recording.visibility).toBe("public")
    expect(result.bundle.runs.find(({ bot }) => bot === 2)?.recording).toEqual({
      state: "missing",
      artifactUrl: null,
      visibility: "organization",
      uploadedAt: null,
      expiresAt: null,
    })
  })
})
