// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Hex32 } from "@individuality/daily-dollar";

export interface RegisterDrawChunkResult {
  eventIds: Hex32[];
  status: "finalized" | "unknown" | "failed";
  txHash?: string;
  error?: unknown;
}

export type RegisterDrawsResult = RegisterDrawChunkResult[];

export type RegisterDrawsErrorCode =
  | "account-missing"
  | "timeout"
  | "signing"
  | "finalized-error"
  /** This host never attested the person, so no alias can be bound here. */
  | "not-attested-device";

/** Classified register error. `message` is fixed, safe copy for logging only;
 *  raw failure is carried only as `cause`. */
export class RegisterDrawsError extends Error {
  readonly code: RegisterDrawsErrorCode;

  constructor(
    code: RegisterDrawsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RegisterDrawsError";
    this.code = code;
  }
}
