// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { emptyResult, type RecordingSegment, type SlotResult } from "./result"
import { buildRecordingCueSheet, renderRecordingHudSvg } from "./recording-annotation"
import { renderAnnotatedBot } from "./recording-render"
import { contrast, loadCrewCatalogue } from "./crew/catalogue"

const segment: RecordingSegment = {
  file: "video-1.webm",
  pageOrdinal: 0,
  startedAt: "2026-10-18T18:00:00.000Z",
  finishedAt: "2026-10-18T18:02:00.000Z",
}

const result = (slot: number, account: string, username: string, profile: string, attempt = 1, game = 901): SlotResult => {
  const value = emptyResult(slot, account, username, new Date("2026-10-18T17:59:00.000Z"), profile, {
    GITHUB_RUN_ID: "39160000000",
    GITHUB_RUN_ATTEMPT: String(attempt),
  })
  value.game = { index: game, gameAt: 1_792_350_000, registrationEnds: 1_792_349_910, reportEnds: 1_792_350_600 }
  value.groups = [{
    round: 0,
    ownIndex: slot - 1,
    members: [
      { index: 0, account: "baseline-account" },
      { index: 1, account: "rejoiner-account" },
      { index: 2, account: "packet-account" },
    ],
  }]
  value.recordings = slot === 1 ? [segment] : []
  return value
}

const transition = (at: string, state: "preparing" | "active" | "recovered" | "verifying" | "passed" | "failed", source: "journey" | "network" | "role" | "outcome", title: string, text: string, action: string | null = null, detail?: string) => ({
  at, state, source, title, text, action, ...(detail ? { detail } : {}),
})

describe("cross-persona recording annotation", () => {
  it("records an independent Node-clock boundary for every page and relaunch", () => {
    const source = readFileSync(resolve(__dirname, "journey.pw.ts"), "utf8")
    expect(source).toContain("const recordingStartedAt = new Date().toISOString()")
    expect(source).toContain("recordingBounds.set(page, { startedAt: recordingStartedAt })")
    expect(source).toContain("if (bounds && bounds.finishedAt === undefined) bounds.finishedAt = new Date().toISOString()")
    expect(source).toContain("savedRecordings[i].push")
    expect(source).toContain("video.saveAs(path)")
    expect(source).toContain("k === ps.length - 1")
    expect(source.indexOf("savedRecordings[i].push")).toBeLessThan(source.lastIndexOf("saveResults()"))
  })
  it("keeps every evidenced crew member on the HUD and advances their own state", () => {
    const captain = result(1, "baseline-account", "jollitypv.12", "baseline-iphone14-wifi")
    const rejoiner = result(2, "rejoiner-account", "jollitypv.29", "kill-background-iphone13")
    const packet = result(3, "packet-account", "jollystorm.90", "storm-pixel6a-timeline")
    captain.narration = [transition("2026-10-18T17:59:50.000Z", "preparing", "journey", "Baseline", "Captain Baseline is healthy.")]
    rejoiner.narration = [
      transition("2026-10-18T17:59:55.000Z", "preparing", "journey", "Relaunch", "The Rejoiner is ready."),
      transition("2026-10-18T18:00:30.000Z", "active", "role", "Relaunch", "The Rejoiner is reconnecting.", "role.killed"),
      transition("2026-10-18T18:00:42.000Z", "recovered", "role", "Relaunch", "The Rejoiner reconnected.", "role.relaunched"),
    ]
    packet.narration = [
      transition("2026-10-18T17:59:58.000Z", "preparing", "journey", "Packet storm", "Packet Jack is ready."),
      transition("2026-10-18T18:01:00.000Z", "active", "network", "Packet storm", "Packet Jack applies 30% packet loss.", "network.1"),
    ]

    const sheet = buildRecordingCueSheet({ runId: "39160000000", receiver: captain, results: [packet, captain, rejoiner], segment, durationSeconds: 120 })

    expect(sheet.receiver.displayName).toBe("Captain Baseline")
    expect(sheet.participants.map((participant) => participant.displayName)).toEqual(["Captain Baseline", "The Rejoiner", "Packet Jack"])
    expect(sheet.participants.every((participant) => contrast(participant.colour, "#0D1321") >= 4.5)).toBe(true)
    expect(sheet.participants.find((participant) => participant.displayName === "Captain Baseline")?.states).toEqual([
      expect.objectContaining({ startSeconds: 0, state: "preparing", text: "Captain Baseline is healthy." }),
    ])
    expect(sheet.participants.find((participant) => participant.displayName === "The Rejoiner")?.states).toEqual([
      expect.objectContaining({ startSeconds: 0, endSeconds: 30, state: "preparing" }),
      expect.objectContaining({ startSeconds: 30, endSeconds: 42, state: "active", text: "The Rejoiner is reconnecting." }),
      expect.objectContaining({ startSeconds: 42, endSeconds: 120, state: "recovered", text: "The Rejoiner reconnected." }),
    ])
    expect(sheet.participants.find((participant) => participant.displayName === "Packet Jack")?.states).toContainEqual(
      expect.objectContaining({ startSeconds: 60, state: "active", text: "Packet Jack applies 30% packet loss." }),
    )
    expect(sheet.unavailable).toEqual([])

    const svg = renderRecordingHudSvg(sheet, 61, { videoHeight: 914, panelWidth: 430 })
    for (const text of ["WHAT THE CREW IS DOING", "Receiver: Captain Baseline", "The Rejoiner", "reconnected", "Packet Jack", "30% packet loss", "Captain Baseline is healthy"]) expect(svg).toContain(text)
  })

  it("keeps the character's real action visible when the in-page HUD transport times out", () => {
    const captain = result(1, "baseline-account", "jollitypv.12", "baseline-iphone14-wifi")
    const rejoiner = result(2, "rejoiner-account", "jollitypv.29", "kill-background-iphone13")
    rejoiner.narration = [
      transition("2026-10-18T18:00:30.000Z", "active", "role", "Relaunch", "The Rejoiner is reconnecting.", "role.killed"),
      transition("2026-10-18T18:00:32.000Z", "failed", "outcome", "Recording overlay unavailable", "The test continued, but this page could not show the recording overlay.", "render.2", "renderer timed out after 2000 ms"),
      transition("2026-10-18T18:00:42.000Z", "recovered", "role", "Relaunch", "The Rejoiner reconnected.", "role.relaunched"),
    ]

    const sheet = buildRecordingCueSheet({ runId: "39160000000", receiver: captain, results: [captain, rejoiner], segment, durationSeconds: 120 })
    const states = sheet.participants.find((participant) => participant.displayName === "The Rejoiner")?.states

    expect(states).toEqual([
      expect.objectContaining({ startSeconds: 0, endSeconds: 30, state: "unavailable" }),
      expect.objectContaining({ startSeconds: 30, endSeconds: 42, state: "active", text: "The Rejoiner is reconnecting." }),
      expect.objectContaining({ startSeconds: 42, endSeconds: 120, state: "recovered", text: "The Rejoiner reconnected." }),
    ])
    expect(JSON.stringify(states)).not.toContain("Recording overlay unavailable")
    expect(JSON.stringify(states)).not.toContain("could not show the recording overlay")
  })

  it.each([
    ["another workflow run", { run: { id: "other-run", attempt: 1 } }],
    ["another attempt", { run: { id: "39160000000", attempt: 2 } }],
    ["another game", { game: { index: 902, gameAt: 1_792_350_000, registrationEnds: 1_792_349_910, reportEnds: 1_792_350_600 } }],
  ])("never imports narration from %s", (_label, override) => {
    const captain = result(1, "baseline-account", "jollitypv.12", "baseline-iphone14-wifi")
    const rejoiner = Object.assign(result(2, "rejoiner-account", "jollitypv.29", "kill-background-iphone13"), override)
    rejoiner.narration = [transition("2026-10-18T18:00:30.000Z", "active", "role", "Relaunch", "The Rejoiner is reconnecting.", "role.killed")]

    const sheet = buildRecordingCueSheet({ runId: "39160000000", receiver: captain, results: [captain, rejoiner], segment, durationSeconds: 120 })

    expect(sheet.participants.map((participant) => participant.displayName)).toEqual(["Captain Baseline"])
    expect(sheet.unavailable).toContainEqual(expect.objectContaining({ account: "rejoiner-account" }))
    expect(JSON.stringify(sheet)).not.toContain("reconnecting")
  })

  it("reports missing crew evidence instead of filling it from the profile plan", () => {
    const captain = result(1, "baseline-account", "jollitypv.12", "baseline-iphone14-wifi")
    const sheet = buildRecordingCueSheet({ runId: "39160000000", receiver: captain, results: [captain], segment, durationSeconds: 120 })

    expect(sheet.unavailable.map((entry) => entry.account)).toEqual(["packet-account", "rejoiner-account"])
    expect(renderRecordingHudSvg(sheet, 30, { videoHeight: 914, panelWidth: 430 })).toContain("Evidence unavailable")
  })

  it("aligns later recording parts independently and preserves a state that began before the part", () => {
    const captain = result(1, "baseline-account", "jollitypv.12", "baseline-iphone14-wifi")
    const rejoiner = result(2, "rejoiner-account", "jollitypv.29", "kill-background-iphone13")
    rejoiner.narration = [
      transition("2026-10-18T18:00:30.000Z", "active", "role", "Relaunch", "The Rejoiner is reconnecting.", "role.killed"),
      transition("2026-10-18T18:00:42.000Z", "recovered", "role", "Relaunch", "The Rejoiner reconnected.", "role.relaunched"),
    ]
    const later: RecordingSegment = { file: "video-1.webm", pageOrdinal: 1, startedAt: "2026-10-18T18:00:35.000Z", finishedAt: "2026-10-18T18:01:35.000Z" }

    const sheet = buildRecordingCueSheet({ runId: "39160000000", receiver: captain, results: [captain, rejoiner], segment: later, durationSeconds: 60 })
    expect(sheet.participants.find((participant) => participant.displayName === "The Rejoiner")?.states).toEqual([
      expect.objectContaining({ startSeconds: 0, endSeconds: 7, state: "active" }),
      expect.objectContaining({ startSeconds: 7, endSeconds: 60, state: "recovered" }),
    ])
  })

  it("uses deterministic ordering for simultaneous events", () => {
    const captain = result(1, "baseline-account", "jollitypv.12", "baseline-iphone14-wifi")
    const rejoiner = result(2, "rejoiner-account", "jollitypv.29", "kill-background-iphone13")
    const packet = result(3, "packet-account", "jollystorm.90", "storm-pixel6a-timeline")
    rejoiner.narration = [transition("2026-10-18T18:00:30.000Z", "active", "role", "Relaunch", "The Rejoiner reconnects.")]
    packet.narration = [transition("2026-10-18T18:00:30.000Z", "active", "network", "Storm", "Packet Jack drops packets.")]

    const one = buildRecordingCueSheet({ runId: "39160000000", receiver: captain, results: [captain, rejoiner, packet], segment, durationSeconds: 120 })
    const two = buildRecordingCueSheet({ runId: "39160000000", receiver: captain, results: [packet, rejoiner, captain], segment, durationSeconds: 120 })
    expect(two).toEqual(one)
    expect(one.participants.find((participant) => participant.displayName === "The Rejoiner")?.states[0]).toEqual(expect.objectContaining({
      startSeconds: 0,
      endSeconds: 30,
      state: "unavailable",
      text: expect.stringContaining("begins later"),
    }))
  })

  it("does not import an event exactly at the segment end or leave an empty state rail", () => {
    const captain = result(1, "baseline-account", "jollitypv.12", "baseline-iphone14-wifi")
    captain.narration = [transition("2026-10-18T18:02:00.000Z", "passed", "outcome", "Baseline", "This belongs after the captured frames.")]
    const sheet = buildRecordingCueSheet({ runId: "39160000000", receiver: captain, results: [captain], segment, durationSeconds: 120 })
    expect(sheet.participants[0].states).toEqual([expect.objectContaining({ startSeconds: 0, endSeconds: 120, state: "unavailable" })])
    expect(JSON.stringify(sheet)).not.toContain("belongs after")
  })

  it("fits the maximum two-round eleven-person roster on an iPhone SE rail", () => {
    const catalogue = loadCrewCatalogue()
    const identities = catalogue.identities.slice(0, 11)
    const crew = identities.map((entry, index) => {
      const value = result(index + 1, `account-${index + 1}`, entry.username, "baseline-iphone14-wifi")
      value.narration = [transition("2026-10-18T17:59:50.000Z", "preparing", "journey", "Ready", `${entry.displayName} is ready.`)]
      return value
    })
    crew[0].groups = [
      { round: 0, ownIndex: 0, members: Array.from({ length: 6 }, (_, index) => ({ index, account: `account-${index + 1}` })) },
      { round: 1, ownIndex: 0, members: [{ index: 0, account: "account-1" }, ...Array.from({ length: 5 }, (_, index) => ({ index: index + 1, account: `account-${index + 7}` }))] },
    ]
    const sheet = buildRecordingCueSheet({ runId: "39160000000", receiver: crew[0], results: crew, segment, durationSeconds: 120 })
    const svg = renderRecordingHudSvg(sheet, 30, { videoHeight: 568, panelWidth: 430 })
    const rowYs = [...svg.matchAll(/translate\(22 (\d+)\)/g)].map((match) => Number(match[1]))
    expect(sheet.participants).toHaveLength(11)
    expect(svg).toContain(identities[10].displayName)
    expect(Math.max(...rowYs)).toBeLessThan(510)
  })

  it("uses compact non-overlapping rows for a six-person iPhone SE rail", () => {
    const catalogue = loadCrewCatalogue()
    const crew = catalogue.identities.slice(0, 6).map((entry, index) => {
      const value = result(index + 1, `account-${index + 1}`, entry.username, "baseline-iphone14-wifi")
      value.narration = [transition("2026-10-18T17:59:50.000Z", "preparing", "journey", "Ready", `${entry.displayName} is handling a deliberately long quality challenge explanation for the compact rail.`)]
      return value
    })
    crew[0].groups = [{ round: 0, ownIndex: 0, members: crew.map((_, index) => ({ index, account: `account-${index + 1}` })) }]
    const sheet = buildRecordingCueSheet({ runId: "39160000000", receiver: crew[0], results: crew, segment, durationSeconds: 120 })
    const svg = renderRecordingHudSvg(sheet, 30, { videoHeight: 568, panelWidth: 430 })
    const rowYs = [...svg.matchAll(/translate\(22 (\d+)\)/g)].map((match) => Number(match[1]))

    expect(rowYs.slice(1).map((value, index) => value - rowYs[index]).every((gap) => gap === 66)).toBe(true)
    expect(svg).not.toContain("deliberately long quality challenge explanation")
  })

  it.each(["manual", "wave-2"])("keeps the original recording byte-for-byte and scopes derived evidence to %s", async (executionKey) => {
    const root = mkdtempSync(join(tmpdir(), "jollity-recording-annotation-"))
    const input = join(root, "input")
    const output = join(root, "output")
    mkdirSync(input)
    const source = join(input, segment.file)
    writeFileSync(source, "immutable original webm bytes")
    const captain = result(1, "baseline-account", "jollitypv.12", "baseline-iphone14-wifi")
    captain.narration = [transition("2026-10-18T18:00:10.000Z", "preparing", "journey", "Baseline", "Captain Baseline is healthy.")]
    const before = readFileSync(source)

    const manifest = await renderAnnotatedBot({
      executionKey,
      runId: "39160000000",
      receiver: captain,
      results: [captain],
      inputDirectory: relative(process.cwd(), input),
      outputDirectory: relative(process.cwd(), output),
      media: {
        probe: () => ({ width: 412, height: 914, durationSeconds: 120, createdAt: segment.startedAt }),
        render: ({ overlayConcatFile, outputFile }) => {
          expect(resolve(overlayConcatFile)).toBe(overlayConcatFile)
          expect(resolve(outputFile)).toBe(outputFile)
          writeFileSync(outputFile, `derived video\n${readFileSync(overlayConcatFile, "utf8")}`)
        },
      },
    })

    expect(readFileSync(source)).toEqual(before)
    expect(manifest.sourceArtifact).toBe(`e2e-live-39160000000-attempt-1-${executionKey}-bot1`)
    expect(manifest.segments).toEqual([
      expect.objectContaining({
        sourceFile: "video-1.webm",
        annotatedFile: "video-1.annotated.mp4",
        downloadedSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        annotatedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        overlayFrames: expect.any(Number),
      }),
    ])
    expect(manifest.segments[0].annotatedSha256).not.toBe(manifest.segments[0].downloadedSourceSha256)
    expect(readFileSync(join(output, "annotation-manifest.json"), "utf8")).toContain('"clockBasis": "runner-wall-clock-media-calibrated"')
    expect(readFileSync(join(output, "video-1.cues.json"), "utf8")).toContain("Captain Baseline is healthy")
  })

  it("fails closed when WebM duration and the runner's segment clock disagree", async () => {
    const root = mkdtempSync(join(tmpdir(), "jollity-recording-clock-"))
    const input = join(root, "input")
    const output = join(root, "output")
    mkdirSync(input)
    writeFileSync(join(input, segment.file), "immutable original webm bytes")
    const captain = result(1, "baseline-account", "jollitypv.12", "baseline-iphone14-wifi")
    captain.recordings = [{ ...segment, finishedAt: "2026-10-18T18:00:01.000Z" }]
    captain.narration = [transition("2026-10-18T18:00:59.000Z", "active", "role", "Impossible", "This event is outside the declared recording clock.")]
    await expect(renderAnnotatedBot({
      executionKey: "manual",
      runId: "39160000000",
      receiver: captain,
      results: [captain],
      inputDirectory: input,
      outputDirectory: output,
      media: {
        probe: () => ({ width: 412, height: 914, durationSeconds: 120, createdAt: segment.startedAt }),
        render: () => { throw new Error("must not render") },
      },
    })).rejects.toThrow(/recording clock cannot be calibrated/i)
  })

  it("keeps a good relaunch segment when another segment is unusable", async () => {
    const root = mkdtempSync(join(tmpdir(), "jollity-recording-partial-"))
    const input = join(root, "input")
    const output = join(root, "output")
    mkdirSync(input)
    const bad: RecordingSegment = { file: "video-1-part1.webm", pageOrdinal: 0, startedAt: "2026-10-18T18:00:00.000Z", finishedAt: "2026-10-18T18:00:10.000Z" }
    const good: RecordingSegment = { file: "video-1.webm", pageOrdinal: 1, startedAt: "2026-10-18T18:01:00.000Z", finishedAt: "2026-10-18T18:03:00.000Z" }
    writeFileSync(join(input, bad.file), "bad segment bytes")
    writeFileSync(join(input, good.file), "good segment bytes")
    const captain = result(1, "baseline-account", "jollitypv.12", "baseline-iphone14-wifi")
    captain.recordings = [bad, good]
    captain.narration = [transition("2026-10-18T18:01:10.000Z", "preparing", "journey", "Baseline", "Captain Baseline is healthy.")]

    const manifest = await renderAnnotatedBot({
      executionKey: "manual",
      runId: "39160000000",
      receiver: captain,
      results: [captain],
      inputDirectory: input,
      outputDirectory: output,
      media: {
        probe: (sourceFile) => ({ width: 412, height: 914, durationSeconds: 120, createdAt: sourceFile.endsWith("part1.webm") ? bad.startedAt : good.startedAt }),
        render: ({ outputFile }) => writeFileSync(outputFile, "derived video"),
      },
    })

    expect(manifest.segments.map((entry) => entry.sourceFile)).toEqual([good.file])
    expect(manifest.unavailableSegments).toEqual([{ sourceFile: bad.file, detail: expect.stringMatching(/clock cannot be calibrated/) }])
  })
})
