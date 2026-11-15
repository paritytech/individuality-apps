// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export { DEFAULT_STATE_MACHINE_SEED, runStateMachineSuite } from "./runner"
export { checkStep } from "./step-check"
export type {
  MachineDefinition,
  NamedInvariant,
  NamedSequence,
  TraceEntry,
  TransitionTable,
} from "./types"

import type { TransitionTable } from "./types"

export const defineTransitionTable = <StateKey extends string, EventKey extends string>() =>
  <Table extends TransitionTable<StateKey, EventKey>>(table: Table): Table => table
