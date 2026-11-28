// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Generate deterministic identity-specific fake-camera clips for live E2E.
// The clip is the camera source itself, so WebRTC degradation and recovery are
// visible to remote peers. Boot-only checks use a neutral harness clip.
//
//   npx tsx scripts/e2e-live/make-y4m.mts <dir> [--boot] [profile ...]
//
// Prints one E2E_FAKE_VIDEO_DIR line for GitHub Actions to export.
import { mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { identityFor, type Profile } from "./profile"
import { profileForName } from "./profiles"
import { crewIdentity, type CrewIdentity } from "./crew/catalogue"
import { harnessCameraClipPath, identityCameraClipPath, type CameraClipResolution } from "./crew/camera-clip"
import { prepareIdentityFrameRenderer, renderHarnessFrame, rgbToYuv420 } from "./crew/camera-frame"

export type ClipMode = "game" | "boot"
export type ClipResolution = CameraClipResolution

interface ClipPlanBase {
  profile: string
  resolution: ClipResolution
  width: number
  height: number
  path: string
}

export type ClipPlan = (ClipPlanBase & { kind: "identity"; identity: CrewIdentity })
  | (ClipPlanBase & { kind: "harness" })

const geometry = (resolution: ClipResolution): readonly [number, number] => resolution === "720p" ? [1280, 720] : [640, 360]
const safeProfile = (value: string): string => {
  if (!/^[a-z0-9-]+$/.test(value)) throw new Error(`unsafe profile name ${JSON.stringify(value)}`)
  return value
}

export function clipPlansForProfiles(dir: string, names: readonly string[], mode: ClipMode): ClipPlan[] {
  const plans: ClipPlan[] = []
  const seen = new Set<string>()
  for (const rawName of names) {
    const name = safeProfile(rawName)
    const profile = profileForName(name)
    const resolution: ClipResolution = profile?.camera.resolution ?? "720p"
    const [width, height] = geometry(resolution)
    if (mode === "boot") {
      const key = `harness:${name}:${resolution}`
      if (seen.has(key)) continue
      seen.add(key)
      plans.push({ kind: "harness", profile: name, resolution, width, height, path: harnessCameraClipPath(dir, name, resolution) })
      continue
    }
    if (!profile) continue
    const username = identityFor(profile as Profile, "previewnet")
    if (!username) continue
    const identity = crewIdentity(username)
    const key = `identity:${identity.key}:${resolution}`
    if (seen.has(key)) continue
    seen.add(key)
    plans.push({ kind: "identity", profile: name, resolution, width, height, identity, path: identityCameraClipPath(dir, identity.key, resolution) })
  }
  return plans
}

const header = (width: number, height: number, fps: number): Buffer => Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`)

async function renderClip(plan: ClipPlan, frameCount = 30, fps = 15): Promise<Buffer> {
  const parts: Buffer[] = [header(plan.width, plan.height, fps)]
  const renderFrame = plan.kind === "identity"
    ? await prepareIdentityFrameRenderer(plan.identity, plan.width, plan.height)
    : (frameIndex: number) => renderHarnessFrame(plan.profile, plan.width, plan.height, frameIndex)
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const rgb = await renderFrame(frameIndex)
    parts.push(Buffer.from("FRAME\n"), rgbToYuv420(rgb, plan.width, plan.height))
  }
  return Buffer.concat(parts)
}

export async function generateClips(dir: string, names: readonly string[], mode: ClipMode): Promise<ClipPlan[]> {
  const absolute = isAbsolute(dir) ? dir : resolve(dir)
  await mkdir(absolute, { recursive: true })
  const plans = clipPlansForProfiles(absolute, names, mode)
  for (const plan of plans) await writeFile(plan.path, await renderClip(plan))
  return plans
}

export interface ParsedY4m {
  width: number
  height: number
  fps: number
  frames: Buffer[]
}

export function readY4m(bytes: Buffer): ParsedY4m {
  const headerEnd = bytes.indexOf(10)
  if (headerEnd < 0) throw new Error("Y4M header is missing a newline")
  const line = bytes.subarray(0, headerEnd).toString("ascii")
  const width = Number(/(?:^| )W(\d+)/.exec(line)?.[1])
  const height = Number(/(?:^| )H(\d+)/.exec(line)?.[1])
  const fps = Number(/(?:^| )F(\d+):/.exec(line)?.[1])
  if (!width || !height || !fps || width % 2 || height % 2) throw new Error(`unsupported Y4M header ${JSON.stringify(line)}`)
  const frameSize = width * height + 2 * (width / 2) * (height / 2)
  const marker = Buffer.from("FRAME\n")
  const frames: Buffer[] = []
  let offset = headerEnd + 1
  while (offset < bytes.length) {
    if (!bytes.subarray(offset, offset + marker.length).equals(marker)) throw new Error(`invalid Y4M frame marker at ${offset}`)
    offset += marker.length
    const end = offset + frameSize
    if (end > bytes.length) throw new Error("truncated Y4M frame")
    frames.push(bytes.subarray(offset, end))
    offset = end
  }
  return { width, height, fps, frames }
}

if (process.argv[1]?.endsWith("make-y4m.mts")) {
  const dir = process.argv[2]
  if (!dir) throw new Error("usage: make-y4m.mts <dir> [--boot] [profile ...]")
  const args = process.argv.slice(3)
  const mode: ClipMode = args.includes("--boot") ? "boot" : "game"
  const names = args.filter((arg) => arg !== "--boot" && Boolean(arg))
  await generateClips(dir, names.length ? names : [process.env.E2E_PROFILE ?? "baseline"], mode)
  console.log(`E2E_FAKE_VIDEO_DIR=${resolve(dir)}`)
}
