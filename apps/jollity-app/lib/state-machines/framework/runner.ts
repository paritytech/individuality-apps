// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import fc from "fast-check"
import { CoverageRecorder } from "./coverage"
import { checkStep } from "./step-check"
import type { CoverageReport, MachineDefinition, TraceEntry } from "./types"

export const DEFAULT_STATE_MACHINE_SEED = 1_592_598_566

function parseSeed(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function summarizeLengths(lengths: readonly number[]): NonNullable<CoverageReport["generatedSequenceLengths"]> | undefined {
  if (lengths.length === 0) return undefined
  const sorted = [...lengths].sort((left, right) => left - right)
  const percentile = (ratio: number): number => sorted[Math.ceil(ratio * sorted.length) - 1]
  return {
    count: sorted.length,
    min: sorted[0],
    mean: Number((sorted.reduce((total, length) => total + length, 0) / sorted.length).toFixed(2)),
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[sorted.length - 1],
  }
}

export async function runStateMachineSuite<
  RealState,
  ModelState,
  Event,
  RealOutput,
  ModelOutput,
  Observation,
  StateKey extends string,
  EventKey extends string,
>(
  definition: MachineDefinition<RealState, ModelState, Event, RealOutput, ModelOutput, Observation, StateKey, EventKey>,
): Promise<{ coverage: CoverageReport; seed: number }> {
  const seed = parseSeed(process.env.SM_SEED) ?? DEFAULT_STATE_MACHINE_SEED
  const coverage = new CoverageRecorder(definition.name, definition.transitionTable, seed)
  const generatedSequenceLengths: number[] = []

  const execute = (
    events: readonly Event[],
    label: string,
    recordCoverage: boolean,
    initial?: { real: RealState; model: ModelState },
  ): void => {
    let real = initial?.real ?? definition.initialReal()
    let model = initial?.model ?? definition.initialModel()
    const trace: TraceEntry<Event, Observation, StateKey, EventKey>[] = []

    const onRecord = recordCoverage ? coverage.record.bind(coverage) : undefined
    events.forEach((event, step) => {
      ;({ real, model } = checkStep({ definition, real, model, event, step, label, trace }, onRecord))
    })
  }

  for (const witness of definition.witnesses) execute(witness.events, `witness:${witness.name}`, true, witness.initial)
  const deterministic = coverage.report()
  if (deterministic.missing.length > 0) {
    throw new Error(`${definition.name}: missing deterministic coverage: ${deterministic.missing.join(", ")}`)
  }
  if (deterministic.impossibleObserved.length > 0) {
    throw new Error(`${definition.name}: impossible pairs observed: ${deterministic.impossibleObserved.join(", ")}`)
  }

  for (const regression of definition.regressions) execute(regression.events, `regression:${regression.name}`, true, regression.initial)
  for (const [index, events] of (definition.generatedSequences?.() ?? []).entries()) execute(events, `generated:${index}`, true)

  if (definition.sequenceArbitrary) {
    const path = process.env.SM_PATH || undefined
    const initialArbitrary =
      definition.initialArbitrary ?? fc.constant({ real: definition.initialReal(), model: definition.initialModel() })
    fc.assert(
      fc.property(initialArbitrary, definition.sequenceArbitrary, (initial, events) => {
        generatedSequenceLengths.push(events.length)
        execute(events, "property", true, initial)
      }),
      {
        numRuns: definition.numRuns ?? 200,
        seed,
        ...(path === undefined ? {} : { path }),
        verbose: 1,
      },
    )
  }

  const generatedStats = summarizeLengths(generatedSequenceLengths)
  const report: CoverageReport = {
    ...coverage.report(),
    ...(generatedStats === undefined ? {} : { generatedSequenceLengths: generatedStats }),
  }
  const directory = resolve(process.cwd(), definition.reportDirectory ?? "test-results/state-machines")
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, `${definition.name}.json`), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nState-machine transition coverage: ${definition.name}`)
  console.table([{ machine: definition.name, seed, declared: report.declared, hit: report.hit, missing: report.missing.length }])
  if (report.generatedSequenceLengths) console.table([report.generatedSequenceLengths])
  return { coverage: report, seed }
}
