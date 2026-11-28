// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { profileByName, profileFor } from "./profile"
import { SESSION_TICK_MS } from "../../apps/jollity-app/lib/game-clock"
import { pageFreezeThresholdMs } from "../../apps/jollity-app/lib/page-lifecycle"
import { FREEZE_THRESHOLD_MS, confirmFreeze, cestTime, turnAtTime, clockHeldDue, clockJumpLanded, dueActions, roleFeasibility, verifyRoleActs, verifyVideoRoleProof, whyNotActed, type RoleAction } from "./role-proof"
import { rolePlan } from "./roles"
import { emptyResult } from "./result"

const act = (id: RoleAction["id"]): RoleAction => ({ id, at: "2026-10-04T10:00:00.000Z", detail: "x" })
const game = { gameAt: 1000, rounds: 2, maxGroupSize: 6, reportEnds: 1300 }
const NET = { live: false, planned: 0, fired: 0 }

describe("dueActions", () => {
  it("lists what each role must do", () => {
    expect(dueActions(rolePlan(profileFor(5), true))).toEqual(["killed", "relaunched", "hidden", "visible"])
    expect(dueActions(rolePlan(profileFor(6), true))).toEqual(["left-app", "rejoined"])
    expect(dueActions(rolePlan(profileFor(1), true))).toEqual(["confirm-tap"])
    expect(dueActions(rolePlan(profileByName("tap-storm-pixel7"), true))).toEqual(["storm-taps"])
    expect(dueActions(rolePlan(profileByName("video-role-late-flip"), true))).toEqual(["left-app", "rejoined", "video-suppressed", "video-enabled", "video-disabled"])
    expect(dueActions(rolePlan(profileByName("video-role-late-never"), true))).toEqual(["left-app", "rejoined", "video-suppressed"])
  })
  it("plain baseline and roles off owe nothing", () => {
    expect(dueActions(rolePlan(null))).toEqual([])
    expect(dueActions(rolePlan(profileFor(5), false))).toEqual([])
  })
})

describe("video-role-proof cross-job lifecycle", () => {
  it("keeps the checked profiles ordered enable < disable < reload", () => {
    const flip = rolePlan(profileByName("video-role-late-flip"), true)
    const viewer = rolePlan(profileByName("reload-mid-game"), true)
    expect(flip.kind).toBe("video-return")
    expect(viewer.kind).toBe("reload")
    if (flip.kind !== "video-return" || viewer.kind !== "reload") throw new Error("wrong proof profile roles")
    expect(flip.enableAtTurn).not.toBeNull()
    expect(flip.disableAtTurn).not.toBeNull()
    expect(flip.enableAtTurn!).toBeLessThan(flip.disableAtTurn!)
    expect(flip.disableAtTurn!).toBeLessThan(viewer.reloadAtTurn)
  })
  const result = (slot: number, profile: string, account: string) => {
    const value = emptyResult(slot, account, profile, new Date(0), profile)
    value.profile = profile
    return value
  }

  it("requires no confirm tile and the default NotPerson for the never-video player, from the viewer and one peer", () => {
    const viewer = result(1, "reload-mid-game", "viewer")
    const flip = result(2, "video-role-late-flip", "flip")
    const never = result(3, "video-role-late-never", "never")
    viewer.role.actions = [{ id: "reloaded", at: "2026-10-07T01:00:05Z", detail: "reload" }]
    flip.role.actions = [
      { id: "video-enabled", at: "2026-10-07T01:00:02Z", detail: "on" },
      { id: "video-disabled", at: "2026-10-07T01:00:04Z", detail: "off" },
    ]
    const notPerson = { verdict: "notperson", source: "unseen", unseenChoice: "default-notperson" as const }
    const flipTile = { at: "2026-10-07T01:00:06Z", id: "flip", role: "coplayer", text: "Seen earlier", verdict: "approve", votable: true }
    const neverTile = { at: "2026-10-07T01:00:06Z", id: "never", role: "unseen", text: "Not a person", verdict: "reject", votable: true }
    viewer.videoRoleProof = {
      turns: [{ turn: 1, at: "2026-10-07T01:00:01Z", roles: { flip: "unseen", never: "unseen" }, verdicts: { flip: "unseen", never: "unseen" } }],
      markers: [{ at: "2026-10-07T01:00:03Z", id: "flip", role: "coplayer" }],
      recap: [flipTile],
      report: { never: { ...notPerson } },
    }
    const baseline = result(4, "baseline", "baseline")
    baseline.videoRoleProof = { turns: [], markers: [], recap: [flipTile], report: { never: { ...notPerson } } }
    const check = () => verifyVideoRoleProof([viewer, flip, never, baseline])
    expect(check()).toMatchObject({ status: "pass", detail: expect.stringMatching(/no confirm tile.*player 4/) })
    viewer.role.actions[0].at = "2026-10-07T01:00:03.500Z"
    expect(check()).toMatchObject({ status: "fail", detail: expect.stringMatching(/disable.*reload/i) })
    viewer.role.actions[0].at = "2026-10-07T01:00:05Z"
    viewer.videoRoleProof.recap = [flipTile, neverTile]
    expect(check()).toMatchObject({ status: "fail", detail: expect.stringMatching(/viewer recap.*tile/i) })
    viewer.videoRoleProof.recap = [flipTile]
    viewer.videoRoleProof.report!.never = { verdict: "person", source: "unseen", unseenChoice: "flipped-person", unseenEverFlipped: true }
    expect(check()).toMatchObject({ status: "fail", detail: expect.stringMatching(/viewer did not file.*default NotPerson/i) })
    viewer.videoRoleProof.report!.never = { ...notPerson }
    baseline.videoRoleProof.recap = [flipTile, neverTile]
    expect(check()).toMatchObject({ status: "fail", detail: expect.stringMatching(/no peer recap/i) })
    baseline.videoRoleProof.recap = []
    expect(check()).toMatchObject({ status: "fail", detail: expect.stringMatching(/no peer recap/i) })
  })
})

describe("verifyRoleActs: a role that was due and did not act FAILS (bot 5, games 185-187)", () => {
  const role = rolePlan(profileFor(5), true)
  it("fails every missing action, naming it", () => {
    const c = verifyRoleActs(5, role, [], NET)
    expect(c.map((x) => x.status)).toEqual(["fail", "fail", "fail", "fail"])
    expect(c[0].detail).toMatch(/due to act \(killed\) and never did/)
  })
  it("fails only what is missing", () => {
    const c = verifyRoleActs(5, role, [act("killed"), act("relaunched")], NET)
    expect(c.map((x) => x.status)).toEqual(["pass", "pass", "fail", "fail"])
  })
  it("passes when everything happened, with the time", () => {
    const c = verifyRoleActs(5, role, [act("killed"), act("relaunched"), act("hidden"), act("visible")], NET)
    expect(c.every((x) => x.status === "pass")).toBe(true)
    expect(c[0].detail).toMatch(/^10:00:00/)
  })
  it("a role off owes nothing, so nothing fails", () => expect(verifyRoleActs(5, rolePlan(profileFor(5), false), [], NET)).toEqual([]))
})

describe("network timeline steps", () => {
  it("fail when a planned step never fired on a shaped runner; ignored when the runner is not shaped", () => {
    const role = rolePlan(profileFor(4), true)
    expect(verifyRoleActs(4, role, [], { live: true, planned: 1, fired: 0 })[0].status).toBe("fail")
    expect(verifyRoleActs(4, role, [], { live: true, planned: 1, fired: 1 })[0].status).toBe("pass")
    expect(verifyRoleActs(4, role, [], { live: false, planned: 1, fired: 0 })).toEqual([])
  })
})

describe("roleFeasibility", () => {
  const kill = rolePlan(profileFor(5), true)
  it("accepts the six-bot two-round game", () => expect(roleFeasibility(kill, game)).toBeNull())
  it("rejects killInRound 2 in a one-round game, clearly", () => {
    expect(roleFeasibility(kill, { ...game, rounds: 1 })).toMatch(/wants round 2 but the game has 1 round/)
  })
  it("rejects a late join after the last turn and a window after the report ends", () => {
    expect(roleFeasibility({ kind: "late-join", joinAfterTurn: 2 }, { ...game, rounds: 1, maxGroupSize: 2 })).toMatch(/only 2 turn/)
    expect(roleFeasibility(kill, { ...game, reportEnds: 1100 })).toMatch(/reports end at 1100/)
  })
  it("a late join or video return may land at any turn the game has (#699)", () => {
    expect(roleFeasibility({ kind: "late-join", joinAfterTurn: 2 }, game)).toBeNull()
    expect(roleFeasibility({ kind: "late-join", joinAfterTurn: 7 }, game)).toBeNull()
    expect(roleFeasibility({ kind: "video-return", joinAfterTurn: 3, enableAtTurn: null, disableAtTurn: null }, game)).toBeNull()
    expect(roleFeasibility({ kind: "video-return", joinAfterTurn: 1, enableAtTurn: 4, disableAtTurn: 10 }, game)).toBeNull()
  })
  it("a late join owes left-app and rejoined", () => {
    expect(dueActions({ kind: "late-join", joinAfterTurn: 1 })).toEqual(["left-app", "rejoined"])
  })
  it("rejects a video-return flip that cannot occur after its return", () => {
    expect(roleFeasibility({ kind: "video-return", joinAfterTurn: 2, enableAtTurn: 2, disableAtTurn: 7 }, game)).toMatch(/not after its return/)
    expect(roleFeasibility({ kind: "video-return", joinAfterTurn: 2, enableAtTurn: 4, disableAtTurn: 4 }, game)).toMatch(/disableAtTurn must come after/)
  })
})

describe("clock jumps are acts too (profile clockJumps)", () => {
  const plain = rolePlan(null)
  it("a jump that never landed fails, naming how many did", () => {
    const [c] = verifyRoleActs(1, plain, [act("clock-jump")], NET, 2)
    expect(c.status).toBe("fail")
    expect(c.detail).toMatch(/1 of 2 jump\(s\) landed/)
  })
  it("passes when every jump landed, with their details", () => {
    const [c] = verifyRoleActs(1, plain, [act("clock-jump"), act("clock-jump")], NET, 2)
    expect(c.status).toBe("pass")
  })
  it("a profile without jumps owes none", () => expect(verifyRoleActs(1, plain, [], NET)).toEqual([]))
  it("a jump after the last turn is impossible and said before the sign-up", () => {
    expect(roleFeasibility(plain, game, [4, 8])).toBeNull()
    expect(roleFeasibility(plain, game, [4, 13])).toMatch(/clock jump waits for turn 13 but the game has only 12/)
  })
})

describe("the clock-jumps profile", () => {
  it("jumps to +30 s at turn 4 and to -75 s at turn 8 (offsets are absolute, not cumulative)", () => {
    expect(profileByName("clock-jumps").clockJumps).toEqual([{ atTurn: 4, offsetS: 30 }, { atTurn: 8, offsetS: -75 }])
  })
})

describe("host-crash acts", () => {
  const role = rolePlan(profileByName("host-crash"), true)
  it("owes the kill and the restart", () => expect(dueActions(role)).toEqual(["host-killed", "host-restarted"]))
  it("is impossible in a one-round game", () => expect(roleFeasibility(role, { ...game, rounds: 1 })).toMatch(/host-crash wants round 2 but the game has 1/))
})

describe("a role problem is a failing check, never a pass", () => {
  it("every problem the journey met (a failed network step, a jump read back wrong, a host that did not come back) fails the bot", () => {
    const c = verifyRoleActs(2, rolePlan(null), [], NET, 0, ["network step 1 failed: outage NOT PROVEN", "host crash: the page reloaded itself"])
    expect(c.map((x) => x.status)).toEqual(["fail", "fail"])
    expect(c[0].detail).toMatch(/outage NOT PROVEN/)
  })
  it("no problems add no checks", () => expect(verifyRoleActs(2, rolePlan(null), [], NET, 0, [])).toEqual([]))
})

describe("clockJumpLanded: the read-back offset must be the target within 2 s", () => {
  it("accepts the target and a small drift, refuses a jump that did not take", () => {
    expect(clockJumpLanded(30, 30.1)).toBe(true)
    expect(clockJumpLanded(-75, -73.5)).toBe(true)
    expect(clockJumpLanded(30, 0)).toBe(false)
    expect(clockJumpLanded(-75, 30)).toBe(false)
    expect(clockJumpLanded(30, 32.5)).toBe(false)
  })
  it("keeps the stale-build evidence label although its executable role is baseline", () => {
    const [c] = verifyRoleActs(1, rolePlan(profileByName("check-stale-build"), true), [], NET, 0, ["fixture failed"])
    expect(c.name).toBe("player 1 role stale-build: problem")
  })
})

describe("the reload, hidden-step and freeze acts", () => {
  const plan = (name: string) => rolePlan(profileByName(name), true)
  const game = { gameAt: 1000, rounds: 2, maxGroupSize: 6, reportEnds: 1300 }
  it("are due", () => {
    expect(dueActions(plan("reload-mid-game"))).toEqual(["reloading", "reloaded"])
    expect(dueActions(plan("clock-step-while-hidden"))).toEqual(["hidden", "clock-step", "visible"])
    expect(dueActions(plan("visible-freeze"))).toEqual(["frozen", "thawed"])
  })
  it("fit the game, or say why not before it plays", () => {
    for (const n of ["reload-mid-game", "clock-step-while-hidden", "visible-freeze"]) expect(roleFeasibility(plan(n), game)).toBeNull()
    const one = { ...game, rounds: 1 }
    expect(roleFeasibility({ kind: "reload", reloadAtTurn: 6 }, one)).toMatch(/reload waits for turn 6 but the game has only 6/)
    expect(roleFeasibility({ kind: "hidden-step", hideAtTurn: 5, showAtTurn: 7, stepS: -60 }, one)).toMatch(/shows the page at turn 7/)
    expect(roleFeasibility({ kind: "freeze", freezeAtTurn: 9, freezeS: 20, holdMonotonic: true }, one)).toMatch(/freeze waits for turn 9/)
  })
  it("a freeze that never thawed fails, with the reason", () => {
    const acts: RoleAction[] = [{ id: "frozen", at: "2026-10-04T19:00:00.000Z", detail: "at turn 9" }]
    const checks = verifyRoleActs(1, plan("visible-freeze"), acts, { live: false, planned: 0, fired: 0 }, 0, ["freeze (game turn 9): the page's timer ticked within 300 ms"])
    expect(checks.map((c) => c.status)).toEqual(["fail", "pass", "fail"])
  })
})

describe("clock-held: a clock that starts wrong must read wrong before its correction", () => {
  it("is due for a wrong-then-corrected clock only", () => {
    expect(clockHeldDue(profileByName("clock-wrong-then-corrected"))).toEqual(["clock-held"])
    expect(clockHeldDue(profileByName("clock-ahead-then-corrected"))).toEqual(["clock-held"])
    expect(clockHeldDue(profileByName("clock-jumps"))).toEqual([])
    expect(clockHeldDue(profileByName("relay-iphonese-fastclock"))).toEqual([])
    expect(clockHeldDue(null)).toEqual([])
  })
  it("a missing read-back fails", () => {
    const p = rolePlan(profileByName("clock-wrong-then-corrected"), true)
    const checks = verifyRoleActs(1, p, [], { live: false, planned: 0, fired: 0 }, 0, [], ["clock-held"])
    expect(checks.map((c) => [c.name, c.status])).toEqual([["player 1 role baseline: clock-held", "fail"]])
  })
})

describe("verifyRoleActs: an act that did not happen says why when the bot knows (games 196, 197)", () => {
  const role = rolePlan(profileFor(1), true)
  it("appends the reason to the failing check and never turns it into a pass", () => {
    const c = verifyRoleActs(1, role, [], NET, 0, [], [], { "confirm-tap": "the app switched auto-confirm off (off-after-background) at 21:25:28" })
    expect(c[0].status).toBe("fail")
    expect(c[0].detail).toMatch(/never did: its trigger did not fire before the game ended; the app switched auto-confirm off \(off-after-background\) at 21:25:28$/)
  })
  it("leaves the plain text alone with no reason", () => {
    expect(verifyRoleActs(1, role, [], NET)[0].detail).toMatch(/before the game ended$/)
  })
})

describe("whyNotActed: the confirm-tap's missing countdown, named", () => {
  const trail = { reports: [], taps: 0, sealed: 0, overrides: 0, autoConfirmOff: { ts: Date.UTC(2026, 9, 4, 19, 25, 28), reason: "off-after-background" } }
  it("names the app's switch-off and the bare-CTA note", () => {
    const w = whyNotActed(trail, ["the countdown never showed: tapped the bare CTA \"Confirm votes\" 5 s after the confirm stage opened"])["confirm-tap"] ?? ""
    expect(w).toMatch(/auto-confirm off \(off-after-background\) at 19:25:28 UTC/)
    expect(w).toMatch(/the countdown never showed/)
  })
  it("says nothing when the app never switched it off and the bot saw no bare tap", () => {
    expect(whyNotActed({ ...trail, autoConfirmOff: undefined }, [])).toEqual({})
    expect(whyNotActed(null, [])).toEqual({})
  })
})

// GAME 197, BOT 1 (#341): the app logged "auto-confirm off" (off-after-background) at 21:25:28 CEST after a 15.7 s stall of
// the page, and the bot tapped the bare "Confirm votes" CTA. The countdown never armed, so the strict act could not happen.
describe("confirmFreeze and the confirm-tap verdict (#341)", () => {
  const OFF = Date.UTC(2026, 9, 4, 19, 25, 28) // 21:25:28 CEST
  const trail = { autoConfirmOff: { ts: OFF, reason: "off-after-background" } }
  const stall = { ms: 15_700, endedAt: OFF - 200 }
  const role = rolePlan(profileFor(1), true)
  const at = (id: RoleAction["id"], ms: number, detail = "x"): RoleAction => ({ id, at: new Date(ms).toISOString(), detail })
  const bare = at("confirm-tap-bare", OFF + 40_000, 'label "Confirm votes", 5 s after the confirm stage opened')
  const rows = [
    { t: new Date(OFF - 30_000).toISOString(), turn: 2 },
    { t: new Date(OFF - 20_000).toISOString(), turn: 3 },
    { t: new Date(OFF + 5_000).toISOString(), turn: 4 },
  ]
  const verdict = (f: ReturnType<typeof confirmFreeze>, acts: RoleAction[]) => verifyRoleActs(1, role, acts, NET, 0, [], [], {}, f)[0]

  it("the threshold is the app's: its tick plus its slack, read from lib, not a copy", () => {
    expect(FREEZE_THRESHOLD_MS).toBe(pageFreezeThresholdMs(SESSION_TICK_MS))
    expect(FREEZE_THRESHOLD_MS).toBe(5500)
    const f = (ms: number) => confirmFreeze({ trail, longTasks: [{ ms, endedAt: OFF }], acts: [] })
    expect(f(FREEZE_THRESHOLD_MS - 1)).toBeNull()
    expect(f(FREEZE_THRESHOLD_MS)).not.toBeNull()
    // a retuned line moves the rule
    expect(confirmFreeze({ trail, longTasks: [{ ms: 3000, endedAt: OFF }], acts: [], thresholdMs: 2000 })).not.toBeNull()
  })

  it("game 197 bot 1: off-after-background, a 15.7 s stall, a bare tap -> INCONCLUSIVE, naming length, turn, CEST time and #341", () => {
    const f = confirmFreeze({ trail, longTasks: [stall], acts: [bare], turnAt: (ms) => turnAtTime(rows, ms) })
    expect(f).toEqual({ ms: 15_700, endedAt: OFF - 200, turn: 3 })
    const c = verdict(f, [bare])
    expect(c.status).toBe("inconclusive")
    expect(c.detail).toMatch(/froze for 15\.7 s in turn 3/)
    expect(c.detail).toMatch(/21:25:27 CEST/)
    expect(c.detail).toMatch(/runner overload, see #341/)
    expect(c.detail).toMatch(/tapped the bare CTA/)
  })

  it("the same game without a long task is not a freeze: the missing countdown tap is a pass-with-note on the bare tap, never a freeze excuse", () => {
    expect(confirmFreeze({ trail, longTasks: [], acts: [bare] })).toBeNull()
    expect(confirmFreeze({ trail, longTasks: [{ ms: 400, endedAt: OFF }], acts: [] })).toBeNull()
    const c = verdict(null, [bare])
    expect(c.status).toBe("pass")
    expect(c.detail).toMatch(/NOTE: .*countdown never showed/)
  })

  it("with no countdown tap and no bare tap the bot never confirmed: FAIL, even beside a freeze-free trail", () => {
    expect(verdict(null, []).status).toBe("fail")
  })

  it("a freeze with no confirmation at all is still inconclusive on the act, the chain check decides the rest", () => {
    expect(verdict(confirmFreeze({ trail, longTasks: [stall], acts: [] }), []).status).toBe("inconclusive")
  })

  it("a real background act before the stall means a real background: not a freeze, FAIL", () => {
    for (const id of ["hidden", "left-app", "killed", "frozen"] as const) {
      expect(confirmFreeze({ trail, longTasks: [stall], acts: [at(id, OFF - 60_000)] })).toBeNull()
    }
    expect(verdict(null, []).status).toBe("fail")
  })

  it("a background act AFTER the app's switch-off does not undo it", () => {
    expect(confirmFreeze({ trail, longTasks: [stall], acts: [at("hidden", OFF + 60_000)] })).not.toBeNull()
  })

  it("needs the app's own reason, and a stall that ended AT that line", () => {
    expect(confirmFreeze({ trail: { autoConfirmOff: { ts: OFF, reason: "other" } }, longTasks: [stall], acts: [] })).toBeNull()
    expect(confirmFreeze({ trail: {}, longTasks: [stall], acts: [] })).toBeNull()
    expect(confirmFreeze({ trail: null, longTasks: [stall], acts: [] })).toBeNull()
    expect(confirmFreeze({ trail, longTasks: [{ ms: 15_700, endedAt: OFF - 60_000 }], acts: [] })).toBeNull()
  })

  it("every other missing act still FAILS, freeze or not", () => {
    const f = { ms: 15_700, endedAt: OFF, turn: 3 }
    const kill = verifyRoleActs(5, rolePlan(profileFor(5), true), [], NET, 0, [], [], {}, f)
    expect(kill.map((x) => x.status)).toEqual(["fail", "fail", "fail", "fail"])
  })

  it("cestTime reads Berlin time, CEST in summer and CET in winter", () => {
    expect(cestTime(OFF)).toBe("21:25:28 CEST")
    expect(cestTime(Date.UTC(2026, 11, 4, 19, 25, 28))).toBe("20:25:28 CET")
  })
})
