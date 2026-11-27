// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { DEFAULT_STATE_MACHINE_SEED, runStateMachineSuite } from "./framework"
import {
  type TurnBooksTestEvent,
  turnBooksMachineDefinition,
  turnBooksRegressionCorpus,
  turnBooksSequenceArbitrary,
  turnBooksTransitionTable,
  turnBooksWitnesses,
} from "./turn-books.definition"

describe("turn-books state-machine model", () => {
  it("matches the independent model, checks every invariant and gates transition coverage", async () => {
    const { coverage } = await runStateMachineSuite(turnBooksMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
    const generated = fc.sample(turnBooksSequenceArbitrary, { seed: DEFAULT_STATE_MACHINE_SEED, numRuns: 300 })
    const stateChangingDepths = generated
      .map((events) => events.filter((event) => event.expected === "transition").length)
      .sort((left, right) => left - right)
    expect(stateChangingDepths[Math.ceil(stateChangingDepths.length * 0.95) - 1]).toBeGreaterThanOrEqual(20)
    expect(stateChangingDepths.at(-1)).toBeGreaterThanOrEqual(25)
    expect(generated.some((events) => events.some((event) => event.action === "restore"))).toBe(true)
    expect(generated.some((events) => events.some((event) => event.action === "restore-auto"))).toBe(true)

    const rank = { "tick-waiting": 0, "tick-turn-0": 1, "tick-turn-1": 2, "late-join-turn-1": 2, "tick-reporting": 3 } as const
    const postRewindDepths = generated.flatMap((events) => {
      let clock = 0
      let rewindAt = -1
      events.forEach((event, index) => {
        if (!(event.action in rank)) return
        const next = rank[event.action as keyof typeof rank]
        if (next < clock && rewindAt < 0) rewindAt = index
        clock = next
      })
      return rewindAt < 0
        ? []
        : [events.slice(rewindAt + 1).filter((event) => event.expected === "transition").length]
    }).sort((left, right) => left - right)
    expect(postRewindDepths.length).toBeGreaterThanOrEqual(75)
    expect(postRewindDepths[Math.floor(postRewindDepths.length / 2)]).toBeGreaterThanOrEqual(5)
    expect(postRewindDepths.reduce((sum, depth) => sum + depth, 0)).toBeGreaterThanOrEqual(postRewindDepths.length * 6)
  })

  it("keeps deterministic witnesses exhaustive for every declared transition and no-op", () => {
    const declared = Object.values(turnBooksTransitionTable).reduce(
      (total, row) => total + Object.values(row).filter((outcome) => outcome !== "impossible").length,
      0,
    )
    expect(turnBooksWitnesses).toHaveLength(declared)
    expect(new Set(turnBooksWitnesses.map((witness) => witness.name)).size).toBe(declared)
  })

  it("keeps the T1 named sequences on every run", () => {
    expect(turnBooksRegressionCorpus.map((entry) => entry.name)).toEqual([
      "door player seals missed turns",
      "late join is not charged for turn 0",
      "tap overrides a replayed seal",
      "normal unban clears a ban that overwrote Person",
      "unban preserves an earlier Person tap on replay",
      "unban preserves an earlier NotPerson tap on replay",
      "ban undo and replay are account scoped",
      "local tap beats a stored tap",
      "local deliberate reject clears a stored default marker",
      "stored defaults restore their sealed evidence",
      "late restore top-up uses restored evidence and ban",
      "same reading is idempotent",
    ])
  })

  const productTrace = (actions: TurnBooksTestEvent["action"][]) => {
    let state = turnBooksMachineDefinition.initialReal()
    for (const action of actions)
      state = turnBooksMachineDefinition.realStep(state, { action, expected: "transition" }).state
    return state
  }

  it("keeps a local Person tap over a stored default verdict", () => {
    const state = productTrace(["tick-waiting", "frame-bob", "tick-turn-0", "tap-bob-person", "restore-auto"])
    expect(state.books.turnVotes[0]?.bob).toBe("person")
  })

  it("#1214: restoring a stored default clears its marker when a local Person tap wins", () => {
    const state = productTrace(["tick-waiting", "frame-bob", "tick-turn-0", "tap-bob-person", "restore-auto"])
    expect(state.books.autoSeals[0]).not.toContain("bob")
  })

  it("#1214: a deliberate local NotPerson tap also clears the stored default marker", () => {
    const state = productTrace(["tick-waiting", "frame-bob", "tick-turn-0", "tap-bob-notperson", "restore-auto"])
    expect(state.books.turnVotes[0]?.bob).toBe("notperson")
    expect(state.books.autoSeals[0]).not.toContain("bob")
  })

  it("#390 gap 1 (clause 2): completion sealing survives a backward T-0 reset", () => {
    const state = productTrace(["tick-turn-0", "frame-bob", "tick-waiting", "tick-reporting"])
    expect(state.books.sealed.has(0), "completed turn 0 must seal after the clock advances again").toBe(true)
  })

  it("#390 gap 1 (clause 2): completion sealing survives a backward reset at T-1", () => {
    const state = productTrace(["tick-turn-0", "frame-bob", "tick-waiting", "tick-turn-1"])
    expect(state.books.sealed.has(0), "completed turn 0 must seal when the clock returns at turn 1").toBe(true)
  })

  it("#390 gap 3 (clause 3): a late-join rewind leaves a pre-entry turn unsealed", () => {
    const state = productTrace(["late-join-turn-1", "tick-turn-0", "frame-bob", "tick-turn-1"])
    expect(
      { sealed: state.books.sealed.has(0), verdict: state.books.turnVotes[0]?.bob },
      "turn 0 ended before entry and must remain unsealed and verdict-free",
    ).toEqual({ sealed: false, verdict: undefined })
  })
})
