// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { reportOutboxMachineDefinition } from "../../state-machines/report-outbox.definition"
import type { TraceMonitor } from "./contract"
import { fromDefinition } from "./from-definition"

/** the framework's trace entry for report-outbox, as its invariants read it */
type OutboxEntry = Parameters<(typeof reportOutboxMachineDefinition.invariants)[number]["check"]>[0]["trace"][number]

/** What the three trace invariants of report-outbox.definition.ts (454-500) read, and nothing more. */
type OutboxMonitor = {
  /** generations that emitted their first attempt (submit:<g>:1), sorted */
  firstAttempts: readonly number[]
  firstAttemptRepeated: boolean
  /** an entry so far had chainClosed, and whether a later entry emitted submit or finish */
  closed: boolean
  emittedAfterClosed: boolean
  /** an entry so far reached confirmed or missed, and whether a later entry emitted submit or finish */
  terminal: boolean
  emittedAfterTerminal: boolean
}

const submitsOrFinishes = (commands: readonly string[]): boolean =>
  commands.some((command) => command.startsWith("submit:") || command === "finish-report")

export const reportOutboxTraceMonitor: TraceMonitor<OutboxEntry, OutboxMonitor> = {
  initial: { firstAttempts: [], firstAttemptRepeated: false, closed: false, emittedAfterClosed: false, terminal: false, emittedAfterTerminal: false },
  step: (m: OutboxMonitor, entry: OutboxEntry): OutboxMonitor => {
    const firstAttempts = [...m.firstAttempts]
    let firstAttemptRepeated = m.firstAttemptRepeated
    for (const command of entry.real.commands) {
      const match = /^submit:(\d+):1$/.exec(command)
      if (match === null) continue
      const generation = Number(match[1])
      if (firstAttempts.includes(generation)) firstAttemptRepeated = true
      else firstAttempts.push(generation)
    }
    const emits = submitsOrFinishes(entry.real.commands)
    const phase = entry.real.state.phase
    return {
      firstAttempts: firstAttempts.sort((left, right) => left - right),
      firstAttemptRepeated,
      closed: m.closed || entry.real.state.chainClosed,
      emittedAfterClosed: m.emittedAfterClosed || (m.closed && emits),
      terminal: m.terminal || phase === "confirmed" || phase === "missed",
      emittedAfterTerminal: m.emittedAfterTerminal || (m.terminal && emits),
    }
  },
  key: (m: OutboxMonitor) =>
    `${m.firstAttempts.join(",")}|${m.firstAttemptRepeated ? 1 : 0}|${m.closed ? 1 : 0}${m.emittedAfterClosed ? 1 : 0}|${m.terminal ? 1 : 0}${m.emittedAfterTerminal ? 1 : 0}`,
  covers: ["each generation emits at most one first attempt", "chain closure prevents later submit or finish", "terminal histories never submit or finish again"],
}

export const reportOutboxAdapter = fromDefinition(reportOutboxMachineDefinition, { traceMonitor: reportOutboxTraceMonitor })
