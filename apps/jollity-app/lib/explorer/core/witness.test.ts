// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * T6: witnesses (design 7). A witness is a replayable JSON choice list for one
 * finding; replay re-runs its labels, and the emitted test inlines them.
 */
// quiescence first: it traps the real timers before anything else loads
import "../mesh/quiescence"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadSpec } from "../mutants/spec"
import type { Label } from "./labels"
import {
  emitTest,
  readWitness,
  replayWitness,
  sourceStamp,
  WITNESS_SOURCE_FILES,
  writeWitness,
  type Witness,
} from "./witness"

const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url))
const consoleLog = console.log
const consoleWarn = console.warn

/** #1374's shape: b's refused signal, a send-answer that settles resolved with no answer on the wire */
const M1374S_LABELS: Label[] = [
  ...loadSpec("M1374s").warmup,
  "pc:b/1:sld:resolve",
  "env:signal-throws:b",
  "pc:b/1:gather",
]

async function planted(overrides: Partial<Witness> = {}): Promise<Witness> {
  return {
    schema: 1,
    machine: "mesh-pair",
    source: await sourceStamp(WITNESS_SOURCE_FILES),
    scenario: {
      name: "single-offer",
      phaseOffsetMs: 1000,
      faults: 2,
      horizonMs: 120_000,
      mutant: "M1374s",
    },
    labels: M1374S_LABELS,
    violation: {
      property: "P2",
      atStep: M1374S_LABELS.length - 1,
      detail:
        "b's statement send-answer on b/1 settled resolved with 0 answers to a/1#1 on the wire",
    },
    ...overrides,
  }
}

describe("witnesses", () => {
  beforeEach(() => {
    console.log = () => {}
  })
  afterEach(() => {
    console.log = consoleLog
    console.warn = consoleWarn
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("round-trips a witness and refuses schema 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explorer-witness-"))
    const witness = await planted()
    const path = await writeWitness(dir, witness)
    expect(path.startsWith(join(dir, "witnesses"))).toBe(true)
    expect(await readWitness(path)).toEqual(witness)
    expect(witness.source.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(Object.keys(witness.source.files)).toContain(
      "apps/jollity-app/lib/webrtc/mesh.ts",
    )

    const future = join(dir, "future.json")
    await writeFile(future, JSON.stringify({ ...witness, schema: 2 }))
    await expect(readWitness(future)).rejects.toThrow(/schema/)
  })

  it("replays a planted finding as reproduced, twice, with identical records", async () => {
    const witness = await planted()
    const first = await replayWitness(witness)
    const second = await replayWitness(witness)
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      status: "reproduced",
      violation: { property: "P2", atStep: witness.violation.atStep },
    })
    // the mutant was undone: unmutated, the same labels do not violate
    const fixed = await replayWitness({
      ...witness,
      scenario: { ...witness.scenario, mutant: null },
    })
    expect(fixed).toEqual({ status: "not-reproduced" })
  })

  it("says different-violation when the detail, the property or the step differs, and not-reproduced only when nothing violates", async () => {
    const witness = await planted()
    for (const changed of [
      { ...witness.violation, detail: "something else" },
      { ...witness.violation, property: "P1" },
      { ...witness.violation, atStep: 0 },
    ]) {
      const result = await replayWitness({ ...witness, violation: changed })
      expect(result).toMatchObject({ status: "different-violation", violation: { property: "P2" } })
    }
    const clean = await replayWitness({ ...witness, scenario: { ...witness.scenario, mutant: null } })
    expect(clean).toEqual({ status: "not-reproduced" })
  })

  it("says out-of-date for a fault label past the fault budget", async () => {
    const witness = await planted()
    const result = await replayWitness({
      ...witness,
      scenario: { ...witness.scenario, faults: 0, mutant: null },
    })
    expect(result).toMatchObject({ status: "out-of-date", label: "env:signal-throws:b" })
  })

  it("refuses a witness without phaseOffsetMs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explorer-witness-"))
    const witness = await planted()
    const scenario = { ...witness.scenario, phaseOffsetMs: undefined }
    const path = join(dir, "nooffset.json")
    await writeFile(path, JSON.stringify({ ...witness, scenario }))
    await expect(readWitness(path)).rejects.toThrow(/malformed/)
  })

  it("reads a witness saved with the old flag field: on is ignored, off is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explorer-witness-"))
    const witness = await planted()
    for (const [flag, ok] of [["on", true], ["off", false]] as const) {
      const path = join(dir, `flag-${flag}.json`)
      await writeFile(path, JSON.stringify({ ...witness, scenario: { ...witness.scenario, flag } }))
      const read = await readWitness(path)
      if (ok) await expect(replayWitness(read)).resolves.toBeDefined()
      else await expect(replayWitness(read)).rejects.toThrow(/flag off/)
    }
  })

  it("the emitted test is red under its mutant and green without it", async () => {
    const withMutant = await planted()
    const without = { ...withMutant, scenario: { ...withMutant.scenario, mutant: null } }
    const name = "mesh-explore-t6-emit.test.ts"
    const file = join(repoRoot, "apps/jollity-app/lib/webrtc", name)
    const run = () =>
      spawnSync("npx", ["vitest", "run", "--config", "vitest.lib.config.ts", `lib/webrtc/${name}`], {
        cwd: join(repoRoot, "apps/jollity-app"),
        encoding: "utf8",
      })
    try {
      await writeFile(file, emitTest(withMutant, "t6-emit"))
      const red = run()
      expect(red.status).not.toBe(0)
      expect(`${red.stdout}${red.stderr}`).toContain("send-answer on b/1 settled resolved")
      await writeFile(file, emitTest(without, "t6-emit"))
      const green = run()
      expect(`${green.stdout}${green.stderr}`).toContain("1 passed")
      expect(green.status).toBe(0)
    } finally {
      await rm(file, { force: true })
    }
  }, 180_000)

  it("says out-of-date with the step when a label is not enabled", async () => {
    const witness = await planted({
      scenario: { ...(await planted()).scenario, mutant: null },
      labels: [...M1374S_LABELS.slice(0, 3), "pc:b/9:srd:resolve"],
    })
    expect(await replayWitness(witness)).toEqual({
      status: "out-of-date",
      atStep: 3,
      label: "pc:b/9:srd:resolve",
    })
  })

  it("warns but replays when a source hash changed", async () => {
    const witness = await planted()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const stale: Witness = {
      ...witness,
      source: {
        ...witness.source,
        files: {
          ...witness.source.files,
          "apps/jollity-app/lib/webrtc/mesh.ts": "sha256:0000",
        },
      },
    }
    const result = await replayWitness(stale)
    expect(result.status).toBe("reproduced")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("lib/webrtc/mesh.ts")
  })

  it("emits a vitest file that imports exploreRoom, inlines the labels, and never starts a search", async () => {
    const witness = await planted({
      scenario: { ...(await planted()).scenario, mutant: null },
    })
    const text = emitTest(witness, "p2-refused-answer")
    expect(text).toContain('import { exploreRoom')
    expect(text).toContain('from "../explorer/mesh/room"')
    for (const label of witness.labels) expect(text).toContain(JSON.stringify(label))
    expect(text).toContain(witness.source.commit)
    expect(text).toContain("faults")
    expect(text).toContain("horizon")
    expect(text).toContain('room.violations("P2")')
    expect(text).not.toMatch(/search\(|run\.explore|explore\.mts/)
    // the emitted file is real TypeScript the explorer's own room accepts
    expect(text).toContain('scenario: "single-offer"')
  })

  it("maps --replay to exit 1 reproduced, 0 not reproduced, 4 out of date", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explorer-witness-cli-"))
    const base = await planted()
    const fixed = { ...base, scenario: { ...base.scenario, mutant: null } }
    const stale = { ...fixed, labels: ["pc:b/9:srd:resolve"] }
    const exit = async (name: string, witness: Witness) => {
      const path = join(dir, `${name}.json`)
      await writeFile(path, JSON.stringify(witness))
      const run = spawnSync(
        "npm",
        ["run", "explore", "--", "--machine", "mesh-pair", "--replay", path, "--out", join(dir, name)],
        { cwd: repoRoot, encoding: "utf8" },
      )
      return { status: run.status, text: `${run.stdout}${run.stderr}` }
    }
    const reproduced = await exit("reproduced", base)
    expect(reproduced.status).toBe(1)
    expect(reproduced.text).toContain("reproduced P2")
    expect((await exit("fixed", fixed)).status).toBe(0)
    const old = await exit("stale", stale)
    expect(old.status).toBe(4)
    expect(old.text).toContain("witness out of date at step 0")
  }, 180_000)
})
