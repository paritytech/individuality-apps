// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The one guard between a log line and anywhere it can go.
 *
 * The local log (lib/debug/telemetry.ts) and Sentry (lib/telemetry) both pass
 * text through `scrubMnemonic`, so a string shaped like a 12-word recovery
 * phrase is redacted the same way on the phone and on the way out. Nothing
 * should ever log one; this is defense in depth. Pure.
 */

import { describeError } from "../host/error-detail"

/** 12+ space-separated lowercase words — mnemonic-shaped, never keep it. */
const MNEMONIC_LIKE = /(?:\b[a-z]+ +){11,}[a-z]+\b/g

export function scrubMnemonic(text: string): string {
  MNEMONIC_LIKE.lastIndex = 0 // a global regex remembers where the last test stopped
  if (!MNEMONIC_LIKE.test(text)) return text
  MNEMONIC_LIKE.lastIndex = 0
  return text.replace(MNEMONIC_LIKE, "[redacted: mnemonic-like string]")
}

/** JSON.stringify that survives bigints (the chain speaks planck), bytes and cycles. */
export function safeStringify(value: unknown, space = 0): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (_key, val: unknown) => {
        // JSON.stringify(new Error("x")) is "{}": say what the error was
        if (val instanceof Error) return describeError(val)
        if (typeof val === "bigint") return `${val.toString()}n`
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[circular]"
          seen.add(val)
        }
        if (val instanceof Uint8Array)
          return `0x${Array.from(val, (b) => b.toString(16).padStart(2, "0")).join("")}`
        return val
      },
      space,
    )
  } catch {
    return String(value)
  }
}
