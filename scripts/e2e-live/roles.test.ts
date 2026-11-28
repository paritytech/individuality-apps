// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { isCheckProfile, loadProfiles, profileFor, profileByName } from "./profile"
import { FREEZE_RESUME_TURNS, HIDDEN_STEP_IDLE, SHOW_GRACE_MS, STEP_AFTER_HIDE_MS, dueAtTurn, freezeLanded, freezeRecovery, hiddenShowDueMs, hiddenStepStep, replayedTurns, savedFloorSurvived, turnStartS } from "./roles"
import { STUCK_CARD_TEXT, stuckCardAtKillNote, BACKGROUND_IDLE, backgroundAt, backgroundPending, backgroundStep, gameEndAt, lateJoinAt, roleName, rolePlan, roundOf, shouldKill, stormGapMs, CONFIRM_COUNTDOWN_GRACE_MS, confirmTapStep, stormTarget } from "./roles"

describe("rolePlan", () => {
  it("baseline (no profile) plays plainly", () => expect(rolePlan(null)).toEqual({ kind: "baseline", changeVerdictThenConfirm: false }))
  it("reads each role's params from profiles.json", () => {
    expect(rolePlan(profileFor(1), true)).toEqual({ kind: "baseline", changeVerdictThenConfirm: true })
    expect(rolePlan(profileFor(2), true)).toEqual({ kind: "baseline", changeVerdictThenConfirm: false })
    expect(rolePlan(profileFor(5), true)).toEqual({ kind: "kill-relaunch", killInRound: 2, background: { fromS: 3, untilS: 12 } })
    expect(rolePlan(profileFor(6), true)).toEqual({ kind: "late-join", joinAfterTurn: 1 })
    expect(rolePlan(profileByName("check-stale-build"), true)).toEqual({ kind: "baseline", label: "stale-build", changeVerdictThenConfirm: false })
  })
  it("every profile has a plan, and only the two checks are check roles", () => {
    for (const p of loadProfiles()) expect(() => rolePlan(p, true)).not.toThrow()
    expect(loadProfiles().filter(isCheckProfile).map((p) => p.name).sort()).toEqual(["check-seat-preparing", "check-stale-build"])
  })
  it("keeps every current profile's role plan and evidence label", () => {
    const special = new Map<string, unknown>([
      ["baseline-iphone14-wifi", { kind: "baseline", changeVerdictThenConfirm: true }],
      ["kill-background-iphone13", { kind: "kill-relaunch", killInRound: 2, background: { fromS: 3, untilS: 12 } }],
      ["late-join-galaxya55-lte-good", { kind: "late-join", joinAfterTurn: 1 }],
      ["late-join-turn-5", { kind: "late-join", joinAfterTurn: 5 }],
      ["issue874-fast-late-join", { kind: "late-join", joinAfterTurn: 6 }],
      ["check-seat-preparing", { kind: "seat-preparing" }],
      ["check-stale-build", { kind: "baseline", label: "stale-build", changeVerdictThenConfirm: false }],
      ["tap-storm-pixel7", { kind: "tap-storm", flips: 3 }],
      ["host-crash", { kind: "host-crash", crashInRound: 2, downS: 1 }],
      ["host-crash-long", { kind: "host-crash", crashInRound: 2, downS: 8 }],
      ["clock-step-while-hidden", { kind: "hidden-step", hideAtTurn: 5, showAtTurn: 7, stepS: -60 }],
      ["reload-mid-game", { kind: "reload", reloadAtTurn: 11 }],
      ["visible-freeze", { kind: "freeze", freezeAtTurn: 9, freezeS: 20, holdMonotonic: true }],
      ["video-role-late-flip", { kind: "video-return", joinAfterTurn: 1, enableAtTurn: 4, disableAtTurn: 10 }],
      ["video-role-late-never", { kind: "video-return", joinAfterTurn: 1, enableAtTurn: null, disableAtTurn: null }],
      ["telemetry-t4-kill-while-stuck", { kind: "kill-relaunch", killInRound: 1, background: null }],
      ["telemetry-t5-stuck-first-reopen", { kind: "kill-relaunch", killInRound: 1, background: null }],
      ["telemetry-t10-big-log", { kind: "tap-storm", flips: 20 }],
      ["telemetry-t12-reload-dedupe", { kind: "reload", reloadAtTurn: 2 }],
      ["reload-clean-close", { kind: "reload", reloadAtTurn: 2 }],
      ["reload-video-back", { kind: "reload", reloadAtTurn: 2 }],
      ["turn-cache-relaunch", { kind: "kill-relaunch", killInRound: 1, background: null }],
      ["host-restart-classified", { kind: "host-crash", crashInRound: 1, downS: 1 }],
    ])
    for (const p of loadProfiles()) {
      const plan = rolePlan(p, true)
      expect(plan, p.name).toEqual(special.get(p.name) ?? { kind: "baseline", changeVerdictThenConfirm: false })
      expect(roleName(plan), p.name).toBe(p.name === "check-stale-build" ? "stale-build" : plan.kind)
    }
  })
})

describe("tap-storm", () => {
  it("reads flips and plays plain with roles off", () => {
    const p = profileByName("tap-storm-pixel7")
    expect(rolePlan(p, true)).toEqual({ kind: "tap-storm", flips: 3 })
    expect(rolePlan(p, false).kind).toBe("baseline")
  })
})

describe("video-return", () => {
  it("reads the bounded flip and never-video profiles", () => {
    expect(rolePlan(profileByName("video-role-late-flip"), true)).toEqual({ kind: "video-return", joinAfterTurn: 1, enableAtTurn: 4, disableAtTurn: 10 })
    expect(rolePlan(profileByName("video-role-late-never"), true)).toEqual({ kind: "video-return", joinAfterTurn: 1, enableAtTurn: null, disableAtTurn: null })
  })
})

describe("roles are opt-in", () => {
  it("disabled: every game role plays plain baseline, the checks stay", () => {
    expect(rolePlan(profileFor(5), false)).toEqual({ kind: "baseline", changeVerdictThenConfirm: false })
    expect(rolePlan(profileFor(1), false)).toEqual({ kind: "baseline", changeVerdictThenConfirm: false })
    expect(rolePlan(profileByName("check-stale-build"), false)).toEqual({ kind: "baseline", label: "stale-build", changeVerdictThenConfirm: false })
  })
})

describe("times", () => {
  it("a late joiner returns joinAfterTurn turns in", () => expect(lateJoinAt(1000, 2)).toBe(1024))
  it("the background window is seconds after the last turn ends", () => {
    expect(backgroundAt(1000, { fromS: 3, untilS: 12 })).toEqual({ from: 1003, until: 1012 })
    // two rounds of six 12 s turns, and the 7 s gap between them (ROUND_GAP)
    expect(gameEndAt({ gameAt: 1000, rounds: 2, maxGroupSize: 6 })).toBe(1151)
  })
  it("the background act waits for the page's confirm stage, then hides fromS later and shows untilS - fromS after that", () => {
    const w = { fromS: 10, untilS: 20 }
    expect(backgroundStep(w, BACKGROUND_IDLE, 1e12)).toBeNull()
    expect(backgroundStep(w, { ...BACKGROUND_IDLE, confirmAtMs: 100_000 }, 105_000)).toBeNull()
    expect(backgroundStep(w, { ...BACKGROUND_IDLE, confirmAtMs: 100_000 }, 110_000)).toBe("hide")
    expect(backgroundStep(w, { confirmAtMs: 100_000, hiddenAtMs: 111_000, shown: false }, 120_000)).toBeNull()
    expect(backgroundStep(w, { confirmAtMs: 100_000, hiddenAtMs: 111_000, shown: false }, 121_000)).toBe("show")
    expect(backgroundStep(w, { confirmAtMs: 100_000, hiddenAtMs: 111_000, shown: true }, 500_000)).toBeNull()
    expect(backgroundStep(null, { ...BACKGROUND_IDLE, confirmAtMs: 100_000 }, 500_000)).toBeNull()
  })
  it("game 190's timeline: killed at turn 8, back 46 s later, the confirm stage seen; both acts land and the bot holds its own Confirm tap", () => {
    // bot 5: kill-background-iphone13 (backgroundFromGameEndS 3, backgroundUntilGameEndS 12). Wall ms of 2026-10-04 16:0x UTC.
    const w = rolePlan(profileFor(5), true)
    if (w.kind !== "kill-relaunch" || !w.background) throw new Error("bot 5 is kill-relaunch with a background window")
    const t = (hms: string) => Date.parse(`2026-10-04T${hms}Z`)
    // the old trigger: the window on a chain clock that lagged the wall; it opened after the bot had left the loop (16:01:45)
    // the new one: the page shows the confirm stage at 16:01:35, whatever any clock says
    let s = { ...BACKGROUND_IDLE }
    expect(backgroundPending(w.background, s)).toBe(false) // before the confirm stage: the bot taps tiles normally
    s = { ...s, confirmAtMs: t("16:01:35") }
    expect(backgroundPending(w.background, s)).toBe(true) // no Confirm tap and no exit on /prize-draw from here
    expect(backgroundStep(w.background, s, t("16:01:37"))).toBeNull()
    expect(backgroundStep(w.background, s, t("16:01:38"))).toBe("hide")
    s = { ...s, hiddenAtMs: t("16:01:38") }
    expect(backgroundStep(w.background, s, t("16:01:46"))).toBeNull()
    expect(backgroundStep(w.background, s, t("16:01:47"))).toBe("show")
    s = { ...s, shown: true }
    expect(backgroundPending(w.background, s)).toBe(false)
  })
})

describe("shouldKill", () => {
  const role = rolePlan(profileFor(5), true)
  const at = (turn: number, stage = "play") => ({ turn, turnsInGame: 12, rounds: 2, stage })
  it("the pill counts the whole game: round 2 is turns 7-12, the kill waits for turn 2 of it (game 186: round index stayed 0)", () => {
    expect(roundOf(1, 12, 2)).toEqual({ round: 0, turnInRound: 1 })
    expect(roundOf(7, 12, 2)).toEqual({ round: 1, turnInRound: 1 })
    expect(roundOf(12, 12, 2)).toEqual({ round: 1, turnInRound: 6 })
    expect(shouldKill(role, at(8), false)).toBe(true)
    expect(shouldKill(role, at(7), false)).toBe(false)
    expect(shouldKill(role, at(3), false)).toBe(false)
  })
  it("never in confirm, twice, without a pill, or for another role", () => {
    expect(shouldKill(role, at(9, "confirm"), false)).toBe(false)
    expect(shouldKill(role, at(9), true)).toBe(false)
    expect(shouldKill(role, { turn: null, turnsInGame: null, rounds: 2, stage: "play" }, false)).toBe(false)
    expect(shouldKill(rolePlan(null), at(9), false)).toBe(false)
  })
})

describe("the storm keeps clear of the debug gesture (5 taps in the top third within 1.5 s)", () => {
  it("paces top-third taps so no 1.5 s window holds five, and runs fast elsewhere", () => {
    expect(stormGapMs(100, 915)).toBe(400)
    expect(stormGapMs(600, 915)).toBe(40)
    // taps 400 ms apart: the fifth lands 1600 ms after the first, outside the 1500 ms window
    expect(4 * stormGapMs(100, 915)).toBeGreaterThan(1500)
  })
})

describe("host-crash", () => {
  const p = profileByName("host-crash")
  it("is a role with a round and a downtime", () => expect(rolePlan(p, true)).toEqual({ kind: "host-crash", crashInRound: 2, downS: 1 }))
  it("is due in the same turn window as a kill: round 2, past its first turn, grid live, once", () => {
    const role = rolePlan(p, true)
    const at = (turn: number) => ({ turn, turnsInGame: 12, rounds: 2, stage: "play" })
    expect(shouldKill(role, at(7), false)).toBe(false) // turn 1 of round 2
    expect(shouldKill(role, at(8), false)).toBe(true)
    expect(shouldKill(role, at(8), true)).toBe(false)
    expect(shouldKill(role, at(3), false)).toBe(false) // round 1
  })
})

describe("confirmTapStep: the confirm-tap role keys on the countdown the page shows (game 192, bot 1)", () => {
  const role = true
  it("taps on the countdown label", () => {
    expect(confirmTapStep(role, "Confirming in 7", 0, 100)).toBe("tap")
    expect(confirmTapStep(role, "Confirming in 1", 0, 100)).toBe("tap")
  })
  it("does NOT tap a bare 'Confirm votes' while the countdown may still arm (it was tapped 1.3 s in, so the act never recorded)", () => {
    expect(confirmTapStep(role, "Confirm votes", 0, 1300)).toBe("wait")
  })
  it("falls back to the bare CTA once the countdown has not shown for the grace, so the report is still filed", () => {
    expect(confirmTapStep(role, "Confirm votes", 0, CONFIRM_COUNTDOWN_GRACE_MS)).toBe("tap")
  })
  it("a retry CTA is tapped at once, and a role that is off taps the bare CTA at once", () => {
    expect(confirmTapStep(role, "Vote didn't send \u2014 tap to retry", 0, 10)).toBe("tap")
    expect(confirmTapStep(false, "Confirm votes", 0, 10)).toBe("tap")
  })
  it("'Confirming...' (count at 0) and 'Submitting...' are left alone", () => {
    expect(confirmTapStep(role, "Confirming...", 0, 10_000)).toBe("wait")
    expect(confirmTapStep(role, "Submitting...", 0, 10_000)).toBe("wait")
    expect(confirmTapStep(false, "Confirming in 5", 0, 10_000)).toBe("wait")
  })
})

describe("stormTarget: ONE storm per turn, on the last tile, so a swallowed tap cannot cost a turn (game 192, bot 8)", () => {
  it("picks the last tile to tap, once per turn", () => {
    const done = new Set<number>()
    expect(stormTarget(["a", "b", "c"], 3, 4, done)).toBe("c")
    expect(stormTarget(["a", "b", "c"], 3, 4, done)).toBeNull() // the turn already had its storm
    expect(stormTarget(["a"], 4, 4, done)).toBe("a")
  })
  it("no flips, no tiles or no turn: no storm", () => {
    expect(stormTarget(["a"], 1, 0, new Set())).toBeNull()
    expect(stormTarget([], 1, 4, new Set())).toBeNull()
    expect(stormTarget(["a"], null, 4, new Set())).toBeNull()
  })
})

describe("the reload, hidden-step and freeze plans", () => {
  it("read their params, and play plain with roles off", () => {
    expect(rolePlan(profileByName("reload-mid-game"), true)).toEqual({ kind: "reload", reloadAtTurn: 11 })
    expect(rolePlan(profileByName("clock-step-while-hidden"), true)).toEqual({ kind: "hidden-step", hideAtTurn: 5, showAtTurn: 7, stepS: -60 })
    expect(rolePlan(profileByName("visible-freeze"), true)).toEqual({ kind: "freeze", freezeAtTurn: 9, freezeS: 20, holdMonotonic: true })
    expect(rolePlan(profileByName("visible-freeze"), false).kind).toBe("baseline")
  })
  it("an act waits for its turn in a live stage, once", () => {
    expect(dueAtTurn({ turn: 5, stage: "play" }, 6, false)).toBe(false)
    expect(dueAtTurn({ turn: 6, stage: "intro" }, 6, false)).toBe(true)
    expect(dueAtTurn({ turn: 7, stage: "play" }, 6, false)).toBe(true)
    expect(dueAtTurn({ turn: 6, stage: "play" }, 6, true)).toBe(false)
    expect(dueAtTurn({ turn: null, stage: "confirm" }, 6, false)).toBe(false)
    expect(dueAtTurn({ turn: 9, stage: "intro" }, 9, false, ["play"])).toBe(false)
  })
})

describe("hiddenStepStep: hide at the turn, step while hidden, show at the later turn", () => {
  const r = { hideAtTurn: 5, showAtTurn: 7 }
  it("hides at hideAtTurn", () => {
    expect(hiddenStepStep(r, HIDDEN_STEP_IDLE, { turn: 4, stage: "play" }, 0)).toBeNull()
    expect(hiddenStepStep(r, HIDDEN_STEP_IDLE, { turn: 5, stage: "intro" }, 0)).toBe("hide")
  })
  it("steps the clock a beat after the hide, so the app read its clocks hidden first", () => {
    const hidden = { ...HIDDEN_STEP_IDLE, hiddenAtMs: 1000 }
    expect(hiddenStepStep(r, hidden, { turn: 5, stage: "play" }, 1000 + STEP_AFTER_HIDE_MS - 1)).toBeNull()
    expect(hiddenStepStep(r, hidden, { turn: 5, stage: "play" }, 1000 + STEP_AFTER_HIDE_MS)).toBe("step")
  })
  it("shows when the page shows showAtTurn, or by the turns' own length when it never does", () => {
    const stepped = { ...HIDDEN_STEP_IDLE, hiddenAtMs: 1000, stepped: true }
    expect(hiddenStepStep(r, stepped, { turn: 6, stage: "play" }, 5000)).toBeNull()
    expect(hiddenStepStep(r, stepped, { turn: 7, stage: "intro" }, 5000)).toBe("show")
    // the fallback is said apart: a live game must show on the page's own turn
    expect(hiddenStepStep(r, stepped, { turn: 5, stage: "play" }, 1000 + 2 * 12_000 + SHOW_GRACE_MS)).toBe("show-late")
    expect(hiddenStepStep(r, { ...stepped, shown: true }, { turn: 8, stage: "play" }, 99_999)).toBeNull()
  })
})

describe("turnStartS: the chain schedule of a game turn", () => {
  const g = { rounds: 2, maxGroupSize: 6 }
  it("12 s per seat inside a round, and the 7 s round gap before the next round's first turn", () => {
    expect(turnStartS(g, 1)).toBe(0)
    expect(turnStartS(g, 6)).toBe(60)
    expect(turnStartS(g, 7)).toBe(79) // not 72: the gap between rounds
    expect(turnStartS(g, 12)).toBe(139)
  })
})

describe("hidden-step's show deadline comes from the chain schedule (game 199, bot 15)", () => {
  // Game 199 (a live run): game_date 20:25:00 UTC. The page showed turn 1 at 20:25:07.4 (chain time runs ~7 s
  // behind the runner's wall on paseo, the runner's mapping the same); bot 15 hid at turn 5's intro, 20:25:55.185, and
  // the fallback fired at 20:26:25.428 (hide + 2 x 12 s + 6 s) while the page read turn 6. Turns 6 -> 7 cross the
  // round gap, so turn 7 began only at ~20:26:26.4: the page was right, and showed turn 7 at 20:26:26.793.
  const r = { hideAtTurn: 5, showAtTurn: 7 }
  const g = { gameAt: 1791145500, rounds: 2, maxGroupSize: 6 }
  const wall = (iso: string) => Date.parse(iso)
  const clock = { chainNowS: g.gameAt, wallNowMs: wall("2026-10-04T20:25:07.400Z") } // the chain's game_date, as the runner read it
  const hiddenAtMs = wall("2026-10-04T20:25:55.185Z")
  it("is the chain start of showAtTurn, on the runner's chain clock, plus the grace", () => {
    expect(hiddenShowDueMs(r, g, hiddenAtMs, clock)).toBe(wall("2026-10-04T20:26:26.400Z") + SHOW_GRACE_MS)
  })
  it("the moment game 199 fell back, turn 6 is not late: the page waits for its own turn 7", () => {
    const stepped = { ...HIDDEN_STEP_IDLE, hiddenAtMs, stepped: true, showDueMs: hiddenShowDueMs(r, g, hiddenAtMs, clock) }
    expect(hiddenStepStep(r, stepped, { turn: 6, stage: "play" }, wall("2026-10-04T20:26:25.428Z"))).toBeNull()
    expect(hiddenStepStep(r, stepped, { turn: 7, stage: "play" }, wall("2026-10-04T20:26:26.793Z"))).toBe("show")
  })
  it("still falls back, as a failure, when the page never shows turn 7", () => {
    const stepped = { ...HIDDEN_STEP_IDLE, hiddenAtMs, stepped: true, showDueMs: hiddenShowDueMs(r, g, hiddenAtMs, clock) }
    expect(hiddenStepStep(r, stepped, { turn: 6, stage: "play" }, wall("2026-10-04T20:26:38.399Z"))).toBeNull()
    expect(hiddenStepStep(r, stepped, { turn: 6, stage: "play" }, wall("2026-10-04T20:26:38.400Z"))).toBe("show-late")
  })
  it("a runner whose chain mapping lags only 2 s (the page's lags 7.4 s) still waits past the page's own turn 7", () => {
    const fresh = { chainNowS: g.gameAt, wallNowMs: wall("2026-10-04T20:25:02.000Z") }
    expect(hiddenShowDueMs(r, g, hiddenAtMs, fresh)).toBeGreaterThan(wall("2026-10-04T20:26:26.793Z") + 5_000)
  })
  it("on the demo (no chain game) it counts the schedule from the hide, round gap included", () => {
    const demo = { gameAt: 0, rounds: 2, maxGroupSize: 6 }
    expect(hiddenShowDueMs(r, demo, 1000, null)).toBe(1000 + (79 - 48) * 1000 + SHOW_GRACE_MS)
  })
})

describe("the freeze's proof and its bound", () => {
  it("a timer that never ticked for the freeze, and a held monotonic clock", () => {
    expect(freezeLanded(20, 20_150, 20_004, true)).toBeNull()
    expect(freezeLanded(20, 400, 20_004, true)).toMatch(/did not stop/)
    expect(freezeLanded(20, 20_150, 0, true)).toMatch(/held back 0 ms/)
    expect(freezeLanded(20, 20_150, 0, false)).toBeNull()
  })
  it("the resume bound can fail: it is below the turns left after the freeze (turn 9 of 12 leaves 4)", () => {
    const p = rolePlan(profileByName("visible-freeze"), true)
    if (p.kind !== "freeze") throw new Error("visible-freeze is not a freeze role")
    expect(FREEZE_RESUME_TURNS).toBe(3)
    expect(FREEZE_RESUME_TURNS).toBeLessThan(12 - p.freezeAtTurn + 1)
  })
})

describe("replayedTurns", () => {
  it("is a turn shown again after a later one, read off the live frames only", () => {
    const rows = [
      { t: "a", turn: 4, stage: "play" },
      { t: "b", turn: 5, stage: "intro" },
      { t: "c", turn: null, stage: "waiting" },
      { t: "d", turn: 5, stage: "play" },
      { t: "e", turn: 1, stage: "confirm" },
      { t: "f", turn: 6, stage: "play" },
    ]
    expect(replayedTurns(rows)).toEqual([])
    expect(replayedTurns([...rows, { t: "g", turn: 4, stage: "play" }])).toEqual([{ from: 6, to: 4, at: "g" }])
  })
})

describe("savedFloorSurvived", () => {
  const saved = (floor: string) => JSON.stringify({ floor, margins: {} })
  it("needs the saved floor before, and the same or higher after", () => {
    expect(savedFloorSurvived(saved("100"), saved("100"))).toBeNull()
    expect(savedFloorSurvived(saved("100"), saved("140"))).toBeNull()
    expect(savedFloorSurvived(null, saved("100"))).toMatch(/no saved store clock before/)
    expect(savedFloorSurvived(saved("100"), null)).toMatch(/gone after the reload/)
    expect(savedFloorSurvived(saved("100"), saved("90"))).toMatch(/went down/)
    expect(savedFloorSurvived("not json", saved("90"))).toMatch(/no saved store clock before/)
  })
})

describe("freezeRecovery: the bot plays again soon after the thaw, and plays the last turn", () => {
  const T = (s: number) => new Date(Date.UTC(2026, 9, 4, 17, 0, s)).toISOString()
  const play = (s: number, turn: number) => ({ t: T(s), stage: "play" as const, turn })
  const win = { from: T(100), to: T(121) }
  it("passes when play resumes within 3 turns of the freeze turn and turn 12 is played", () => {
    const rows = [play(98, 9), play(125, 9), play(140, 11), play(150, 12)]
    expect(freezeRecovery(rows, win, 9, 12)).toEqual({ ok: true, detail: "played turn 9 again 4 s after the thaw (within 3 of the freeze's turn 9), and the last turn 12" })
  })
  it("fails when play resumes later than freeze turn + 3", () => {
    expect(freezeRecovery([play(98, 9), play(170, 13)], win, 9, 13).ok).toBe(false)
  })
  it("fails when the last turn is never played", () => {
    const r = freezeRecovery([play(125, 10), play(140, 11)], win, 9, 12)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/never played the last turn 12/)
  })
  it("fails when nothing is played after the thaw; a frame stamped inside the freeze does not count", () => {
    expect(freezeRecovery([play(110, 9)], win, 9, 12).detail).toMatch(/never played after the thaw/)
  })
})

describe("the bot always confirms when the page asks (games 196, 197: a tap on the bare CTA filed the report)", () => {
  it("an enabled, tappable CTA is tapped once the grace has passed, for the countdown role and for every other, at any later time", () => {
    for (const role of [true, false]) {
      for (const label of ["Confirm votes", "Vote didn't send \u2014 tap to retry"]) {
        for (const later of [0, 1, 4_999, 5_000, 20_000, 120_000]) {
          const step = confirmTapStep(role, label, 0, CONFIRM_COUNTDOWN_GRACE_MS + later)
          expect(step, `${role} ${label} +${later}`).toBe("tap")
        }
      }
    }
  })
  it("the countdown role's wait is bounded by the grace: it never waits past it", () => {
    expect(confirmTapStep(true, "Confirm votes", 0, CONFIRM_COUNTDOWN_GRACE_MS - 1)).toBe("wait")
    expect(confirmTapStep(true, "Confirm votes", 0, CONFIRM_COUNTDOWN_GRACE_MS)).toBe("tap")
  })
})

describe("stuckCardAtKillNote: the fact that decides app-vs-harness for host-stuck-waiting", () => {
  it("says the card was there, and that the evidence was what got lost", () => {
    const note = stuckCardAtKillNote(true, 82)
    expect(note).toContain("WAS on the page at the kill")
    expect(note).toContain("82 s into the hang")
    expect(note).toContain("the evidence was lost, not the app failing to show it")
  })

  it("says the app never raised it, when the page was readable and clean", () => {
    const note = stuckCardAtKillNote(false, 82)
    expect(note).toContain("was NOT on the page at the kill")
    expect(note).toContain("the app never raised it during the hang")
  })

  it("does not turn an unreadable page into a clean one", () => {
    // A page that is gone is not a page that showed nothing: the two must not collapse.
    const note = stuckCardAtKillNote(null, 82)
    expect(note).toContain("could not be read")
    expect(note).toContain("unknown")
    expect(note).not.toContain("WAS on the page")
    expect(note).not.toContain("was NOT on the page")
  })

  it("quotes the profile's own card text", () => {
    expect(STUCK_CARD_TEXT).toBe("Restart the Polkadot app")
    expect(stuckCardAtKillNote(false, 1)).toContain(STUCK_CARD_TEXT)
  })
})

describe("stuckCardAtKillNote's seconds", () => {
  // The first version passed killAtMs - Date.now() — milliseconds REMAINING — and would
  // have printed "82000 s into the hang". The note is fed hangS minus what is left, so
  // for a 90 s hang killed 8 s before the end it must say 82, never 82000.
  it("reads a 90 s hang killed 8 s from the end as 82 s in", () => {
    expect(stuckCardAtKillNote(true, 90 - 8)).toContain("82 s into the hang")
  })

  it("never renders a millisecond value as seconds", () => {
    const note = stuckCardAtKillNote(true, 90 - 8)
    expect(note).not.toContain("82000")
    expect(note).not.toMatch(/\d{4,} s into the hang/)
  })
})

describe("sampling the card at the kill, not at the hang's start", () => {
  // The first version sampled right after the hang came into force - ~80 s before the
  // kill - so a card the app raises later in the hang was reported as "the app never
  // raised it": a false APP finding, the one thing this persona's evidence must not
  // produce. The sample now runs inside crashHost's pre-kill hook, after its wait.
  //
  // This models that: the card is absent at 8 s into a 90 s hang and present from 60 s.
  const cardShownAt = (secondsIntoHang: number): boolean => secondsIntoHang >= 60

  it("reports the late card as present when sampled at the kill", () => {
    const atKill = 90 - 8 // the kill happens 8 s before the hang ends
    expect(stuckCardAtKillNote(cardShownAt(atKill), atKill)).toContain("WAS on the page at the kill")
    expect(stuckCardAtKillNote(cardShownAt(atKill), atKill)).toContain("82 s into the hang")
  })

  it("would have reported the same card as absent at the hang's start", () => {
    // what the old sampling point produced, kept here so the defect cannot come back
    const atHangStart = 8
    expect(stuckCardAtKillNote(cardShownAt(atHangStart), atHangStart)).toContain("was NOT on the page")
  })
})
