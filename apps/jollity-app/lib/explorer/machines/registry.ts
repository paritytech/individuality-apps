// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { RegisteredMachine } from "./contract"
import { payoffAdapter } from "./payoff.adapter"
import { cameraAdapter } from "./camera.adapter"
import { readRetryAdapter } from "./read-retry.adapter"
import { collectablesRereadAdapter } from "./collectables-reread.adapter"
import { launchStallAdapter } from "./launch-stall.adapter"
import { clockSyncAdapter } from "./clock-sync.adapter"
import { reportOutboxAdapter } from "./report-outbox.adapter"
import { reportRetryAdapter } from "./report-retry.adapter"
import { sendAdaptationAdapter } from "./send-adaptation.adapter"
import { evidenceProjectionAdapter } from "./evidence-projection.adapter"
import { chainHealthAdapter } from "./chain-health.adapter"
import { messageExpiryClockAdapter } from "./message-expiry-clock.adapter"
import { signupRetryAdapter } from "./signup-retry.adapter"
import { storeCalibrationAdapter } from "./store-calibration.adapter"
import { collectablesScreenAdapter } from "./collectables-screen.adapter"
import { drawScreenAdapter } from "./draw-screen.adapter"

/** The machines `npm run explore -- --machine <name>` searches through exploreMachine. */
export const MACHINES: Record<string, RegisteredMachine> = {
  payoff: payoffAdapter,
  camera: cameraAdapter,
  "read-retry": readRetryAdapter,
  "collectables-reread": collectablesRereadAdapter,
  "launch-stall": launchStallAdapter,
  "clock-sync": clockSyncAdapter,
  "report-outbox": reportOutboxAdapter,
  "report-retry": reportRetryAdapter,
  "send-adaptation": sendAdaptationAdapter,
  "evidence-projection": evidenceProjectionAdapter,
  "chain-health": chainHealthAdapter,
  "message-expiry-clock": messageExpiryClockAdapter,
  "signup-retry": signupRetryAdapter,
  "store-calibration": storeCalibrationAdapter,
  "draw-screen": drawScreenAdapter,
  "collectables-screen": collectablesScreenAdapter,
}
