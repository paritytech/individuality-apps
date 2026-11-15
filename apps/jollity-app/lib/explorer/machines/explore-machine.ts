// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Breadth-first search over one MachineAdapter from its normal initial states. The visited key is canonical(state) plus
 * traceMonitor.key, so two paths merge only when the state and everything the trace invariants read agree. A step whose
 * check returns a message is a violation: it is reported with its path and not expanded further. Bounded evidence, never a
 * proof: the report says how deep the search got and whether the frontier closed.
 */
import type { MachineAdapter } from "./contract"

export interface ExploreMachineReport {
  machine: string
  states: number
  edges: number
  depthCompleted: number
  frontierClosed: boolean
  violations: { message: string; trace: string[] }[]
  /** the declared cells no search edge took, or "cell list unknown" for an adapter with no cell index (never [], which would read as every cell reached) */
  unreachedCells: string[] | "cell list unknown"
  excluded: { invariant: string; reason: string }[]
}

/** One edge the search took; `trace` in check and the monitor's entries are these, from the start to the current state. */
export interface MachineStep<S, E, O> {
  index: number
  previous: S
  event: E
  state: S
  output: O
}

/** The declared cells of an adapter that has them (fromDefinition's transition table), for the unreached-cells list. */
export interface CellIndex {
  declared: readonly string[]
  cell(state: unknown, event: unknown): string
}

const cellIndexes = new WeakMap<object, CellIndex>()

export function registerCells(adapter: object, index: CellIndex): void {
  cellIndexes.set(adapter, index)
}

export function cellsOf(adapter: object): CellIndex | undefined {
  return cellIndexes.get(adapter)
}

interface Node<S, E, O> {
  label: string
  state: S
  monitor: unknown
  steps: readonly MachineStep<S, E, O>[]
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function exploreMachine<S, E, O>(adapter: MachineAdapter<S, E, O>, bounds: { depth: number; maxStates: number }): ExploreMachineReport {
  if (!Number.isInteger(bounds.depth) || bounds.depth < 0) throw new RangeError("exploreMachine depth must be a non-negative integer")
  if (!Number.isInteger(bounds.maxStates) || bounds.maxStates < 1) throw new RangeError("exploreMachine maxStates must be a positive integer")
  const monitor = adapter.traceMonitor
  const cells = cellsOf(adapter)
  const reached = new Set<string>()
  const keyOf = (state: S, monitorState: unknown): string =>
    monitor === undefined ? adapter.canonical(state) : `${adapter.canonical(state)}\n${monitor.key(monitorState)}`

  const visited = new Set<string>()
  let frontier: Node<S, E, O>[] = []
  for (const { label, state } of adapter.initial()) {
    const key = keyOf(state, monitor?.initial)
    if (visited.has(key)) continue
    visited.add(key)
    frontier.push({ label, state, monitor: monitor?.initial, steps: [] })
  }

  const violations: ExploreMachineReport["violations"] = []
  const seenViolations = new Set<string>()
  let edges = 0
  let depthCompleted = 0
  let capped = false

  for (let depth = 1; depth <= bounds.depth && frontier.length > 0 && !capped; depth++) {
    const next: Node<S, E, O>[] = []
    for (const node of frontier) {
      for (const event of adapter.enabledEvents(node.state)) {
        if (cells !== undefined) reached.add(cells.cell(node.state, event))
        const path = [node.label, ...node.steps.map((step) => String(step.event)), String(event)]
        let violation: string | null
        let step: MachineStep<S, E, O> | undefined
        try {
          const result = adapter.step(node.state, event)
          step = { index: node.steps.length, previous: node.state, event, state: result.state, output: result.output }
          violation = adapter.check({ previous: node.state, state: result.state, event, output: result.output, trace: [...node.steps, step] })
        } catch (error) {
          violation = message(error)
        }
        if (violation !== null || step === undefined) {
          const text = violation ?? "step failed"
          // one shortest witness per violation: the same failure reached at a later step is not a new finding
          const seen = text.replace(/ step \d+/, "")
          if (!seenViolations.has(seen)) {
            seenViolations.add(seen)
            violations.push({ message: text, trace: path })
          }
          continue
        }
        edges++
        const monitorState = monitor === undefined ? undefined : monitor.step(node.monitor, step)
        const key = keyOf(step.state, monitorState)
        if (visited.has(key)) continue
        if (visited.size >= bounds.maxStates) {
          capped = true
          continue
        }
        visited.add(key)
        next.push({ label: node.label, state: step.state, monitor: monitorState, steps: [...node.steps, step] })
      }
    }
    if (!capped) depthCompleted = depth
    frontier = next
  }

  return {
    machine: adapter.name,
    states: visited.size,
    edges,
    depthCompleted,
    frontierClosed: !capped && frontier.length === 0,
    violations,
    unreachedCells: cells === undefined ? "cell list unknown" : cells.declared.filter((cell) => !reached.has(cell)).sort(),
    excluded: [...(adapter.excluded ?? [])],
  }
}
