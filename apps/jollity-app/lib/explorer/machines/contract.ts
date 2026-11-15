// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The contract every machine the explorer searches implements. Members use method syntax, so any
 * MachineAdapter<S, E, O> is assignable to RegisteredMachine without `any`. README.md is the checklist for a new adapter.
 */

export interface TraceMonitor<Entry, M> {
  initial: M
  step(monitor: M, entry: Entry): M
  /** part of the visited key: two paths with equal keys must give equal verdicts for every trace invariant, now and later */
  key(monitor: M): string
  /** the invariants this monitor stands for, by name */
  covers: readonly string[]
}

// members use method syntax, so any MachineAdapter<S, E, O> is assignable to RegisteredMachine without `any`
export type RegisteredMachine = MachineAdapter<unknown, string, unknown>

export interface MachineAdapter<State, Event, Output> {
  name: string
  /** normal initial states only: the app's start value(s), never a definition's initialArbitrary */
  initial(): readonly { label: string; state: State }[]
  /** the finite event alphabet enabled in `state`; representative values live inside the definition's concreteEvent */
  enabledEvents(state: State): readonly Event[]
  step(state: State, event: Event): { state: State; output: Output }
  /** the FULL state as stable JSON; an adapter may drop a field only with a successor-equivalence test */
  canonical(state: State): string
  /** returns a message on violation; `trace` is the path the BFS took to `state` */
  check(context: { previous: State; state: State; event: Event; output: Output; trace: readonly unknown[] }): string | null
  /** required when any invariant reads `trace`; its key joins the visited key */
  traceMonitor?: TraceMonitor<unknown, unknown>
  /** invariants excluded from exhaustive claims, with the reason printed in the report */
  excluded?: readonly { invariant: string; reason: string }[]
}
