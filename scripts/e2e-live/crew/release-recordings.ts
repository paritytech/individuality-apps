// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from "node:child_process"
import { copyFileSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { validatePublicationBundle, validatePublicRunRecord, type PublicationBundle } from "./run-record"
import { attemptArtifactName, validateExecutionKey } from "../result"

export const RECORDING_REPOSITORY = "paritytech/jollity-tests"
export const RECORDING_RETENTION_DAYS = 14
const CREW_TAG = /^crew-run-[1-9][0-9]*-a[1-9][0-9]*(?:-x[a-z0-9][a-z0-9-]{0,63})?$/

export interface RecordingAsset { runKey: string; bot: number; source: string; name: string }
export interface RecordingPlan { repository: string; tag: string; runId: number; attempt: number; executionKey: string | null; assets: RecordingAsset[] }
export interface GitHubRelease { tag_name: string; published_at: string; prerelease: boolean }
export type GhRunner = (args: readonly string[]) => string
export interface PublishRecordingOptions { bundle: unknown; annotationsDir: string; repository?: string; gh?: GhRunner; dryRun?: boolean; now?: Date }
const positive = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`)
  return value
}
const slug = (value: string): string => /^[a-z0-9][a-z0-9-]*$/.test(value) ? value : (() => { throw new Error("persona must be a lowercase slug") })()
const stamp = (value: string): string => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : (() => { throw new Error("release timestamp is invalid") })()
export const recordingReleaseTag = (runId: number, attempt: number, executionKey?: string): string =>
  `crew-run-${positive(runId, "run")}-a${positive(attempt, "attempt")}${executionKey ? `-x${validateExecutionKey(executionKey)}` : ""}`

export const recordingAssetName = (runId: number, attempt: number, bot: number, persona: string, part?: number, executionKey?: string): string =>
  `run-${positive(runId, "run")}-a${positive(attempt, "attempt")}${executionKey ? `-x${validateExecutionKey(executionKey)}` : ""}-bot${String(positive(bot, "bot")).padStart(2, "0")}-${slug(persona)}${part === undefined ? "" : `-p${positive(part, "part")}`}.mp4`
const walk = (root: string, name: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
  const path = join(root, entry.name)
  return entry.isDirectory() ? walk(path, name) : entry.isFile() && entry.name === name ? [path] : []
})
interface AnnotationManifest { version: 1; runId: string; attempt: number; slot: number; receiver: { key: string }; sourceArtifact: string; segments: { annotatedFile: string }[] }
interface AnnotatedVideo { source: string; sourceArtifact: string }
const manifestVideos = (root: string): Map<string, AnnotatedVideo[]> => {
  const videos = new Map<string, AnnotatedVideo[]>()
  for (const path of walk(root, "annotation-manifest.json").sort()) {
    const manifestDirectory = resolve(dirname(path))
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Partial<AnnotationManifest>
    if (manifest.version !== 1 || typeof manifest.runId !== "string" || !/^[1-9][0-9]*$/.test(manifest.runId) ||
      !Number.isSafeInteger(manifest.attempt) || manifest.attempt! < 1 || !Number.isSafeInteger(manifest.slot) || manifest.slot! < 1 ||
      !manifest.receiver || typeof manifest.receiver.key !== "string" || !Array.isArray(manifest.segments) || typeof manifest.sourceArtifact !== "string")
      throw new Error(`invalid annotation manifest ${path}`)
    const key = `${manifest.runId}:${manifest.attempt}:${manifest.slot}:${manifest.receiver.key}`
    const sources = manifest.segments.map((segment) => {
      if (!segment || typeof segment.annotatedFile !== "string" || !segment.annotatedFile.endsWith(".annotated.mp4")) throw new Error(`invalid annotated segment in ${path}`)
      const source = resolve(manifestDirectory, segment.annotatedFile)
      if (dirname(source) !== manifestDirectory) throw new Error(`unsafe annotated segment in ${path}`)
      return { source, sourceArtifact: manifest.sourceArtifact! }
    })
    videos.set(key, [...(videos.get(key) ?? []), ...sources])
  }
  return videos
}
export function planRecordingReleases(bundleValue: unknown, annotationsDir: string, repository = RECORDING_REPOSITORY): { bundle: PublicationBundle; plans: RecordingPlan[] } {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("recording repository must be owner/name")
  const bundle = validatePublicationBundle(bundleValue)
  const runs = bundle.runs.filter((run) => run.bot !== null && run.identity !== null)
  if (!runs.length) return { bundle, plans: [] }
  const videos = manifestVideos(annotationsDir)
  const groups = new Map<string, typeof runs>()
  for (const run of runs) {
    const executionKey = run.suiteId === null ? null : validateExecutionKey(run.executionKey)
    const key = `${run.runId}:${run.attempt}:${executionKey ?? ""}`
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  const plans = [...groups.values()].map((group) => {
    const { runId, attempt } = group[0]!
    const executionKey = group[0]!.suiteId === null ? null : validateExecutionKey(group[0]!.executionKey)
    const assets = group.flatMap((run) => {
      const expectedArtifact = attemptArtifactName(String(run.runId), run.bot!, run.attempt, run.executionKey)
      const key = `${run.runId}:${run.attempt}:${run.bot}:${run.identity!.key}`
      return (videos.get(key) ?? []).map((video, index, all) => {
        if (video.sourceArtifact !== expectedArtifact) throw new Error(`annotation source artifact mismatch for ${run.key}`)
        return {
          runKey: run.key,
          bot: run.bot!,
          source: video.source,
          name: recordingAssetName(runId, attempt, run.bot!, run.identity!.key, all.length > 1 ? index + 1 : undefined, executionKey ?? undefined),
        }
      })
    }).sort((one, two) => one.bot - two.bot || one.name.localeCompare(two.name))
    return { repository, tag: recordingReleaseTag(runId, attempt, executionKey ?? undefined), runId, attempt, executionKey, assets }
  }).filter((plan) => plan.assets.length).sort((one, two) => one.attempt - two.attempt || one.tag.localeCompare(two.tag))
  if (!plans.length) throw new Error("no annotated bot MP4s matched the publication")
  return { bundle, plans }
}

export function planRecordingRelease(bundleValue: unknown, annotationsDir: string, repository = RECORDING_REPOSITORY): { bundle: PublicationBundle; plan: RecordingPlan } {
  const { bundle, plans } = planRecordingReleases(bundleValue, annotationsDir, repository)
  if (plans.length !== 1) throw new Error("one release must contain one source attempt and execution")
  return { bundle, plan: plans[0]! }
}

export function expiredCrewReleaseTags(releases: readonly GitHubRelease[], now: Date): string[] {
  const cutoff = now.getTime() - RECORDING_RETENTION_DAYS * 86_400_000
  return releases.filter((release) => release.prerelease && CREW_TAG.test(release.tag_name) && Date.parse(release.published_at) <= cutoff).map((release) => release.tag_name)
}

// The paginated release listing of the video repository outgrows the 1 MB default (ENOBUFS, 26 Oct).
export const GH_MAX_BUFFER = 64 * 1024 * 1024
const defaultGh: GhRunner = (args) => execFileSync("gh", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GH_MAX_BUFFER }).trim()
const downloadUrl = (plan: RecordingPlan, name: string): string => `https://github.com/${plan.repository}/releases/download/${plan.tag}/${name}`

export function publishRecordingRelease(options: PublishRecordingOptions): { bundle: PublicationBundle; plan: RecordingPlan | null; plans: RecordingPlan[]; commands: string[][] } {
  const { bundle, plans } = planRecordingReleases(options.bundle, options.annotationsDir, options.repository)
  const gh = options.gh ?? defaultGh
  const commands: string[][] = []
  const run = (args: string[]): string => { commands.push(args); return options.dryRun ? "" : gh(args) }
  if (!plans.length) return { plan: null, plans, commands, bundle }
  if (!options.dryRun && run(["api", `repos/${plans[0]!.repository}`, "--jq", ".visibility"]) !== "public") throw new Error("recording repository must be public")
  const releaseTimes = new Map<string, string>()
  for (const plan of plans) {
    let publishedAt = options.now?.toISOString() ?? new Date().toISOString()
    if (!options.dryRun) {
      try { run(["release", "view", plan.tag, "--repo", plan.repository]) } catch { run(["release", "create", plan.tag, "--repo", plan.repository, "--prerelease", "--title", `PreviewNet Crew ${plan.runId} attempt ${plan.attempt}${plan.executionKey ? ` ${plan.executionKey}` : ""}`, "--notes", "Bot-only receiver recordings; retained for 14 days."]) }
    } else run(["release", "create", plan.tag, "--repo", plan.repository, "--prerelease"])
    const uploadDir = mkdtempSync(join(tmpdir(), "crew-recording-release-"))
    try {
      for (const asset of plan.assets) {
        const upload = join(uploadDir, asset.name)
        try { linkSync(asset.source, upload) } catch { copyFileSync(asset.source, upload) }
        run(["release", "upload", plan.tag, upload, "--repo", plan.repository, "--clobber"])
      }
    } finally {
      rmSync(uploadDir, { recursive: true, force: true })
    }
    if (!options.dryRun) {
      const release = JSON.parse(run(["api", `repos/${plan.repository}/releases/tags/${plan.tag}`])) as { published_at: string }
      publishedAt = stamp(release.published_at)
    }
    releaseTimes.set(plan.tag, publishedAt)
  }
  let releases: GitHubRelease[] = []
  if (!options.dryRun) releases = (JSON.parse(run(["api", "--paginate", "--slurp", `repos/${plans[0]!.repository}/releases?per_page=100`])) as GitHubRelease[][]).flat()
  for (const expired of expiredCrewReleaseTags(releases, options.now ?? new Date())) run(["release", "delete", expired, "--repo", plans[0]!.repository, "--cleanup-tag", "--yes"])
  const publications = new Map(plans.flatMap((plan) => plan.assets.map((asset) => [asset.runKey, {
    urls: plan.assets.filter((other) => other.runKey === asset.runKey).map((other) => downloadUrl(plan, other.name)),
    publishedAt: releaseTimes.get(plan.tag)!,
  }] as const)))
  return { plan: plans.length === 1 ? plans[0]! : null, plans, commands, bundle: validatePublicationBundle({ ...bundle, runs: bundle.runs.map((record) => {
    const publication = publications.get(record.key)
    if (publication) return validatePublicRunRecord({ ...record, recording: { state: "available", visibility: "public", artifactUrl: publication.urls[0], artifactUrls: publication.urls, uploadedAt: publication.publishedAt, expiresAt: new Date(Date.parse(publication.publishedAt) + RECORDING_RETENTION_DAYS * 86_400_000).toISOString() } })
    if (record.bot !== null && record.identity !== null) return validatePublicRunRecord({
      ...record,
      recording: { state: "missing", artifactUrl: null, visibility: "organization", uploadedAt: null, expiresAt: null },
    })
    return record
  }) }) }
}
