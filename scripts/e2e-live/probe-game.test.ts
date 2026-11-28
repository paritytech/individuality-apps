// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { awaitProbedGame, matchProbedGame, parseProbedGame, probedGameDecision } from "./probe-game"

describe("parseProbedGame", () => {
  it("reads the exact game identity handed over by the probe", () => {
    expect(parseProbedGame({ GITHUB_ACTIONS: "true", E2E_PROBED_GAME: "57", E2E_PROBED_GAME_AT: "1791273900", REGISTRATION_ENDS: "1791273600" })).toEqual({ index: 57, gameAt: 1791273900, registrationEnds: 1791273600 })
  })

  it("keeps an exact future kickoff pending when the probe has no concrete index yet", () => {
    expect(parseProbedGame({ GITHUB_ACTIONS: "true", E2E_PROBED_GAME: "", E2E_PROBED_GAME_AT: "1791273900", REGISTRATION_ENDS: "1791273600" })).toEqual({
      index: null,
      gameAt: 1791273900,
      registrationEnds: 1791273600,
    })
  })

  it("keeps a desk run on the current Registration game when no probe exists", () => {
    expect(parseProbedGame({})).toBeNull()
    expect(parseProbedGame({ REGISTRATION_ENDS: "1791273600" })).toBeNull()
  })

  it.each([
    [{ GITHUB_ACTIONS: "true", REGISTRATION_ENDS: "1791273600" }, "E2E_PROBED_GAME_AT"],
    [{ GITHUB_ACTIONS: "true", E2E_PROBED_GAME: "57", REGISTRATION_ENDS: "1791273600" }, "E2E_PROBED_GAME_AT"],
    [{ GITHUB_ACTIONS: "true", E2E_PROBED_GAME: "57", E2E_PROBED_GAME_AT: "1791273900" }, "REGISTRATION_ENDS"],
    [{ GITHUB_ACTIONS: "true", E2E_PROBED_GAME: "game-57", E2E_PROBED_GAME_AT: "1791273900", REGISTRATION_ENDS: "1791273600" }, "E2E_PROBED_GAME"],
    [{ GITHUB_ACTIONS: "true", E2E_PROBED_GAME: "57", E2E_PROBED_GAME_AT: "later", REGISTRATION_ENDS: "1791273600" }, "E2E_PROBED_GAME_AT"],
    [{ GITHUB_ACTIONS: "true", E2E_PROBED_GAME: "57", E2E_PROBED_GAME_AT: "1791273900", REGISTRATION_ENDS: "soon" }, "REGISTRATION_ENDS"],
    [{ E2E_PROBED_GAME: "57" }, "E2E_PROBED_GAME_AT"],
  ])("fails closed for a missing or malformed live input (%s)", (env, name) => {
    expect(() => parseProbedGame(env)).toThrow(name)
  })
})

describe("matchProbedGame", () => {
  const expected = { index: 57, gameAt: 1791273900, registrationEnds: 1791273600 }

  it("accepts only the exact game selected by the probe", () => {
    expect(matchProbedGame(expected, { index: 57, gameAt: 1791273900, registrationEnds: 1791273600, state: "Registration" })).toEqual({ ok: true })
  })

  it("refuses the next game even while it is in Registration", () => {
    expect(matchProbedGame(expected, { index: 58, gameAt: 1791275700, registrationEnds: 1791275400, state: "Registration" })).toEqual({
      ok: false,
      reason: "the probe selected game 57 (registration ends 1791273600), but the chain now has game 58 in Registration (registration ends 1791275400); the probe's game is over",
    })
  })

  it("refuses a game index whose timing no longer matches the probe", () => {
    expect(matchProbedGame(expected, { index: 57, gameAt: 1791273900, registrationEnds: 1791273601, state: "Registration" })).toEqual({
      ok: false,
      reason: "the probe selected game 57 (registration ends 1791273600), but the chain now has game 57 in Registration (registration ends 1791273601); the probe's game is over",
    })
  })

  it("refuses the selected game after registration has ended", () => {
    expect(matchProbedGame(expected, { index: 57, gameAt: 1791273900, registrationEnds: 1791273600, state: "Shuffle" })).toEqual({
      ok: false,
      reason: "the probe selected game 57 (registration ends 1791273600), but the chain now has game 57 in Shuffle (registration ends 1791273600); the probe's game is over",
    })
  })

  it("refuses when the selected game is no longer current", () => {
    expect(matchProbedGame(expected, null)).toEqual({
      ok: false,
      reason: "the probe selected game 57 (registration ends 1791273600), but the chain has no current game; the probe's game is over",
    })
  })
})

describe("probedGameDecision", () => {
  const expected = { index: 57, gameAt: 1791273900, registrationEnds: 1791273600 }
  const current = { index: 58, gameAt: 1791275700, registrationEnds: 1791275400, state: "Registration" }

  it("continues only for the exact selected game in Registration", () => {
    expect(probedGameDecision(1, expected, { ...expected, state: "Registration" })).toEqual({ action: "continue" })
  })

  it("fails attempt 1 so a late or slow original runner stays visible", () => {
    expect(probedGameDecision(1, expected, current)).toEqual({
      action: "fail",
      reason: "the probe selected game 57 (registration ends 1791273600), but the chain now has game 58 in Registration (registration ends 1791275400); the probe's game is over",
    })
  })

  it("clean-skips a restarted attempt and preserves its expected/current evidence", () => {
    expect(probedGameDecision(2, expected, current)).toEqual({
      action: "skip",
      reason: "the probe selected game 57 (registration ends 1791273600), but the chain now has game 58 in Registration (registration ends 1791275400); the probe's game is over",
      skipped: {
        kind: "restarted-after-probed-game",
        expected,
        current: { index: 58, gameAt: 1791275700, registrationEnds: 1791275400 },
      },
    })
  })
})

describe("awaitProbedGame", () => {
  const pending = { index: null, gameAt: 1791275400, registrationEnds: 1791275100 }
  const old = { index: 57, gameAt: 1791273600, registrationEnds: 1791273300, state: "Reporting" }
  const target = { index: 58, gameAt: 1791275400, registrationEnds: 1791275100, state: "Registration" }

  it("rescans a future kickoff until that exact concrete game exists, then binds its index", async () => {
    const reads = [
      { chainNow: 1791274800, game: old },
      { chainNow: 1791274950, game: null },
      { chainNow: 1791274960, game: target },
    ]
    let pauses = 0
    const decision = await awaitProbedGame(1, pending, async () => reads.shift()!, async () => {
      pauses++
    })
    expect(pauses).toBe(2)
    expect(decision).toEqual({ action: "continue", game: { index: 58, gameAt: 1791275400, registrationEnds: 1791275100 } })
  })

  it("rejects a different kickoff instead of falling through to it", async () => {
    const later = { index: 59, gameAt: 1791277200, registrationEnds: 1791276900, state: "Registration" }
    const decision = await awaitProbedGame(1, pending, async () => ({ chainNow: 1791275000, game: later }), async () => {
      throw new Error("must not wait after kickoff drift")
    })
    expect(decision.action).toBe("fail")
    if (decision.action === "continue") throw new Error("different kickoff unexpectedly continued")
    expect(decision.reason).toContain("advanced to game 59 at 1791277200")
    expect(decision.reason).toContain("exact scheduled kickoff 1791275400")
  })

  it("rejects the exact kickoff when its immutable registration end differs", async () => {
    const mismatch = { ...target, registrationEnds: target.registrationEnds + 1 }
    const decision = await awaitProbedGame(1, pending, async () => ({ chainNow: 1791274960, game: mismatch }), async () => {})
    expect(decision.action).toBe("fail")
    if (decision.action === "continue") throw new Error("mismatched registration end unexpectedly continued")
    expect(decision.reason).toContain("registration ends 1791275101")
    expect(decision.reason).toContain("probe selected 1791275100")
  })

  it("keeps the restarted-run evidence contract when a pending kickoff has already passed", async () => {
    const later = { index: 59, gameAt: 1791277200, registrationEnds: 1791276900, state: "Registration" }
    const decision = await awaitProbedGame(2, pending, async () => ({ chainNow: 1791277000, game: later }), async () => {})
    expect(decision).toEqual({
      action: "skip",
      reason: "the chain advanced to game 59 at 1791277200, past the probe's exact scheduled kickoff 1791275400; refusing a different kickoff",
      skipped: {
        kind: "restarted-after-probed-game",
        expected: pending,
        current: { index: 59, gameAt: 1791277200, registrationEnds: 1791276900 },
      },
    })
  })
})

describe("probe-to-play workflow wiring", () => {
  const workflow = readFileSync(resolve(__dirname, "../../.github/workflows/e2e-live.yml"), "utf8")

  it("exports the selected game from probe and gives it to every play job", () => {
    expect(workflow).toContain("game: ${{ steps.probe.outputs.game }}")
    expect(workflow).toContain("E2E_PROBED_GAME: ${{ needs.probe.outputs.game }}")
    expect(workflow).toContain("E2E_PROBED_GAME_AT: ${{ needs.probe.outputs.game_at }}")
  })
})
