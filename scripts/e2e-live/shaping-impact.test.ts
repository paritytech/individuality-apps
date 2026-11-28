// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { main, readJourneyLog, roleStressed, runVerdict, TURN_TROUBLE, unmeasuredStress } from "./shaping-impact.mts"
import { profileByName, type Profile } from "./profile"

// Every fixture is an excerpt of a REAL journey.log / devLog line from a live run
// (game 1592, 28 Oct 2026). The three defects these tests pin were found by reading
// the eight downloaded runs of that night; each one scored a fault that DID land as
// "no impact", so the tests assert the reading that the artifacts actually support.

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "shaping-impact-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const profile = (over: Partial<Profile>): Profile =>
  ({
    name: "p",
    bot: null,
    device: "Pixel 7",
    cpuThrottle: 1,
    camera: { delayMs: 0, resolution: "360p" },
    clockOffsetS: 0,
    network: { profile: "wifi", relayOnly: false },
    role: { kind: "baseline", params: {} },
    expect: [],
    ...over,
  }) as Profile

describe("readJourneyLog: the run's own word on whether a persona could fire", () => {
  // bot 30, a live run — verbatim
  const INCONCLUSIVE = [
    "",
    "Running 5 tests using 1 worker",
    "  INCONCLUSIVE host-chain-lost applies to this run — the app under test is dim2-pr1394-sandbox00.testnet, which reads the chain THROUGH the host (getHostProvider), so a host-chain cut also cuts the app's reads: host-chain-lost is only meaningful with app=local; its cuts are NOT played",
  ].join("\n")

  it("reads the run declaring a persona inconclusive, and why", () => {
    const dir = scratch()
    writeFileSync(join(dir, "journey.log"), INCONCLUSIVE)
    const reason = readJourneyLog(dir).get("host-chain-lost")
    expect(reason).toBeDefined()
    expect(reason).toContain("only meaningful with app=local")
    expect(reason).toContain("its cuts are NOT played")
  })

  it("does not attribute one persona's inconclusive to another", () => {
    const dir = scratch()
    writeFileSync(join(dir, "journey.log"), INCONCLUSIVE)
    expect(readJourneyLog(dir).has("chain-outage")).toBe(false)
  })

  it("says nothing when the run judged the persona normally", () => {
    const dir = scratch()
    writeFileSync(join(dir, "journey.log"), "  PASS      player 30 profile host-chain-lost: viewport — 412x915\n")
    expect(readJourneyLog(dir).has("host-chain-lost")).toBe(false)
  })

  it("treats a missing journey.log as no verdict rather than as a pass", () => {
    expect(readJourneyLog(scratch()).size).toBe(0)
  })

  it("takes the typed field from the -result artifact, where it actually ships", () => {
    // result.ts SlotResult.inconclusive, verbatim from bot 30's result-30.json. It ships
    // in the separate `-result` directory, which is why readJourneyLog (handed the BOT
    // directory) cannot see it and runVerdict takes it from the loaded result instead.
    const typed = {
      inconclusive: [
        {
          name: "player 30 host-chain-lost applies to this run",
          detail: "the app under test is dim2-pr1394-sandbox00.testnet, which reads the chain THROUGH the host (getHostProvider), so a host-chain cut also cuts the app's reads: host-chain-lost is only meaningful with app=local",
        },
      ],
    }
    const botDir = scratch()
    writeFileSync(join(botDir, "journey.log"), INCONCLUSIVE)
    const reason = runVerdict(typed, readJourneyLog(botDir), "host-chain-lost")
    expect(reason).toContain("only meaningful with app=local")
    // the typed detail, not the printed line's tail
    expect(reason).not.toContain("its cuts are NOT played")
  })

  it("falls back to the printed line when the typed field does not name the persona", () => {
    const botDir = scratch()
    writeFileSync(join(botDir, "journey.log"), INCONCLUSIVE)
    expect(runVerdict(null, readJourneyLog(botDir), "host-chain-lost")).toContain("only meaningful with app=local")
    expect(runVerdict({ inconclusive: [{ name: "player 9 chain-outage applies to this run", detail: "other" }] }, readJourneyLog(botDir), "host-chain-lost")).toContain("only meaningful with app=local")
  })

  it("reads the game stage's own prefixed line, not only the boot shape", () => {
    // journey.pw.ts writes `player ${slot} host-chain-lost applies to this run` at stage (c)
    const dir = scratch()
    writeFileSync(join(dir, "journey.log"), "  INCONCLUSIVE player 30 host-chain-lost applies to this run — only meaningful with app=local\n")
    expect(readJourneyLog(dir).get("host-chain-lost")).toContain("only meaningful with app=local")
  })
})

describe("TURN_TROUBLE: the TURN issuer outage as the app recorded it", () => {
  // the reader counts these with the same countMatching it uses for every other signal,
  // so what the test pins is the regex: which lines are trouble and which are not.
  const trouble = (msgs: readonly string[]): number => msgs.filter((m) => TURN_TROUBLE.test(m)).length
  // bot 15, a live run — verbatim devLog lines, in order
  const AT = 1793183671270
  const lines = [
    { ts: AT, tag: "rtc", message: "[jollity-rtc] TURN: try 1 failed (turn/issue-with-proof: no answer in 5000ms), trying again" },
    { ts: AT + 1950, tag: "rtc", message: "[jollity-rtc] TURN: still fetching, starting on STUN only" },
    { ts: AT + 1950, tag: "rtc", message: "[jollity-rtc] ICE: STUN-only — cross-network peers will not connect" },
    { ts: AT + 5800, tag: "rtc", message: "[jollity-rtc] TURN: try 2 failed (turn/issue-with-proof: no answer in 5000ms), trying again" },
    { ts: AT + 13000, tag: "rtc", message: "[jollity-rtc] TURN: issuer 1 failed — turn/issue-with-proof: no answer in 5000ms" },
    { ts: AT + 13000, tag: "rtc", message: "[jollity-rtc] TURN: failed to fetch credentials, using empty list" },
    { ts: AT + 149405, tag: "rtc", message: "[jollity-rtc] ICE: relayed — 8 TURN servers configured" },
  ]

  it("counts only the forms that mean the app gave up on TURN", () => {
    // exact: the issuer failure and the empty-list outcome. Neither the retries nor the
    // STUN-only interim state counts — a healthy start that succeeds on try 3 writes both.
    expect(trouble(lines.map((l) => l.message))).toBe(2)
  })

  it("does not count the recovery as trouble", () => {
    expect(trouble(lines.map((l) => l.message).filter((m) => /relayed/.test(m)))).toBe(0)
  })

  it("does not count the retries and interim state that every healthy cold start writes", () => {
    // a live run: 24 of the run's 58 bot exports carry this pair, the pure wifi
    // control locale-la-enus among them, and then relay fine seconds later. ice.ts writes
    // "try N failed ... trying again" only when another try follows, so try 3 succeeding
    // is a healthy start, not trouble.
    expect(
      trouble([
        "[jollity-rtc] TURN: try 1 failed (turn/issue-with-proof: no answer in 5000ms), trying again",
        "[jollity-rtc] TURN: try 2 failed (turn/issue-with-proof: no answer in 5000ms), trying again",
        "[jollity-rtc] ICE: STUN-only — cross-network peers will not connect",
      ]),
    ).toBe(0)
  })

  it("does not match an ordinary TURN credential refresh", () => {
    expect(trouble(["[jollity-rtc] TURN: client response received and parsed lifecycle=initial request_started_at_ms=1793183820000"])).toBe(0)
  })
})

describe("roleStressed: a persona stressed by its clock is not a control", () => {
  // The real personas, read from profiles.json: if a clock field changes there, the
  // reading that depends on it has to be re-examined rather than quietly passing
  // against a stale copy.
  it("treats a clock offset from boot as a role stress", () => {
    expect(roleStressed(profileByName("clock-wrong-then-corrected"))).toBe(true)
  })

  it("treats an in-game clock jump as a role stress", () => {
    expect(roleStressed(profileByName("clock-jumps"))).toBe(true)
  })

  it("leaves a plain wifi baseline persona as a control", () => {
    expect(roleStressed(profileByName("locale-la-enus"))).toBe(false)
  })

  it("counts an in-connection fault as stress, not as a control", () => {
    // peerFault / dataChannelFault / telemetryTorture move nothing the network record
    // sees, so these personas were scored "no impact" and fed the run's own reference.
    expect(roleStressed(profileByName("late-signal"))).toBe(true)
    expect(roleStressed(profileByName("game259-dropped-lane-rebuild"))).toBe(true)
    expect(roleStressed(profileByName("telemetry-t1-baseline"))).toBe(true)
    expect(unmeasuredStress(profileByName("late-signal"))).toEqual([expect.stringContaining("peer fault")])
  })

  it("still counts the existing role kinds", () => {
    expect(roleStressed(profile({ role: { kind: "freeze", params: {} } }))).toBe(true)
    expect(roleStressed(profile({ camera: { delayMs: 9000, resolution: "360p" } }))).toBe(true)
  })

  it("names the clock as the reason, so the row does not explain a clock fault as a role", () => {
    // The row used to read "role baseline: this persona is stressed by what the bot DOES"
    // for a persona whose only stress is the clock: a role it does not have, and no
    // mention of the fault that is actually there.
    expect(unmeasuredStress(profileByName("clock-jumps"))).toEqual(["clock jumps at turns 4, 8"])
    // the real persona is BOTH 5 s slow from boot and corrected at turn 6
    expect(unmeasuredStress(profileByName("clock-wrong-then-corrected"))).toEqual(["clock -5 s from boot", "clock jumps at turns 6"])
    expect(unmeasuredStress(profileByName("locale-la-enus"))).toEqual([])
  })
})

describe("the report's signal wiring", () => {
  // The second commit of this PR exists because TURN reached the per-window breakdown but
  // not the shaped-span summary, so a persona's row read "nothing happened" beside windows
  // that listed its trouble. Nothing tested that wiring, which is how it got through.
  const RUN = "40671092856"
  const bot = (slot: number, profile: Record<string, unknown>, lines: { ts: number; tag: string; message: string }[], netem: string, result?: Record<string, unknown>) => {
    const dir = scratch()
    const name = `e2e-live-${RUN}-attempt-1-manual-bot${slot}`
    const botDir = join(dir, name)
    mkdirSync(botDir)
    writeFileSync(join(botDir, "profile.json"), JSON.stringify({ profile: (profile as { name: string }).name, definition: profile }))
    writeFileSync(join(botDir, `devlog-${slot}.json`), JSON.stringify({ lines, longTasks: [], why: null }))
    writeFileSync(join(botDir, "netem.log"), netem)
    if (result) {
      const resDir = join(dir, `${name}-result`)
      mkdirSync(resDir)
      writeFileSync(join(resDir, `result-${slot}.json`), JSON.stringify(result))
    }
    return dir
  }
  const NETEM = "2026-10-28T10:34:10.654Z netem apply wifi\n[netem] ens4: netem delay 10ms  (profile wifi)\n2026-10-28T10:43:02.057Z netem clear\n[netem] cleared\n"
  const TURN_LINES = [
    { ts: Date.parse("2026-10-28T10:34:40Z"), tag: "rtc", message: "[jollity-rtc] TURN: try 2 failed (turn/issue-with-proof: no answer in 5000ms), trying again" },
    { ts: Date.parse("2026-10-28T10:34:41Z"), tag: "rtc", message: "[jollity-rtc] TURN: failed to fetch credentials, using empty list" },
  ]

  it("names TURN trouble in the shaped-span summary, not only in the windows", () => {
    const base = { bot: null, device: "Pixel 7", cpuThrottle: 1, camera: { delayMs: 0, resolution: "360p" }, clockOffsetS: 0, role: { kind: "baseline", params: {} }, expect: [] }
    const dir = bot(15, { ...base, name: "turn-issuer-outage", network: { profile: "wifi", relayOnly: false } }, TURN_LINES, NETEM, { profile: "turn-issuer-outage", account: "5D5BbGsxwRdj4GEtkxrmxLqqYMVQWPoRhgpQKxZawB7YARkB" })
    let out = ""
    expect(main([dir, "--run", RUN], (t) => (out += t))).toBe(0)
    expect(out).toContain("TURN trouble line(s) in the shaped span")
    expect(out).not.toContain("no repair line in the shaped span")
  })
})
