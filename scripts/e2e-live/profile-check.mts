// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Prove every profile in profiles.json takes in a REAL Chromium, with no game,
// no chain and no host: for each profile (or the names on the command line) it
// launches Chromium with chromiumArgsFor, makes the context from
// contextOptionsFor, applies applyPageProfile, loads a trivial page from a
// local server (localhost is a secure context, so getUserMedia works) and
// asserts what the PAGE reports: user agent, viewport, the clock offset, the
// getUserMedia delay and the CPU throttle (a fixed busy loop, against an
// unthrottled page of the same browser).
//
//   npm run e2e:live:profile-check                       every profile
//   npm run e2e:live:profile-check -- slow-pixel7-lte-poor
//
// Needs @playwright/test and a Chromium (`npx playwright install chromium`).
// Set E2E_FAKE_VIDEO_360P / _720P (make-y4m.mts writes the profile's) to check the
// camera resolution too.
import { createServer } from "node:http"
import { chromium } from "@playwright/test"
import { applyPageProfile, cameraClip, chromiumArgsFor, contextOptionsFor, profileChecks, readPageFacts, timeGetUserMedia } from "./browser-profile"
import { loadProfiles } from "./profile"

const server = createServer((_, res) => res.setHeader("content-type", "text/html").end("<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>profile-check</title>"))
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
const url = `http://localhost:${(server.address() as { port: number }).port}/`

const burn = () => {
  const t0 = performance.now()
  let x = 0
  for (let i = 0; i < 3e7; i++) x += i % 7
  return performance.now() - t0 + x * 0
}

const browser = await chromium.launch({ args: chromiumArgsFor(null) })
const wanted = process.argv.slice(2)
const profiles = loadProfiles().filter((p) => !wanted.length || wanted.includes(p.name))
if (!profiles.length) throw new Error(`no profile among ${wanted.join(", ")}`)

// the unthrottled yardstick, in the same browser
const plain = await browser.newPage()
await plain.goto(url)
const baseMs = await plain.evaluate(burn)
await plain.close()

let failed = 0
for (const p of profiles) {
  // the profile's own launch flags matter only for the camera clip; one launch per profile keeps that honest
  const b = await chromium.launch({ args: chromiumArgsFor(p) })
  const opts = contextOptionsFor(p)
  const ctx = await b.newContext(opts)
  const page = await ctx.newPage()
  await applyPageProfile(page, p)
  await page.goto(url)
  const facts = await readPageFacts(page)
  const cam = await timeGetUserMedia(page)
  const checks = profileChecks(p, { userAgent: opts.userAgent, viewport: opts.viewport ?? undefined }, facts, p.camera.delayMs > 0 ? cam.ms : null, cam.error)
  // the frame size is only the profile's when a clip for its resolution is configured (E2E_FAKE_VIDEO_360P / _720P)
  const clip = cameraClip(p)
  if (clip && !cam.error) checks.push({ name: `profile ${p.name}: camera ${p.camera.resolution}`, status: cam.height === (p.camera.resolution === "720p" ? 720 : 360) ? "pass" : "fail", detail: `the fake camera delivered ${cam.width}x${cam.height}` })
  const ms = await page.evaluate(burn)
  const ratio = ms / baseMs
  if (p.cpuThrottle > 1) checks.push({ name: `profile ${p.name}: cpu throttle x${p.cpuThrottle}`, status: ratio >= p.cpuThrottle * 0.5 ? "pass" : "fail", detail: `busy loop ${Math.round(ms)} ms vs ${Math.round(baseMs)} ms unthrottled (x${ratio.toFixed(1)})` })
  console.log(`\n${p.name} (${p.device}, cpu x${p.cpuThrottle}, clock ${p.clockOffsetS >= 0 ? "+" : ""}${p.clockOffsetS} s, camera +${p.camera.delayMs} ms)`)
  for (const c of checks) {
    console.log(`  ${c.status.toUpperCase().padEnd(5)} ${c.name.split(": ")[1]} - ${c.detail}`)
    if (c.status === "fail") failed++
  }
  await b.close()
}
await browser.close()
server.close()
console.log(failed ? `\n${failed} check(s) failed` : "\nevery profile took")
process.exit(failed ? 1 : 0)
