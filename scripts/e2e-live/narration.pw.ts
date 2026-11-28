// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, renameSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, test, type Browser } from "@playwright/test"
import sharp from "sharp"
import { scenarioPresentation } from "./crew/catalogue"
import { NARRATION_HOST_ID, ScenarioNarrator, scenarioNarration } from "./narration"

const proofDir = resolve(process.env.E2E_OUT ?? "scripts/out/e2e-live", "narration-proof")
const videoDir = join(proofDir, "videos")
const screenshotDir = join(proofDir, "screenshots")

const intersects = (
  one: { x: number; y: number; width: number; height: number },
  two: { x: number; y: number; width: number; height: number },
): boolean => one.x < two.x + two.width
  && one.x + one.width > two.x
  && one.y < two.y + two.height
  && one.y + one.height > two.y

async function recordProof(
  browser: Browser,
  options: {
    slug: string
    profile: string
    attribution: string
    viewport: { width: number; height: number }
    action: string
  },
): Promise<void> {
  const context = await browser.newContext({
    viewport: options.viewport,
    recordVideo: { dir: videoDir, size: options.viewport },
  })
  const page = await context.newPage()
  const video = page.video()
  try {
    await page.setContent(`
      <!doctype html>
      <style>
        html, body { width: 100%; height: 100%; margin: 0; background: linear-gradient(160deg, #14233b, #30194b); font-family: system-ui; }
        #underlay { position: fixed; inset: 18px auto auto 18px; width: 280px; height: 100px; }
        #primary { position: fixed; inset: auto 18px 18px; height: 52px; border: 0; border-radius: 26px; padding: 0 28px; }
        #clicks { position: fixed; right: 18px; top: 18px; color: white; }
      </style>
      <button id="underlay" type="button">Button behind the overlay</button>
      <button id="primary" type="button">Continue</button>
      <output id="clicks">0</output>
      <script>
        let clicks = 0
        document.querySelector('#underlay').addEventListener('click', () => { document.querySelector('#clicks').textContent = String(++clicks) })
        document.querySelector('#primary').addEventListener('click', () => { document.querySelector('#primary').textContent = 'Continued' })
      </script>
    `)

    const scenario = scenarioPresentation(options.profile)
    const narrator = new ScenarioNarrator(options.attribution)
    await narrator.attach(page)
    await narrator.transition(scenarioNarration(scenario, "preparing", "journey"))
    await page.waitForTimeout(450)
    await narrator.transition(scenarioNarration(scenario, "active", options.action.startsWith("network.") ? "network" : "role", options.action))
    await page.waitForTimeout(450)
    await narrator.transition(scenarioNarration(scenario, "recovered", options.action.startsWith("network.") ? "network" : "role", options.action))
    await page.waitForTimeout(450)
    await narrator.transition(scenarioNarration(scenario, "verifying", "outcome"))
    await page.waitForTimeout(450)
    await narrator.transition(scenarioNarration(scenario, "passed", "outcome"))
    await page.waitForTimeout(450)

    const host = page.locator(`#${NARRATION_HOST_ID}`)
    await expect(host).toHaveCount(1)
    const hostBox = await host.boundingBox()
    const primaryBox = await page.locator("#primary").boundingBox()
    expect(hostBox).not.toBeNull()
    expect(primaryBox).not.toBeNull()
    expect(hostBox!.x).toBeGreaterThanOrEqual(0)
    expect(hostBox!.y).toBeGreaterThanOrEqual(0)
    expect(hostBox!.x + hostBox!.width).toBeLessThanOrEqual(options.viewport.width)
    expect(hostBox!.y + hostBox!.height).toBeLessThanOrEqual(options.viewport.height)
    expect(intersects(hostBox!, primaryBox!)).toBe(false)

    await page.locator("#underlay").click()
    await expect(page.locator("#clicks")).toHaveText("1")
    await page.locator("#primary").click()
    await expect(page.locator("#primary")).toHaveText("Continued")

    const screenshot = join(screenshotDir, `${options.slug}.png`)
    await page.screenshot({ path: screenshot })
    await sharp(screenshot).resize({ height: 360, withoutEnlargement: true }).png().toFile(join(screenshotDir, `${options.slug}-360h.png`))
  } finally {
    await context.close()
  }
  if (!video) throw new Error(`Playwright did not create ${options.slug} video`)
  renameSync(await video.path(), join(videoDir, `${options.slug}.webm`))
}

test("records representative crew narration without blocking the app", async ({ browser }) => {
  mkdirSync(videoDir, { recursive: true })
  mkdirSync(screenshotDir, { recursive: true })
  await recordProof(browser, {
    slug: "captain-baseline-iphone14",
    profile: "baseline-iphone14-wifi",
    attribution: "Captain Baseline",
    viewport: { width: 390, height: 844 },
    action: "role.confirm-tap",
  })
  await recordProof(browser, {
    slug: "packet-jack-pixel6a",
    profile: "storm-pixel6a-timeline",
    attribution: "Packet Jack",
    viewport: { width: 412, height: 915 },
    action: "network.1",
  })
})
