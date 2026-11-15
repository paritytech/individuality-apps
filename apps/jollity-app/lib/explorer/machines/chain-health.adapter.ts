// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { chainHealthMachineDefinition } from "../../state-machines/chain-health.definition"
import { fromDefinition } from "./from-definition"

// every chain-health invariant reads one step only, so there is no trace monitor
export const chainHealthAdapter = fromDefinition(chainHealthMachineDefinition)
