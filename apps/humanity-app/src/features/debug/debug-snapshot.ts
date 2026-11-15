// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The whole panel as one JSON document, for pasting into a bug report.
 *
 * Built from the same `DebugSection[]` the panel renders, so the document can
 * never drift from what was on screen — a report that disagrees with the panel
 * it came from is worse than no report.
 *
 * React-free and clipboard-free so the shaping stays unit-testable.
 */
import type { LogEntry } from "@humanity/shared/logging/log-buffer.ts";

import type { MutationRecord } from "./debug-mutation-journal.ts";

import type { DebugSection } from "./debug-format.ts";
import type { DebugPrizeState } from "./debug-prize-state.ts";
import type { DebugScenarioId } from "./debug-scenarios.ts";

interface DebugSnapshotSimulation {
  /**
   * True when any panel-local override is active. Load-bearing: with a
   * scenario or prize outcome picked, the section values below describe a
   * simulation and not the chain, and whoever reads this document has no other
   * way to tell.
   */
  active: boolean;
  scenario: DebugScenarioId | null;
  pendingScenario: DebugScenarioId | null;
  applying: boolean;
  prize: DebugPrizeState;
}

interface DebugSnapshotLog {
  /** ISO-8601, for reading. */
  at: string;
  level: string;
  category: string;
  message: string;
}

interface DebugSnapshotMutation {
  /** ISO-8601, for reading. */
  at: string;
  mutation: string;
  outcome: string;
  detail: string;
}

export interface DebugSnapshot {
  capturedAt: string;
  simulation: DebugSnapshotSimulation;
  /** Section title -> row label -> rendered value, in panel order. Both keys
   *  are already unique: the panel uses them as React keys. */
  sections: Record<string, Record<string, string>>;
  /**
   * Every mutation the panel attempted, oldest first, including the ones it
   * refused to submit. Nothing else in this document records them: the hooks
   * log a failure code without the draw it was for, and a refusal never reaches
   * the logger at all.
   */
  mutations: DebugSnapshotMutation[];
  /** Oldest first — chronological reads better in a pasted report than the
   *  panel's newest-first list, which exists for a live tail. */
  logs: DebugSnapshotLog[];
  /** Set when the buffer had already evicted records by capture time, so a
   *  reader does not mistake the tail for the whole session. */
  logsTruncated: boolean;
  /** Same caveat as {@link DebugSnapshot.logsTruncated}, for the journal. */
  mutationsTruncated: boolean;
}

export interface DebugSnapshotInput {
  capturedAtMs: number;
  sections: readonly DebugSection[];
  logs: readonly LogEntry[];
  logCapacity: number;
  mutations: readonly MutationRecord[];
  mutationCapacity: number;
  scenario: DebugScenarioId | null;
  pendingScenario: DebugScenarioId | null;
  applying: boolean;
  prize: DebugPrizeState;
}

export function buildDebugSnapshot(input: DebugSnapshotInput): DebugSnapshot {
  const sections: Record<string, Record<string, string>> = {};
  for (const section of input.sections) {
    const rows: Record<string, string> = {};
    for (const row of section.rows) rows[row.label] = row.value;
    for (const [label, ...cells] of section.table?.rows ?? []) {
      if (label != null) rows[label] = cells.join(" · ");
    }
    sections[section.title] = rows;
  }

  return {
    capturedAt: new Date(input.capturedAtMs).toISOString(),
    simulation: {
      active: input.scenario != null || input.prize.outcome != null,
      scenario: input.scenario,
      pendingScenario: input.pendingScenario,
      applying: input.applying,
      prize: input.prize,
    },
    sections,
    mutations: input.mutations.map((record) => ({
      at: new Date(record.at).toISOString(),
      mutation: record.mutation,
      outcome: record.outcome,
      detail: record.detail,
    })),
    logs: input.logs.map((entry) => ({
      at: new Date(entry.time).toISOString(),
      level: entry.level,
      category: entry.category,
      message: entry.message,
    })),
    logsTruncated: input.logs.length >= input.logCapacity,
    mutationsTruncated: input.mutations.length >= input.mutationCapacity,
  };
}

/** Two-space indent: these get pasted into issues and read by humans. */
export function serializeDebugSnapshot(snapshot: DebugSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}
