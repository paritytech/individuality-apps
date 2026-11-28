// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { access, mkdtemp, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { crewIdentity, loadCrewCatalogue } from "./catalogue"
import {
  frameRegions,
  harnessFrameSvg,
  identityFrameSvg,
  identityGesture,
  identityGesturePosePath,
  identityGestureSubjectBounds,
  measureGestureSubjectBounds,
  renderHarnessFrame,
  renderIdentityFrame,
  rgbToYuv420,
  squareSafeRegion,
} from "./camera-frame"

const rgbAt = (frame: Buffer, width: number, x: number, y: number): readonly number[] => {
  const offset = (y * width + x) * 3
  return [frame[offset], frame[offset + 1], frame[offset + 2]]
}

const variedPixels = (frame: Buffer, width: number, region: { x: number; y: number; width: number; height: number }): number => {
  const first = rgbAt(frame, width, region.x, region.y).join(",")
  let varied = 0
  for (let y = region.y; y < region.y + region.height; y += Math.max(1, Math.floor(region.height / 20))) {
    for (let x = region.x; x < region.x + region.width; x += Math.max(1, Math.floor(region.width / 20))) {
      if (rgbAt(frame, width, x, y).join(",") !== first) varied++
    }
  }
  return varied
}

const regionBytes = (frame: Buffer, width: number, region: { x: number; y: number; width: number; height: number }): Buffer => {
  const rows: Buffer[] = []
  for (let y = region.y; y < region.y + region.height; y++) {
    const start = (y * width + region.x) * 3
    rows.push(frame.subarray(start, start + region.width * 3))
  }
  return Buffer.concat(rows)
}

describe.each([
  [640, 360],
  [1280, 720],
] as const)("camera frame at %ix%i", (width, height) => {
  it("keeps the ordinary portrait card with its display name and username", async () => {
    const identity = crewIdentity("jollitypv.12")
    const still = await renderIdentityFrame(identity, width, height, 0)
    const posed = await renderIdentityFrame(identity, width, height, 15)
    const stillAgain = await renderIdentityFrame(identity, width, height, 0)
    const plateLess = await renderIdentityFrame(identity, width, height, 0, false)
    const svg = identityFrameSvg(identity, width, height, 0)

    expect(still).toHaveLength(width * height * 3)
    expect(svg).toContain(identity.displayName.split(" ")[0])
    expect(svg).toContain(identity.username)
    expect(still.equals(posed)).toBe(false)
    expect(still.equals(stillAgain)).toBe(true)
    const regions = frameRegions(width, height)
    const safe = squareSafeRegion(width, height)
    for (const plate of [regions.name, regions.username]) {
      expect(plate.x).toBeGreaterThanOrEqual(safe.x)
      expect(plate.x + plate.width).toBeLessThanOrEqual(safe.x + safe.width)
      expect(regionBytes(still, width, plate).equals(regionBytes(plateLess, width, plate))).toBe(false)
      expect(regionBytes(still, width, plate).equals(regionBytes(posed, width, plate))).toBe(true)
    }
    expect(regionBytes(still, width, regions.portrait).equals(regionBytes(posed, width, regions.portrait))).toBe(false)
    const samples = await mkdtemp(join(tmpdir(), "crew-frame-sample-"))
    await sharp(still, { raw: { width, height, channels: 3 } }).png().toFile(join(samples, `identity-${width}x${height}.png`))
  })

  it("renders a legible boot harness without crew portrait content", async () => {
    const profile = "slow-pixel7-lte-poor"
    const svg = harnessFrameSvg(profile, width, height, 0)
    expect(svg).toContain("Harness Check")
    expect(svg).toContain(profile)
    for (const identity of loadCrewCatalogue().identities) {
      expect(svg).not.toContain(identity.displayName)
      expect(svg).not.toContain(identity.username)
    }
    const frame = await renderHarnessFrame(profile, width, height, 0)
    const regions = frameRegions(width, height)
    expect(variedPixels(frame, width, regions.name)).toBeGreaterThan(15)
    expect(variedPixels(frame, width, regions.username)).toBeGreaterThan(8)
    const samples = await mkdtemp(join(tmpdir(), "crew-harness-sample-"))
    await sharp(frame, { raw: { width, height, channels: 3 } }).png().toFile(join(samples, `harness-${width}x${height}.png`))
  })
})

describe("crew gestures", () => {
  it("loads the gesture path through the CommonJS Playwright runtime", async () => {
    const source = await readFile(join(process.cwd(), "scripts/e2e-live/crew/camera-frame.ts"), "utf8")
    const compiled = ts.transpileModule(source, {
      compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, resolveJsonModule: true, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const cjsModule = { exports: {} as Record<string, unknown> }
    const cjsRequire = (id: string): unknown => {
      if (id === "node:path") return { join }
      if (id === "sharp") return () => undefined
      if (id === "./gesture-poses/subject-bounds.json") return {}
      throw new Error(`unexpected CommonJS dependency: ${id}`)
    }
    new Function("require", "exports", "module", compiled)(cjsRequire, cjsModule.exports, cjsModule)
    const posePath = (cjsModule.exports as {
      identityGesturePosePath(identity: { key: string }, pose: "a" | "b"): string
    }).identityGesturePosePath
    expect(posePath({ key: "captain-baseline" }, "a")).toBe(
      join(process.cwd(), "scripts/e2e-live/crew/gesture-poses/captain-baseline-a.webp"),
    )
  })

  it("assigns a distinct gesture to every playing identity", () => {
    const gestures = loadCrewCatalogue().identities.map(identityGesture)
    expect(gestures).toHaveLength(31)
    expect(new Set(gestures.map(({ label }) => label)).size).toBe(gestures.length)
  })

  it("ships two generated action poses for every identity", async () => {
    const pairs = loadCrewCatalogue().identities.map((identity) => [
      identityGesturePosePath(identity, "a"),
      identityGesturePosePath(identity, "b"),
    ] as const)
    const paths = pairs.flat()
    expect(paths).toHaveLength(62)
    const hashes = await Promise.all(paths.map(async (path) => {
      await access(path)
      expect(await sharp(path).metadata()).toMatchObject({ format: "webp", width: 640, height: 360 })
      return createHash("sha256").update(await readFile(path)).digest("hex")
    }))
    expect(new Set(hashes).size).toBe(paths.length)
    await Promise.all(pairs.map(async ([poseA, poseB]) => {
      expect((await readFile(poseA)).equals(await readFile(poseB))).toBe(false)
    }))
  })

  it("recomputes every generated character subject inside the centred tile-safe square", async () => {
    const safe = squareSafeRegion(640, 360)
    const measured = new Set<string>()
    for (const identity of loadCrewCatalogue().identities) {
      for (const pose of ["a", "b"] as const) {
        const bounds = identityGestureSubjectBounds(identity, pose)
        expect(await measureGestureSubjectBounds(identity, pose), `${identity.key}-${pose} measured manifest`).toEqual(bounds)
        measured.add(JSON.stringify(bounds))
        expect(bounds.width, `${identity.key}-${pose} subject width`).toBeGreaterThan(0)
        expect(bounds.height, `${identity.key}-${pose} subject height`).toBeGreaterThan(0)
        expect(bounds.x, `${identity.key}-${pose} subject left`).toBeGreaterThanOrEqual(safe.x)
        expect(bounds.y, `${identity.key}-${pose} subject top`).toBeGreaterThanOrEqual(safe.y)
        expect(bounds.x + bounds.width, `${identity.key}-${pose} subject right`).toBeLessThanOrEqual(safe.x + safe.width)
        expect(bounds.y + bounds.height, `${identity.key}-${pose} subject bottom`).toBeLessThanOrEqual(safe.y + safe.height)
      }
    }
    expect(measured.size).toBeGreaterThan(20)
  })
})

describe("RGB to YUV420", () => {
  it("requires even dimensions and clamps every output channel", () => {
    expect(() => rgbToYuv420(Buffer.alloc(3 * 3 * 2), 3, 2)).toThrow(/even dimensions/)
    const rgb = Buffer.from([
      0, 0, 0, 255, 255, 255,
      255, 0, 0, 0, 255, 0,
    ])
    const yuv = rgbToYuv420(rgb, 2, 2)
    expect(yuv).toHaveLength(6)
    expect([...yuv].every((value) => value >= 0 && value <= 255)).toBe(true)
  })
})
