// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { main, shapingRows } from "../shaping-impact.mts"
import { shapingSummary, shapingTally, type ShapingSourceRow } from "./shaping-summary"

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

// Excerpts of what scripts/e2e-live/shaping-impact.mts emits for a live run,
// verbatim from its rows (bot 2 slow-pixel7-lte-poor, bot 30 host-chain-lost).
const slow: ShapingSourceRow = {
  persona: "slow-pixel7-lte-poor",
  bot: 2,
  attempt: 1,
  phase: "manual",
  intended: "2 Mbit, 150ms ±40ms, 2% loss; CPU ×4",
  evidence: ["rtt p50 196ms / p95 367ms (12 samples)", "egress as peers received it: loss 2.52% (471/18712 pkts)"],
  flags: ["CPU ×4 cannot be judged on the game span"],
  verdict: "impact seen",
}
const chainLost: ShapingSourceRow = {
  persona: "host-chain-lost",
  bot: 30,
  attempt: 1,
  phase: "manual",
  intended: "unlimited, 10ms, 0% loss; sign-up: host chain cut 60s",
  evidence: ["rtt p50 23ms / p95 106ms (7 samples)", "3 heal(s), 0 connection stall(s) in the shaped span"],
  flags: [],
  verdict: "cannot tell",
}

describe("shapingSummary", () => {
  it("puts the intended fault next to the app's own measurement", () => {
    const [row] = shapingSummary([slow])
    expect(row!.persona).toBe("slow-pixel7-lte-poor")
    expect(row!.intended).toContain("2 Mbit")
    // this fixture has no "predicted by this shaping" line, so the fallback is the
    // peer-received counters - never the plain inbound ones
    expect(row!.measured).toContain("egress as peers received it")
    expect(row!.measured).not.toContain("own inbound")
    expect(row!.verdict).toBe("impact seen")
  })

  it("shows the REASON for a cannot-tell row, which assess appends last", () => {
    // assess() puts the reason at the END, so taking the first line showed
    // "rtt p50 23ms / p95 106ms | cannot tell" with no explanation at all.
    const [row] = shapingSummary([
      {
        ...chainLost,
        evidence: [
          "rtt p50 23ms / p95 106ms (7 samples)",
          "3 heal(s), 0 connection stall(s) in the shaped span",
          "the run declared this persona inconclusive, so its fault was never played: only meaningful with app=local",
        ],
      },
    ])
    expect(row!.verdict).toBe("cannot tell")
    expect(row!.measured).toContain("only meaningful with app=local")
  })

  it("prefers what peers received or what the shaping predicted over plain inbound counters", () => {
    const [row] = shapingSummary([
      {
        ...slow,
        evidence: [
          "own inbound (not attributed to this persona's egress shaping): 227/18384 packets lost",
          "egress as peers received it: loss 2.52% (471/18712 pkts)",
          "predicted by this shaping: rtt 196ms vs the run's wifi reference 23ms",
        ],
      },
    ])
    expect(row!.measured).not.toContain("own inbound")
    // "predicted by this shaping" is the reader's verdict rationale, so it wins; the
    // peer-received counters are the fallback when there is no rationale.
    expect(row!.measured).toContain("predicted by this shaping")
  })

  it("carries the reader's flag as a note, so a verdict is not shown bare", () => {
    expect(shapingSummary([slow])[0]!.note).toContain("CPU ×4 cannot be judged")
    expect(shapingSummary([chainLost])[0]!.note).toBeNull()
  })

  it("states a missing measurement rather than leaving the cell blank", () => {
    const [row] = shapingSummary([{ ...chainLost, evidence: [] }])
    expect(row!.measured).toBe("no app-side measurement recorded")
  })

  it("keeps the bot number, so a person can find that bot's video", () => {
    expect(shapingSummary([slow, chainLost]).map((r) => r.bot)).toEqual([2, 30])
  })

  it("keeps the reader's order", () => {
    expect(shapingSummary([slow, chainLost]).map((r) => r.persona)).toEqual(["slow-pixel7-lte-poor", "host-chain-lost"])
  })

  it("truncates a very long measurement instead of blowing the row", () => {
    const long = { ...slow, evidence: ["x".repeat(400)] }
    const measured = shapingSummary([long])[0]!.measured
    expect(measured.length).toBeLessThanOrEqual(180)
    expect(measured.endsWith("…")).toBe(true)
  })
})

describe("a re-run bot", () => {
  // shapingRows used to drop the attempt, so a bot that ran twice appeared as two "bot 7"
  // rows with different verdicts and the tally counted the slot twice.
  const attempt = (n: number, verdict: "impact seen" | "no impact") => ({ ...slow, bot: 7, attempt: n, verdict })

  it("keeps both attempts visible but marks the earlier one superseded", () => {
    const rows = shapingSummary([attempt(1, "no impact"), attempt(2, "impact seen")])
    expect(rows).toHaveLength(2)
    expect(rows[0]!.superseded).toBe(true)
    expect(rows[1]!.superseded).toBe(false)
  })

  it("tallies the slot once, on its latest attempt", () => {
    const rows = shapingSummary([attempt(1, "no impact"), attempt(2, "impact seen")])
    expect(shapingTally(rows)).toBe("1 impact seen")
  })

  it("does not mark a single-attempt bot superseded", () => {
    expect(shapingSummary([attempt(1, "impact seen")])[0]!.superseded).toBe(false)
  })
})

describe("shapingTally", () => {
  it("reports the three verdicts in the reader's own wording", () => {
    expect(shapingTally(shapingSummary([slow, chainLost]))).toBe("1 impact seen, 1 cannot tell")
  })

  it("omits a verdict that no persona has", () => {
    expect(shapingTally(shapingSummary([slow]))).toBe("1 impact seen")
  })
})

describe("the page and the terminal read the same rows", () => {
  // shapingRows used to copy main()'s setup, which is exactly the drift this PR claims to
  // prevent. Both now go through buildRows; this runs one fixture artifact tree through
  // both and asserts they agree, so a future divergence fails here.
  const RUN = "40671092856"
  const base = { bot: null, device: "Pixel 7", cpuThrottle: 1, camera: { delayMs: 0, resolution: "360p" }, clockOffsetS: 0, role: { kind: "baseline", params: {} }, expect: [] }
  const NETEM = "2026-10-28T10:34:10.654Z netem apply wifi\n[netem] ens4: netem delay 10ms  (profile wifi)\n2026-10-28T10:43:02.057Z netem clear\n[netem] cleared\n"

  const tree = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "shaping-both-"))
    dirs.push(dir)
    const write = (slot: number, profile: Record<string, unknown>, lines: { ts: number; tag: string; message: string }[], result?: Record<string, unknown>) => {
      const name = `e2e-live-${RUN}-attempt-1-manual-bot${slot}`
      mkdirSync(join(dir, name))
      writeFileSync(join(dir, name, "profile.json"), JSON.stringify({ profile: (profile as { name: string }).name, definition: profile }))
      writeFileSync(join(dir, name, `devlog-${slot}.json`), JSON.stringify({ lines, longTasks: [], why: null }))
      writeFileSync(join(dir, name, "netem.log"), NETEM)
      if (result) {
        mkdirSync(join(dir, `${name}-result`))
        writeFileSync(join(dir, `${name}-result`, `result-${slot}.json`), JSON.stringify(result))
      }
    }
    const at = Date.parse("2026-10-28T10:35:00Z")
    write(2, { ...base, name: "slow-pixel7-lte-poor", network: { profile: "lte-poor", relayOnly: false } }, [
      { ts: at, tag: "rtc", message: "[jollity-rtc] path 5Peer relay/udp" },
    ])
    write(3, { ...base, name: "locale-la-enus", network: { profile: "wifi", relayOnly: false } }, [
      { ts: at, tag: "rtc", message: "[jollity-rtc] path 5Peer host/host udp" },
    ])
    return dir
  }

  it("gives the same verdict per persona and the same tally", () => {
    const dir = tree()
    const fromPage = shapingSummary(shapingRows([dir, "--run", RUN]).rows)
    let terminal = ""
    expect(main([dir, "--run", RUN], (t) => (terminal += t))).toBe(0)

    for (const row of fromPage) {
      // the terminal prints "| <persona> | <bot> | ... | **<verdict>** |"
      const line = terminal.split("\n").find((l) => l.startsWith(`| ${row.persona} | ${row.bot} |`))
      expect(line, `no terminal row for ${row.persona} bot ${row.bot}`).toBeDefined()
      expect(line).toContain(`**${row.verdict}**`)
    }
    // Same counts, compared order-insensitively: the terminal tallies in first-seen order
    // and the page in a fixed one (an optional follow-up, not this round).
    const tallyLine = terminal.split("\n").find((l) => l.startsWith("Verdicts: "))!
    const parts = (text: string) => text.replace(/^Verdicts: /, "").replace(/\.$/, "").split(", ").map((p) => p.trim()).sort()
    expect(parts(tallyLine)).toEqual(parts(shapingTally(fromPage)))
  })
})
