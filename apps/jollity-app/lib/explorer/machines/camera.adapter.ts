// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { cameraMachineDefinition } from "../../state-machines/camera.definition"
import { fromDefinition } from "./from-definition"

// camera.definition.ts has no invariant that reads the trace, so the adapter needs no trace monitor
export const cameraAdapter = fromDefinition(cameraMachineDefinition)
