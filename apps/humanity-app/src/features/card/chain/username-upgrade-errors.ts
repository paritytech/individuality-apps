// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Stable error categories for the lite-to-full upgrade. */
export type UsernameUpgradeErrorCode =
  | "invalid-username"
  | "account-missing"
  | "signer-account-missing"
  | "lite-owner-unavailable"
  | "owner-mismatch"
  | "username-taken"
  | "missing-alias"
  | "alias-binding-failed"
  | "alias-context-mismatch"
  | "ring-unavailable"
  | "context-mismatch"
  | "timeout"
  | "finalized-error"
  | "signing"
  | "incompatible-proof"
  | "pending";

/**
 * Classified upgrade error. `message` is fixed, safe copy for logging and
 * diagnostics only; it is never rendered. Any raw failure is carried only as
 * `cause`.
 */
export class UsernameUpgradeError extends Error {
  readonly code: UsernameUpgradeErrorCode;

  constructor(
    code: UsernameUpgradeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "UsernameUpgradeError";
    this.code = code;
  }
}
