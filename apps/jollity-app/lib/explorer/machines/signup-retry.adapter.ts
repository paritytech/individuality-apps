// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { signupRetryMachineDefinition } from "../../state-machines/signup-retry.definition"
import { fromDefinition } from "./from-definition"

export const signupRetryAdapter = fromDefinition(signupRetryMachineDefinition)
