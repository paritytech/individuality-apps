// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { CoverageReport, TransitionDeclaration, TransitionTable } from "./types"

export class CoverageRecorder<StateKey extends string, EventKey extends string> {
  readonly #hits = new Map<string, number>()
  readonly #impossible = new Set<string>()

  constructor(
    readonly machine: string,
    readonly table: TransitionTable<StateKey, EventKey>,
    readonly seed: number,
  ) {}

  record(state: StateKey, event: EventKey, outcome: TransitionDeclaration): void {
    const pair = `${state}::${event}`
    const key = `${pair}::${outcome}`
    this.#hits.set(key, (this.#hits.get(key) ?? 0) + 1)
    if (outcome === "impossible") this.#impossible.add(pair)
  }

  report(): CoverageReport {
    const required: string[] = []
    for (const [state, row] of Object.entries(this.table) as [StateKey, Record<EventKey, TransitionDeclaration>][]) {
      for (const [event, declaration] of Object.entries(row) as [EventKey, TransitionDeclaration][]) {
        if (declaration !== "impossible") required.push(`${state}::${event}::${declaration}`)
      }
    }
    const missing = required.filter((pair) => !this.#hits.has(pair)).sort()
    return {
      machine: this.machine,
      seed: this.seed,
      declared: required.length,
      hit: required.length - missing.length,
      missing,
      impossibleObserved: [...this.#impossible].sort(),
      hits: Object.fromEntries([...this.#hits.entries()].sort(([a], [b]) => a.localeCompare(b))),
    }
  }
}
