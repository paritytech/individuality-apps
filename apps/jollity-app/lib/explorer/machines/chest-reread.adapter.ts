// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { chestRereadMachineDefinition } from "../../state-machines/chest-reread.definition"
import { fromDefinition } from "./from-definition"

// every chest-reread invariant (chest-reread.definition.ts) reads one step only, so there is no trace monitor
export const chestRereadAdapter = fromDefinition(chestRereadMachineDefinition)
