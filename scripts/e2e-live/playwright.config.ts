// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The live journey (scripts/e2e-live/journey.pw.ts) against the hosted
// players (one on a CI runner, E2E_SLOT) that scripts/e2e-live/boot.mts has already booted: no webServer
// here, the slots are in E2E_SLOTS. Run it through boot.mts
// (`npm run e2e:live`), never on its own.
//
// It lives under scripts/ and matches *.pw.ts on purpose: the root tsconfig
// (and so `next build`) excludes scripts/, and vitest's default glob does not
// match .pw.ts, so neither picks up a file that imports @playwright/test,
// which main does not install yet (it lands with #203).
import { defineConfig, devices } from "@playwright/test"
import { botProfile, chromiumArgsFor } from "./browser-profile"

const OUT = process.env.E2E_OUT ?? "scripts/out/e2e-live"
// the bot's behaviour (boot.mts hands E2E_PROFILE down); "baseline" is null and
// leaves the launch exactly as it was. The device itself is applied per
// context in journey.pw.ts, the launch flags (fake camera, its clip) here.
const PROFILE = botProfile(process.env.E2E_PROFILE)

export default defineConfig({
  testDir: ".",
  testMatch: process.env.E2E_NARRATION_PROOF === "1" ? "narration.pw.ts" : "journey.pw.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // a game is ~2.5 min plus registration (180 s), shuffle and reporting;
  // each stage sets its own bound, this is the outer one
  timeout: 20 * 60_000,
  reporter: [["list"]],
  outputDir: `${OUT}/test-results`,
  use: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    trace: "off",
    // Playwright's default is NO limit on a locator action. The play loop
    // polls `confirm.count()` and then reads `innerText()`; when the app
    // navigated to /prize-draw between the two, `innerText()` waited for a
    // button that no longer existed until the 20-min test timeout (CI run
    // 37141325278, game 172: the game was played and settled, the test
    // failed). A bounded action turns that into a caught error and the next
    // tick of the loop sees the new URL.
    // 30 s, not 10: a full-page screenshot on a 2-vCPU runner running three
    // webpack dev servers and software GL took over 10 s and failed stage (a)
    // (PR #299 boot a live run). Still bounded, which is what #292 needs.
    actionTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        permissions: ["camera"],
        launchOptions: {
          args: [
            // a synthetic camera: the waiting-room door opens only on a live one
            // (and the profile's clip, when the runner generated one)
            ...chromiumArgsFor(PROFILE),
            // software GL for the chest and the prize draw
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
          ],
        },
      },
    },
  ],
})
