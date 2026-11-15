// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The sign-up failure reason, as a pure helper the sign-up flow and a
 * surface's telemetry both read.
 *
 * A signing the player cancelled is signing-refused, by the words the host
 * classifier reads as a decline. A host that failed during signing says
 * something else and keeps its stage.
 */
import { classifyHostFailure } from "@individuality/people-chain"

export function signupFailureReason(errorText: string, stage: string): string {
  return classifyHostFailure(errorText) === "declined" ? "signing-refused" : stage
}
