// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * fromDefinition turns a state-machine framework definition (lib/state-machines/<name>.definition.ts) into a
 * MachineAdapter. The state is the lockstep pair {real, model}; the alphabet is the row keys of the
 * transition table; representative event values come from the definition's own step functions; check runs the
 * framework's checkStep on the edge the search actually took. initial() is the definition's initialReal()/initialModel() only:
 * initialArbitrary is never read.
 */
import { checkStep, type MachineDefinition, type TraceEntry } from "../../state-machines/framework"
import type { MachineAdapter, TraceMonitor } from "./contract"
import { cellsOf, registerCells, type MachineStep } from "./explore-machine"

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortKeys(child)]))
  }
  return value
}

/** JSON with object keys sorted, so equal states give equal strings whatever order their fields were written in. */
const stableJson = (value: unknown): string => JSON.stringify(sortKeys(value))

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function fromDefinition<R, M, E extends string, RO, MO, Ob, SK extends string, Mon = never>(
  definition: MachineDefinition<R, M, E, RO, MO, Ob, SK, E>,
  options?: { traceMonitor?: TraceMonitor<TraceEntry<E, Ob, SK, E>, Mon>; excluded?: readonly { invariant: string; reason: string }[] },
): MachineAdapter<{ real: R; model: M }, E, { real: RO; model: MO }> {
  type Pair = { real: R; model: M }
  type Out = { real: RO; model: MO }
  type Step = MachineStep<Pair, E, Out>

  const excludedNames = new Set((options?.excluded ?? []).map((entry) => entry.invariant))
  // the fields checkStep reads, copied once so initialArbitrary (and any other extra field) is never touched
  const base: MachineDefinition<R, M, E, RO, MO, Ob, SK, E> = {
    name: definition.name,
    initialReal: () => definition.initialReal(),
    initialModel: () => definition.initialModel(),
    realStep: (state, event) => definition.realStep(state, event),
    modelStep: (state, event) => definition.modelStep(state, event),
    classifyRealStep: (previous, result) => definition.classifyRealStep(previous, result),
    observeReal: (result) => definition.observeReal(result),
    observeModel: (result) => definition.observeModel(result),
    realStateKey: (state) => definition.realStateKey(state),
    modelStateKey: (state) => definition.modelStateKey(state),
    eventKey: (event) => definition.eventKey(event),
    transitionTable: definition.transitionTable,
    witnesses: [],
    regressions: [],
    invariants: definition.invariants.filter((invariant) => !excludedNames.has(invariant.name)),
  }

  const entries = new WeakMap<object, TraceEntry<E, Ob, SK, E>>()
  /** the framework's trace entry for one edge, exactly as checkStep would have pushed it */
  const toEntry = (step: Step): TraceEntry<E, Ob, SK, E> => {
    const cached = entries.get(step)
    if (cached !== undefined) return cached
    const before = definition.realStateKey(step.previous.real)
    const eventKey = definition.eventKey(step.event)
    const realResult = { state: step.state.real, output: step.output.real }
    const entry: TraceEntry<E, Ob, SK, E> = {
      step: step.index,
      before,
      eventKey,
      event: step.event,
      declared: definition.transitionTable[before]?.[eventKey] ?? "impossible",
      outcome: definition.classifyRealStep(step.previous.real, realResult),
      real: definition.observeReal(realResult),
      model: definition.observeModel({ state: step.state.model, output: step.output.model }),
    }
    entries.set(step, entry)
    return entry
  }

  let alphabet: readonly E[] | undefined
  const events = (): readonly E[] =>
    (alphabet ??= Object.keys(definition.transitionTable[definition.realStateKey(definition.initialReal())]) as E[])

  const monitor = options?.traceMonitor
  const adapter: MachineAdapter<Pair, E, Out> = {
    name: definition.name,
    initial: () => [{ label: "start", state: { real: definition.initialReal(), model: definition.initialModel() } }],
    enabledEvents: () => events(),
    step: (state, event) => {
      const real = definition.realStep(state.real, event)
      const model = definition.modelStep(state.model, event)
      return { state: { real: real.state, model: model.state }, output: { real: real.output, model: model.output } }
    },
    canonical: (state) => stableJson(state),
    check: ({ previous, state, event, output, trace }) => {
      const steps = trace as readonly Step[]
      try {
        checkStep({
          // the edge the search took, not a fresh step: a planted or broken step is judged as it happened
          definition: { ...base, realStep: () => ({ state: state.real, output: output.real }), modelStep: () => ({ state: state.model, output: output.model }) },
          real: previous.real,
          model: previous.model,
          event,
          step: steps.length - 1,
          label: "explore",
          trace: steps.slice(0, -1).map(toEntry),
        })
        return null
      } catch (error) {
        return message(error)
      }
    },
    ...(monitor === undefined
      ? {}
      : {
          traceMonitor: {
            initial: monitor.initial,
            step: (state: unknown, step: unknown) => monitor.step(state as Mon, toEntry(step as Step)),
            key: (state: unknown) => monitor.key(state as Mon),
            covers: monitor.covers,
          },
        }),
    ...(options?.excluded === undefined ? {} : { excluded: options.excluded }),
  }

  registerCells(adapter, {
    declared: Object.entries(definition.transitionTable).flatMap(([stateKey, row]) =>
      Object.entries(row as Record<string, string>).flatMap(([eventKey, declared]) => (declared === "impossible" ? [] : [`${stateKey}::${eventKey}`])),
    ),
    cell: (state, event) => `${definition.realStateKey((state as Pair).real)}::${definition.eventKey(event as E)}`,
  })
  return adapter
}

/** A copy of `adapter` whose step leaves the real state unchanged on `event`: the planted bug the explorer must catch. */
export function plantStaleReal<S extends { real: unknown; model: unknown }, E, O>(adapter: MachineAdapter<S, E, O>, event: E): MachineAdapter<S, E, O> {
  const planted: MachineAdapter<S, E, O> = {
    ...adapter,
    name: `${adapter.name} (stale real on ${String(event)})`,
    step: (state, taken) => {
      const result = adapter.step(state, taken)
      return taken === event ? { state: { ...result.state, real: state.real }, output: result.output } : result
    },
  }
  const cells = cellsOf(adapter)
  if (cells !== undefined) registerCells(planted, cells)
  return planted
}
