// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { BOT_TAG, botTelemetry, sentrySummaryLine } from "./telemetry-env"

const DSN = "https://key@o1.ingest.de.sentry.io/2"
const TEST_DSN = "https://test@o1.ingest.de.sentry.io/3"

describe("botTelemetry", () => {
  it("adds the DSN and the default tag when a DSN is set", () => {
    const t = botTelemetry({ NEXT_PUBLIC_SENTRY_DSN: DSN })
    expect(t.env).toEqual({ NEXT_PUBLIC_SENTRY_DSN: DSN, NEXT_PUBLIC_SENTRY_TAG: BOT_TAG })
    expect(BOT_TAG).toBe("e2e-bot")
  })
  it("adds nothing without a DSN, even with a tag", () => {
    expect(botTelemetry({}).env).toEqual({})
    expect(botTelemetry({ NEXT_PUBLIC_SENTRY_DSN: "  ", NEXT_PUBLIC_SENTRY_TAG: "x" }).env).toEqual({})
  })
  it("lets an explicit tag win", () => {
    expect(botTelemetry({ NEXT_PUBLIC_SENTRY_DSN: DSN, NEXT_PUBLIC_SENTRY_TAG: "e2e-desk" }).env.NEXT_PUBLIC_SENTRY_TAG).toBe("e2e-desk")
  })
  it("never forwards a mnemonic and never prints the DSN", () => {
    const t = botTelemetry({
      NEXT_PUBLIC_SENTRY_DSN: DSN,
      E2E_PLAYER_1_MNEMONIC: "word word",
      HOST_CLI_SIGNER_MNEMONIC: "word word",
    })
    expect(Object.keys(t.env).sort()).toEqual(["NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_TAG"])
    expect(t.describe).not.toContain(DSN)
    expect(t.describe).toContain("e2e-bot")
  })
})

describe("the test project", () => {
  it("forwards the test DSN with the production one", () => {
    const t = botTelemetry({ NEXT_PUBLIC_SENTRY_DSN: DSN, NEXT_PUBLIC_SENTRY_DSN_TEST: TEST_DSN })
    expect(t.env).toEqual({ NEXT_PUBLIC_SENTRY_DSN: DSN, NEXT_PUBLIC_SENTRY_DSN_TEST: TEST_DSN, NEXT_PUBLIC_SENTRY_TAG: BOT_TAG })
    expect(t.describe).toContain("project test")
    expect(t.describe).not.toContain(TEST_DSN)
  })
  it("switches telemetry on with the test DSN alone", () => {
    expect(botTelemetry({ NEXT_PUBLIC_SENTRY_DSN_TEST: TEST_DSN }).env).toEqual({
      NEXT_PUBLIC_SENTRY_DSN_TEST: TEST_DSN,
      NEXT_PUBLIC_SENTRY_TAG: BOT_TAG,
    })
  })
  it("says production when there is no test DSN", () => {
    expect(botTelemetry({ NEXT_PUBLIC_SENTRY_DSN: DSN }).describe).toContain("project production")
  })
  it("links the summary to the project the bots wrote to", () => {
    const line = sentrySummaryLine({ NEXT_PUBLIC_SENTRY_DSN: DSN, NEXT_PUBLIC_SENTRY_DSN_TEST: TEST_DSN, ...CONFIG }, 163)
    expect(line).toContain("?project=222&")
    expect(line).toContain("test project")
    expect(line).not.toContain(TEST_DSN)
  })
})

const CONFIG = { DIM2_SENTRY_ORG: "example-org", DIM2_SENTRY_PROJECT_IDS: '{"production": "111", "test": "222"}' }

describe("sentrySummaryLine", () => {
  it("links a search on the game and the tag", () => {
    const line = sentrySummaryLine({ NEXT_PUBLIC_SENTRY_DSN: DSN, ...CONFIG }, 163)
    expect(line).toContain("https://example-org.sentry.io/issues/?project=111&query=game.index%3A163%20test.tag%3Ae2e-bot")
    expect(line).toContain("software rendering")
    expect(line).not.toContain(DSN)
  })
  it("names the project without a link when the org and ids are not configured", () => {
    const line = sentrySummaryLine({ NEXT_PUBLIC_SENTRY_DSN: DSN, DIM2_SENTRY_PROJECT_IDS: "not json" }, 163)
    expect(line).toContain("production project")
    expect(line).not.toContain("sentry.io")
  })
  it("says so when telemetry is off", () => {
    expect(sentrySummaryLine({}, 163)).toMatch(/off/)
  })
})
