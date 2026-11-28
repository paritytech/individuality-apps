// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import sharp from "sharp"
import { buildRecordingCueSheet, renderRecordingHudSvg, type RecordingCueSheet } from "./recording-annotation"
import { attemptArtifactName, validateExecutionKey, validateRecordingProvenance, type SlotResult } from "./result"

export interface VideoProbe {
  width: number
  height: number
  durationSeconds: number
  createdAt: string
}

export interface RecordingMediaTools {
  probe(sourceFile: string): VideoProbe
  render(input: { sourceFile: string; overlayConcatFile: string; outputFile: string; panelWidth: number }): void | Promise<void>
}

export interface AnnotationManifest {
  version: 1
  runId: string
  attempt: number
  slot: number
  gameIndex: number
  receiver: RecordingCueSheet["receiver"]
  clockBasis: RecordingCueSheet["clockBasis"]
  sourceArtifact: string
  originalPreserved: true
  segments: {
    sourceFile: string
    downloadedSourceSha256: string
    annotatedFile: string
    annotatedSha256: string
    cuesFile: string
    overlayFrames: number
    width: number
    height: number
    panelWidth: number
    durationSeconds: number
    mediaStartedAt: string
  }[]
  unavailableSegments: { sourceFile: string; detail: string }[]
}

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex")

export const ffmpegMediaTools: RecordingMediaTools = {
  probe(sourceFile) {
    const raw = JSON.parse(execFileSync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration:format_tags=creation_time",
      "-of", "json",
      sourceFile,
    ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string; tags?: { creation_time?: string } } }
    const width = Number(raw.streams?.[0]?.width)
    const height = Number(raw.streams?.[0]?.height)
    const durationSeconds = Number(raw.format?.duration)
    const createdAtMs = Date.parse(raw.format?.tags?.creation_time ?? "")
    if (![width, height, durationSeconds].every((value) => Number.isFinite(value) && value > 0)) throw new Error(`ffprobe returned invalid video metadata for ${basename(sourceFile)}`)
    if (!Number.isFinite(createdAtMs)) throw new Error(`ffprobe returned no creation_time for ${basename(sourceFile)}`)
    return { width, height, durationSeconds, createdAt: new Date(createdAtMs).toISOString() }
  },
  render({ sourceFile, overlayConcatFile, outputFile, panelWidth }) {
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", sourceFile,
      "-f", "concat", "-safe", "0", "-i", overlayConcatFile,
      "-filter_complex", `[0:v]pad=iw+${panelWidth}:ih:0:0:color=0x0D1321[base];[base][1:v]overlay=x=W-w:y=0:eof_action=repeat:shortest=1[out]`,
      "-map", "[out]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      outputFile,
    ], { cwd: dirname(overlayConcatFile), stdio: "inherit" })
  },
}

const frameBoundaries = (sheet: RecordingCueSheet): number[] => [...new Set([
  0,
  sheet.segment.durationSeconds,
  ...sheet.participants.flatMap((participant) => participant.states.flatMap((state) => [state.startSeconds, state.endSeconds])),
])].filter((value) => value >= 0 && value <= sheet.segment.durationSeconds).sort((one, two) => one - two)

export async function renderAnnotatedBot(input: {
  runId: string
  executionKey?: string
  receiver: SlotResult
  results: readonly SlotResult[]
  inputDirectory: string
  outputDirectory: string
  media?: RecordingMediaTools
}): Promise<AnnotationManifest> {
  const { runId, receiver, results } = input
  const executionKey = validateExecutionKey(input.executionKey ?? process.env.E2E_EXECUTION_KEY ?? "manual")
  const inputDirectory = resolve(input.inputDirectory)
  const outputDirectory = resolve(input.outputDirectory)
  const media = input.media ?? ffmpegMediaTools
  validateRecordingProvenance(receiver)
  if (receiver.version !== 2) throw new Error(`bot ${receiver.slot} result predates recording narration`)
  if (receiver.run?.id !== runId || !receiver.run.attempt) throw new Error(`bot ${receiver.slot} has no exact run/attempt provenance`)
  if (!receiver.game) throw new Error(`bot ${receiver.slot} has no game provenance`)
  if (!receiver.recordings?.length) throw new Error(`bot ${receiver.slot} has no recording-segment provenance`)
  mkdirSync(outputDirectory, { recursive: true })
  const segments: AnnotationManifest["segments"] = []
  const unavailableSegments: AnnotationManifest["unavailableSegments"] = []

  for (const segment of [...receiver.recordings].sort((one, two) => one.pageOrdinal - two.pageOrdinal)) {
    const sourceFile = resolve(inputDirectory, segment.file)
    let sourceBefore: string | null = null
    try {
      if (resolve(inputDirectory, basename(segment.file)) !== sourceFile) throw new Error(`unsafe recording path ${segment.file}`)
      sourceBefore = sha256(sourceFile)
      const probe = media.probe(sourceFile)
      const requestedAt = Date.parse(segment.startedAt)
      const finishedAt = Date.parse(segment.finishedAt)
      const mediaStartedAt = Date.parse(probe.createdAt)
      const mediaFinishedAt = mediaStartedAt + probe.durationSeconds * 1000
      if (![requestedAt, finishedAt, mediaStartedAt, mediaFinishedAt].every(Number.isFinite) || mediaStartedAt < requestedAt - 1_000 || mediaStartedAt > finishedAt || Math.abs(mediaFinishedAt - finishedAt) > 15_000) {
        throw new Error(`recording clock cannot be calibrated to ${segment.file}`)
      }
      const panelWidth = 430 + ((probe.width + 430) % 2)
      const calibratedSegment = { ...segment, startedAt: probe.createdAt }
      const cueSheet = buildRecordingCueSheet({ runId, receiver, results, segment: calibratedSegment, durationSeconds: probe.durationSeconds })
      const stem = basename(segment.file, ".webm")
      const cuesFile = `${stem}.cues.json`
      const annotatedFile = `${stem}.annotated.mp4`
      const cuesPath = join(outputDirectory, cuesFile)
      const annotatedPath = join(outputDirectory, annotatedFile)
      writeFileSync(cuesPath, JSON.stringify(cueSheet, null, 2) + "\n")
      const boundaries = frameBoundaries(cueSheet)
      const frameNames: string[] = []
      for (let index = 0; index < boundaries.length - 1; index += 1) {
        const name = `${stem}.hud-${String(index).padStart(3, "0")}.png`
        frameNames.push(name)
        const svg = renderRecordingHudSvg(cueSheet, boundaries[index], { videoHeight: probe.height, panelWidth })
        await sharp(Buffer.from(svg)).png().toFile(join(outputDirectory, name))
      }
      const concatFile = `${stem}.hud.ffconcat`
      const concatPath = join(outputDirectory, concatFile)
      const concatLines = ["ffconcat version 1.0"]
      frameNames.forEach((name, index) => {
        concatLines.push(`file '${name}'`)
        concatLines.push(`duration ${(boundaries[index + 1] - boundaries[index]).toFixed(3)}`)
      })
      // The concat demuxer applies the final duration only when the last frame
      // appears again. The duplicate is metadata, not another visible interval.
      concatLines.push(`file '${frameNames.at(-1)}'`)
      writeFileSync(concatPath, concatLines.join("\n") + "\n")
      await media.render({ sourceFile, overlayConcatFile: concatPath, outputFile: annotatedPath, panelWidth })
      const sourceAfter = sha256(sourceFile)
      if (sourceAfter !== sourceBefore) throw new Error(`annotation modified original ${segment.file}`)
      segments.push({
        sourceFile: segment.file,
        downloadedSourceSha256: sourceBefore,
        annotatedFile,
        annotatedSha256: sha256(annotatedPath),
        cuesFile,
        overlayFrames: frameNames.length,
        width: probe.width,
        height: probe.height,
        panelWidth,
        durationSeconds: probe.durationSeconds,
        mediaStartedAt: probe.createdAt,
      })
    } catch (error) {
      if (sourceBefore !== null && sha256(sourceFile) !== sourceBefore) throw new Error(`annotation modified original ${segment.file}`)
      unavailableSegments.push({ sourceFile: segment.file, detail: String((error as Error)?.message ?? error).split("\n")[0] })
    }
  }

  if (segments.length === 0) throw new Error(`no recording segments could be annotated: ${unavailableSegments.map((segment) => `${segment.sourceFile}: ${segment.detail}`).join("; ")}`)
  const firstCue = JSON.parse(readFileSync(join(outputDirectory, segments[0].cuesFile), "utf8")) as RecordingCueSheet
  const manifest: AnnotationManifest = {
    version: 1,
    runId,
    attempt: receiver.run.attempt,
    slot: receiver.slot,
    gameIndex: receiver.game.index,
    receiver: firstCue.receiver,
    clockBasis: firstCue.clockBasis,
    sourceArtifact: attemptArtifactName(runId, receiver.slot, receiver.run.attempt, executionKey),
    originalPreserved: true,
    segments,
    unavailableSegments,
  }
  writeFileSync(join(outputDirectory, "annotation-manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  return manifest
}
