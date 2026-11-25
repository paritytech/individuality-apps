// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { collectablesRereadMachineDefinition } from "../../state-machines/collectables-reread.definition"
import { fromDefinition } from "./from-definition"

// every collectables-reread invariant (collectables-reread.definition.ts) reads one step only, so there is no trace monitor
export const collectablesRereadAdapter = fromDefinition(collectablesRereadMachineDefinition)
