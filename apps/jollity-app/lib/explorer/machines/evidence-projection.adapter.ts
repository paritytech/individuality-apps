// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { evidenceProjectionMachineDefinition } from "../../state-machines/evidence-projection.definition"
import { fromDefinition } from "./from-definition"

// every evidence-projection invariant (evidence-projection.definition.ts) reads one step only, so there is no trace monitor
export const evidenceProjectionAdapter = fromDefinition(evidenceProjectionMachineDefinition)
