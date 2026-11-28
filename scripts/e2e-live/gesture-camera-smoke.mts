// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// PR-boot smoke for the exact generated-camera + host-gesture browser path.
// The ordinary boot journey deliberately disables gestures, so without this
// check a transform regression can pass PR boot and break every game bot.
import { createServer } from "node:http"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "@playwright/test"
import { contextOptionsFor, hostGestureScript, readHostGesture, setHostGesture } from "./browser-profile"
import { crewIdentity } from "./crew/catalogue"
import { identityGesturePosePath } from "./crew/camera-frame"
import { profileFor } from "./profile"

const cameraDir = process.env.E2E_FAKE_VIDEO_DIR
if (!cameraDir) throw new Error("E2E_FAKE_VIDEO_DIR is required")
const clip = readdirSync(cameraDir).find((name) => name.endsWith(".y4m"))
if (!clip) throw new Error(`no generated Y4M clip in ${cameraDir}`)

const identity = crewIdentity("jollitypv.12")
const pose = (name: "a" | "b") => `data:image/webp;base64,${readFileSync(identityGesturePosePath(identity, name)).toString("base64")}`
const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html")
  response.end("<!doctype html><video autoplay muted playsinline></video>")
})

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
if (!address || typeof address === "string") throw new Error("camera smoke server did not bind")

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${join(cameraDir, clip)}`,
  ],
})

try {
  const context = await browser.newContext(contextOptionsFor(profileFor(1)))
  const page = await context.newPage()
  await page.addInitScript(hostGestureScript(pose("a"), pose("b")))
  await page.goto(`http://127.0.0.1:${address.port}`)
  const source = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true })
    const video = document.querySelector("video")!
    video.srcObject = stream
    await Promise.race([
      new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve())),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("generated camera produced no frame")), 5_000)),
    ])
    return { width: video.videoWidth, height: video.videoHeight, state: stream.getVideoTracks()[0]?.readyState }
  })
  if (source.state !== "live" || source.width < 1 || source.height < 1) throw new Error(`generated camera is not live: ${JSON.stringify(source)}`)

  const enabled = await setHostGesture(page, true)
  if (!enabled.ready || enabled.sources !== 1) throw new Error(`gesture transform did not attach: ${JSON.stringify(enabled)}`)
  await page.waitForFunction(() => {
    const facts = (globalThis as unknown as { __e2eHostGesture?: { facts(): { framesIn: number; framesOut: number } } }).__e2eHostGesture?.facts()
    return !!facts && facts.framesIn > 0 && facts.framesOut > 0
  }, undefined, { timeout: 5_000 })
  const facts = await readHostGesture(page)
  if (!facts || facts.framesIn < 1 || facts.framesOut < 1) throw new Error(`gesture transform produced no frames: ${JSON.stringify(facts)}`)
  console.log(`camera smoke: ${source.width}x${source.height} native frame; gesture ${facts.framesIn}/${facts.framesOut} frames`)
  await context.close()
} finally {
  await browser.close()
  server.close()
}
